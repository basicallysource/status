import { HISTORY_DAYS } from './config';
import type { DeployRow, DeploySource } from './deploy';
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
CREATE TABLE IF NOT EXISTS deploys (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor TEXT    NOT NULL,
  version TEXT    NOT NULL,
  started INTEGER NOT NULL,
  ended   INTEGER,
  -- 'reported' has exact times from the deploying process; 'observed' is
  -- inferred from a heartbeat and is only accurate to the beat interval.
  source  TEXT    NOT NULL DEFAULT 'observed'
);
CREATE INDEX IF NOT EXISTS deploys_recent ON deploys (monitor, started DESC);
-- Credentials for machines that report about services. Hashed, and scoped to
-- the services each machine may speak for. Rows are inserted by hand; there is
-- no endpoint that creates one. See src/auth.ts.
CREATE TABLE IF NOT EXISTS tokens (
  name      TEXT PRIMARY KEY,
  hash      TEXT NOT NULL,
  monitors  TEXT NOT NULL,
  created   INTEGER NOT NULL,
  last_used INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS tokens_hash ON tokens (hash);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

// SQLite has no ADD COLUMN IF NOT EXISTS, and on every deploy after the first
// the column is already there. That is the ordinary case, not an error.
const ADDITIONS = [
  'ALTER TABLE incidents ADD COLUMN deploy TEXT',
  "ALTER TABLE deploys ADD COLUMN source TEXT NOT NULL DEFAULT 'observed'",
];

export async function migrate(db: D1Database): Promise<void> {
  // Comments come out before the split, because statements are separated on `;`
  // and prose contains semicolons. A comment quietly cutting a CREATE TABLE in
  // half fails as "incomplete input", which reads like a typo in the schema
  // rather than like the sentence above it.
  const stmts = SCHEMA.split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  await db.batch(stmts.map((s) => db.prepare(s)));
  for (const sql of ADDITIONS) {
    await db
      .prepare(sql)
      .run()
      .catch((e) => {
        if (!/duplicate column/i.test(String(e))) throw e;
      });
  }
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

/** Adds minutes to a day's down count, for time that was excused as a deploy
 *  and later turned out to be an outage. */
export const backfillDownStmt = (db: D1Database, monitor: string, ts: number, minutes: number) =>
  db
    .prepare(
      `INSERT INTO daily (monitor, day, up, down) VALUES (?1, ?2, 0, ?3)
       ON CONFLICT(monitor, day) DO UPDATE SET down = down + ?3`,
    )
    .bind(monitor, dayKey(ts), minutes);

/** One tick of writes, batched into a single round trip. */
export function tickStmts(db: D1Database, rows: TickResult[]): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  for (const r of rows) {
    // Maintenance counts as neither. Uptime should not be flattered by a deploy,
    // and should not be punished by one either — if the deploy turns out to have
    // been an outage, backfillDownStmt puts those minutes back as down.
    if (r.status !== 'maintenance') {
      out.push(
        db
          .prepare(
            `INSERT INTO daily (monitor, day, up, down) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(monitor, day) DO UPDATE SET up = up + ?3, down = down + ?4`,
          )
          .bind(r.id, dayKey(r.ts), r.ok ? 1 : 0, r.ok ? 0 : 1),
      );
    }
    out.push(
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
  deploy: string | null = null,
) =>
  db
    .prepare(
      'INSERT INTO incidents (monitor, status, started, detail, deploy) VALUES (?1,?2,?3,?4,?5)',
    )
    .bind(monitor, status, ts, detail, deploy);

export const openDeployStmt = (
  db: D1Database,
  monitor: string,
  version: string,
  ts: number,
  source: DeploySource = 'observed',
) =>
  db
    .prepare(
      'INSERT INTO deploys (monitor, version, started, ended, source) VALUES (?1,?2,?3,NULL,?4)',
    )
    .bind(monitor, version, ts, source);

/** A deploy that began and finished between two heartbeats. Minute resolution is
 *  the honest answer, and better than no record of it at all. */
export const pointDeployStmt = (db: D1Database, monitor: string, version: string, ts: number) =>
  db
    .prepare(
      "INSERT INTO deploys (monitor, version, started, ended, source) VALUES (?1,?2,?3,?3,'observed')",
    )
    .bind(monitor, version, ts);

export const closeDeployStmt = (db: D1Database, monitor: string, ts: number) =>
  db
    .prepare(
      `UPDATE deploys SET ended = ?2 WHERE id =
        (SELECT id FROM deploys WHERE monitor = ?1 AND ended IS NULL ORDER BY started DESC LIMIT 1)`,
    )
    .bind(monitor, ts);

/** The open deploy a service is reporting, if it has one. */
export const openDeployFor = (db: D1Database, monitor: string) =>
  db
    .prepare(
      `SELECT monitor, version, started, ended, source FROM deploys
       WHERE monitor = ?1 AND ended IS NULL ORDER BY started DESC LIMIT 1`,
    )
    .bind(monitor)
    .first<DeployRow>();

/** The most recent deploy per monitor, which is the only one a tick asks about. */
export async function latestDeploys(db: D1Database): Promise<Record<string, DeployRow>> {
  const { results } = await db
    .prepare(
      `SELECT d.monitor, d.version, d.started, d.ended, d.source FROM deploys d
       JOIN (SELECT monitor, MAX(started) AS started FROM deploys GROUP BY monitor) m
         ON m.monitor = d.monitor AND m.started = d.started`,
    )
    .all<DeployRow>();
  return Object.fromEntries((results ?? []).map((r) => [r.monitor, r]));
}

export async function recentDeploys(db: D1Database, limit = 20): Promise<DeployRow[]> {
  const { results } = await db
    .prepare(
      'SELECT monitor, version, started, ended, source FROM deploys ORDER BY started DESC LIMIT ?1',
    )
    .bind(limit)
    .all<DeployRow>();
  return results ?? [];
}

export const touchTokenStmt = (db: D1Database, name: string, ts: number) =>
  db.prepare('UPDATE tokens SET last_used = ?2 WHERE name = ?1').bind(name, ts);

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
  /** The version being deployed when this started, if one was. Correlation —
   *  the page says "during", never "because of". */
  deploy: string | null;
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
    db.prepare('DELETE FROM deploys WHERE started < ?1').bind(cutoff),
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
    ['state', 'beats', 'daily', 'incidents', 'deploys'].map((t) =>
      db.prepare(`DELETE FROM ${t} WHERE monitor NOT IN (${ph})`).bind(...knownIds),
    ),
  );
}
