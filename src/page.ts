import { HISTORY_DAYS, SITE } from './config';
import { headline } from './board';
import { fmtDuration } from './monitor';
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
  deploy: string | null;
}

export interface PageDeploy {
  name: string;
  version: string;
  started: number;
  ended: number | null;
  /** Null when nobody measured it — see the `source` column. */
  seconds: number | null;
  typical: number | null;
  slow: boolean;
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

const utc = (ts: number) => `${new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`;

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
      ${m.since ? `<div class="sub">${esc(fmtDuration(now - m.since))}</div>` : ''}
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
    <div class="sub">${esc(utc(i.started))}${i.detail ? ` · ${esc(i.detail)}` : ''}${
      // "during", never "because of". We know these coincided; we do not know
      // one caused the other, and a status page should not guess in public.
      i.deploy ? ` · during the ${esc(i.deploy)} update` : ''
    }</div>
  </div>
</li>`;

const deploy = (d: PageDeploy, now: number) => `
<li>
  <span class="pip ${d.ended === null ? 'maintenance' : 'up'}"></span>
  <div>
    <div><strong>${esc(d.name)}</strong> updated to ${esc(d.version)}${
      d.ended === null
        ? ` — <em>in progress, ${esc(fmtDuration(now - d.started))} so far</em>`
        : d.seconds !== null
          ? ` — took ${esc(fmtDuration(d.seconds))}`
          : ''
    }</div>
    <div class="sub">${esc(utc(d.started))}${
      // The comparison is the point of showing a number at all: 40s means
      // nothing on its own, and "40s, usually 15s" means something.
      d.slow && d.typical !== null ? ` · <span class="warn">usually ${esc(fmtDuration(d.typical))}</span>` : ''
    }</div>
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
@media(max-width:520px){main{padding:32px 16px 56px}.desc{display:none}}
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
    <span>Checked every minute · updated ${esc(utc(d.now))}</span>
    <span><a href="/api/status">JSON</a></span>
  </footer>
</main>
<script>
// Re-fetch this same page and swap <main>, rather than re-rendering client side:
// the server stays the only thing that knows how to draw a status.
(function () {
  var busy = false;
  async function refresh() {
    if (busy || document.hidden) return;
    busy = true;
    try {
      var res = await fetch('/', { cache: 'no-store' });
      if (!res.ok) return;
      var doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      var next = doc.querySelector('main');
      if (next) document.querySelector('main').replaceWith(next);
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
  setInterval(refresh, 30000);
  // Catch up immediately when the tab comes back, instead of showing something
  // stale until the next interval.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refresh();
  });
})();
</script>`;
}
