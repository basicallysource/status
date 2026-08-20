# AGENTS.md

Read `README.md` first — it says what this is and how it fits together.

## Assume everything here is public

The page this serves is public, and this repository is written to be publishable
too. That constrains what belongs in it:

- **Service descriptions in `src/config.ts` are read by customers.** Write them
  for someone checking whether the thing they use is broken. No internal
  hostnames, no implementation detail, no "public X" phrasing that implies a
  private counterpart, and nothing that reads as internal shorthand.
- **No private endpoints, account identifiers, or infrastructure topology in
  committed files.** Anything of that shape is a secret, not a var — which is
  why the push endpoint is `PUSH_API` rather than a value in `wrangler.toml`.
- **Comments explain the engineering reason, not the incident.** "A full disk
  has taken this bot down before" is useful to the next reader. A dated internal
  postmortem is not, and does not belong in a public repo.

## The rule the design rests on

**This service must never depend on what it watches.** A health check that runs
beside a service reports green while users get errors, because an overloaded
host still answers itself. If a change would make this rely on a machine,
database, or network path that an outage could also take down, the change is
wrong however convenient it is.

Concretely: probe from outside, over the public internet. Do not move state onto
monitored infrastructure. Do not route an alert through something being watched.

## Adding a service

Edit `src/config.ts`. Nothing else. Removing one sweeps its rows on the next
deploy (`pruneOrphans`) — without that, a stranded incident nothing can close
would leave the page reporting an outage forever.

## Limits worth knowing before adding anything

Cloudflare's free tier, and several of these are account-wide rather than
per-worker, so they are shared with anything else on the same account:

- **100,000 worker requests/day.** The schedule alone is 1,440. Each heartbeat
  source adds roughly another 1,440.
- **5 scheduled triggers per account.** This uses one.
- **10ms CPU per invocation.** The page render is the only loop of any size;
  keep it cheap. 90 days × N services is fine. A per-check history would not be.
- **50 subrequests and 50 database queries per invocation.** A cycle with a
  handful of services uses about a dozen of each. Around twenty services is
  where that stops holding, and the answer is `db.batch`, not more round trips.

Measure rather than trusting this list: the GraphQL analytics API answers
`workersInvocationsAdaptive` for an account.

## Testing

`npm run check` runs `tsc --noEmit` and vitest. The tests worth protecting are
the state-machine ones — the flap guard, and thresholds producing `degraded`
versus `down`. Those encode judgement calls rather than mechanics.

Probe tests inject a fake `fetch`. Never write a test that hits a real host.

## Deploying

`npm run deploy`. The database and the custom domain are both declared in
`wrangler.toml`, so a deploy owns them; do not point DNS by hand.
