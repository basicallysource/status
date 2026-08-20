export type Status = 'up' | 'degraded' | 'down' | 'unknown';

/**
 * A metric carried on a heartbeat becomes a degraded state when it crosses a
 * line — or a full outage, when `level: 'down'` says the service is not merely
 * unwell (a stopped daemon is an outage; a filling disk is not, yet).
 */
export type Threshold = { level?: 'down' | 'degraded' } & (
  | { warn?: number; crit: number }
  | { equals: string | number | boolean }
);

interface Base {
  id: string;
  name: string;
  group?: string;
  description?: string;
}

export interface HttpMonitor extends Base {
  kind: 'http';
  url: string;
  /** Substring the body must contain. A 200 that says the wrong thing is not up. */
  expectBody?: string;
  timeoutMs?: number;
}

export interface HeartbeatMonitor extends Base {
  kind: 'heartbeat';
  /** Silence longer than this is an outage. */
  staleAfterSec?: number;
  thresholds?: Record<string, Threshold>;
}

export type Monitor = HttpMonitor | HeartbeatMonitor;

export interface Observation {
  ok: boolean;
  degraded?: boolean;
  latencyMs: number | null;
  code: number | null;
  err: string | null;
  meta?: Record<string, unknown> | null;
}

export interface Transition {
  status: Status;
  since: number;
  fails: number;
  changed: boolean;
  prevStatus: Status;
}

export interface StateRow {
  monitor: string;
  status: Status;
  since: number;
  fails: number;
  last_ts: number | null;
  last_err: string | null;
  last_latency_ms: number | null;
  meta: string | null;
}

export interface Env {
  DB: D1Database;
  /** Shared secret for POST /beat/<id> and POST /api/tick. */
  BEAT_TOKEN?: string;
  /** Fires a new message per state change, so it can notify. */
  DISCORD_ALERT_WEBHOOK?: string;
  /** Holds one message edited in place: the status page, mirrored. */
  DISCORD_BOARD_WEBHOOK?: string;
  /** A private push-notification endpoint taking POST /notify {title, message}. */
  PUSH_API?: string;
  PUSH_TOKEN?: string;
}
