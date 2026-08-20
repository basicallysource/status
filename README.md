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

## Routes

| Route | |
|---|---|
| `GET /` | the status page |
| `GET /api/status` | same data as JSON |
| `GET /healthz` | is the worker up |
| `POST /beat/<id>` | record a heartbeat (bearer `BEAT_TOKEN`) |
| `POST /api/tick` | run a check now (bearer `BEAT_TOKEN`) |

Heartbeats take metrics as JSON or query params:

```bash
curl -XPOST -H "Authorization: Bearer $TOKEN" \
  "https://status.basically.website/beat/<id>?service=active&disk_pct=53"
```

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
