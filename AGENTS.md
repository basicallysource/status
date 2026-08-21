# AGENTS.md

## This repo is written to be public

The page is public and the repo should be publishable.

- Service descriptions in `src/config.ts` are read by customers. No internal
  hostnames, no implementation detail, no "public X" phrasing that implies a
  private counterpart.
- No private endpoints or infrastructure topology in committed files. That is
  why `ADMIN_ALERT_URL` is a secret rather than a var in `wrangler.toml`, and
  why it holds the entire URL: a code that appends a known path to a secret
  base still publishes half the address, and the half that describes it.
- The same goes for what we send. `{title, message}` over a bearer token is the
  shape of every notification service there has ever been, and that is the
  point — nothing here should let a reader infer what is on the other end.
- Comments give the engineering reason, not the incident history.

Internal context — real hostnames, credential locations — is in the gitignored
`AGENTS.local.md`.

## What we record and what we publish are different sets

`src/publish.ts` is the boundary, and it is a closed vocabulary: the page says
one of the sentences written there and nothing else.

**Adding a metric is safe. Publishing one is a deliberate edit to
`publish.ts`.** If a number belongs on the page, write the sentence a stranger
should read — never the field name, never the threshold it tripped.

It has to fail this way round. The version this replaced formatted whatever keys
a heartbeat happened to carry and printed them, so publishing was the default
and a metric added to a box's beat script next month would have landed on the
public internet with nobody deciding it should. Don't reintroduce anything that
renders `meta`, `last_err`, or a version tag into the page or the board.

Public: status, uptime, the daily bars, incident times, response time, and that
an update happened. Ours: every metric value, version tags, deploy durations,
threshold numbers, probe error text, and all host samples — reachable through
`/api/deploys` and `/api/hosts`, both operator-only.

## The collector

`collector/` is a Go agent on each box, replacing a hand-installed shell script.
Read its README before changing it. Two rules it exists to keep:

- **Never fork and never walk a filesystem.** Everything is a read of a file the
  kernel synthesises in memory, plus one `statfs`. Sizing a directory is the one
  measurement on these boxes that costs real I/O. The single exception is
  `systemctl is-active`, and only where a service heartbeat is also being sent.
- **Absent means not measured.** A stopped service reports nothing rather than
  zero; a kernel without pressure stalls simply has no `psi_*` keys. A zero is a
  measurement, and a chart will draw it as one.

It is resident rather than a timer because `/proc/stat` counts since boot, so
every rate is a delta between two readings and a process that exits cannot
subtract.

Samples are never spooled. A failed report is logged and dropped — replaying an
hour of stale samples would let a box that was dead backfill an hour of "I was
fine", and the gap is the honest record.

## Deploying

Two tags, deliberately separate, because they reach different machines by
different means and one shared version would make every page tweak restart five
boxes.

- `v*` — the worker. Checks, deploys, then curls the live domain.
- `collector-v*` — the box agent. Builds a static binary and publishes it with a
  checksum; boxes pull it themselves within 30 minutes.

A tag ships. Push to main runs the tests and stops there.

```bash
git tag v<n> && git push origin v<n>
```

`.github/workflows/deploy.yml` checks, deploys, then curls the live domain,
because a green deploy onto a broken route is a thing that happens. Actions is
free here because the repo is public. `npm run deploy` still works from a laptop
if CI is the thing that's broken.

The worker's credential is a scoped token in repo secrets — Workers Scripts
Write, D1 Write, Account Settings Read, and nothing else. Minting one needs the
dashboard, so it is not something a session can replace on its own.

## A service's claim about itself is never load-bearing

`deploying` lets a service say its own failure is routine, which is a mute
button if you let it be one. Every path that honours it expires on our clock:
capped by `MAINTENANCE_MAX_SEC`, never applied to silence, never applied to a
degraded metric, never applied to an outage already in progress, and the excused
minutes are added back as downtime if it turns out to have been real. Keep every
one of those when changing this. Tests assert each of them by name.

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
  reports an outage forever. It is the only sweep left, and it is about
  correctness, not age.
- **Nothing is deleted for being old, and don't add anything that is.** A check
  that changes nothing writes a counter rather than a row, so history is cheap;
  the one table that grows is `host_samples`, at ~84 MB per box per year against
  D1's 10 GB ceiling. `HISTORY_DAYS` is how many bars the page draws, not how
  much is kept. The thing to watch is a query reading a year to draw a day —
  hence `HOST_QUERY_MAX_HOURS` and the index on `host_samples (ts)`. If
  long-range charts ever get drawn routinely, roll up to the hour and keep both.
- Worth keeping green: the state machine tests (flap guard, and thresholds
  producing `degraded` vs `down`). Probe tests inject a fake `fetch` — never hit
  a real host in a test.
- The database and custom domain are declared in `wrangler.toml`, so a deploy
  owns them. Don't point DNS by hand.
