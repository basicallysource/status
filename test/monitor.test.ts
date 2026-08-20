import { describe, expect, it } from 'vitest';
import { checkThresholds, fmtDuration, nextState, probeHeartbeat, probeHttp } from '../src/monitor';
import { overall, renderBoard } from '../src/board';
import { deployEvents, excused } from '../src/deploy';
import { alertText, worthAlerting } from '../src/notify';
import { MAINTENANCE_MAX_SEC } from '../src/config';
import { describeMeta } from '../src/index';
import type {
  HeartbeatMonitor,
  HttpMonitor,
  Monitor,
  Observation,
  StateRow,
  Transition,
} from '../src/types';

const mon: Monitor = { id: 'x', name: 'Balloon', kind: 'heartbeat' };

const state = (over: Partial<StateRow>): StateRow => ({
  monitor: 'x',
  status: 'up',
  since: 1000,
  fails: 0,
  last_ts: 1000,
  last_err: null,
  last_latency_ms: null,
  meta: null,
  ...over,
});

const bad: Observation = { ok: false, latencyMs: null, code: null, err: 'boom' };
const good: Observation = { ok: true, latencyMs: 12, code: 200, err: null };

describe('flap guard', () => {
  it('holds a healthy service up on a single failure', () => {
    const t = nextState(state({ status: 'up' }), bad, 2000);
    expect(t.status).toBe('up');
    expect(t.changed).toBe(false);
    expect(t.fails).toBe(1);
  });

  it('declares down on the second consecutive failure', () => {
    const t = nextState(state({ status: 'up', fails: 1 }), bad, 2000);
    expect(t.status).toBe('down');
    expect(t.changed).toBe(true);
    expect(t.since).toBe(2000);
  });

  it('does not wait when it has never seen the service healthy', () => {
    const t = nextState(undefined, bad, 2000);
    expect(t.status).toBe('down');
    expect(t.changed).toBe(true);
  });

  it('recovers immediately and resets the counter', () => {
    const t = nextState(state({ status: 'down', fails: 7, since: 1000 }), good, 2000);
    expect(t.status).toBe('up');
    expect(t.fails).toBe(0);
    expect(t.since).toBe(2000);
  });

  it('keeps `since` anchored while the status is unchanged', () => {
    const t = nextState(state({ status: 'up', since: 1000 }), good, 9999);
    expect(t.since).toBe(1000);
    expect(t.changed).toBe(false);
  });
});

describe('heartbeat', () => {
  const m: HeartbeatMonitor = {
    id: 'balloon',
    name: 'Balloon',
    kind: 'heartbeat',
    staleAfterSec: 600,
    thresholds: {
      disk_pct: { warn: 85, crit: 93 },
      gateway: { equals: 'connected' },
      service: { equals: 'active', level: 'down' },
    },
  };

  it('is down when silent past the window', () => {
    const o = probeHeartbeat(m, { ts: 1000, meta: null }, 1000 + 601);
    expect(o.ok).toBe(false);
    expect(o.err).toContain('silent');
  });

  it('is up when fresh and healthy', () => {
    const o = probeHeartbeat(m, { ts: 1000, meta: '{"disk_pct":40,"gateway":"connected"}' }, 1100);
    expect(o.ok).toBe(true);
    expect(o.degraded).toBeFalsy();
  });

  it('is degraded, not down, when a metric crosses the line', () => {
    const o = probeHeartbeat(m, { ts: 1000, meta: '{"disk_pct":94,"gateway":"connected"}' }, 1100);
    expect(o.ok).toBe(true);
    expect(o.degraded).toBe(true);
    expect(o.err).toContain('disk_pct at 94%');
  });

  it('catches a disconnected gateway even with a fresh beat', () => {
    const o = probeHeartbeat(m, { ts: 1000, meta: '{"gateway":"reconnecting"}' }, 1100);
    expect(o.degraded).toBe(true);
    expect(o.err).toContain('gateway is reconnecting');
  });

  it('calls a stopped service an outage, not merely degraded', () => {
    const o = probeHeartbeat(m, { ts: 1000, meta: '{"service":"inactive","disk_pct":10}' }, 1100);
    expect(o.ok).toBe(false);
    expect(o.degraded).toBeFalsy();
    expect(o.err).toContain('service is inactive');
  });

  it('still reports a healthy box while its service is down', () => {
    const o = probeHeartbeat(m, { ts: 1000, meta: '{"service":"inactive","disk_pct":94}' }, 1100);
    expect(o.ok).toBe(false);
    expect(o.err).toContain('disk_pct at 94%');
  });

  it('stays quiet about metrics it was not sent', () => {
    expect(checkThresholds(m, { disk_pct: 10 })).toEqual([]);
    expect(checkThresholds(m, null)).toEqual([]);
  });
});

describe('probeHttp', () => {
  const m: HttpMonitor = { id: 'h', name: 'H', kind: 'http', url: 'https://x.test/', timeoutMs: 50 };

  it('fails a body that does not contain what it must', async () => {
    const f = (async () => new Response('nope', { status: 200 })) as unknown as typeof fetch;
    const o = await probeHttp({ ...m, expectBody: '"ok":true' }, f);
    expect(o.ok).toBe(false);
    expect(o.err).toContain('body missing');
  });

  it('passes a body that does', async () => {
    const f = (async () => new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch;
    const o = await probeHttp({ ...m, expectBody: '"ok":true' }, f);
    expect(o.ok).toBe(true);
  });

  it('reports the code on a 5xx', async () => {
    const f = (async () => new Response('bad gateway', { status: 502 })) as unknown as typeof fetch;
    const o = await probeHttp(m, f);
    expect(o.ok).toBe(false);
    expect(o.code).toBe(502);
    expect(o.err).toBe('HTTP 502');
  });

  it('treats a hang as down rather than waiting forever', async () => {
    const f = ((_u: string, init: RequestInit) =>
      new Promise((_res, rej) => {
        init.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      })) as unknown as typeof fetch;
    const o = await probeHttp(m, f);
    expect(o.ok).toBe(false);
    expect(o.err).toContain('timed out');
  });
});

describe('board', () => {
  it('reports the worst status present', () => {
    expect(overall([{ status: 'up' }, { status: 'degraded' }])).toBe('degraded');
    expect(overall([{ status: 'degraded' }, { status: 'down' }])).toBe('down');
    expect(overall([{ status: 'up' }, { status: 'up' }])).toBe('up');
  });

  it('renders a line per service without a clock in it', () => {
    const out = renderBoard(
      [{ name: 'Hive', status: 'down', since: 940, detail: 'HTTP 502', uptime: 99.1 }],
      1000,
    );
    expect(out).toContain('Hive');
    expect(out).toContain('HTTP 502');
    expect(out).toContain('99.10% 90d');
    expect(out).toContain('1m');
  });
});

describe('fmtDuration', () => {
  it('reads the way a person would say it', () => {
    expect(fmtDuration(45)).toBe('45s');
    expect(fmtDuration(600)).toBe('10m');
    expect(fmtDuration(3600)).toBe('1h');
    expect(fmtDuration(3660)).toBe('1h 1m');
    expect(fmtDuration(90000)).toBe('1d 1h');
  });
});

describe('describeMeta', () => {
  it('renders a heartbeat’s metrics readably', () => {
    expect(describeMeta({ service: 'active', disk_pct: 55 })).toBe('service active · disk 55%');
  });

  it('phrases the deploy keys as English', () => {
    expect(describeMeta({ version: 'r1', deploying: 'r2' })).toBe('on r1 · deploying r2');
  });

  it('is null when there is nothing to say', () => {
    expect(describeMeta(null)).toBeNull();
    expect(describeMeta({})).toBeNull();
  });
});

describe('deploy events', () => {
  it('opens a window when a service starts reporting one', () => {
    expect(deployEvents({ version: 'r1' }, { version: 'r1', deploying: 'r2' })).toEqual([
      { kind: 'opened', version: 'r2' },
    ]);
  });

  it('closes it when the service stops reporting one', () => {
    expect(deployEvents({ version: 'r1', deploying: 'r2' }, { version: 'r2' })).toEqual([
      { kind: 'closed' },
    ]);
  });

  it('closes the old window before opening a different one', () => {
    expect(deployEvents({ deploying: 'r2' }, { deploying: 'r3' })).toEqual([
      { kind: 'closed' },
      { kind: 'opened', version: 'r3' },
    ]);
  });

  it('records a deploy that began and ended between two reports', () => {
    expect(deployEvents({ version: 'r1' }, { version: 'r2' })).toEqual([
      { kind: 'missed', version: 'r2' },
    ]);
  });

  it('does not call the first sighting of a version a deploy', () => {
    expect(deployEvents(null, { version: 'r1' })).toEqual([]);
    expect(deployEvents({}, { version: 'r1' })).toEqual([]);
  });

  it('treats an empty value as no claim at all', () => {
    expect(deployEvents({ deploying: 'r2' }, { deploying: '' })).toEqual([{ kind: 'closed' }]);
    expect(deployEvents({}, { deploying: '' })).toEqual([]);
  });

  it('stays quiet when nothing changed', () => {
    const same = { version: 'r1', deploying: 'r2' };
    expect(deployEvents(same, { ...same })).toEqual([]);
  });
});

describe('what a declared deploy may excuse', () => {
  const beat = { stale: false };
  const done = (ended: number) => ({ monitor: 'x', version: 'r2', started: ended - 30, ended });

  it('excuses a failure while the deploy is being reported', () => {
    expect(excused({ deploying: 'r2' }, undefined, beat, 5000)).toBe(true);
  });

  it('keeps excusing briefly after the deploy finishes', () => {
    expect(excused({ version: 'r2' }, done(4990), beat, 5000)).toBe(true);
  });

  it('stops once the grace is spent', () => {
    expect(excused({ version: 'r2' }, done(4000), beat, 5000)).toBe(false);
  });

  it('never excuses silence — a box that died mid-deploy is the worst case', () => {
    expect(excused({ deploying: 'r2' }, undefined, { stale: true }, 5000)).toBe(false);
  });

  it('excuses nothing when no deploy was ever reported', () => {
    expect(excused({ version: 'r2' }, undefined, beat, 5000)).toBe(false);
  });
});

describe('maintenance is time-boxed', () => {
  it('holds a deploying service out of the outage list', () => {
    const t = nextState(state({ status: 'up', fails: 1 }), bad, 2000, true);
    expect(t.status).toBe('maintenance');
    expect(t.changed).toBe(true);
  });

  it('gives up on the excuse and calls it down', () => {
    const began = 2000;
    const t = nextState(
      state({ status: 'maintenance', since: began, fails: 5 }),
      bad,
      began + MAINTENANCE_MAX_SEC,
      true,
    );
    expect(t.status).toBe('down');
    expect(t.changed).toBe(true);
    // The outage is dated from when we started excusing it, not from now.
    expect(t.prevSince).toBe(began);
  });

  it('still calls it down one second before the cap', () => {
    const t = nextState(
      state({ status: 'maintenance', since: 2000, fails: 5 }),
      bad,
      2000 + MAINTENANCE_MAX_SEC - 1,
      true,
    );
    expect(t.status).toBe('maintenance');
  });

  it('does not launder an outage that was already in progress', () => {
    const t = nextState(state({ status: 'down', since: 1000, fails: 9 }), bad, 2000, true);
    expect(t.status).toBe('down');
  });

  it('does not hide a degraded metric — a disk fills up during deploys too', () => {
    const warn: Observation = { ok: true, degraded: true, latencyMs: null, code: null, err: 'disk at 90%' };
    const t = nextState(state({ status: 'up' }), warn, 2000, true);
    expect(t.status).toBe('degraded');
  });

  it('recovers straight to up when the deploy lands', () => {
    const t = nextState(state({ status: 'maintenance', since: 2000 }), good, 2100);
    expect(t.status).toBe('up');
    expect(t.changed).toBe(true);
  });
});

describe('what is worth waking someone for', () => {
  const t = (over: Partial<Transition>): Transition => ({
    status: 'down',
    since: 2000,
    prevSince: 1000,
    fails: 2,
    changed: true,
    prevStatus: 'up',
    ...over,
  });

  it('says nothing about a routine deploy, in either direction', () => {
    expect(worthAlerting(t({ status: 'maintenance' }))).toBe(false);
    expect(worthAlerting(t({ status: 'up', prevStatus: 'maintenance' }))).toBe(false);
  });

  it('shouts when a deploy overruns', () => {
    const over = t({ status: 'down', prevStatus: 'maintenance' });
    expect(worthAlerting(over)).toBe(true);
    expect(alertText(mon, over, bad, 2500).title).toContain('overrun');
  });

  it('still reports an ordinary outage and an ordinary recovery', () => {
    expect(worthAlerting(t({}))).toBe(true);
    expect(worthAlerting(t({ status: 'up', prevStatus: 'down' }))).toBe(true);
  });

  it('measures a recovery against the outage, not against the recovery', () => {
    const back = t({ status: 'up', prevStatus: 'down', since: 2000, prevSince: 1400 });
    expect(alertText(mon, back, good, 2000).body).toContain('10m');
  });
});
