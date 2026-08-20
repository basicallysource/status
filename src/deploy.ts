import { DEPLOY_GRACE_SEC } from './config';

/**
 * Deploys, learned from what a service already reports about itself.
 *
 * A service says two things: the version it is running, and the version it is
 * installing right now, if any. Everything here is derived by comparing one
 * report to the one before it — the same shape the incident log already uses,
 * so there is no second source of truth about what a service is doing.
 *
 * Balloon needs no new endpoint and no new credential for this: its release
 * agent already publishes a pending deploy for the whole box to read, and its
 * heartbeat already has a token. See agents/balloon-beat.sh.
 */

/** A deploy that is running, or one that has finished. */
export interface DeployRow {
  monitor: string;
  version: string;
  started: number;
  ended: number | null;
}

export type DeployEvent =
  /** A service began installing `version`. */
  | { kind: 'opened'; version: string }
  /** The install it was reporting is over. */
  | { kind: 'closed' }
  /** A version changed with no window around it — a deploy that began and
   *  ended between two reports. Recorded at minute resolution rather than not
   *  at all. */
  | { kind: 'missed'; version: string };

type Meta = Record<string, unknown> | null | undefined;

/** A version string, or null. Anything that is not a plain non-empty string is
 *  not a version — an empty query parameter carries no claim. */
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

export const deployingVersion = (meta: Meta): string | null => str(meta?.deploying);
export const runningVersion = (meta: Meta): string | null => str(meta?.version);

/** What changed about a service's deploy state between two reports. */
export function deployEvents(prev: Meta, next: Meta): DeployEvent[] {
  const was = deployingVersion(prev);
  const now = deployingVersion(next);
  const events: DeployEvent[] = [];

  if (was !== now) {
    // A window that never closed before a different one opened belongs to a
    // deploy nobody is going to hear the end of. Close it rather than leaving a
    // row that stays open forever.
    if (was) events.push({ kind: 'closed' });
    if (now) events.push({ kind: 'opened', version: now });
  }

  const from = runningVersion(prev);
  const to = runningVersion(next);
  // Only against a known previous version: the first report from a service is
  // not a deploy, it is the first time we looked.
  if (from && to && from !== to && !was) events.push({ kind: 'missed', version: to });

  return events;
}

/**
 * Whether a failing service is failing because it is being deployed.
 *
 * Three things have to be true, and each one is a way this cannot become a mute
 * button. The service has to be claiming a deploy right now, or have finished
 * one moments ago — the grace covers the seconds between an install completing
 * and the process actually answering again. We have to still be hearing from
 * it. And the caller time-boxes how long it will act on this; see nextState.
 */
export function excused(
  meta: Meta,
  latest: DeployRow | undefined,
  obs: { stale?: boolean },
  nowSec: number,
): boolean {
  if (obs.stale) return false;
  if (deployingVersion(meta)) return true;
  return !!latest?.ended && nowSec - latest.ended <= DEPLOY_GRACE_SEC;
}

/** The deploy an incident starting now should be filed against, if any. */
export function blame(
  meta: Meta,
  latest: DeployRow | undefined,
  nowSec: number,
): string | null {
  const deploying = deployingVersion(meta);
  if (deploying) return deploying;
  if (latest && (latest.ended === null || nowSec - latest.ended <= DEPLOY_GRACE_SEC)) {
    return latest.version;
  }
  return null;
}
