import { ANALYTICS, HISTORY_DAYS, SITE } from './config';
import { headline } from './board';
import { fmtDuration } from './monitor';
import { relativeTime, utcTime } from './time';
import type { Status } from './types';

export interface DayCell {
  day: string;
  up: number;
  down: number;
  total: number;
  pct: number;
  status: Status;
}

export interface PageMonitor {
  name: string;
  group: string;
  description?: string;
  status: Status;
  since: number | null;
  detail: string;
  uptime: number;
  days: DayCell[];
}

export interface PageIncident {
  name: string;
  status: Status;
  started: number;
  ended: number | null;
  detail: string | null;
  duringUpdate: boolean;
}

/**
 * An update, as the public sees one: that it happened and when.
 *
 * No version and no duration. Both are recorded and both are ours; a reader
 * here wants to know why the bars have a notch in them. See publish.ts.
 */
export interface PageDeploy {
  name: string;
  started: number;
  ended: number | null;
}

export interface PageData {
  now: number;
  overall: Status;
  monitors: PageMonitor[];
  incidents: PageIncident[];
  deploys: PageDeploy[];
}

const LABEL: Record<Status, string> = {
  up: 'Operational',
  degraded: 'Degraded',
  down: 'Outage',
  maintenance: 'Updating',
  unknown: 'No data',
};

const esc = (s: unknown): string =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

const timestamp = (ts: number, now: number): string => {
  const whole = Math.floor(ts);
  return `<time class="stamp" datetime="${new Date(whole * 1000).toISOString()}" data-ts="${whole}">
    <span>UTC: ${esc(utcTime(whole))}</span><span class="time-sep"> · </span>
    <span data-local>Your time: loading…</span><span class="time-sep"> · </span>
    <span data-relative>${esc(relativeTime(whole, now))}</span>
  </time>`;
};

const bar = (d: DayCell) =>
  `<i class="b ${d.status}" title="${esc(
    d.total ? `${d.day}: ${d.pct.toFixed(2)}% up (${d.up}/${d.total})` : `${d.day}: no data`,
  )}"></i>`;

const row = (m: PageMonitor, now: number) => `
<section class="card">
  <div class="head">
    <div>
      <div class="name">${esc(m.name)}</div>
      ${m.description ? `<div class="desc">${esc(m.description)}</div>` : ''}
    </div>
    <div class="right">
      <div class="${m.status}">${LABEL[m.status]}</div>
      ${m.since ? `<div class="sub state-time">Since ${timestamp(m.since, now)}</div>` : ''}
    </div>
  </div>
  <div class="bars">${m.days.map(bar).join('')}</div>
  <div class="legend">
    <span>${HISTORY_DAYS} days ago</span>
    <span>${m.uptime.toFixed(2)} % uptime</span>
    <span>Today</span>
  </div>
  ${
    m.detail
      ? `<div class="detail ${m.status === 'down' || m.status === 'degraded' ? 'bad' : ''}">${esc(
          m.detail,
        )}</div>`
      : ''
  }
</section>`;

const incident = (i: PageIncident, now: number) => `
<li>
  <span class="pip ${i.status}"></span>
  <div>
    <div><strong>${esc(i.name)}</strong> — ${LABEL[i.status]} for ${esc(
      fmtDuration((i.ended ?? now) - i.started),
    )}${i.ended ? '' : ' <em>(ongoing)</em>'}</div>
    <div class="sub event-time">Started ${timestamp(i.started, now)}</div>
    ${i.ended ? `<div class="sub event-time">Ended ${timestamp(i.ended, now)}</div>` : ''}
    ${
      i.detail || i.duringUpdate
        ? `<div class="sub">${i.detail ? esc(i.detail) : ''}${
            i.detail && i.duringUpdate ? ' · ' : ''
          }${i.duringUpdate ? 'during an update' : ''}</div>`
        : ''
    }
  </div>
</li>`;

const deploy = (d: PageDeploy, now: number) => `
<li>
  <span class="pip ${d.ended === null ? 'maintenance' : 'up'}"></span>
  <div>
    <div><strong>${esc(d.name)}</strong> was updated${
      d.ended === null ? ' — <em>in progress</em>' : ''
    }</div>
    <div class="sub event-time">${d.ended === null ? 'Started' : 'Updated'} ${timestamp(d.started, now)}</div>
  </div>
</li>`;

/** The tab has to say what is wrong without being read. */
function pageTitle(overall: Status): string {
  const prefix =
    overall === 'down'
      ? 'Outage · '
      : overall === 'degraded'
        ? 'Degraded · '
        : overall === 'maintenance'
          ? 'Updating · '
          : '';
  return `${prefix}${SITE.title}`;
}

export function renderPage(d: PageData): string {
  const groups = new Map<string, PageMonitor[]>();
  for (const m of d.monitors) groups.set(m.group, [...(groups.get(m.group) ?? []), m]);

  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(pageTitle(d.overall))}</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg?s=${esc(d.overall)}">
${ANALYTICS}
<style>
:root{--bg:#fbfbfa;--card:#fff;--fg:#1a1a19;--muted:#6f6f6b;--line:#e7e6e3;
  --up:#3ba55d;--degraded:#e6a817;--down:#ed4245;--maintenance:#4c6ef5;--unknown:#cbcac6}
@media(prefers-color-scheme:dark){:root{--bg:#131312;--card:#1c1c1a;--fg:#eee;--muted:#9a9a95;
  --line:#2e2e2b;--up:#46c46e;--degraded:#f0b429;--down:#f2585b;--maintenance:#6b8afd;
  --unknown:#46463f}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,-apple-system,
  "Segoe UI",Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:800px;margin:0 auto;padding:48px 20px 72px}
h1{font-size:19px;font-weight:600;margin:0 0 24px}
/* No uppercase transform: the group names carry their own casing, and
   "basically" is lowercase on purpose. */
h2{font-size:12px;font-weight:600;letter-spacing:.04em;
  color:var(--muted);margin:32px 0 10px}
.banner{padding:16px 20px;border-radius:10px;font-weight:600;color:#fff;margin-bottom:28px}
.banner.up{background:var(--up)}.banner.degraded{background:var(--degraded)}
.banner.down{background:var(--down)}.banner.unknown{background:var(--unknown)}
.banner.maintenance{background:var(--maintenance)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;
  padding:16px 18px;margin-bottom:10px}
.head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
.name{font-weight:550}
.desc,.sub{color:var(--muted);font-size:12.5px}
.right{text-align:right;flex:none;font-size:13px;font-weight:550}
.state-time{max-width:430px;font-weight:400}
.stamp{font-variant-numeric:tabular-nums}
.event-time+.event-time{margin-top:2px}
/* Scoped to .right on purpose: a bare .up would also repaint the banner's
   white text green, on a green background. */
.right .up{color:var(--up)}.right .degraded{color:var(--degraded)}
.right .down{color:var(--down)}.right .unknown{color:var(--muted)}
.right .maintenance{color:var(--maintenance)}
.bars{display:flex;gap:2px;height:30px;margin:14px 0 6px}
.b{flex:1;min-width:2px;border-radius:2px;background:var(--unknown)}
.b.up{background:var(--up)}.b.degraded{background:var(--degraded)}.b.down{background:var(--down)}
.b.unknown{opacity:.45}
.legend{display:flex;justify-content:space-between;color:var(--muted);font-size:12px;
  font-variant-numeric:tabular-nums}
.detail{margin-top:12px;padding-top:12px;border-top:1px solid var(--line);
  color:var(--muted);font-size:13px}
.detail.bad{color:var(--down)}
ul{list-style:none;padding:0;margin:0}
li{display:flex;gap:10px;background:var(--card);border:1px solid var(--line);
  border-radius:10px;padding:13px 18px;margin-bottom:8px;font-size:14px}
.pip{width:8px;height:8px;border-radius:50%;flex:none;margin-top:7px;background:var(--unknown)}
.pip.up{background:var(--up)}.pip.degraded{background:var(--degraded)}.pip.down{background:var(--down)}
.pip.maintenance{background:var(--maintenance)}
.warn{color:var(--degraded)}
footer{margin-top:36px;color:var(--muted);font-size:12px;display:flex;
  justify-content:space-between;gap:12px;flex-wrap:wrap}
a{color:inherit}
@media(max-width:520px){main{padding:32px 16px 56px}.desc{display:none}
  .head{display:block}.right{text-align:left;margin-top:8px}.state-time{max-width:none}}
</style>
<main>
  <h1>${esc(SITE.title)}</h1>
  <div class="banner ${d.overall}">${esc(headline(d.overall))}</div>
  ${[...groups]
    .map(([g, ms]) => `<h2>${esc(g)}</h2>${ms.map((m) => row(m, d.now)).join('')}`)
    .join('')}
  <h2>Past incidents</h2>
  ${
    d.incidents.length
      ? `<ul>${d.incidents.map((i) => incident(i, d.now)).join('')}</ul>`
      : `<p class="sub">No incidents recorded.</p>`
  }
  ${
    d.deploys.length
      ? `<h2>Recent updates</h2><ul>${d.deploys
          .slice(0, 8)
          .map((x) => deploy(x, d.now))
          .join('')}</ul>`
      : ''
  }
  <footer>
    <span>Checked every minute · updated ${timestamp(d.now, d.now)}</span>
    <span><a href="/api/status">JSON</a></span>
  </footer>
</main>
<script>
// Re-fetch this same page and swap <main>, rather than re-rendering client side:
// the server stays the only thing that knows how to draw a status.
(function () {
  var busy = false;
  function relative(ts) {
    var delta = Math.round(Date.now() / 1000 - ts);
    var seconds = Math.abs(delta);
    if (seconds < 5) return 'just now';
    var units = [['year', 31536000], ['month', 2592000], ['day', 86400],
      ['hour', 3600], ['minute', 60], ['second', 1]];
    var parts = [], left = seconds;
    for (var i = 0; i < units.length; i++) {
      var name = units[i][0], size = units[i][1], count = Math.floor(left / size);
      if (!count && !parts.length) continue;
      if (count) {
        parts.push(count + ' ' + name + (count === 1 ? '' : 's'));
        left -= count * size;
      }
      if (parts.length === 2) break;
    }
    var said = parts.join(' ') || 'less than a second';
    return delta >= 0 ? said + ' ago' : 'in ' + said;
  }
  function hydrateTimes(root) {
    root.querySelectorAll('time[data-ts]').forEach(function (node) {
      var ts = Number(node.dataset.ts);
      var local = new Date(ts * 1000).toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric',
        minute: '2-digit', timeZoneName: 'short'
      });
      node.querySelector('[data-local]').textContent = 'Your time: ' + local;
      node.querySelector('[data-relative]').textContent = relative(ts);
    });
  }
  async function refresh() {
    if (busy || document.hidden) return;
    busy = true;
    try {
      var res = await fetch('/', { cache: 'no-store' });
      if (!res.ok) return;
      var doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      var next = doc.querySelector('main');
      if (next) {
        document.querySelector('main').replaceWith(next);
        hydrateTimes(document);
      }
      if (doc.title) document.title = doc.title;
      var from = doc.querySelector('link[rel="icon"]');
      var to = document.querySelector('link[rel="icon"]');
      // Replace the node rather than setting href: some browsers ignore a
      // mutated favicon href and keep painting the old icon.
      if (from && to && from.getAttribute('href') !== to.getAttribute('href')) {
        to.remove();
        document.head.appendChild(from.cloneNode(true));
      }
    } catch (e) {
      /* a failed refresh just leaves the last good render up */
    } finally {
      busy = false;
    }
  }
  hydrateTimes(document);
  setInterval(refresh, 30000);
  setInterval(function () { hydrateTimes(document); }, 30000);
  // Catch up immediately when the tab comes back, instead of showing something
  // stale until the next interval.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refresh();
  });
})();
</script>`;
}
