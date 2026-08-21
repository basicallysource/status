# status-collector

Reports one box to status.basically.website, once a minute. Go, no dependencies,
one static binary, ~6 MB.

## Why a program and not a script

The shell script this replaced was installed by hand, so nobody could tell what
was running on a box without going and reading it. That is the same failure this
whole project exists to fix: Docker's healthchecks reported green through a
six-hour outage because the thing reporting was accountable to nothing outside
itself. This one carries a version, says it on every sample, and updates itself
from a published release.

The other reason is arithmetic. `/proc/stat` and `/proc/diskstats` count since
boot, so "CPU is 8% busy" only exists as a delta between two readings — and a
script that exits cannot subtract. Being resident is what buys the CPU
breakdown, the I/O and network rates, and noticing an OOM kill between one
minute and the next.

## What it reads

All of it from `/proc` and `/sys`, plus one `statfs`. No forks, no filesystem
walks — sizing a directory is the one measurement on these boxes that costs real
I/O. The single exception is `systemctl is-active`, and only on a box that also
reports a service heartbeat.

| | |
|---|---|
| load | `load1` `load5` `load15` `procs_running` `procs_blocked` |
| cpu | `cpu_busy_pct` `cpu_user_pct` `cpu_system_pct` `cpu_iowait_pct` **`cpu_steal_pct`** |
| memory | `mem_pct` `mem_total_mb` `mem_available_mb` `cached_mb` `dirty_mb` `swap_pct` |
| pressure | `psi_cpu_some` `psi_io_some/full` `psi_memory_some/full` |
| disk | `disk_pct` `disk_free_gb` `disk_read_mb_s` `disk_write_mb_s` `disk_busy_pct` |
| network | `net_rx_mb_s` `net_tx_mb_s` |
| kernel | `oom_kills` `major_faults` `ctxt_per_sec` `forks_per_sec` `uptime_s` |
| per service | `svc_<name>_mem_mb` `svc_<name>_mem_peak_mb` `svc_<name>_oom` `svc_<name>_oom_kill` |

Three of those earn their keep in ways the others cannot:

- **`cpu_steal_pct`** is time the hypervisor gave to another tenant. On a shared
  droplet a slow climb here over a month is the neighbour getting busier, and it
  is indistinguishable from our own code getting slower in every other metric.
- **PSI** is the share of wall-clock time work was *stalled* waiting for a
  resource. Load average counts runnable tasks, so it cannot tell a busy box
  from a stuck one. blip sits at load 0.24 with `psi_cpu_some` near 5.
- **`svc_*_mem_mb`** is what would have caught hive-backend climbing to 2.2 GB
  days before it started serving 502s.

Absent means not measured. A stopped service reports nothing rather than zero,
and a kernel without pressure stalls simply has no `psi_*` keys — a zero would
be drawn on a chart as a measurement nobody took.

## Configuration

`/etc/status-collector/collector.env`, mode 600:

```
HOST=blip                      # must match the token's host: scope
BEAT_TOKEN=...                 # scoped credential
MONITOR=balloon                # optional: also send a service heartbeat
UNIT=balloon-bot.service       # optional: the unit that heartbeat reports on
SERVICES=balloon-bot.service   # comma separated; units or container names
DISKS=disk=/                   # comma separated label=path
```

## Layout

```
cmd/status-collector/    the binary: config from the environment, and the tick loop
internal/host/           reading a box: /proc, /sys, statfs. No network, no forks.
internal/report/         sending a sample to the page. The only thing that knows the wire format.
internal/selfupdate/     replacing this binary with a newer release, safely.
install.sh               the one-time bootstrap
```

`internal/host` is the part worth keeping honest: it takes a root directory, so
every reader in it runs against a fixture on a laptop, and the tests need no
Linux box, no container, and no root.

## Running it

```bash
go test ./...
go run ./cmd/status-collector --once   # collect twice a second apart, print, exit
```

`--once` samples twice on purpose: the first reading has nothing to subtract
from, so printing it would show levels with no rates and look broken.

## Shipping

```bash
git tag collector-v1 && git push origin collector-v1
```

CI builds a static linux/amd64 binary, publishes it with a `.sha256`, and every
box picks it up within 30 minutes: verify the checksum, run the new binary's own
`--version` as a smoke test, then `rename(2)` it into place and exit so systemd
starts it. The outgoing binary is kept as `.prev`. A build made from a laptop
(`version` is `dev`) is never replaced automatically — somebody is debugging.

The one-time bootstrap is `install.sh`: copy it and the binary to a box, run it
with `HOST=` set, and put a credential in `/etc/status-collector/collector.env`.

## Limits

`MemoryMax=64M` and `CPUQuota=10%` in the unit, deliberately tight. The monitor
must never become the thing that needs monitoring, and blip has OOM-killed
things before.

Samples are never spooled. A report that fails is logged and dropped — replaying
an hour of stale samples later would let a box that was dead backfill an hour of
"I was fine", and the gap is the honest record.
