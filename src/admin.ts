/**
 * The operator view: everything the public page deliberately does not say.
 *
 * This is the other half of the split in publish.ts. That file is a closed
 * vocabulary because a stranger reads it; this one draws every number we have,
 * because the person reading it is the person on call.
 *
 * The shell below carries no data. It is fetched without a credential, asks for
 * one, keeps it in localStorage, and calls the same operator APIs a terminal
 * would — so there is no second authentication path to get wrong, and no
 * session state on the server. If Cloudflare Access is ever put in front of
 * /admin, the token prompt simply stops being reached; nothing here changes.
 *
 * Deploy markers are the point of drawing any of this. "CPU has been climbing
 * since June" is only useful next to what was shipped in June.
 */

import { ANALYTICS } from './config';

export function renderAdmin(): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Boxes · basically</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg?s=up">
${ANALYTICS}
<style>
:root{--bg:#fbfbfa;--card:#fff;--fg:#1a1a19;--muted:#6f6f6b;--line:#e7e6e3;
  --ink:#4c6ef5;--warn:#e6a817;--bad:#ed4245;--deploy:#b197fc}
@media(prefers-color-scheme:dark){:root{--bg:#131312;--card:#1c1c1a;--fg:#eee;--muted:#9a9a95;
  --line:#2e2e2b;--ink:#6b8afd;--warn:#f0b429;--bad:#f2585b;--deploy:#9775fa}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
  font:14px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Inter,system-ui,sans-serif}
main{max-width:1200px;margin:0 auto;padding:32px 20px 64px}
h1{font-size:18px;font-weight:600;margin:0 0 4px}
.sub{color:var(--muted);font-size:12.5px}
.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:20px 0 8px}
button,select{font:inherit;color:inherit;background:var(--card);border:1px solid var(--line);
  border-radius:7px;padding:6px 11px;cursor:pointer}
button.on{background:var(--ink);border-color:var(--ink);color:#fff}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px;margin-top:14px}
.chart{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px 8px}
.chart h3{margin:0;font-size:12.5px;font-weight:600}
.now{float:right;font-variant-numeric:tabular-nums;color:var(--muted);font-weight:500}
svg{display:block;width:100%;height:auto;margin-top:4px}
.axis{fill:var(--muted);font-size:8px;font-variant-numeric:tabular-nums}
.frame{stroke:var(--line);stroke-width:1}
.mark{stroke:var(--deploy);stroke-width:1;stroke-dasharray:2 2;opacity:.9}
.cross{stroke:var(--muted);stroke-width:1;opacity:.6}
.cursor circle{fill:var(--ink)}
svg{cursor:crosshair}
/* Reserved whether or not the mouse is over it, so hovering does not shove
   every other card down the page. */
.read{margin:2px 0 0;height:16px;font-size:11.5px;color:var(--muted);
  font-variant-numeric:tabular-nums}
.empty{margin:14px 0 18px;font-size:12px;color:var(--muted)}
.note{color:var(--muted);font-size:12px;margin-top:10px}
.gate{max-width:440px;margin:80px auto;background:var(--card);border:1px solid var(--line);
  border-radius:10px;padding:22px}
input{font:inherit;width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:7px;
  background:var(--bg);color:inherit;margin:10px 0}
.bad{color:var(--bad)}
</style>
<main id="app"><p class="sub">Loading…</p></main>
<script>
const KEY = 'status-operator-token';
const app = document.getElementById('app');

// Ranges pair a window with how finely to sample it. A month drawn from every
// sample would be 43,000 points per box; the server thins to the stride, so a
// month costs about the same as a day.
const RANGES = [
  { label: '6h',  hours: 6,       stride: 60 },
  { label: '24h', hours: 24,      stride: 300 },
  { label: '7d',  hours: 24 * 7,  stride: 1800 },
  { label: '30d', hours: 24 * 30, stride: 7200 },
];

// Which metrics to draw, in the order an on-call person would want them. The
// first three are the ones no other tool here can answer.
const PANELS = [
  { key: 'psi_cpu_some',    title: 'CPU pressure',        unit: '%', hint: 'share of time work was stalled waiting for CPU' },
  { key: 'psi_memory_some', title: 'Memory pressure',     unit: '%' },
  { key: 'cpu_steal_pct',   title: 'CPU steal',           unit: '%', hint: 'time the hypervisor gave to another tenant' },
  { key: 'cpu_busy_pct',    title: 'CPU busy',            unit: '%' },
  { key: 'load1',           title: 'Load (1m)',           unit: '' },
  { key: 'mem_pct',         title: 'Memory used',         unit: '%' },
  { key: 'swap_pct',        title: 'Swap used',           unit: '%' },
  { key: 'disk_pct',        title: 'Disk used',           unit: '%' },
  { key: 'oom_kills',       title: 'OOM kills (total)',   unit: '' },
  { key: 'disk_busy_pct',   title: 'Disk busy',           unit: '%' },
  { key: 'net_rx_mb_s',     title: 'Network in',          unit: 'MB/s' },
  { key: 'net_tx_mb_s',     title: 'Network out',         unit: 'MB/s' },
  { key: 'ctxt_per_sec',    title: 'Context switches',    unit: '/s' },
  { key: 'major_faults',    title: 'Major faults (total)', unit: '' },
];

let state = { range: 1, host: null, token: localStorage.getItem(KEY) || '' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path) {
  const res = await fetch(path, { headers: { Authorization: 'Bearer ' + state.token } });
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function gate(message) {
  app.innerHTML = \`<div class="gate">
    <h1>Boxes</h1>
    <p class="sub">Operator credential required. It is kept in this browser only.</p>
    <input id="tok" type="password" placeholder="operator token" autocomplete="off">
    <button id="go">Open</button>
    \${message ? \`<p class="sub bad">\${esc(message)}</p>\` : ''}
  </div>\`;
  const save = () => {
    state.token = document.getElementById('tok').value.trim();
    if (!state.token) return;
    localStorage.setItem(KEY, state.token);
    load();
  };
  document.getElementById('go').onclick = save;
  document.getElementById('tok').onkeydown = (e) => { if (e.key === 'Enter') save(); };
}

async function load() {
  if (!state.token) return gate('');
  const r = RANGES[state.range];
  app.innerHTML = '<p class="sub">Loading…</p>';
  let hosts, deploys;
  try {
    [hosts, deploys] = await Promise.all([
      api(\`/api/hosts?hours=\${r.hours}&stride=\${r.stride}\`),
      api('/api/deploys'),
    ]);
  } catch (e) {
    if (String(e.message) === 'unauthorized') {
      localStorage.removeItem(KEY);
      state.token = '';
      return gate('That credential was refused.');
    }
    app.innerHTML = \`<p class="sub bad">\${esc(e.message)}</p>\`;
    return;
  }
  draw(hosts, deploys, r);
}

function draw(hosts, deploys, range) {
  // Oldest first: the API returns newest first because every other reader wants
  // "what is happening now", and a chart wants the opposite.
  const samples = (hosts.samples || []).slice().sort((a, b) => a.ts - b.ts);
  const names = [...new Set(samples.map((s) => s.host))].sort();
  if (!state.host || !names.includes(state.host)) state.host = names[0] || null;
  const mine = samples.filter((s) => s.host === state.host);

  const from = mine.length ? mine[0].ts : 0;
  const to = mine.length ? mine[mine.length - 1].ts : 1;
  const marks = (deploys.deploys || []).filter((d) => d.started >= from && d.started <= to);

  app.innerHTML = \`
    <h1>Boxes</h1>
    <p class="sub">Recorded and never public. \${mine.length} samples over \${range.label}\${
      marks.length ? \`, \${marks.length} deploy\${marks.length > 1 ? 's' : ''} marked\` : ''}.</p>
    <div class="bar">
      \${names.map((h) => \`<button data-host="\${esc(h)}" class="\${h === state.host ? 'on' : ''}">\${esc(h)}</button>\`).join('')}
      <span style="flex:1"></span>
      \${RANGES.map((x, i) => \`<button data-range="\${i}" class="\${i === state.range ? 'on' : ''}">\${x.label}</button>\`).join('')}
    </div>
    <div class="grid">\${PANELS.map((p, i) => panel(p, mine, marks, from, to, i)).join('')}</div>
    <p class="note">Times are local. Hover a chart to read the sample under the cursor.
      Dashed lines are deploys — every service's, not just this box's — and carry the
      version on hover.</p>\`;

  wireHover(PANELS.map((p) => mine.filter((r) => typeof r[p.key] === 'number')
    .map((r) => [r.ts, r[p.key]])), from, to, to - from);

  app.querySelectorAll('[data-host]').forEach((b) =>
    (b.onclick = () => { state.host = b.dataset.host; draw(hosts, deploys, range); }));
  app.querySelectorAll('[data-range]').forEach((b) =>
    (b.onclick = () => { state.range = +b.dataset.range; load(); }));
}

// A chart with axes you can read and a value you can hover.
//
// The version this replaced drew a bare line and put the y minimum and maximum
// in the bottom two corners, which is exactly where an x-axis label belongs —
// so it read as a time range and was not one. Time now has its own labelled
// axis along the bottom, values are labelled up the left, and moving the mouse
// over a chart reads out the sample under the cursor.
const M = { left: 40, right: 10, top: 8, bottom: 18 };
const W = 320, H = 132;
const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;

function panel(p, rows, marks, from, to, index) {
  const points = rows.filter((r) => typeof r[p.key] === 'number').map((r) => [r.ts, r[p.key]]);
  const latest = points.length ? points[points.length - 1][1] : null;
  const unit = p.unit ? ' ' + p.unit : '';
  const head = \`<h3>\${esc(p.title)}<span class="now">\${
    latest === null ? '—' : esc(fmt(latest)) + unit}</span></h3>\`;
  if (points.length < 2) {
    return \`<div class="chart">\${head}<p class="empty">not reported by this box</p></div>\`;
  }

  const values = points.map((q) => q[1]);
  const min = Math.min(...values), max = Math.max(...values);
  // A series that never moves gets a flat line across the middle and one label,
  // rather than an invented range that makes a constant look like it varies.
  const flat = max - min < 1e-9;
  const lo = flat ? min - 1 : min;
  const hi = flat ? max + 1 : max;

  const x = (t) => M.left + ((t - from) / Math.max(1, to - from)) * PLOT_W;
  const y = (v) => M.top + PLOT_H - ((v - lo) / (hi - lo)) * PLOT_H;

  const line = points.map((q, i) => (i ? 'L' : 'M') + x(q[0]).toFixed(1) + ' ' + y(q[1]).toFixed(1)).join(' ');
  const rules = marks.map((d) => {
    const px = x(d.started).toFixed(1);
    return \`<line class="mark" x1="\${px}" x2="\${px}" y1="\${M.top}" y2="\${M.top + PLOT_H}"><title>\${
      esc(d.monitor + ' ' + d.version + ' · ' + clock(d.started, to - from))}</title></line>\`;
  }).join('');

  // Value labels: high and low up the left, outside the plot, so they never sit
  // on top of the line the way corner labels did.
  const yLabels = flat
    ? \`<text class="axis" x="\${M.left - 5}" y="\${y(min) + 3}" text-anchor="end">\${esc(fmt(min))}</text>\`
    : [max, min].map((v) => \`<text class="axis" x="\${M.left - 5}" y="\${
        y(v) + (v === max ? 7 : 0)}" text-anchor="end">\${esc(fmt(v))}</text>\`).join('');

  const span = to - from;
  const xLabels = [0, 0.5, 1].map((f) => {
    const t = from + span * f;
    return \`<text class="axis" x="\${x(t).toFixed(1)}" y="\${H - 5}" text-anchor="\${
      f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}">\${esc(clock(t, span))}</text>\`;
  }).join('');

  return \`<div class="chart" data-panel="\${index}">\${head}
    <svg viewBox="0 0 \${W} \${H}">
      <line class="frame" x1="\${M.left}" x2="\${M.left + PLOT_W}" y1="\${M.top + PLOT_H}" y2="\${M.top + PLOT_H}"/>
      <line class="frame" x1="\${M.left}" x2="\${M.left}" y1="\${M.top}" y2="\${M.top + PLOT_H}"/>
      \${rules}
      <path d="\${line}" fill="none" stroke="var(--ink)" stroke-width="1.4" stroke-linejoin="round"/>
      \${yLabels}\${xLabels}
      <g class="cursor" style="display:none">
        <line class="cross" y1="\${M.top}" y2="\${M.top + PLOT_H}"/>
        <circle r="3"/>
      </g>
    </svg>
    <p class="read">&nbsp;</p></div>\`;
}

// Wires up hover for every chart. One listener per chart, reading from the
// series it was drawn with, so the number shown is the sample itself rather
// than something interpolated off the pixels.
function wireHover(series, from, to, span) {
  document.querySelectorAll('.chart[data-panel]').forEach((card) => {
    const idx = +card.dataset.panel;
    const p = PANELS[idx];
    const points = series[idx];
    if (!points || points.length < 2) return;
    const svg = card.querySelector('svg');
    const cursor = card.querySelector('.cursor');
    const readout = card.querySelector('.read');
    const values = points.map((q) => q[1]);
    const min = Math.min(...values), max = Math.max(...values);
    const flat = max - min < 1e-9;
    const lo = flat ? min - 1 : min, hi = flat ? max + 1 : max;

    const move = (ev) => {
      const box = svg.getBoundingClientRect();
      const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
      // Back out of the rendered pixels into viewBox units, then into a time.
      const vx = ((clientX - box.left) / box.width) * W;
      const t = from + ((vx - M.left) / PLOT_W) * (to - from);
      let best = points[0];
      for (const q of points) if (Math.abs(q[0] - t) < Math.abs(best[0] - t)) best = q;
      const px = M.left + ((best[0] - from) / Math.max(1, to - from)) * PLOT_W;
      const py = M.top + PLOT_H - ((best[1] - lo) / (hi - lo)) * PLOT_H;
      cursor.style.display = '';
      cursor.querySelector('line').setAttribute('x1', px);
      cursor.querySelector('line').setAttribute('x2', px);
      cursor.querySelector('circle').setAttribute('cx', px);
      cursor.querySelector('circle').setAttribute('cy', py);
      readout.textContent = fmt(best[1]) + (p.unit ? ' ' + p.unit : '') + '  ·  ' + clock(best[0], 0);
    };
    const leave = () => { cursor.style.display = 'none'; readout.innerHTML = '&nbsp;'; };
    svg.addEventListener('mousemove', move);
    svg.addEventListener('touchmove', move);
    svg.addEventListener('mouseleave', leave);
  });
}

// Local time, because the person reading this is trying to line an event up
// with their own day. A span of a week or more wants dates, not clock times;
// a span of zero is the hover readout, which wants both.
function clock(ts, span) {
  const d = new Date(ts * 1000);
  const hhmm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (span === 0) return date + ' ' + hhmm;
  return span >= 3 * 86400 ? date : hhmm;
}

function fmt(v) {
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (Math.abs(v) >= 1000) return (v / 1000).toFixed(1) + 'k';
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\\.?0+$/, '');
}

load();
</script>`;
}
