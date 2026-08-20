# AGENTS.md

## This repo is written to be public

The page is public and the repo should be publishable.

- Service descriptions in `src/config.ts` are read by customers. No internal
  hostnames, no implementation detail, no "public X" phrasing that implies a
  private counterpart.
- No private endpoints or infrastructure topology in committed files. That's why
  the push endpoint is a secret, not a var in `wrangler.toml`.
- Comments give the engineering reason, not the incident history.

Internal context — real hostnames, credential locations — is in the gitignored
`AGENTS.local.md`.

## Don't couple it to what it watches

A health check running beside a service reports green while users get errors.
Probe from outside, keep state off monitored infrastructure, and don't route
alerts through anything being watched.

## Free-tier limits

Account-wide, so shared with anything else on the account:

- **100k worker requests/day.** The schedule is 1,440; each heartbeat source
  adds ~1,440 more.
- **5 scheduled triggers per account.** This uses one.
- **10ms CPU per invocation.** Keep the page render cheap — 90 days × N services
  is fine, a per-check history isn't.
- **50 subrequests and 50 DB queries per invocation.** A cycle uses about a
  dozen of each; ~20 services is where that stops holding. Fix with `db.batch`.

Measure rather than trust this: `workersInvocationsAdaptive` in the GraphQL
analytics API.

## Notes

- Removing a service from `config.ts` sweeps its rows on the next deploy
  (`pruneOrphans`). Without that a stranded incident never closes and the page
  reports an outage forever.
- Worth keeping green: the state machine tests (flap guard, and thresholds
  producing `degraded` vs `down`). Probe tests inject a fake `fetch` — never hit
  a real host in a test.
- The database and custom domain are declared in `wrangler.toml`, so a deploy
  owns them. Don't point DNS by hand.
