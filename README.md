# status

Status page for basically services: <https://status.basically.website>

A Cloudflare Worker checks each service every minute, stores results in D1, and
renders the page. Alerts fire on state changes. It runs outside the
infrastructure it watches, so an outage there can't take it down too.

## Adding a service

Edit `src/config.ts`. Nothing else. Two kinds:

- **`http`** — fetches a URL with a timeout, optionally asserting on the body.
- **`heartbeat`** — the service POSTs in and silence is the alert, for anything
  with no public URL. Metrics sent along with a beat (disk usage, say) can carry
  thresholds that show as degraded.

Descriptions show up on the public page, so write them for whoever is checking
whether the thing they use is broken.

## Deploys

A service can report the version it is running and the version it is installing,
as ordinary heartbeat metrics named `version` and `deploying`. Both are
optional and neither needs a new endpoint or credential.

Reporting them buys two things. Deploys land in a table with a start and an end,
so an incident can say which update was in flight when it began. And a service
that stops answering while it says it is deploying reads as **Updating** rather
than as an outage, and does not alert.

That second one is a service asking not to be alerted on, so it expires on our
clock. It is honoured for `MAINTENANCE_MAX_SEC`, after which the service is down
and the alert is louder than an ordinary one. It never covers silence, and never
covers a degraded metric. Time excused and later judged an outage is added back
to that day's downtime.

A service that reports its own start and end gets an exact duration, and is
compared against the median of its own last ten deploys:

```bash
curl -XPOST -H "Authorization: Bearer $TOKEN" -d '{"version":"r1"}' \
  https://status.basically.website/deploy/<id>/start
# ... deploy ...
curl -XPOST -H "Authorization: Bearer $TOKEN" \
  https://status.basically.website/deploy/<id>/end     # -> {"seconds": 38}
```

Deploys inferred from a heartbeat are recorded too, but their duration is an
artefact of how often we looked, so they are kept out of the statistics.

## Boxes

A machine can report on itself, separately from any service it runs:

```bash
curl -XPOST -H "Authorization: Bearer $TOKEN" \
  "https://status.basically.website/host/blip?load1=0.4&cpus=1&mem_pct=25.3&swap_pct=0&uptime_s=3010111"
```

This is recorded and never rendered. A box is not a service — whether the API
answers is a customer's question, and how hard the machine is working to answer
it is ours. Read it back with `GET /api/hosts?hours=6[&host=blip]`, which needs
the operator credential and answers at most `HOST_QUERY_MAX_HOURS` at a time.

`/admin` draws it: one chart per metric, per box, with every deploy marked on
every chart — "CPU has been climbing since June" is only useful next to what
shipped in June. The page carries no data and asks the browser for the same
operator credential a terminal would use, so there is no second authentication
path and no server-side session. Putting Cloudflare Access in front of `/admin`
would need no change here; the token prompt would simply stop being reached.

Ranges pair a window with a stride, and the server thins rather than averages: a
month is 43,000 samples per box, and reducing that inside a Worker's 10 ms CPU
budget is the expensive half. A thinned month can miss a one-minute spike — the
right trade for "has this changed since June", the wrong one for "3am on
Tuesday", which wants a narrow range and every sample in it.

Collectors read `/proc` and nothing else — no forks, no disk. Do not add anything
that walks a filesystem: sizing directories is the one measurement on these boxes
that costs real I/O.

## What is public, and what is only recorded

Two different questions share one system. A customer asks whether the thing they
use works. We ask how hard the machines are working to make that true. The first
is published; the second is ours.

**Published** — the status of each service, uptime percentages and the daily
bars, when an incident started and ended, response time, and the fact that an
update happened.

**Recorded, never rendered** — every metric value (disk, memory, load, swap, host
uptime), version tags, deploy durations and how they compare, the numbers a
threshold tripped on, and the error text from a probe. Read it through
`GET /api/deploys` and `GET /api/hosts`, both operator-only.

`src/publish.ts` is the boundary, and it is a closed vocabulary: the page says
one of the sentences written there and nothing else. It has to work this way
round. The version this replaced formatted whatever keys a heartbeat happened to
carry, which made publication the default — a metric added on a box next month
would have appeared on the public internet with nobody deciding it should. Now a
new metric is recorded, queryable, and invisible until someone writes a sentence
for it on purpose.

So: **adding a metric is safe; publishing one is a deliberate edit to
`publish.ts`.** If you want a number on the page, write the sentence a stranger
should read, not the field name.

## Retention

Nothing is deleted by age. `HISTORY_DAYS` is how many bars the page draws, not
how much is kept.

It is affordable because a check that changes nothing writes a counter rather
than a row, so a service costs a few rows a day however long it runs. The one
table that grows is `host_samples`, at a sample a minute per box — about 84 MB
a year per box, against D1's 10 GB per-database ceiling.

Keeping it is the point: whether deploys are getting slower, whether a box has
been creeping toward its memory for months, whether this outage rhymes with one
last spring. None of that can be asked of data already thrown away.

The thing to watch is not size but a query reading a year to draw a day, which
is what `HOST_QUERY_MAX_HOURS` and the index on `host_samples (ts)` are for. If
long-range charts ever get drawn routinely, roll the samples up to the hour and
keep both — do not start deleting.

## Tokens

`BEAT_TOKEN` is the operator credential and authorises `POST /api/tick` and
`GET /api/hosts`.
Everything a machine reports about a service uses a row in the `tokens` table,
hashed and scoped to the services that machine may speak for (and to
`host:<name>` for reporting on itself) — a credential on
one box cannot file a fake outage, or a fake maintenance window, against a
service on another.

Nothing mints tokens over HTTP. Rows are inserted with `wrangler d1 execute`,
which already requires being able to deploy this worker:

```sql
INSERT INTO tokens (name, hash, monitors, created)
VALUES ('blip', '<sha256 of the token>', '["balloon","host:blip"]', <epoch>);
```

## Routes

| Route | |
|---|---|
| `GET /` | the status page |
| `GET /api/status` | same data as JSON |
| `GET /admin` | operator dashboard: box charts with deploy markers |
| `GET /healthz` | is the worker up |
| `POST /beat/<id>` | record a heartbeat (service token) |
| `POST /deploy/<id>/start` `.../end` | report a deploy (service token) |
| `POST /host/<name>` | record a box sample (service token, `host:<name>`) |
| `GET /api/deploys` | versions and durations, not public (operator token) |
| `GET /api/hosts` | box samples, not public (operator token) |
| `POST /api/tick` | run a check now (operator token) |

Heartbeats take metrics as JSON or query params. An empty value is dropped, so
an unset shell variable says nothing rather than something wrong:

```bash
curl -XPOST -H "Authorization: Bearer $TOKEN" \
  "https://status.basically.website/beat/<id>?service=active&disk_pct=53&version=r1"
```

`collector/` is the agent that runs on the boxes and sends both of the above.
`beats/` holds the shell scripts it replaced, kept until every box is on it.

## Developing

```bash
npm install
npm run check     # tsc --noEmit && vitest
```

Shipping is a tag. Pushing to main runs the tests and stops there — the thing
that watches everything else should not change because of a stray commit:

```bash
git tag v3 && git push --tags
```

The workflow checks, deploys, then asks the live domain whether it is actually
answering, because a green deploy onto a broken route is a thing that happens.
It needs two repository secrets: `CLOUDFLARE_API_TOKEN` (an API token with *Edit
Cloudflare Workers* and *D1 Edit*, scoped to this account) and
`CLOUDFLARE_ACCOUNT_ID`. `npm run deploy` still works from a laptop for an
emergency.

Secrets, set with `wrangler secret put`. Each alert channel is off when its
secret is missing:

| | |
|---|---|
| `BEAT_TOKEN` | the operator credential: manual ticks and box samples |
| `ADMIN_ALERT_URL`, `ADMIN_ALERT_TOKEN` | a private endpoint an alert is POSTed to, and its bearer credential |
| `DISCORD_ALERT_WEBHOOK` | a message per state change |
| `DISCORD_BOARD_WEBHOOK` | one message, edited in place, mirroring the page |
