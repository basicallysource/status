import { describe, expect, it } from 'vitest';
import { checkThresholds, fmtDuration, nextState, probeHeartbeat, probeHttp } from '../src/monitor';
import { boardFingerprint, incidentLines, overall, statusCard } from '../src/board';
import type { DayCell, PageData } from '../src/page';

import { deployEvents, excused, isOpen, isSlow, typicalSeconds, type DeployRow } from '../src/deploy';
import { allowed } from '../src/auth';
import { alertText, worthAlerting } from '../src/notify';
import { DEPLOY_MAX_OPEN_SEC, MAINTENANCE_MAX_SEC } from '../src/config';
import { PUBLIC_NOTE, publicDetail } from '../src/publish';
import type {
  HeartbeatMonitor,
  HttpMonitor,
  Monitor,
  Observation,
  StateRow,
  Transition,
} from '../src/types';

/** A page with one service and ninety green days, for the board tests. */
function samplePage(status: 'up' | 'down'): PageData {
  const days: DayCell[] = Array.from({ length: 90 }, (_, i) => ({
    day: `2026-01-${i}`,
    up: 1,
    down: 0,
    total: 1,
    pct: 100,
    status: 'up',
  }));
  return {
    now: 1000,
    overall: status,
    monitors: [
      {
        name: 'Hive',
        group: 'Hive',
        description: 'Machine sync.',
        status,
        since: 940,
        detail: 'Responding in 110ms',
        uptime: 99.1,
        days,
      },
    ],
    incidents: [],
    deploys: [],
  };
}

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

  it('dates the held status with a stamp that keeps itself right', () => {
    // Baked "8h 26m" would be wrong for as long as the status held, and this
    // card is only redrawn on a change.
    expect(JSON.stringify(statusCard(samplePage('up'), ['a.png']))).toContain('since <t:940:R>');
  });

  it('says who, what state, and how long, without a clock in it', () => {
    const page = samplePage('down');
    const card = JSON.stringify(statusCard(page, ['a.png']));
    expect(card).toContain('Hive');
    expect(card).toContain('Outage');
    expect(card).toContain('· 99.10%');
    expect(card).toContain('Responding in 110ms');
  });

  it('links the page from inside the container', () => {
    // Not the embed footer it used to live in: Discord renders no markdown
    // there, so a link arrives as literal brackets.
    expect(JSON.stringify(statusCard(samplePage('up'), ['a.png']))).toContain(
      '[status.basically.website](https://status.basically.website)',
    );
  });

  it('carries one bar image per service', () => {
    const page = samplePage('up');
    const card = statusCard(page, ['uptime-0.png']) as any;
    const gallery = card.components[0].components.filter((c: any) => c.type === 12);
    expect(gallery).toHaveLength(page.monitors.length);
    expect(gallery[0].items[0].media.url).toBe('attachment://uptime-0.png');
  });

  it('redraws when a day cell changes colour, not only when a service does', () => {
    const a = samplePage('up');
    const b = samplePage('up');
    b.monitors[0]!.days[3]!.status = 'down';
    expect(boardFingerprint(a)).not.toBe(boardFingerprint(b));
  });

  it('does not redraw as time passes', () => {
    const a = samplePage('up');
    const b = { ...samplePage('up'), now: 999_999 };
    expect(boardFingerprint(a)).toBe(boardFingerprint(b));
  });

  it('words an incident the way the page does: what, how long, when', () => {
    const lines = incidentLines([
      {
        name: 'Hive API',
        status: 'down',
        started: 1_760_000_000,
        ended: 1_760_000_600,
        detail: 'Not responding',
        duringUpdate: true,
      },
    ]);
    // Discord markup, not a UTC string: the channel has readers in several
    // zones, and these re-render on their client so they never go stale in a
    // message that is only edited when something changes.
    expect(lines[0]).toBe(
      '**Hive API** — Outage for 10m\n-# <t:1760000000:f> · <t:1760000000:R> · Not responding · during an update',
    );
  });

  it('says ongoing rather than a duration that is wrong on arrival', () => {
    // The message is only redrawn on a change, so "for 3m" would sit there
    // being wrong for as long as the outage lasted.
    const lines = incidentLines([
      { name: 'Hive API', status: 'down', started: 1_760_000_000, ended: null, detail: null, duringUpdate: false },
    ]);
    expect(lines[0]).toContain('— ongoing');
    expect(lines[0]).not.toContain('for ');
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

describe('what the public is told', () => {
  // The property under test is what the page CANNOT say. A closed vocabulary is
  // only worth having if nothing routes around it, so these assert absence.
  it('says how the service behaves toward a caller, when that is known', () => {
    expect(publicDetail('up', 143)).toBe('Responding in 143ms');
  });

  it('tells a heartbeat’s user it is healthy, and none of its metrics', () => {
    const said = publicDetail('up', null);
    expect(said).toBe('Healthy');
    for (const leak of ['disk', '59', 'r2026', 'service', 'active']) {
      expect(said).not.toContain(leak);
    }
  });

  it('never names the metric that tripped, or its threshold', () => {
    const said = publicDetail('degraded', null);
    expect(said).toBe(PUBLIC_NOTE.degraded);
    expect(said).not.toMatch(/\d/);
    expect(said.toLowerCase()).not.toContain('disk');
  });

  it('has a sentence for every state, so nothing falls through to raw data', () => {
    for (const s of ['up', 'degraded', 'down', 'maintenance', 'unknown'] as const) {
      expect(PUBLIC_NOTE[s]).toBeTruthy();
    }
  });

  it('puts no number in any of them but a measured response time', () => {
    for (const note of Object.values(PUBLIC_NOTE)) expect(note).not.toMatch(/\d/);
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

  it('does not re-record a deploy the service already measured', () => {
    const measured: DeployRow = {
      monitor: 'x',
      version: 'r2',
      started: 100,
      ended: 118,
      source: 'reported',
    };
    // The heartbeat notices the version change a minute after the reporter
    // already timed it. Without this the page lists the same deploy twice.
    expect(deployEvents({ version: 'r1' }, { version: 'r2' }, measured)).toEqual([]);
    expect(deployEvents({ version: 'r1' }, { version: 'r1', deploying: 'r2' }, measured)).toEqual([]);
  });

  it('still infers a deploy the service did not report', () => {
    const measured: DeployRow = {
      monitor: 'x',
      version: 'r2',
      started: 100,
      ended: 118,
      source: 'reported',
    };
    expect(deployEvents({ version: 'r2' }, { version: 'r3' }, measured)).toEqual([
      { kind: 'missed', version: 'r3' },
    ]);
  });

  it('does not let an inferred row silence a later inference of itself', () => {
    const inferred: DeployRow = {
      monitor: 'x',
      version: 'r2',
      started: 100,
      ended: 100,
      source: 'observed',
    };
    expect(deployEvents({ version: 'r1' }, { version: 'r2' }, inferred)).toEqual([
      { kind: 'missed', version: 'r2' },
    ]);
  });
});

describe('what a declared deploy may excuse', () => {
  const beat = { stale: false };
  const done = (ended: number): DeployRow => ({
    monitor: 'x',
    version: 'r2',
    started: ended - 30,
    ended,
    source: 'reported',
  });

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

describe('deploy timing', () => {
  const d = (started: number, ended: number | null, source: DeployRow['source']): DeployRow => ({
    monitor: 'x',
    version: 'v',
    started,
    ended,
    source,
  });

  it('takes the median of measured deploys', () => {
    const rows = [d(0, 40, 'reported'), d(0, 10, 'reported'), d(0, 20, 'reported')];
    expect(typicalSeconds(rows)).toBe(20);
  });

  it('ignores inferred ones — their duration is how often we looked', () => {
    expect(typicalSeconds([d(0, 600, 'observed'), d(0, 10, 'reported')])).toBe(10);
    expect(typicalSeconds([d(0, 60, 'observed')])).toBeNull();
  });

  it('ignores deploys still running', () => {
    expect(typicalSeconds([d(0, null, 'reported')])).toBeNull();
  });

  it('calls a deploy slow only when it is both relatively and absolutely worse', () => {
    expect(isSlow(120, 30)).toBe(true);
    // Four times as long, but nine seconds is nobody's problem.
    expect(isSlow(12, 3)).toBe(false);
    expect(isSlow(50, 40)).toBe(false);
    expect(isSlow(500, null)).toBe(false);
  });

  it('stops treating an abandoned deploy as running', () => {
    expect(isOpen(d(1000, null, 'reported'), 1600)).toBe(true);
    expect(isOpen(d(1000, null, 'reported'), 1000 + DEPLOY_MAX_OPEN_SEC)).toBe(false);
  });
});

describe('who may report what', () => {
  it('honours a scope of specific services', () => {
    expect(allowed('["balloon"]', 'balloon')).toBe(true);
    expect(allowed('["balloon"]', 'hive')).toBe(false);
  });

  it('honours a wildcard', () => {
    expect(allowed('*', 'anything')).toBe(true);
  });

  it('fails shut on a scope it cannot read', () => {
    expect(allowed('balloon', 'balloon')).toBe(false);
    expect(allowed('', 'balloon')).toBe(false);
    expect(allowed('null', 'balloon')).toBe(false);
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
