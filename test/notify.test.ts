import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextState } from '../src/monitor';
import { sendAlert } from '../src/notify';
import type { Env, Monitor, Observation, StateRow, Transition } from '../src/types';

const MONITOR: Monitor = { id: 'example', name: 'Example', kind: 'heartbeat' };
const OBSERVATION: Observation = { ok: false, latencyMs: null, code: null, err: 'not answering' };
const TRANSITION: Transition = {
  status: 'down',
  prevStatus: 'up',
  since: 2000,
  prevSince: 1000,
  fails: 2,
  changed: true,
};
const ENV: Env = {
  DB: {} as D1Database,
  ADMIN_ALERT_URL: 'https://alerts.example.invalid/receiver',
  ADMIN_ALERT_TOKEN: 'test-credential',
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('operator alerts', () => {
  it('requests a time-sensitive outage with a stable transition ID and bounded delivery', async () => {
    const fetch_mock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch_mock);

    await sendAlert(ENV, MONITOR, TRANSITION, OBSERVATION, 2000);
    await sendAlert(ENV, MONITOR, TRANSITION, OBSERVATION, 2060);

    expect(fetch_mock).toHaveBeenCalledTimes(2);
    const [url, init] = fetch_mock.mock.calls[0];
    expect(url).toBe(ENV.ADMIN_ALERT_URL);
    expect(init.headers.authorization).toBe('Bearer test-credential');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body)).toEqual({
      title: 'Example is down',
      message: 'not answering',
      request_id: 'example:down:2000',
      urgency: 'time_sensitive',
    });
    expect(JSON.parse(fetch_mock.mock.calls[1][1].body).request_id).toBe('example:down:2000');
  });

  it('keeps subsequent failed polls quiet', async () => {
    const fetch_mock = vi.fn();
    vi.stubGlobal('fetch', fetch_mock);
    const state_row: StateRow = {
      monitor: MONITOR.id,
      status: 'down',
      since: 2000,
      fails: 2,
      last_ts: 2000,
      last_err: OBSERVATION.err,
      last_latency_ms: null,
      meta: null,
    };

    const transition = nextState(state_row, OBSERVATION, 2060);
    expect(transition.changed).toBe(false);
    await sendAlert(ENV, MONITOR, transition, OBSERVATION, 2060);
    expect(fetch_mock).not.toHaveBeenCalled();
  });

  it('reports degraded services with time-sensitive delivery', async () => {
    const fetch_mock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch_mock);
    await sendAlert(ENV, MONITOR, { ...TRANSITION, status: 'degraded' }, OBSERVATION, 2000);
    expect(JSON.parse(fetch_mock.mock.calls[0][1].body).urgency).toBe('time_sensitive');
  });

  it('reports recovery without interrupting and gives it a separate ID', async () => {
    const fetch_mock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch_mock);
    const transition: Transition = { ...TRANSITION, status: 'up', prevStatus: 'down', since: 2600 };
    await sendAlert(ENV, MONITOR, transition, OBSERVATION, 2600);
    await sendAlert(ENV, MONITOR, transition, OBSERVATION, 2660);
    expect(JSON.parse(fetch_mock.mock.calls[0][1].body)).toMatchObject({
      title: 'Example recovered',
      request_id: 'example:up:2600',
      urgency: 'normal',
    });
    expect(fetch_mock.mock.calls[1][1].body).toBe(fetch_mock.mock.calls[0][1].body);
  });

  it('suppresses routine maintenance but alerts when it overruns', async () => {
    const fetch_mock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch_mock);
    await sendAlert(ENV, MONITOR, { ...TRANSITION, status: 'maintenance' }, OBSERVATION, 2000);
    await sendAlert(
      ENV, MONITOR, { ...TRANSITION, status: 'up', prevStatus: 'maintenance' }, OBSERVATION, 2000,
    );
    expect(fetch_mock).not.toHaveBeenCalled();

    await sendAlert(ENV, MONITOR, { ...TRANSITION, prevStatus: 'maintenance' }, OBSERVATION, 2000);
    expect(fetch_mock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch_mock.mock.calls[0][1].body).title).toContain('overrun');
  });

  it('keeps delivery failures from breaking checks or the other alert channel', async () => {
    const fetch_mock = vi.fn().mockImplementation(async (url: string) =>
      new Response(null, { status: url === ENV.ADMIN_ALERT_URL ? 403 : 204 }),
    );
    vi.stubGlobal('fetch', fetch_mock);
    const error_mock = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(sendAlert(
      { ...ENV, DISCORD_ALERT_WEBHOOK: 'https://alerts.example.invalid/other' },
      MONITOR, TRANSITION, OBSERVATION, 2000,
    )).resolves.toBeUndefined();
    expect(fetch_mock).toHaveBeenCalledTimes(2);
    expect(error_mock).toHaveBeenCalledWith(expect.stringContaining('admin alert 403'));
  });

  it('leaves the operator channel disabled without its credential', async () => {
    const fetch_mock = vi.fn();
    vi.stubGlobal('fetch', fetch_mock);
    await sendAlert({ ...ENV, ADMIN_ALERT_TOKEN: undefined }, MONITOR, TRANSITION, OBSERVATION, 2000);
    expect(fetch_mock).not.toHaveBeenCalled();
  });
});
