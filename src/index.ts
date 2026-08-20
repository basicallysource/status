import { HISTORY_DAYS, HOST_HISTORY_DAYS, MONITORS, MONITOR_BY_ID } from './config';
import { overall, syncBoard, type BoardRow } from './board';
import {
  abandonDeployStmt,
  backfillDownStmt,
  beatStmt,
  closeDeployStmt,
  closeIncidentStmt,
  dayKey,
  history,
  hostSampleStmt,
  hostSamples,
  latestDeploys,
  loadBeats,
  loadState,
  migrate,
  openDeployFor,
  openDeployStmt,
  openIncidentStmt,
  pointDeployStmt,
  pruneOld,
  pruneOrphans,
  recentDeploys,
  recentIncidents,
  tickStmts,
  touchTokenStmt,
  type TickResult,
} from './db';
import { authorize, isOperator } from './auth';
import { blame, deployEvents, excused, isSlow, typicalSeconds } from './deploy';
import { fmtDuration, nextState, parseMeta, probe } from './monitor';
import { sendAlert, worthAlerting } from './notify';
import { faviconSvg } from './favicon';
import { renderPage, type DayCell, type PageData, type PageMonitor } from './page';
import type { Env, Status } from './types';

// Workers reuse an isolate across invocations, so this stays off almost every
// tick without needing a migration runner. A deploy makes a fresh isolate,
// which is exactly when a changed monitor list needs its orphans swept.
let schemaReady = false;
async function ensureSchema(db: D1Database): Promise<void> {
  if (!schemaReady) {
    await migrate(db);
    await pruneOrphans(db, MONITORS.map((m) => m.id));
    schemaReady = true;
  }
}

export async function tick(env: Env, nowSec = Math.floor(Date.now() / 1000)) {
  await ensureSchema(env.DB);
  const [state, beats, deploys] = await Promise.all([
    loadState(env.DB),
    loadBeats(env.DB),
    latestDeploys(env.DB),
  ]);
  const observations = await Promise.all(MONITORS.map((m) => probe(m, beats, nowSec)));

  const rows: TickResult[] = [];
  const writes: D1PreparedStatement[] = [];
  const alerts: { i: number; t: ReturnType<typeof nextState> }[] = [];

  MONITORS.forEach((m, i) => {
    const obs = observations[i];
    const prev = state[m.id];
    const prevMeta = parseMeta(prev?.meta ?? null);
    const meta = obs.meta ?? prevMeta;

    for (const e of deployEvents(prevMeta, obs.meta, deploys[m.id])) {
      if (e.kind === 'opened') writes.push(openDeployStmt(env.DB, m.id, e.version, nowSec));
      else if (e.kind === 'closed') writes.push(closeDeployStmt(env.DB, m.id, nowSec));
      else writes.push(pointDeployStmt(env.DB, m.id, e.version, nowSec));
    }

    const t = nextState(state[m.id], obs, nowSec, excused(meta, deploys[m.id], obs, nowSec));
    rows.push({
      id: m.id,
      ts: nowSec,
      ok: obs.ok && !obs.degraded,
      status: t.status,
      since: t.since,
      fails: t.fails,
      latencyMs: obs.latencyMs,
      err: obs.err,
      meta,
    });
    if (!t.changed) return;

    if (t.prevStatus === 'maintenance' && t.status === 'down') {
      // We excused these minutes as a deploy and they turned out to be an
      // outage, so they are downtime after all. One tick is one minute. A window
      // spanning midnight lands them all on today, which is close enough for a
      // number that is already about a whole day.
      const excusedMin = Math.round((nowSec - (prev?.since ?? nowSec)) / 60);
      if (excusedMin > 0) writes.push(backfillDownStmt(env.DB, m.id, nowSec, excusedMin));
    }

    if (t.status === 'down' || t.status === 'degraded') {
      writes.push(closeIncidentStmt(env.DB, m.id, nowSec));
      writes.push(
        openIncidentStmt(
          env.DB,
          m.id,
          t.status,
          // An outage we spent time excusing began when we started excusing it,
          // not when we gave up on the excuse.
          t.prevStatus === 'maintenance' ? (prev?.since ?? nowSec) : nowSec,
          obs.err,
          blame(meta, deploys[m.id], nowSec),
        ),
      );
    } else if (t.status === 'up') {
      writes.push(closeIncidentStmt(env.DB, m.id, nowSec));
    }
    // A move into maintenance opens no incident: a deploy is not an incident
    // unless it overruns, and that transition is handled above.
    alerts.push({ i, t });
  });

  await env.DB.batch([...tickStmts(env.DB, rows), ...writes]);

  await Promise.allSettled(
    alerts
      .filter(({ t }) => worthAlerting(t))
      .map(({ i, t }) => sendAlert(env, MONITORS[i], t, observations[i], nowSec)),
  );

  const board: BoardRow[] = rows.map((r, i) => ({
    name: MONITORS[i].name,
    status: r.status,
    since: r.since,
    detail: r.err ?? '',
    uptime: 0,
  }));
  await syncBoard(env, await withUptime(env, board, nowSec), nowSec).catch((e) =>
    console.error('board sync:', e),
  );

  const d = new Date(nowSec * 1000);
  if (d.getUTCHours() === 4 && d.getUTCMinutes() < 1) await pruneOld(env.DB, nowSec);

  return { checked: rows.length, changed: alerts.length };
}

async function withUptime(env: Env, board: BoardRow[], nowSec: number): Promise<BoardRow[]> {
  const hist = await history(env.DB, dayKey(nowSec - HISTORY_DAYS * 86400));
  return board.map((b, i) => {
    const h = hist[MONITORS[i].id] ?? {};
    let up = 0;
    let total = 0;
    for (const v of Object.values(h)) {
      up += v.up;
      total += v.up + v.down;
    }
    return { ...b, uptime: total ? (up / total) * 100 : 100 };
  });
}

/** The keys a service reports about its own deploys read as English rather than
 *  as field names. Everything else is `key value`. */
const META_PHRASE: Record<string, (v: unknown) => string> = {
  version: (v) => `on ${v}`,
  deploying: (v) => `deploying ${v}`,
};

/** "service active · disk 55% · on r2026.08.20-3" — a heartbeat's metrics. */
export function describeMeta(meta: Record<string, unknown> | null): string | null {
  if (!meta) return null;
  const parts = Object.entries(meta)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) =>
      META_PHRASE[k] ? META_PHRASE[k](v) : k.endsWith('_pct') ? `${k.slice(0, -4)} ${v}%` : `${k} ${v}`,
    );
  return parts.length ? parts.join(' · ') : null;
}

function dayCell(day: string, up: number, down: number): DayCell {
  const total = up + down;
  const pct = total ? (up / total) * 100 : 0;
  const status: Status = !total ? 'unknown' : down === 0 ? 'up' : pct >= 95 ? 'degraded' : 'down';
  return { day, up, down, total, pct, status };
}

async function buildPage(env: Env, nowSec: number): Promise<PageData> {
  await ensureSchema(env.DB);
  const [state, hist, incidents, deploys] = await Promise.all([
    loadState(env.DB),
    history(env.DB, dayKey(nowSec - HISTORY_DAYS * 86400)),
    recentIncidents(env.DB, 15),
    recentDeploys(env.DB, 20),
  ]);

  const monitors: PageMonitor[] = MONITORS.map((m) => {
    const s = state[m.id];
    const h = hist[m.id] ?? {};
    const days: DayCell[] = [];
    let up = 0;
    let total = 0;
    for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
      const day = dayKey(nowSec - i * 86400);
      const r = h[day] ?? { up: 0, down: 0 };
      days.push(dayCell(day, r.up, r.down));
      up += r.up;
      total += r.up + r.down;
    }
    const status: Status = s?.status ?? 'unknown';
    const detail =
      status === 'maintenance'
        ? // What is happening, not what is failing: mid-deploy, "service
          // activating" is the symptom and the deploy is the news.
          (describeMeta(parseMeta(s?.meta ?? null)) ?? 'A new version is being installed')
        : status !== 'up'
          ? (s?.last_err ?? '')
          : s?.last_latency_ms != null
          ? `Responding in ${s.last_latency_ms}ms`
          : // A heartbeat has no latency, but it usually carries metrics. Showing
            // them lets a disk be watched climbing rather than only alerted on.
            (describeMeta(parseMeta(s?.meta ?? null)) ?? 'Healthy');

    return {
      name: m.name,
      group: m.group ?? 'Services',
      description: m.description,
      status,
      since: s?.since ?? null,
      detail,
      uptime: total ? (up / total) * 100 : 100,
      days,
    };
  });

  return {
    now: nowSec,
    overall: overall(monitors),
    monitors,
    incidents: incidents.map((i) => ({
      name: MONITOR_BY_ID[i.monitor]?.name ?? i.monitor,
      status: i.status,
      started: i.started,
      ended: i.ended,
      detail: i.detail,
      deploy: i.deploy,
    })),
    deploys: deploys.map((d) => {
      // Each service is judged against its own history, not a shared number:
      // hive runs migrations before it answers and the bot just restarts.
      const typical = typicalSeconds(deploys.filter((x) => x.monitor === d.monitor));
      const seconds = d.ended !== null && d.source === 'reported' ? d.ended - d.started : null;
      return {
        name: MONITOR_BY_ID[d.monitor]?.name ?? d.monitor,
        version: d.version,
        started: d.started,
        ended: d.ended,
        // Only where it was measured. An inferred duration is an artefact of how
        // often we looked, and putting it in a column labelled "took" would
        // invite someone to compare it with one that means something.
        seconds,
        typical,
        slow: seconds !== null && isSlow(seconds, typical),
      };
    }),
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

/**
 * Metrics off a request. JSON body preferred; query params keep a shell
 * one-liner a one-liner, which is what every reporter on a box actually is.
 */
async function readMetrics(req: Request): Promise<Record<string, unknown> | null> {
  if ((req.headers.get('content-type') ?? '').includes('application/json')) {
    const body = await req.json<Record<string, unknown>>().catch(() => null);
    if (body) return body;
  }
  const q = new URL(req.url).searchParams;
  if (![...q.keys()].length) return null;
  const meta: Record<string, unknown> = {};
  // An empty parameter is a shell variable that was not set, which is a claim
  // the sender did not make — `deploying=` means no deploy, not a deploy named
  // "". Dropping it here keeps every reader from having to re-decide.
  for (const [k, v] of q) {
    if (v === '') continue;
    meta[k] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  }
  return Object.keys(meta).length ? meta : null;
}

/**
 * A box reporting on itself: load, memory, swap, uptime.
 *
 * Scoped as `host:<name>` rather than as a service, because a box is not a
 * service — hive-prod runs hive, but "hive-prod is at 91% memory" is an
 * engineering fact and "hive is down" is a customer one. Nothing posted here
 * reaches the public page.
 */
async function handleHost(req: Request, env: Env, host: string): Promise<Response> {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(host)) return json({ error: 'bad host name' }, 400);
  const who = await authorize(req, env, `host:${host}`);
  if (!who) return json({ error: 'unauthorized' }, 401);

  const metrics = await readMetrics(req);
  if (!metrics) return json({ error: 'no metrics' }, 400);

  const nowSec = Math.floor(Date.now() / 1000);
  await ensureSchema(env.DB);
  await env.DB.batch([
    hostSampleStmt(env.DB, host, nowSec, metrics),
    touchTokenStmt(env.DB, who, nowSec),
  ]);
  return json({ ok: true, host, ts: nowSec, metrics });
}

async function handleBeat(req: Request, env: Env, id: string): Promise<Response> {
  const m = MONITOR_BY_ID[id];
  if (!m || m.kind !== 'heartbeat') return json({ error: `unknown heartbeat monitor: ${id}` }, 404);
  const who = await authorize(req, env, id);
  if (!who) return json({ error: 'unauthorized' }, 401);

  const meta = await readMetrics(req);
  const nowSec = Math.floor(Date.now() / 1000);
  await ensureSchema(env.DB);
  await env.DB.batch([beatStmt(env.DB, id, nowSec, meta), touchTokenStmt(env.DB, who, nowSec)]);
  return json({ ok: true, monitor: id, ts: nowSec, meta });
}

/**
 * A service telling us about its own deploy, so the duration is measured rather
 * than inferred from how often we happen to look.
 *
 * `start` is called before anything is touched and `end` when the service is
 * back and answering. Neither may ever fail the deploy that calls it: the caller
 * ignores the result, and this returns an error rather than throwing so that a
 * bad report cannot look like an outage of the status page itself.
 */
async function handleDeploy(req: Request, env: Env, id: string, phase: string): Promise<Response> {
  const m = MONITOR_BY_ID[id];
  if (!m) return json({ error: `unknown monitor: ${id}` }, 404);
  const who = await authorize(req, env, id);
  if (!who) return json({ error: 'unauthorized' }, 401);

  const body = await req.json<{ version?: string }>().catch(() => ({}) as { version?: string });
  const nowSec = Math.floor(Date.now() / 1000);
  const open = await openDeployFor(env.DB, id);

  if (phase === 'start') {
    const version = (body.version ?? '').trim();
    if (!version) return json({ error: 'version is required' }, 400);

    // Starting the same version twice is one deploy being retried, not two
    // deploys. An installer that waits for a running job and comes back next
    // minute has to be able to say "still me" without either forking the record
    // or resetting the clock on how long this has really been going.
    if (open && open.version === version) {
      await touchTokenStmt(env.DB, who, nowSec).run();
      return json({ ok: true, monitor: id, version, started: open.started, resumed: true });
    }

    const writes = [openDeployStmt(env.DB, id, version, nowSec, 'reported')];
    if (open) writes.unshift(abandonDeployStmt(env.DB, id, nowSec));
    writes.push(touchTokenStmt(env.DB, who, nowSec));
    await env.DB.batch(writes);
    return json({ ok: true, monitor: id, version, started: nowSec });
  }

  if (!open) return json({ error: 'no deploy is open for this service' }, 409);
  await env.DB.batch([closeDeployStmt(env.DB, id, nowSec), touchTokenStmt(env.DB, who, nowSec)]);
  return json({ ok: true, monitor: id, version: open.version, seconds: nowSec - open.started });
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(tick(env));
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const path = new URL(req.url).pathname.replace(/\/+$/, '') || '/';
    const now = () => Math.floor(Date.now() / 1000);

    if (req.method === 'POST' && path.startsWith('/beat/')) {
      return handleBeat(req, env, decodeURIComponent(path.slice(6)));
    }
    if (req.method === 'POST' && path.startsWith('/host/')) {
      return handleHost(req, env, decodeURIComponent(path.slice(6)));
    }
    if (req.method === 'POST' && path.startsWith('/deploy/')) {
      const [id, phase, ...rest] = path.slice(8).split('/');
      if (!id || rest.length || (phase !== 'start' && phase !== 'end')) {
        return json({ error: 'expected /deploy/<monitor>/start or /deploy/<monitor>/end' }, 404);
      }
      return handleDeploy(req, env, decodeURIComponent(id), phase);
    }
    if (path === '/healthz') return json({ ok: true, service: 'basically-status' });
    if (path === '/favicon.svg') {
      const s = new URL(req.url).searchParams.get('s') ?? 'unknown';
      return new Response(faviconSvg(s), {
        headers: {
          'content-type': 'image/svg+xml; charset=utf-8',
          // Keyed by status in the query string, so it is safe to cache hard.
          'cache-control': 'public, max-age=86400',
        },
      });
    }
    if (path === '/api/status') return json(await buildPage(env, now()));
    if (path === '/api/hosts') {
      // Operator-only. The public page says whether a service works; how hard a
      // box is breathing to make that true is ours.
      if (!isOperator(req, env)) return json({ error: 'unauthorized' }, 401);
      const q = new URL(req.url).searchParams;
      const hours = Math.min(Number(q.get('hours') ?? 6) || 6, HOST_HISTORY_DAYS * 24);
      await ensureSchema(env.DB);
      const rows = await hostSamples(env.DB, now() - hours * 3600, q.get('host') ?? undefined);
      return json({
        hours,
        samples: rows.map((r) => ({ host: r.host, ts: r.ts, ...(parseMeta(r.metrics) ?? {}) })),
      });
    }
    if (path === '/api/tick' && req.method === 'POST') {
      // The operator credential, not a service's: running a check on demand is
      // not something any reporting machine has a reason to do.
      return isOperator(req, env) ? json(await tick(env)) : json({ error: 'unauthorized' }, 401);
    }
    if (path === '/') {
      return new Response(renderPage(await buildPage(env, now())), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
      });
    }
    return new Response('Not found', { status: 404 });
  },
};

export { fmtDuration };
