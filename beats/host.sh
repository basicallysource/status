#!/bin/bash
# Reports one box to status.basically.website once a minute.
#
# INTERIM. This is the same collection blip's balloon.sh does, minus the
# service beat, generalised so a second box did not need a second copy of the
# same awk. Both are being replaced by a single Go collector that can carry more
# than a handful of numbers and that ships with a version, rather than being
# installed by hand and drifting where nobody can see it.
#
# Installed at /usr/local/bin/status-host-beat with a systemd timer beside it.
# HOST and BEAT_TOKEN come from the env file; HOST must match the name the
# token is scoped to (`host:<name>`), or the report is refused.
set -uo pipefail
. /etc/hive-status/beat.env
STATUS="${STATUS_URL:-https://status.basically.website}"
HOST="${HOST:-$(hostname)}"

# Everything below reads /proc, which is memory: no disk touched, no processes
# forked, microseconds of CPU. Do not add anything that walks a filesystem —
# sizing directories is the one measurement on these boxes that costs real I/O.
read -r load1 _ < /proc/loadavg
cpus=$(nproc 2>/dev/null || echo 1)

# MemAvailable, not MemFree: the kernel's own estimate of what a new process
# could actually get, which counts reclaimable cache. MemFree on a healthy box
# looks alarming and means nothing.
mem_pct=$(awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2}
  END{ if (t>0) printf "%.1f", (t-a)*100/t }' /proc/meminfo)
swap_pct=$(awk '/^SwapTotal:/{t=$2} /^SwapFree:/{f=$2}
  END{ if (t>0) printf "%.1f", (t-f)*100/t; else print 0 }' /proc/meminfo)

# statfs on one path, not a walk of it.
disk=$(df -P / | awk 'NR==2{gsub(/%/,"",$5); print $5}')

# Uptime is reboot detection for free: it only counts up, so a smaller number
# than last time means the box restarted between samples.
uptime_s=$(awk '{printf "%d", $1}' /proc/uptime)

curl -fsS --max-time 20 -X POST \
  -H "Authorization: Bearer $BEAT_TOKEN" \
  "$STATUS/host/${HOST}?load1=${load1}&cpus=${cpus}&mem_pct=${mem_pct}&swap_pct=${swap_pct}&disk_pct=${disk}&uptime_s=${uptime_s}" \
  -o /dev/null
