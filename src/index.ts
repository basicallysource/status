import { HISTORY_DAYS, MONITORS, MONITOR_BY_ID } from './config';
import { overall, syncBoard, type BoardRow } from './board';
import {
  beatStmt,
  closeIncidentStmt,
  dayKey,
  history,
  loadBeats,
  loadState,
  migrate,
  openIncidentStmt,
  pruneOld,
  pruneOrphans,
  recentIncidents,
  tickStmts,
  type TickResult,
} from './db';
import { fmtDuration, nextState, parseMeta, probe } from './monitor';
import { sendAlert } from './notify';
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
  const [state, beats] = await Promise.all([loadState(env.DB), loadBeats(env.DB)]);
  const observations = await Promise.all(MONITORS.map((m) => probe(m, beats, nowSec)));

  const rows: TickResult[] = [];
  const incidentWrites: D1PreparedStatement[] = [];
  const alerts: { i: number; t: ReturnType<typeof nextState> }[] = [];

  MONITORS.forEach((m, i) => {
    const obs = observations[i];
    const t = nextState(state[m.id], obs, nowSec);
    rows.push({
      id: m.id,
      ts: nowSec,
      ok: obs.ok && !obs.degraded,
      status: t.status,
      since: t.since,
      fails: t.fails,
      latencyMs: obs.latencyMs,
      err: obs.err,
      meta: obs.meta ?? parseMeta(state[m.id]?.meta ?? null),
    });
    if (!t.changed) return;
    incidentWrites.push(closeIncidentStmt(env.DB, m.id, nowSec));
    if (t.status !== 'up') incidentWrites.push(openIncidentStmt(env.DB, m.id, t.status, nowSec, obs.err));
    alerts.push({ i, t });
  });

  await env.DB.batch([...tickStmts(env.DB, rows), ...incidentWrites]);

  await Promise.allSettled(
    alerts.map(({ i, t }) => sendAlert(env, MONITORS[i], t, observations[i], nowSec)),
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

/** "service active · disk 55%" — a heartbeat's metrics, in a readable line. */
export function describeMeta(meta: Record<string, unknown> | null): string | null {
  if (!meta) return null;
  const parts = Object.entries(meta)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => (k.endsWith('_pct') ? `${k.slice(0, -4)} ${v}%` : `${k} ${v}`));
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
  const [state, hist, incidents] = await Promise.all([
    loadState(env.DB),
    history(env.DB, dayKey(nowSec - HISTORY_DAYS * 86400)),
    recentIncidents(env.DB, 15),
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
      status !== 'up'
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
    })),
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const authed = (req: Request, env: Env) =>
  !!env.BEAT_TOKEN && req.headers.get('authorization') === `Bearer ${env.BEAT_TOKEN}`;

async function handleBeat(req: Request, env: Env, id: string): Promise<Response> {
  const m = MONITOR_BY_ID[id];
  if (!m || m.kind !== 'heartbeat') return json({ error: `unknown heartbeat monitor: ${id}` }, 404);
  if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);

  // JSON body preferred; query params keep a shell one-liner a one-liner.
  let meta: Record<string, unknown> | null = null;
  if ((req.headers.get('content-type') ?? '').includes('application/json')) {
    meta = await req.json<Record<string, unknown>>().catch(() => null);
  }
  if (!meta) {
    const q = new URL(req.url).searchParams;
    if ([...q.keys()].length) {
      meta = {};
      for (const [k, v] of q) meta[k] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
    }
  }

  const nowSec = Math.floor(Date.now() / 1000);
  await ensureSchema(env.DB);
  await beatStmt(env.DB, id, nowSec, meta).run();
  return json({ ok: true, monitor: id, ts: nowSec, meta });
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
    if (path === '/healthz') return json({ ok: true, service: 'basically-status' });
    if (path === '/api/status') return json(await buildPage(env, now()));
    if (path === '/api/tick' && req.method === 'POST') {
      return authed(req, env) ? json(await tick(env)) : json({ error: 'unauthorized' }, 401);
    }
    if (path === '/') {
      return new Response(renderPage(await buildPage(env, now())), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=20' },
      });
    }
    return new Response('Not found', { status: 404 });
  },
};

export { fmtDuration };
