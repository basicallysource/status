import { describe, expect, it } from 'vitest';
import { checkThresholds, fmtDuration, nextState, probeHeartbeat, probeHttp } from '../src/monitor';
import { overall, renderBoard } from '../src/board';
import { describeMeta } from '../src/index';
import type { HeartbeatMonitor, HttpMonitor, Observation, StateRow } from '../src/types';

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

  it('is null when there is nothing to say', () => {
    expect(describeMeta(null)).toBeNull();
    expect(describeMeta({})).toBeNull();
  });
});
