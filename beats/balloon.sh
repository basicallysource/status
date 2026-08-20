#!/bin/bash
# Reports the box that runs Balloon to status.basically.website once a minute.
#
# Deliberately outside the bot: a stopped or wedged bot is still reported by a
# healthy box, and a dead box shows up as silence rather than as good news.
#
# Installed by hand at /usr/local/bin/balloon-status-beat, with a systemd timer
# beside it and the token in /etc/balloon-status/beat.env. It lives here so that
# what is running is reviewable and diffable; see AGENTS.local.md.
set -uo pipefail
. /etc/balloon-status/beat.env

svc=$(systemctl is-active balloon-bot.service 2>/dev/null || true)
[ -n "$svc" ] || svc=unknown
disk=$(df -P / | awk 'NR==2{gsub(/%/,"",$5); print $5}')
version=$(cat /var/lib/balloon-release/installed/bot 2>/dev/null || true)

# The release agent publishes a pending deploy here and rewrites it on every
# poll that still has work to do, so an untouched file is the opinion of an
# agent that is no longer running. Five minutes is the same bound the bot's own
# reader uses. Reporting it is what lets the status page tell a restart apart
# from an outage — without it, a beat that lands mid-restart reads as down.
deploying=
flag=/run/balloon-deploy
if [ -f "$flag" ] && [ -z "$(find "$flag" -mmin +5 2>/dev/null)" ]; then
  deploying=$(head -c 64 "$flag" | tr -dc 'A-Za-z0-9.-')
fi

# Empty values are dropped by the receiver, so an unset version or no pending
# deploy says nothing rather than saying something wrong.
curl -fsS --max-time 20 -X POST \
  -H "Authorization: Bearer $BEAT_TOKEN" \
  "https://status.basically.website/beat/balloon?service=${svc}&disk_pct=${disk}&version=${version}&deploying=${deploying}" \
  -o /dev/null
