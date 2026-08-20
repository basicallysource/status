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
the operator credential.

Samples are kept for `HOST_HISTORY_DAYS`, shorter than the page's window because
a row a minute per box is the only thing here that grows quickly.

Collectors read `/proc` and nothing else — no forks, no disk. Do not add anything
that walks a filesystem: sizing directories is the one measurement on these boxes
that costs real I/O.

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
| `GET /healthz` | is the worker up |
| `POST /beat/<id>` | record a heartbeat (service token) |
| `POST /deploy/<id>/start` `.../end` | report a deploy (service token) |
| `POST /host/<name>` | record a box sample (service token, `host:<name>`) |
| `GET /api/hosts` | box samples, not public (operator token) |
| `POST /api/tick` | run a check now (operator token) |

Heartbeats take metrics as JSON or query params. An empty value is dropped, so
an unset shell variable says nothing rather than something wrong:

```bash
curl -XPOST -H "Authorization: Bearer $TOKEN" \
  "https://status.basically.website/beat/<id>?service=active&disk_pct=53&version=r1"
```

`beats/` holds the reporting scripts that run on the boxes.

## Developing

```bash
npm install
npm run check     # tsc --noEmit && vitest
npm run deploy
```

Secrets, set with `wrangler secret put`. Each alert channel is off when its
secret is missing:

| | |
|---|---|
| `BEAT_TOKEN` | the operator credential: manual ticks and box samples |
| `PUSH_API`, `PUSH_TOKEN` | push notification endpoint and credential |
| `DISCORD_ALERT_WEBHOOK` | a message per state change |
| `DISCORD_BOARD_WEBHOOK` | one message, edited in place, mirroring the page |
