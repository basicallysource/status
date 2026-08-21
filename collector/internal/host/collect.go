// Package host reads what a box knows about itself, out of /proc, /sys and one
// statfs.
//
// Two rules hold this package together.
//
// One: never fork, never walk a filesystem. Every number here is a read of a
// file the kernel synthesises in memory, or a single statfs. Sizing a directory
// is the one measurement on these boxes that costs real I/O, and it is what made
// a disk-usage number expensive enough to notice. `du` does not belong here, and
// neither does anything that shells out.
//
// Two: rates need two readings. /proc/stat and /proc/diskstats are counters
// since boot, so "CPU is 40% busy" is only meaningful as a delta between two
// samples. That is why the collector is resident rather than a timer firing a
// script — a process that exits cannot subtract, and the alternative is writing
// the last reading to disk every minute forever.
package host

import (
	"bufio"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Sample is one moment of a box, as flat key/value pairs. Flat on purpose: it
// lands in a JSON column and gets queried by key, and nesting would mean every
// reader had to know the shape.
type Sample map[string]any

// Options is everything a collector needs to know before it can read a box.
type Options struct {
	// Root is "/" in production and a fixture directory under test, which is
	// what makes every reader here runnable without a Linux box.
	Root string
	// Disks maps a metric label to a mount point: {"disk": "/"}.
	Disks map[string]string
	// Services are systemd units or docker container names to record memory
	// for. Named rather than discovered — see cgroup.go.
	Services []string
}

// Collector holds what it needs to turn counters into rates.
type Collector struct {
	root     string
	disks    map[string]string
	services []string
	prev     *counters
}

// counters is the raw cumulative state, kept only to subtract from next time.
type counters struct {
	at     time.Time
	cpu    cpuTimes
	diskIO diskIO
	net    netTotals
	ctxt   uint64
	forks  uint64
}

type cpuTimes struct {
	user, nice, system, idle, iowait, irq, softirq, steal uint64
}

func (c cpuTimes) total() uint64 {
	return c.user + c.nice + c.system + c.idle + c.iowait + c.irq + c.softirq + c.steal
}

type diskIO struct {
	readSectors, writeSectors, ioMillis uint64
}

type netTotals struct {
	rxBytes, txBytes uint64
}

func New(opts Options) *Collector {
	if opts.Root == "" {
		opts.Root = "/"
	}
	return &Collector{root: opts.Root, disks: opts.Disks, services: opts.Services}
}

func (c *Collector) path(parts ...string) string {
	return filepath.Join(append([]string{c.root}, parts...)...)
}

// Collect reads everything once.
//
// A reader that fails contributes nothing and does not stop the others: a kernel
// without pressure stalls, a container without cgroup files, a box with no swap
// are all ordinary, and none of them is a reason to report nothing at all. A
// missing key means "not measured here", which is exactly what an absent column
// should mean.
func (c *Collector) Collect(now time.Time) Sample {
	s := Sample{}
	c.readLoad(s)
	c.readMeminfo(s)
	c.readPressure(s)
	c.readUptime(s)
	c.readVmstat(s)
	c.readDiskUsage(s)
	c.readServices(s)
	s["cpus"] = runtime.NumCPU()

	cur := &counters{at: now}
	c.readStat(s, cur)
	c.readDiskstats(cur)
	c.readNetDev(cur)

	// Rates only once there is something to subtract from. The first sample
	// after a restart carries levels but no rates, which is honest: we do not
	// know what happened while we were not running.
	if c.prev != nil {
		elapsed := now.Sub(c.prev.at).Seconds()
		if elapsed > 0 {
			c.rates(s, cur, elapsed)
		}
	}
	c.prev = cur
	return s
}

func (c *Collector) rates(s Sample, cur *counters, elapsed float64) {
	// Unsigned subtraction wraps, so a reboot would otherwise turn into an
	// enormous positive span and a set of plausible-looking percentages of
	// nothing. Compare before subtracting, always.
	if cur.cpu.total() > c.prev.cpu.total() {
		span := cur.cpu.total() - c.prev.cpu.total()
		f := func(now, was uint64) float64 {
			if now < was {
				return 0
			}
			return round1(float64(now-was) * 100 / float64(span))
		}
		s["cpu_user_pct"] = f(cur.cpu.user+cur.cpu.nice, c.prev.cpu.user+c.prev.cpu.nice)
		s["cpu_system_pct"] = f(cur.cpu.system+cur.cpu.irq+cur.cpu.softirq, c.prev.cpu.system+c.prev.cpu.irq+c.prev.cpu.softirq)
		s["cpu_iowait_pct"] = f(cur.cpu.iowait, c.prev.cpu.iowait)
		// Steal is the number that cannot be got any other way and the one that
		// explains a box getting slower without our code changing: it is time
		// the hypervisor gave to somebody else's VM. On a shared droplet a slow
		// month-long climb here is the neighbour, not us.
		s["cpu_steal_pct"] = f(cur.cpu.steal, c.prev.cpu.steal)
		s["cpu_busy_pct"] = round1(100 - f(cur.cpu.idle, c.prev.cpu.idle))
	}
	perSec := func(now, was uint64) float64 {
		if now < was {
			return 0 // a counter that went backwards is a reboot, not a negative rate
		}
		return round1(float64(now-was) / elapsed)
	}
	s["ctxt_per_sec"] = perSec(cur.ctxt, c.prev.ctxt)
	s["forks_per_sec"] = perSec(cur.forks, c.prev.forks)
	// Sectors are 512 bytes by kernel convention in diskstats, regardless of the
	// device's own sector size.
	s["disk_read_mb_s"] = round2(perSec(cur.diskIO.readSectors, c.prev.diskIO.readSectors) * 512 / 1e6)
	s["disk_write_mb_s"] = round2(perSec(cur.diskIO.writeSectors, c.prev.diskIO.writeSectors) * 512 / 1e6)
	// Milliseconds of I/O per second: 1000 means the disk was busy the whole
	// time, which is saturation however small the byte counts look.
	s["disk_busy_pct"] = round1(min(perSec(cur.diskIO.ioMillis, c.prev.diskIO.ioMillis)/10, 100))
	s["net_rx_mb_s"] = round2(perSec(cur.net.rxBytes, c.prev.net.rxBytes) / 1e6)
	s["net_tx_mb_s"] = round2(perSec(cur.net.txBytes, c.prev.net.txBytes) / 1e6)
}

func (c *Collector) readFile(parts ...string) string {
	b, err := os.ReadFile(c.path(parts...))
	if err != nil {
		return ""
	}
	return string(b)
}

func (c *Collector) eachLine(rel string, fn func(string)) {
	f, err := os.Open(c.path(rel))
	if err != nil {
		return
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		fn(scanner.Text())
	}
}

func num(s string) float64 {
	v, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return 0
	}
	return v
}

func round1(v float64) float64 { return float64(int64(v*10+0.5)) / 10 }
func round2(v float64) float64 { return float64(int64(v*100+0.5)) / 100 }
