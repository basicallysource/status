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
STATUS="${BALLOON_STATUS_URL:-https://status.basically.website}"

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
  "$STATUS/beat/balloon?service=${svc}&disk_pct=${disk}&version=${version}&deploying=${deploying}" \
  -o /dev/null

# --------------------------------------------------------------- the box itself
#
# Reported separately from the service and never shown publicly: this box is not
# the bot. How hard it is breathing is an engineering fact, and "the bot is down"
# is the customer one.
#
# Everything below reads /proc, which is memory — no disk touched, no processes
# forked, microseconds of CPU. Do not add anything here that walks a filesystem:
# sizing directories is the one measurement on these boxes that costs real I/O,
# and it is what made a disk-usage number expensive enough to notice.
read -r load1 _ < /proc/loadavg
cpus=$(nproc 2>/dev/null || echo 1)

# MemAvailable, not MemFree: the kernel's own estimate of what a new process
# could actually get, which counts reclaimable cache. MemFree on a healthy box
# looks alarming and means nothing.
mem_pct=$(awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2}
  END{ if (t>0) printf "%.1f", (t-a)*100/t }' /proc/meminfo)
swap_pct=$(awk '/^SwapTotal:/{t=$2} /^SwapFree:/{f=$2}
  END{ if (t>0) printf "%.1f", (t-f)*100/t; else print 0 }' /proc/meminfo)

# Uptime is reboot detection for free: it only ever counts up, so a smaller
# number than last time means the box restarted between samples. No process has
# to be resident through the reboot to notice it happened.
uptime_s=$(awk '{printf "%d", $1}' /proc/uptime)

curl -fsS --max-time 20 -X POST \
  -H "Authorization: Bearer $BEAT_TOKEN" \
  "$STATUS/host/blip?load1=${load1}&cpus=${cpus}&mem_pct=${mem_pct}&swap_pct=${swap_pct}&disk_pct=${disk}&uptime_s=${uptime_s}" \
  -o /dev/null
