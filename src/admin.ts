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

export function renderAdmin(): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Boxes · basically</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg?s=up">
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
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:10px;margin-top:14px}
.chart{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px 8px}
.chart h3{margin:0;font-size:12.5px;font-weight:600}
.now{float:right;font-variant-numeric:tabular-nums;color:var(--muted);font-weight:500}
svg{display:block;width:100%;height:78px;margin-top:6px;overflow:visible}
.axis{fill:var(--muted);font-size:9px}
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
    <div class="grid">\${PANELS.map((p) => panel(p, mine, marks, from, to)).join('')}</div>
    <p class="note">Deploy markers are every service's deploys, not just this box's.
      A metric with no line was not reported by this box.</p>\`;

  app.querySelectorAll('[data-host]').forEach((b) =>
    (b.onclick = () => { state.host = b.dataset.host; draw(hosts, deploys, range); }));
  app.querySelectorAll('[data-range]').forEach((b) =>
    (b.onclick = () => { state.range = +b.dataset.range; load(); }));
}

function panel(p, rows, marks, from, to) {
  const points = rows.filter((r) => typeof r[p.key] === 'number').map((r) => [r.ts, r[p.key]]);
  const latest = points.length ? points[points.length - 1][1] : null;
  const head = \`<h3>\${esc(p.title)}<span class="now">\${
    latest === null ? '—' : esc(fmt(latest)) + (p.unit ? ' ' + p.unit : '')}</span></h3>\`;
  if (points.length < 2) return \`<div class="chart">\${head}<svg viewBox="0 0 300 78"></svg></div>\`;

  const W = 300, H = 78, pad = 2;
  const values = points.map((q) => q[1]);
  let lo = Math.min(...values), hi = Math.max(...values);
  // A flat line should sit in the middle of its panel rather than be scaled up
  // into dramatic-looking noise, which is what a zero-height range would do.
  if (hi - lo < 1e-9) { hi = lo + 1; lo -= 1; }
  const x = (t) => pad + ((t - from) / Math.max(1, to - from)) * (W - pad * 2);
  const y = (v) => H - pad - ((v - lo) / (hi - lo)) * (H - pad * 2 - 10);

  const line = points.map((q, i) => (i ? 'L' : 'M') + x(q[0]).toFixed(1) + ' ' + y(q[1]).toFixed(1)).join(' ');
  const rules = marks.map((d) => {
    const px = x(d.started).toFixed(1);
    return \`<line x1="\${px}" x2="\${px}" y1="0" y2="\${H - pad}" stroke="var(--deploy)"
      stroke-width="1" stroke-dasharray="2 2" opacity="0.85"><title>\${
      esc(d.monitor + ' ' + d.version + ' · ' + new Date(d.started * 1000).toISOString().slice(0, 16).replace('T', ' '))
      }</title></line>\`;
  }).join('');

  return \`<div class="chart">\${head}
    <svg viewBox="0 0 \${W} \${H}" preserveAspectRatio="none">
      \${rules}
      <path d="\${line}" fill="none" stroke="var(--ink)" stroke-width="1.4"
        stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
      <text class="axis" x="0" y="\${H}">\${esc(fmt(lo))}</text>
      <text class="axis" x="\${W}" y="\${H}" text-anchor="end">\${esc(fmt(hi))}</text>
    </svg></div>\`;
}

function fmt(v) {
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (Math.abs(v) >= 1000) return (v / 1000).toFixed(1) + 'k';
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\\.?0+$/, '');
}

load();
</script>`;
}
