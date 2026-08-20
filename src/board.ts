import { SITE } from './config';
import { kvGet, kvSetStmt } from './db';
import { fmtDuration } from './monitor';
import { COLOR, ICON } from './notify';
import type { Env, Status } from './types';

export interface BoardRow {
  name: string;
  status: Status;
  since: number | null;
  detail: string;
  uptime: number;
}

const LABEL: Record<Status, string> = {
  up: 'Operational',
  degraded: 'Degraded',
  down: 'Outage',
  maintenance: 'Updating',
  unknown: 'No data',
};

export function overall(rows: { status: Status }[]): Status {
  if (rows.some((r) => r.status === 'down')) return 'down';
  if (rows.some((r) => r.status === 'degraded')) return 'degraded';
  // Below both, and above up: a service being updated is worth saying out loud,
  // but it is not a reason to paint the page as if something were wrong.
  if (rows.some((r) => r.status === 'maintenance')) return 'maintenance';
  if (rows.length && rows.every((r) => r.status === 'unknown')) return 'unknown';
  return 'up';
}

export function headline(status: Status): string {
  return status === 'up'
    ? 'All systems operational'
    : status === 'degraded'
      ? 'Degraded performance'
      : status === 'down'
        ? 'Active outage'
        : status === 'maintenance'
          ? 'Update in progress'
          : 'Waiting for first checks';
}

/** The page, as one Discord message. Deliberately excludes any clock so an
 *  unchanged status does not churn an edit every minute. */
export function renderBoard(rows: BoardRow[], nowSec: number): string {
  const lines = rows.map((r) => {
    const held = r.since ? ` · ${fmtDuration(nowSec - r.since)}` : '';
    const why = r.status === 'up' ? '' : r.detail ? ` — ${r.detail}` : '';
    return `${ICON[r.status]} **${r.name}** · ${LABEL[r.status]}${held}${why} · ${r.uptime.toFixed(2)}% 90d`;
  });
  return lines.join('\n');
}

async function send(env: Env, body: unknown, messageId: string | null): Promise<string | null> {
  const base = env.DISCORD_BOARD_WEBHOOK!;
  if (messageId) {
    const res = await fetch(`${base}/messages/${messageId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) return messageId;
    // 404/410 means someone deleted it; fall through and post a fresh one.
    if (res.status !== 404 && res.status !== 410) {
      throw new Error(`board edit ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  }
  const res = await fetch(`${base}?wait=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`board post ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { id?: string }).id ?? null;
}

/**
 * Mirrors the page into one Discord message, edited in place. Only when the
 * content actually changed — an unchanged board costs nothing.
 */
export async function syncBoard(env: Env, rows: BoardRow[], nowSec: number): Promise<'skipped' | 'synced'> {
  if (!env.DISCORD_BOARD_WEBHOOK) return 'skipped';

  const status = overall(rows);
  const description = renderBoard(rows, nowSec);
  const fingerprint = `${status}\n${rows.map((r) => `${r.name}:${r.status}`).join('|')}`;

  const [prev, messageId] = await Promise.all([
    kvGet(env.DB, 'board:fingerprint'),
    kvGet(env.DB, 'board:message'),
  ]);
  if (prev === fingerprint && messageId) return 'skipped';

  const body = {
    embeds: [
      {
        title: `${ICON[status]} ${headline(status)}`,
        description,
        color: COLOR[status],
        url: SITE.url,
        timestamp: new Date(nowSec * 1000).toISOString(),
        footer: { text: 'Updated when something changes · checked every minute' },
      },
    ],
  };

  const id = await send(env, body, messageId);
  const writes = [kvSetStmt(env.DB, 'board:fingerprint', fingerprint)];
  if (id && id !== messageId) writes.push(kvSetStmt(env.DB, 'board:message', id));
  await env.DB.batch(writes);
  return 'synced';
}
