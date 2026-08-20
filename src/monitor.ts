import { FAILURES_BEFORE_DOWN } from './config';
import type {
  HeartbeatMonitor,
  HttpMonitor,
  Monitor,
  Observation,
  StateRow,
  Status,
  Transition,
} from './types';

const UA = 'basically-status/1 (+https://status.basically.website)';

export async function probeHttp(m: HttpMonitor, f: typeof fetch = fetch): Promise<Observation> {
  const timeoutMs = m.timeoutMs ?? 10000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await f(m.url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'user-agent': UA, 'cache-control': 'no-cache' },
      // Never let a cached 200 vouch for an origin that is currently on fire.
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    const latencyMs = Date.now() - started;
    if (res.status < 200 || res.status >= 400) {
      return { ok: false, latencyMs, code: res.status, err: `HTTP ${res.status}` };
    }
    if (m.expectBody && !(await res.text()).includes(m.expectBody)) {
      return { ok: false, latencyMs, code: res.status, err: `body missing ${m.expectBody}` };
    }
    return { ok: true, latencyMs, code: res.status, err: null };
  } catch (e) {
    const aborted = e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError');
    return {
      ok: false,
      latencyMs: Date.now() - started,
      code: null,
      err: aborted ? `timed out after ${timeoutMs}ms` : String(e instanceof Error ? e.message : e),
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface Problem {
  text: string;
  level: 'down' | 'degraded';
}

/** Metrics riding on a heartbeat become a visible state, so a disk fills up loudly. */
export function checkThresholds(
  m: HeartbeatMonitor,
  meta: Record<string, unknown> | null,
): Problem[] {
  const problems: Problem[] = [];
  for (const [key, rule] of Object.entries(m.thresholds ?? {})) {
    const raw = meta?.[key];
    if (raw === undefined || raw === null) continue;
    const level = rule.level ?? 'degraded';
    if ('equals' in rule) {
      if (raw !== rule.equals) {
        problems.push({ text: `${key} is ${String(raw)}, expected ${String(rule.equals)}`, level });
      }
      continue;
    }
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    if (v >= rule.crit) problems.push({ text: `${key} at ${v}% (critical ${rule.crit}%)`, level });
    else if (rule.warn !== undefined && v >= rule.warn) {
      problems.push({ text: `${key} at ${v}% (warning ${rule.warn}%)`, level: 'degraded' });
    }
  }
  return problems;
}

export function probeHeartbeat(
  m: HeartbeatMonitor,
  beat: { ts: number; meta: string | null } | undefined,
  nowSec: number,
): Observation {
  if (!beat) return { ok: false, latencyMs: null, code: null, err: 'no heartbeat received yet', meta: null };
  const meta = parseMeta(beat.meta);
  const age = nowSec - beat.ts;
  const staleAfter = m.staleAfterSec ?? 600;
  if (age > staleAfter) {
    return { ok: false, latencyMs: null, code: null, err: `silent for ${fmtDuration(age)}`, meta };
  }
  const problems = checkThresholds(m, meta);
  if (!problems.length) return { ok: true, latencyMs: null, code: null, err: null, meta };

  const err = problems.map((p) => p.text).join('; ');
  return problems.some((p) => p.level === 'down')
    ? { ok: false, latencyMs: null, code: null, err, meta }
    : { ok: true, degraded: true, latencyMs: null, code: null, err, meta };
}

export const probe = (m: Monitor, beats: Record<string, { ts: number; meta: string | null }>, now: number) =>
  m.kind === 'http' ? probeHttp(m) : Promise.resolve(probeHeartbeat(m, beats[m.id], now));

/**
 * Flap guard: one failed probe does not move a healthy service to down. A status
 * page that cries wolf is worse than none, and the cost is a single minute.
 */
export function nextState(prev: StateRow | undefined, obs: Observation, nowSec: number): Transition {
  const prevStatus: Status = prev?.status ?? 'unknown';
  let fails = prev?.fails ?? 0;
  let status: Status;

  if (obs.ok) {
    fails = 0;
    status = obs.degraded ? 'degraded' : 'up';
  } else {
    fails += 1;
    const settled = prevStatus === 'up' || prevStatus === 'degraded';
    status = fails >= FAILURES_BEFORE_DOWN || !settled ? 'down' : prevStatus;
  }

  const changed = status !== prevStatus;
  return { status, since: changed ? nowSec : prev?.since ?? nowSec, fails, changed, prevStatus };
}

export function parseMeta(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return h ? `${d}d ${h}h` : `${d}d`;
}
