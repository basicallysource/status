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

Resolution is the reporting interval — a deploy shorter than one beat is
recorded as a point in time. For exact durations a service would have to report
its own start and end.

## Routes

| Route | |
|---|---|
| `GET /` | the status page |
| `GET /api/status` | same data as JSON |
| `GET /healthz` | is the worker up |
| `POST /beat/<id>` | record a heartbeat (bearer `BEAT_TOKEN`) |
| `POST /api/tick` | run a check now (bearer `BEAT_TOKEN`) |

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
| `BEAT_TOKEN` | authenticates heartbeats and manual ticks |
| `PUSH_API`, `PUSH_TOKEN` | push notification endpoint and credential |
| `DISCORD_ALERT_WEBHOOK` | a message per state change |
| `DISCORD_BOARD_WEBHOOK` | one message, edited in place, mirroring the page |
