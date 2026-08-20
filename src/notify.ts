import { fmtDuration } from './monitor';
import type { Env, Monitor, Observation, Status, Transition } from './types';

export const COLOR: Record<Status, number> = {
  up: 0x3ba55d,
  degraded: 0xe6a817,
  down: 0xed4245,
  unknown: 0x9a9a95,
};

export const ICON: Record<Status, string> = { up: '🟢', degraded: '🟡', down: '🔴', unknown: '⚪' };

export function alertText(m: Monitor, t: Transition, obs: Observation, nowSec: number) {
  if (t.status === 'up') {
    const label = t.prevStatus === 'degraded' ? 'degraded' : 'down';
    const dur = fmtDuration(nowSec - t.since);
    return { title: `${m.name} recovered`, body: `Back up after ${dur} ${label}.` };
  }
  const verb = t.status === 'degraded' ? 'is degraded' : 'is down';
  return { title: `${m.name} ${verb}`, body: obs.err ?? verb };
}

async function post(url: string, init: RequestInit, label: string): Promise<void> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${label} ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/**
 * A notification channel that is itself broken must not break the probe loop:
 * an alert we cannot deliver is still a check that has to be recorded.
 */
export async function sendAlert(
  env: Env,
  m: Monitor,
  t: Transition,
  obs: Observation,
  nowSec: number,
): Promise<void> {
  const { title, body } = alertText(m, t, obs, nowSec);
  const jobs: Promise<void>[] = [];

  if (env.DISCORD_ALERT_WEBHOOK) {
    jobs.push(
      post(
        env.DISCORD_ALERT_WEBHOOK,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            embeds: [
              {
                title: `${ICON[t.status]} ${title}`,
                description: body,
                color: COLOR[t.status],
                timestamp: new Date(nowSec * 1000).toISOString(),
              },
            ],
          }),
        },
        'discord alert',
      ),
    );
  }

  if (env.PUSH_API && env.PUSH_TOKEN) {
    jobs.push(
      post(
        `${env.PUSH_API.replace(/\/$/, '')}/notify`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${env.PUSH_TOKEN}`,
          },
          body: JSON.stringify({ title, message: body }),
        },
        'push',
      ),
    );
  }

  for (const r of await Promise.allSettled(jobs)) {
    if (r.status === 'rejected') console.error(`alert ${m.id}: ${r.reason}`);
  }
}
