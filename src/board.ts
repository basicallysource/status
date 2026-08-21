import { HISTORY_DAYS, SITE } from './config';
import { kvGet, kvSetStmt } from './db';
import { fmtDuration } from './monitor';
import { COLOR } from './notify';
import type { DayCell, PageData, PageIncident, PageMonitor } from './page';
import { Canvas, type RGBA } from './png';
import type { Env, Status } from './types';

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

// ------------------------------------------------------------------ the bars

/**
 * The page's own palette, dark-theme values.
 *
 * Discord has both themes and gives no way to know which the reader is in, so
 * the strip is drawn on TRANSPARENT and every colour has to survive either
 * background. The three status colours are saturated enough to. Grey is the
 * one that cannot: a light grey vanishes on white and a dark one vanishes on
 * black, so "no data" is a mid grey at partial alpha, which reads as absence
 * on both instead of as a colour on one.
 */
const BAR: Record<Status, RGBA> = {
  up: [70, 196, 110, 255],
  degraded: [240, 180, 41, 255],
  down: [242, 88, 91, 255],
  maintenance: [107, 138, 253, 255],
  unknown: [122, 122, 116, 115],
};

// Drawn at roughly twice the width Discord will show, so it lands as a retina
// image rather than a soft one. Proportions match the page: a thin gap, a
// slight round, a bar about seven times taller than it is wide.
const BAR_W = 8;
const BAR_GAP = 4;
const BAR_H = 56;
const BAR_R = 2;

export function stripSize(dayCount: number): { width: number; height: number } {
  return { width: Math.max(1, dayCount * (BAR_W + BAR_GAP) - BAR_GAP), height: BAR_H };
}

/** One service's history as a bar chart, PNG bytes. */
export async function uptimeStrip(days: DayCell[]): Promise<Uint8Array> {
  const { width, height } = stripSize(days.length);
  const canvas = new Canvas(width, height);
  days.forEach((d, i) => {
    canvas.fillRounded(i * (BAR_W + BAR_GAP), 0, BAR_W, height, BAR_R, BAR[d.status]);
  });
  return canvas.toPng();
}

// ------------------------------------------------------------------ the card

/** Discord component type ids. */
const TEXT = 10;
const GALLERY = 12;
const SEPARATOR = 14;
const CONTAINER = 17;
/** IS_COMPONENTS_V2. Without it Discord rejects `components` at top level. */
const V2_FLAG = 1 << 15;

/**
 * The board's shape, as a version string.
 *
 * A Discord message created with embeds CANNOT be edited into a components-v2
 * message — the API refuses the conversion — so a layout change of that kind
 * has to delete and repost rather than edit. This marker is how the worker
 * knows which kind of message it is holding an id for.
 */
const FORMAT = 'v2-1';

const text = (content: string) => ({ type: TEXT, content });
const separator = (spacing: 1 | 2 = 1) => ({ type: SEPARATOR, divider: true, spacing });

/**
 * One service, in the two lines the page gives it.
 *
 * The page can afford a legend under every chart — "90 days ago · 96.73 %
 * uptime · Today" — because it has the width. Discord does not, and three
 * lines per service turns four services into a wall. So the percentage joins
 * the status line, the description and the probe's own reading share the small
 * line, and the range is stated once in the footer instead of four times.
 */
export function serviceLines(m: PageMonitor): string {
  // "since 8 hours ago" rather than the page's "8h 26m", because that number
  // is computed once and this message may not be touched again for days.
  const held = m.since ? ` since ${ago(m.since)}` : '';
  const head = `**${m.name}** · ${LABEL[m.status]}${held} · ${m.uptime.toFixed(2)}%`;
  const sub = [m.description, m.detail].filter(Boolean).join(' · ');
  return sub ? `${head}\n-# ${sub}` : head;
}

const host = SITE.url.replace(/^https?:\/\//, '');

/**
 * The bottom message: the page, as a card.
 *
 * A components-v2 Container, not an embed, for one reason that matters — its
 * `accent_color` is the full-height bar down the side, which is the closest
 * Discord has to the page's banner. An embed's colour is the same stripe but
 * an embed cannot hold an image per row, and the bars are the point.
 */
export function statusCard(page: PageData, files: string[]) {
  const inner: unknown[] = [text(`## ${headline(page.overall)}`)];
  let group = '';
  page.monitors.forEach((m, i) => {
    if (m.group !== group) {
      group = m.group;
      inner.push(separator(2));
      inner.push(text(`### ${group}`));
    } else {
      inner.push(separator(1));
    }
    inner.push(text(serviceLines(m)));
    inner.push({ type: GALLERY, items: [{ media: { url: `attachment://${files[i]}` } }] });
  });
  inner.push(separator(2));
  inner.push(
    text(
      `-# Each bar is one day, ${HISTORY_DAYS} days to today · checked every minute · [${host}](${SITE.url})`,
    ),
  );
  return {
    flags: V2_FLAG,
    components: [{ type: CONTAINER, accent_color: COLOR[page.overall], components: inner }],
  };
}

/**
 * Discord's own timestamp markup. `f` is the reader's local date and time in
 * their locale, `R` is "8 hours ago".
 *
 * Two reasons this beats the UTC string the page prints. The page has one
 * reader at a time looking at a clock; a channel has everyone, in their own
 * zones, and nobody should have to convert. And these RE-RENDER on the
 * reader's client every time they look, which matters more here than anywhere
 * else: the board is only redrawn when something CHANGES, so any duration
 * baked into the text at render time would be wrong for however long the
 * status held. A relative stamp is the one kind of clock that stays right in a
 * message nobody is editing.
 */
const at = (ts: number) => `<t:${Math.floor(ts)}:f>`;
const ago = (ts: number) => `<t:${Math.floor(ts)}:R>`;

/**
 * The message ABOVE the card: what has actually gone wrong lately.
 *
 * Its own message, and posted first so it sits above, because the two answer
 * different questions and change on different clocks. "Is it up right now" is
 * the thing someone scrolls to the bottom for, so it has to be the last
 * message in the channel; "what happened this month" is history and belongs
 * over it.
 */
export function incidentLines(incidents: PageIncident[], limit = 6): string[] {
  return incidents.slice(0, limit).map((i) => {
    // "for 1m" while it is running would be a number that is already wrong by
    // the time anyone reads it, and this message is only redrawn on a change.
    // A span, so it stays a duration — Discord has markup for instants only.
    const lasted = i.ended ? `for ${fmtDuration(i.ended - i.started)}` : '— ongoing';
    const during = i.duringUpdate ? ' · during an update' : '';
    return `**${i.name}** — ${LABEL[i.status]} ${lasted}\n-# ${at(i.started)} · ${ago(i.started)}${i.detail ? ` · ${i.detail}` : ''}${during}`;
  });
}

function incidentCard(page: PageData) {
  const lines = incidentLines(page.incidents);
  const body = lines.length
    ? lines.join('\n')
    : `-# Nothing recorded in the last ${HISTORY_DAYS} days.`;
  return {
    flags: V2_FLAG,
    components: [
      {
        // Deliberately not the overall status colour. This message is history,
        // and painting it red because something is down right now would say
        // the past went wrong too.
        type: CONTAINER,
        accent_color: COLOR.unknown,
        components: [text('### Recent incidents'), separator(1), text(body)],
      },
    ],
  };
}

// ------------------------------------------------------------------ delivery

async function sendMultipart(
  url: string,
  method: 'POST' | 'PATCH',
  payload: unknown,
  files: { name: string; bytes: Uint8Array }[],
): Promise<Response> {
  const form = new FormData();
  form.append(
    'payload_json',
    JSON.stringify({
      ...(payload as object),
      // On an edit this list REPLACES what the message carries. Sending it
      // every time is what keeps a stale strip from surviving a redraw.
      attachments: files.map((f, i) => ({ id: i, filename: f.name })),
    }),
  );
  files.forEach((f, i) => {
    form.append(`files[${i}]`, new Blob([f.bytes], { type: 'image/png' }), f.name);
  });
  return fetch(url, { method, body: form });
}

/** Returns the message id, or null if Discord would not give one back. */
async function postMessage(
  webhook: string,
  payload: unknown,
  files: { name: string; bytes: Uint8Array }[],
): Promise<string | null> {
  const res = await sendMultipart(`${webhook}?wait=true`, 'POST', payload, files);
  if (!res.ok) throw new Error(`board post ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { id?: string }).id ?? null;
}

/** True if the edit landed. False means the message is gone and must be reposted. */
async function editMessage(
  webhook: string,
  id: string,
  payload: unknown,
  files: { name: string; bytes: Uint8Array }[],
): Promise<boolean> {
  const res = await sendMultipart(`${webhook}/messages/${id}`, 'PATCH', payload, files);
  if (res.ok) return true;
  if (res.status === 404 || res.status === 410) return false;
  throw new Error(`board edit ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function deleteMessage(webhook: string, id: string): Promise<void> {
  await fetch(`${webhook}/messages/${id}`, { method: 'DELETE' }).catch(() => undefined);
}

/**
 * Everything that decides whether the card needs redrawing.
 *
 * Not the rendered card: durations and uptimes move every minute and would
 * force an edit every minute, which is the cost this exists to avoid. Not
 * status alone either — the bars are half the card, so a day-cell changing
 * colour has to count, and so does a change to the LAYOUT, which is why one
 * row rendered at a fixed instant is folded in. Without that last part an edit
 * to this file reaches the card only the next time something breaks.
 */
const LAYOUT_PROBE = JSON.stringify([
  statusCard(
    {
      now: 0,
      overall: 'up',
      monitors: [
        {
          name: 'probe',
          group: 'probe',
          description: 'probe',
          status: 'up',
          since: 0,
          detail: 'probe',
          uptime: 100,
          days: [],
        },
      ],
      incidents: [],
      deploys: [],
    },
    ['probe.png'],
  ),
  incidentCard({
    now: 0,
    overall: 'up',
    monitors: [],
    incidents: [{ name: 'probe', status: 'down', started: 0, ended: 60, detail: 'probe', duringUpdate: false }],
    deploys: [],
  }),
]);

export function boardFingerprint(page: PageData): string {
  const services = page.monitors
    .map(
      (m) =>
        `${m.group}/${m.name}:${m.status}:${m.detail}:${m.days.map((d) => d.status[0]).join('')}`,
    )
    .join('|');
  return [FORMAT, LAYOUT_PROBE, page.overall, services, incidentLines(page.incidents).join('|')].join(
    '\n',
  );
}

/**
 * Mirrors the page into two Discord messages, edited in place: incidents above,
 * live status below. Only when something actually changed.
 */
export async function syncBoard(env: Env, page: PageData): Promise<'skipped' | 'synced'> {
  const webhook = env.DISCORD_BOARD_WEBHOOK;
  if (!webhook) return 'skipped';

  const fingerprint = boardFingerprint(page);
  const [prev, format, incidentId, statusId] = await Promise.all([
    kvGet(env.DB, 'board:fingerprint'),
    kvGet(env.DB, 'board:format'),
    kvGet(env.DB, 'board:incidents'),
    kvGet(env.DB, 'board:message'),
  ]);
  if (prev === fingerprint && format === FORMAT && incidentId && statusId) return 'skipped';

  const files = await Promise.all(
    page.monitors.map(async (m, i) => ({
      name: `uptime-${i}.png`,
      bytes: await uptimeStrip(m.days),
    })),
  );
  const status = statusCard(page, files.map((f) => f.name));
  const incidents = incidentCard(page);

  // A message made of embeds cannot become a components-v2 message, so a
  // format change is a repost rather than an edit. Order is the reason both go
  // at once: the card has to end up BELOW, and the only way to guarantee that
  // is to post them in order into an empty slot.
  let ids: { incidents: string | null; status: string | null } = { incidents: incidentId, status: statusId };
  const stale = format !== FORMAT || !incidentId || !statusId;
  if (stale) {
    if (incidentId) await deleteMessage(webhook, incidentId);
    if (statusId) await deleteMessage(webhook, statusId);
    ids = { incidents: null, status: null };
  }

  if (ids.incidents && ids.status) {
    const ok =
      (await editMessage(webhook, ids.incidents, incidents, [])) &&
      (await editMessage(webhook, ids.status, status, files));
    if (!ok) {
      // One of them was deleted by hand. Clear both and fall through, so the
      // pair is reposted in the right order rather than leaving the card on top.
      await deleteMessage(webhook, ids.incidents);
      await deleteMessage(webhook, ids.status);
      ids = { incidents: null, status: null };
    }
  }

  if (!ids.incidents || !ids.status) {
    ids = {
      incidents: await postMessage(webhook, incidents, []),
      status: await postMessage(webhook, status, files),
    };
  }

  const writes = [
    kvSetStmt(env.DB, 'board:fingerprint', fingerprint),
    kvSetStmt(env.DB, 'board:format', FORMAT),
  ];
  if (ids.incidents) writes.push(kvSetStmt(env.DB, 'board:incidents', ids.incidents));
  if (ids.status) writes.push(kvSetStmt(env.DB, 'board:message', ids.status));
  await env.DB.batch(writes);
  return 'synced';
}
