# status

The status page behind <https://status.basically.website>, running as a single
Cloudflare Worker.

## Why it works this way

A health check that runs on the same machine as the service will report green
while users are getting errors, because an overloaded host answers itself long
after it has stopped answering anyone else. So this runs nowhere near the
services it watches: it probes them from outside, over the public internet, the
same way a customer reaches them.

That is the one architectural rule here. Everything else is small.

## What it does

Once a minute it checks every service, records the result, and announces any
change of state.

- **HTTP checks** fetch a URL with a strict timeout and can assert on the
  response body, because a 200 carrying the wrong payload is not healthy, and a
  request that hangs is not healthy either.
- **Heartbeat checks** invert the direction: the service reports in to us, and
  silence is the alert. This covers anything with no public URL to probe, like a
  chat bot or a background worker. A heartbeat can carry metrics, and a
  threshold on one surfaces a problem (a filling disk, say) as a visible warning
  well before it becomes an outage.

A service has to fail twice in a row before it is called down. A page that cries
wolf stops being read, and the cost of being sure is one minute.

## Alerts

Every channel is optional and is skipped when its secret is absent, so the
service degrades to "still checking, just quieter" rather than breaking.

On each state change (up ↔ degraded ↔ down) it can send:

- a push notification, through a private endpoint of your choosing;
- a Discord message per change, so it can notify a channel;
- a Discord "board": one message, edited in place, mirroring the page. It is
  rewritten only when the status actually changes, so it never churns.

Point the relevant secret at each one to turn it on. There is no other wiring.

## Layout

    src/config.ts    what we watch — adding a service is a change to this file alone
    src/monitor.ts   probing, and the up/degraded/down state machine
    src/db.ts        schema and queries
    src/notify.ts    alert fan-out
    src/board.ts     the mirrored, edit-in-place Discord message
    src/page.ts      the HTML
    src/index.ts     routes and the scheduled entry point

## Routes

| Route | |
|---|---|
| `GET /` | the status page |
| `GET /api/status` | the same data as JSON |
| `GET /healthz` | liveness of the worker itself |
| `POST /beat/<id>` | record a heartbeat (bearer `BEAT_TOKEN`) |
| `POST /api/tick` | run a check cycle now (bearer `BEAT_TOKEN`) |

A heartbeat accepts metrics as JSON or as query parameters, so reporting from a
shell stays a one-liner:

```bash
curl -XPOST -H "Authorization: Bearer $TOKEN" \
  "https://status.basically.website/beat/<id>?service=active&disk_pct=53"
```

## Running it

```bash
npm install
npm run check     # tsc --noEmit && vitest
npm run deploy
```

State lives in Cloudflare D1; the schema is created on first run. Configuration
that is not secret lives in `wrangler.toml`. Secrets are set with
`wrangler secret put` and are never committed:

| Secret | |
|---|---|
| `BEAT_TOKEN` | authenticates heartbeats and manual ticks |
| `PUSH_API`, `PUSH_TOKEN` | push-notification endpoint and its credential |
| `DISCORD_ALERT_WEBHOOK` | one message per state change |
| `DISCORD_BOARD_WEBHOOK` | the mirrored, edited-in-place board |

## Cost

It fits in Cloudflare's free tier with room to spare. One check a minute is
1,440 scheduled invocations a day against a ceiling of 100,000, and each cycle
writes two rows per service. There is no raw per-check table on purpose: the
incident log already carries the timeline at a fraction of the writes, and the
daily rollups carry the history the page draws.
