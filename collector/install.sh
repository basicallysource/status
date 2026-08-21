#!/bin/bash
# Put status-collector on a box, once. After this the collector updates itself.
#
# Run it from a laptop with the binary beside it:
#   scp status-collector install.sh root@<box>:/tmp/
#   ssh root@<box> 'HOST=blip MONITOR=balloon UNIT=balloon-bot.service \
#     SERVICES=balloon-bot.service bash /tmp/install.sh'
#
# BEAT_TOKEN is not passed here. This writes the env file without one and says
# so: a token typed on a command line ends up in shell history and in the process
# list of every other user on the box.
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

# An existing env file is left alone: it holds the credential, and re-running
# this to upgrade a box must not wipe it.
if [ ! -s "$ENV_FILE" ]; then
  umask 077
  cat > "$ENV_FILE" <<EOF
HOST=$HOST
BEAT_TOKEN=
MONITOR=$MONITOR
UNIT=$UNIT
SERVICES=$SERVICES
DISKS=$DISKS
EOF
  chmod 600 "$ENV_FILE"
  echo "NOTE: put a credential in $ENV_FILE before this reports anything"
fi

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
echo "installed $($BIN --version) on $HOST"
