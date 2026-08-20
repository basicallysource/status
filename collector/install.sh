#!/bin/bash
# Put status-collector on a box, once. After this the collector updates itself.
#
# Run it from a laptop with the binary beside it:
#   scp status-collector install.sh root@<box>:/tmp/
#   ssh root@<box> 'HOST=blip MONITOR=balloon UNIT=balloon-bot.service \
#     SERVICES=balloon-bot.service bash /tmp/install.sh'
#
# BEAT_TOKEN is not passed here. If the box already has a credential from the
# shell-script era this reuses it; otherwise it writes a placeholder and says so,
# because a token typed on a command line ends up in shell history and in the
# process list of every other user on the box.
set -euo pipefail

: "${HOST:?is required, and must match the host scope on the token}"
MONITOR="${MONITOR:-}"
UNIT="${UNIT:-}"
SERVICES="${SERVICES:-}"
DISKS="${DISKS:-disk=/}"
BIN=/usr/local/bin/status-collector
ENV_DIR=/etc/status-collector
ENV_FILE="$ENV_DIR/collector.env"

install -m 755 /tmp/status-collector "$BIN"
mkdir -p "$ENV_DIR"

# Inherit the credential the hand-installed beat scripts were using, so swapping
# to the collector does not need a new token minted and registered.
token=""
for old in /etc/hive-status/beat.env /etc/balloon-status/beat.env; do
  [ -r "$old" ] || continue
  # Sourced in a subshell rather than parsed: the shell already knows how to
  # unquote its own assignment syntax, and hand-rolling that is where the
  # nested quoting goes wrong.
  token=$(. "$old" >/dev/null 2>&1; printf '%s' "${BEAT_TOKEN:-}")
  [ -n "$token" ] && break
done

if [ ! -s "$ENV_FILE" ]; then
  umask 077
  cat > "$ENV_FILE" <<EOF
HOST=$HOST
BEAT_TOKEN=$token
MONITOR=$MONITOR
UNIT=$UNIT
SERVICES=$SERVICES
DISKS=$DISKS
EOF
  chmod 600 "$ENV_FILE"
fi
[ -n "$token" ] || echo "NOTE: no credential found; put one in $ENV_FILE before this reports anything"

cat > /etc/systemd/system/status-collector.service <<'EOF'
[Unit]
Description=report this box to status.basically.website
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/status-collector/collector.env
ExecStart=/usr/local/bin/status-collector
Restart=always
RestartSec=10

# The monitor must never become the thing that needs monitoring. This box has
# 2 GB and has OOM-killed things before; a collector that grew a leak would be
# the worst possible source of one. 64M is roughly four times what it uses.
MemoryMax=64M
CPUQuota=10%

# It reads /proc and /sys, writes one file when it updates itself, and talks to
# two hosts. It has no business anywhere else.
NoNewPrivileges=true
ProtectHome=true
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=false
ReadWritePaths=/usr/local/bin

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now status-collector.service
sleep 2
systemctl is-active status-collector.service

# The old timers' job is done. Leaving one running means two things reporting
# the same box a minute apart, and a chart of any metric only one of them sends
# ends up full of holes.
#
# Tested by the unit file existing, not by grepping `systemctl list-unit-files`:
# under `set -o pipefail`, a `grep -q` that matches exits early, the writer gets
# SIGPIPE, and the whole pipeline reports failure — so the condition was false
# precisely when there WAS something to retire. Both boxes silently kept their
# old timer through the first install because of that.
for stale in status-host-beat balloon-status-beat; do
  unit="/etc/systemd/system/$stale.timer"
  [ -e "$unit" ] || continue
  systemctl disable --now "$stale.timer" >/dev/null 2>&1 || true
  rm -f "$unit" "/etc/systemd/system/$stale.service"
  echo "retired $stale.timer"
done
systemctl daemon-reload
echo "installed $($BIN --version) on $HOST"
