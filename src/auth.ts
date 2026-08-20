import type { Env } from './types';

/**
 * Who may report what.
 *
 * Two roles, and they do not overlap. `BEAT_TOKEN` is the operator credential —
 * it runs a check on demand and nothing else. Everything a machine says about a
 * service goes through a row in `tokens`, scoped to the services that machine is
 * actually allowed to speak for.
 *
 * The scoping is the point. blip runs a bot the public can talk to and hive-prod
 * serves customers; a credential on either that could file a fake outage, or a
 * fake maintenance window, against the other is a bad trade for the convenience
 * of one shared string. Rotating one also stops meaning "break every reporter at
 * once".
 *
 * There is deliberately no endpoint that mints a token. Keys are inserted with
 * `wrangler d1 execute`, which already requires being able to deploy this
 * worker, so the ability to create a credential is not reachable from the
 * internet at all. See README.
 */

/** Stored as a hash, so the database is not a list of working credentials. */
export async function hashToken(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const bearer = (req: Request): string | null => {
  const h = req.headers.get('authorization') ?? '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() || null : null;
};

/** The operator credential, for actions that are not a service reporting in. */
export const isOperator = (req: Request, env: Env): boolean =>
  !!env.BEAT_TOKEN && bearer(req) === env.BEAT_TOKEN;

export interface TokenRow {
  name: string;
  monitors: string;
}

/**
 * The name of the key presented, if it is allowed to speak for `monitor`.
 * Returns null for anything else, so a caller cannot tell an unknown key from a
 * known key used on the wrong service.
 */
export async function authorize(
  req: Request,
  env: Env,
  monitor: string,
): Promise<string | null> {
  const raw = bearer(req);
  if (!raw) return null;
  const row = await env.DB.prepare('SELECT name, monitors FROM tokens WHERE hash = ?1')
    .bind(await hashToken(raw))
    .first<TokenRow>();
  if (!row) return null;
  if (!allowed(row.monitors, monitor)) return null;
  return row.name;
}

/** `*` for anything, otherwise a JSON array of monitor ids. */
export function allowed(scope: string, monitor: string): boolean {
  if (scope.trim() === '*') return true;
  try {
    const ids = JSON.parse(scope) as unknown;
    return Array.isArray(ids) && ids.includes(monitor);
  } catch {
    // A scope we cannot read grants nothing. A malformed row should fail shut.
    return false;
  }
}
