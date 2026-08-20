import { HISTORY_DAYS } from './config';
import type { StateRow, Status } from './types';

// Four tables, each earning its place: where things stand, when a beat last
// landed, the daily rollup the bars are drawn from, and the incident log.
// Raw per-check rows are deliberately absent — the incident log already carries
// the timeline, at a fraction of the writes.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS state (
  monitor         TEXT PRIMARY KEY,
  status          TEXT    NOT NULL,
  since           INTEGER NOT NULL,
  fails           INTEGER NOT NULL DEFAULT 0,
  last_ts         INTEGER,
  last_err        TEXT,
  last_latency_ms INTEGER,
  meta            TEXT
);
CREATE TABLE IF NOT EXISTS beats (
  monitor TEXT PRIMARY KEY,
  ts      INTEGER NOT NULL,
  meta    TEXT
);
CREATE TABLE IF NOT EXISTS daily (
  monitor TEXT    NOT NULL,
  day     TEXT    NOT NULL,
  up      INTEGER NOT NULL DEFAULT 0,
  down    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (monitor, day)
);
CREATE TABLE IF NOT EXISTS incidents (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor TEXT    NOT NULL,
  status  TEXT    NOT NULL,
  started INTEGER NOT NULL,
  ended   INTEGER,
  detail  TEXT
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

export async function migrate(db: D1Database): Promise<void> {
  const stmts = SCHEMA.split(';').map((s) => s.trim()).filter(Boolean);
  await db.batch(stmts.map((s) => db.prepare(s)));
}

export const dayKey = (tsSec: number): string => new Date(tsSec * 1000).toISOString().slice(0, 10);

export async function loadState(db: D1Database): Promise<Record<string, StateRow>> {
  const { results } = await db.prepare('SELECT * FROM state').all<StateRow>();
  return Object.fromEntries((results ?? []).map((r) => [r.monitor, r]));
}

export async function loadBeats(
  db: D1Database,
): Promise<Record<string, { monitor: string; ts: number; meta: string | null }>> {
  const { results } = await db.prepare('SELECT * FROM beats').all<{
    monitor: string;
    ts: number;
    meta: string | null;
  }>();
  return Object.fromEntries((results ?? []).map((r) => [r.monitor, r]));
}

export const beatStmt = (
  db: D1Database,
  monitor: string,
  ts: number,
  meta: unknown,
): D1PreparedStatement =>
  db
    .prepare(
      `INSERT INTO beats (monitor, ts, meta) VALUES (?1, ?2, ?3)
       ON CONFLICT(monitor) DO UPDATE SET ts = ?2, meta = ?3`,
    )
    .bind(monitor, ts, meta ? JSON.stringify(meta) : null);

export interface TickResult {
  id: string;
  ts: number;
  ok: boolean;
  status: Status;
  since: number;
  fails: number;
  latencyMs: number | null;
  err: string | null;
  meta: Record<string, unknown> | null;
}

/** One tick of writes, batched into a single round trip. */
export function tickStmts(db: D1Database, rows: TickResult[]): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  for (const r of rows) {
    out.push(
      db
        .prepare(
          `INSERT INTO daily (monitor, day, up, down) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(monitor, day) DO UPDATE SET up = up + ?3, down = down + ?4`,
        )
        .bind(r.id, dayKey(r.ts), r.ok ? 1 : 0, r.ok ? 0 : 1),
      db
        .prepare(
          `INSERT INTO state (monitor, status, since, fails, last_ts, last_err, last_latency_ms, meta)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
           ON CONFLICT(monitor) DO UPDATE SET
             status=?2, since=?3, fails=?4, last_ts=?5, last_err=?6, last_latency_ms=?7, meta=?8`,
        )
        .bind(
          r.id,
          r.status,
          r.since,
          r.fails,
          r.ts,
          r.err,
          r.latencyMs,
          r.meta ? JSON.stringify(r.meta) : null,
        ),
    );
  }
  return out;
}

export const closeIncidentStmt = (db: D1Database, monitor: string, ts: number) =>
  db
    .prepare(
      `UPDATE incidents SET ended = ?2 WHERE id =
        (SELECT id FROM incidents WHERE monitor = ?1 AND ended IS NULL ORDER BY started DESC LIMIT 1)`,
    )
    .bind(monitor, ts);

export const openIncidentStmt = (
  db: D1Database,
  monitor: string,
  status: Status,
  ts: number,
  detail: string | null,
) =>
  db
    .prepare('INSERT INTO incidents (monitor, status, started, detail) VALUES (?1,?2,?3,?4)')
    .bind(monitor, status, ts, detail);

export interface DayRow {
  up: number;
  down: number;
}

export async function history(
  db: D1Database,
  sinceDay: string,
): Promise<Record<string, Record<string, DayRow>>> {
  const { results } = await db
    .prepare('SELECT monitor, day, up, down FROM daily WHERE day >= ?1')
    .bind(sinceDay)
    .all<{ monitor: string; day: string; up: number; down: number }>();
  const out: Record<string, Record<string, DayRow>> = {};
  for (const r of results ?? []) (out[r.monitor] ??= {})[r.day] = { up: r.up, down: r.down };
  return out;
}

export interface IncidentRow {
  id: number;
  monitor: string;
  status: Status;
  started: number;
  ended: number | null;
  detail: string | null;
}

export async function recentIncidents(db: D1Database, limit = 15): Promise<IncidentRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM incidents ORDER BY started DESC LIMIT ?1')
    .bind(limit)
    .all<IncidentRow>();
  return results ?? [];
}

export async function kvGet(db: D1Database, k: string): Promise<string | null> {
  const row = await db.prepare('SELECT v FROM kv WHERE k = ?1').bind(k).first<{ v: string }>();
  return row?.v ?? null;
}

export const kvSetStmt = (db: D1Database, k: string, v: string) =>
  db
    .prepare('INSERT INTO kv (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = ?2')
    .bind(k, v);

/** Drops history that has aged past the window the page draws. */
export async function pruneOld(db: D1Database, nowSec: number): Promise<void> {
  const cutoff = nowSec - HISTORY_DAYS * 86400;
  await db.batch([
    db.prepare('DELETE FROM daily WHERE day < ?1').bind(dayKey(cutoff)),
    db.prepare('DELETE FROM incidents WHERE ended IS NOT NULL AND ended < ?1').bind(cutoff),
  ]);
}

/**
 * Forgets every monitor no longer in the config. Without this, removing one
 * strands an open incident nothing will ever close and the page reports an
 * outage forever. Runs on the first tick of each isolate, so a deploy that
 * changes the config cleans up after itself.
 */
export async function pruneOrphans(db: D1Database, knownIds: string[]): Promise<void> {
  const ph = knownIds.map((_, i) => `?${i + 1}`).join(',') || "''";
  await db.batch(
    ['state', 'beats', 'daily', 'incidents'].map((t) =>
      db.prepare(`DELETE FROM ${t} WHERE monitor NOT IN (${ph})`).bind(...knownIds),
    ),
  );
}
