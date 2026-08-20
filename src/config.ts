import type { Monitor } from './types';

// What we watch. Adding a service is a change to this list and nothing else.
//
// Descriptions appear on the public page, so they are written for whoever is
// checking whether the thing they use is broken — not for us.

export const MONITORS: Monitor[] = [
  {
    id: 'hive',
    name: 'Hive API',
    group: 'Hive',
    kind: 'http',
    url: 'https://hive.basically.website/api/health',
    // A 200 that says the wrong thing is not healthy.
    expectBody: '"ok":true',
    // An overloaded origin fails by hanging rather than by refusing, so a
    // generous timeout would report it healthy while nothing actually worked.
    timeoutMs: 8000,
    description: 'Machine sync, sorting data, and accounts.',
  },
  {
    id: 'hive-web',
    name: 'Hive web app',
    group: 'Hive',
    kind: 'http',
    url: 'https://hive.basically.website/',
    timeoutMs: 10000,
    description: 'Browser dashboard.',
  },
  {
    id: 'balloon',
    name: 'balloon',
    group: 'balloon',
    kind: 'heartbeat',
    // Beaten by a timer on the host rather than from inside the bot itself, so
    // that a stopped or wedged bot is still reported by a healthy host, and a
    // host that dies shows up as silence.
    // A restart during a deploy is well under this; ten minutes is a real outage.
    staleAfterSec: 600,
    thresholds: {
      service: { equals: 'active', level: 'down' },
      // A full disk has taken this bot down before. Warn long before it does.
      disk_pct: { warn: 85, crit: 93 },
    },
    description: 'Discord bot.',
  },
  {
    id: 'basically-website',
    name: 'basically.website',
    group: 'basically',
    kind: 'http',
    url: 'https://basically.website/',
    timeoutMs: 10000,
  },
];

export const MONITOR_BY_ID: Record<string, Monitor> = Object.fromEntries(
  MONITORS.map((m) => [m.id, m]),
);

/** Consecutive failures before we call it down. One is too jumpy to trust. */
export const FAILURES_BEFORE_DOWN = 2;

/**
 * The longest a declared deploy may keep a service off the outage list.
 *
 * This number is the whole safety of the feature: a service telling us it is
 * deploying is a service asking not to be alerted on, so the answer has to
 * expire on our clock rather than theirs. Balloon restarts in about 30 seconds
 * and rolls itself back inside another 30, so anything past five minutes is a
 * deploy that went wrong — which is an outage, and gets alerted as one.
 */
export const MAINTENANCE_MAX_SEC = 300;

/**
 * How long after a deploy lands its failures are still its fault.
 *
 * The gap between "the installer is finished" and "the process answers again"
 * is real, and the pending flag is already cleared inside it.
 */
export const DEPLOY_GRACE_SEC = 120;

/**
 * When an unfinished deploy is presumed abandoned.
 *
 * A deploy that reported its start and never its end is a deploy whose reporter
 * died, and it must not go on excusing failures or being blamed for unrelated
 * ones forever. Generous, because a real one can be slow — hive runs database
 * migrations before it answers — and because MAINTENANCE_MAX_SEC already bounds
 * the part that actually hides anything.
 */
export const DEPLOY_MAX_OPEN_SEC = 1800;

/** How many past deploys a service's typical duration is drawn from. */
export const DEPLOY_TYPICAL_WINDOW = 10;

/**
 * Days of bars the page draws.
 *
 * A window onto the data, not a limit on it: nothing is deleted when it scrolls
 * off the end. See the note on retention in db.ts.
 */
export const HISTORY_DAYS = 90;

/**
 * The longest span a single /api/hosts query will answer.
 *
 * Not how long samples are kept — how much one request may read. host_samples
 * grows by a row a minute per box, and an uncapped range over it is the easy
 * way to read a year in order to draw a day.
 */
export const HOST_QUERY_MAX_HOURS = 24 * 30;

export const SITE = {
  title: 'basically Status',
  url: 'https://status.basically.website',
};
