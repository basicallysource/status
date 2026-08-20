package main

import (
	"bufio"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Everything a box knows about itself, read from /proc and /sys.
//
// Two rules hold this file together.
//
// One: never fork, never walk a filesystem. Every number here is a read of a
// file the kernel synthesises in memory, or a single statfs. Sizing a directory
// is the one measurement on these boxes that costs real I/O, and it is what made
// a disk-usage number expensive enough to notice. `du` does not belong here, and
// neither does anything that shells out.
//
// Two: rates need two readings. /proc/stat and /proc/diskstats are counters
// since boot, so "CPU is 40% busy" is only meaningful as a delta between two
// samples. That is why this program is resident rather than a timer firing a
// script — a process that exits cannot subtract, and the alternative is writing
// the last reading to disk every minute forever.

// Sample is one moment of a box, as flat key/value pairs. Flat on purpose: it
// lands in a JSON column and gets queried by key, and nesting would mean every
// reader had to know the shape.
type Sample map[string]any

// Collector holds what it needs to turn counters into rates.
//
// root is "/" in production and a fixture directory under test, which is what
// makes every reader here testable without a Linux box or a fake /proc mount.
type Collector struct {
	root string
	prev *counters
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

func NewCollector(root string) *Collector {
	if root == "" {
		root = "/"
	}
	return &Collector{root: root}
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

	cur := &counters{at: now}
	c.readStat(s, cur)
	c.readDiskstats(s, cur)
	c.readNetDev(s, cur)

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

func (c *Collector) readLoad(s Sample) {
	fields := strings.Fields(c.readFile("proc", "loadavg"))
	if len(fields) < 4 {
		return
	}
	s["load1"] = num(fields[0])
	s["load5"] = num(fields[1])
	s["load15"] = num(fields[2])
	// "2/431" — runnable over total. Runnable above the CPU count is the queue
	// that load average is a smoothed guess at, without the smoothing.
	if run, _, ok := strings.Cut(fields[3], "/"); ok {
		s["procs_running"] = num(run)
	}
}

func (c *Collector) readMeminfo(s Sample) {
	kb := map[string]float64{}
	c.eachLine("proc/meminfo", func(line string) {
		key, rest, ok := strings.Cut(line, ":")
		if !ok {
			return
		}
		fields := strings.Fields(rest)
		if len(fields) > 0 {
			kb[key] = num(fields[0])
		}
	})
	total := kb["MemTotal"]
	if total <= 0 {
		return
	}
	// MemAvailable, not MemFree: the kernel's own estimate of what a new process
	// could actually get, counting reclaimable cache. MemFree on a healthy box
	// looks alarming and means nothing.
	avail := kb["MemAvailable"]
	s["mem_total_mb"] = round1(total / 1024)
	s["mem_available_mb"] = round1(avail / 1024)
	s["mem_pct"] = round1((total - avail) * 100 / total)
	s["cached_mb"] = round1(kb["Cached"] / 1024)
	// Dirty pages waiting to be written. A number that climbs and stays is a
	// disk that cannot keep up with what is being asked of it.
	s["dirty_mb"] = round1(kb["Dirty"] / 1024)
	if swapTotal := kb["SwapTotal"]; swapTotal > 0 {
		s["swap_total_mb"] = round1(swapTotal / 1024)
		s["swap_pct"] = round1((swapTotal - kb["SwapFree"]) * 100 / swapTotal)
	} else {
		s["swap_pct"] = 0.0
	}
}

// readPressure reads PSI, which is the best single answer to "is this box
// suffering" and is not derivable from anything else here.
//
// Load average counts runnable tasks, so it cannot tell a busy box from a stuck
// one — hive at load 5 could be working hard or thrashing, and the number is the
// same. PSI measures the share of wall-clock time that work was stalled waiting
// for a resource. `some` is any task stalled; `full` is everything stalled at
// once, which on memory is the shape of a box about to die.
func (c *Collector) readPressure(s Sample) {
	for _, res := range []string{"cpu", "io", "memory"} {
		c.eachLine(filepath.Join("proc/pressure", res), func(line string) {
			fields := strings.Fields(line)
			if len(fields) < 2 {
				return
			}
			kind := fields[0] // "some" or "full"
			for _, f := range fields[1:] {
				k, v, ok := strings.Cut(f, "=")
				if ok && k == "avg60" {
					s["psi_"+res+"_"+kind] = num(v)
				}
			}
		})
	}
}

func (c *Collector) readUptime(s Sample) {
	fields := strings.Fields(c.readFile("proc", "uptime"))
	if len(fields) > 0 {
		// Reboot detection for free: uptime only counts up, so a smaller number
		// than the previous sample means the box restarted in between. Nothing
		// has to stay resident through a reboot to notice one happened.
		s["uptime_s"] = int64(num(fields[0]))
	}
}

func (c *Collector) readVmstat(s Sample) {
	c.eachLine("proc/vmstat", func(line string) {
		key, value, ok := strings.Cut(line, " ")
		if !ok {
			return
		}
		switch key {
		// Cumulative since boot. A delta between two samples is how we learn the
		// kernel killed something, without a process resident to watch dmesg —
		// which is what the OOM story on hive would have needed.
		case "oom_kill":
			s["oom_kills"] = int64(num(value))
		case "pgmajfault":
			s["major_faults"] = int64(num(value))
		}
	})
}

func (c *Collector) readStat(s Sample, cur *counters) {
	c.eachLine("proc/stat", func(line string) {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			return
		}
		switch fields[0] {
		case "cpu":
			get := func(i int) uint64 {
				if len(fields) > i {
					return uint64(num(fields[i]))
				}
				return 0
			}
			cur.cpu = cpuTimes{get(1), get(2), get(3), get(4), get(5), get(6), get(7), get(8)}
		case "ctxt":
			cur.ctxt = uint64(num(fields[1]))
		case "processes":
			cur.forks = uint64(num(fields[1]))
		case "procs_blocked":
			// Tasks stuck in uninterruptible sleep, which is almost always I/O.
			s["procs_blocked"] = num(fields[1])
		}
	})
}

// readDiskstats sums the real block devices.
//
// Deliberately skips loop, ram and device-mapper entries, and skips partitions
// by taking only devices whose name does not end in a digit after a letter —
// counting sda and sda1 both would double every byte.
func (c *Collector) readDiskstats(_ Sample, cur *counters) {
	c.eachLine("proc/diskstats", func(line string) {
		fields := strings.Fields(line)
		if len(fields) < 14 {
			return
		}
		name := fields[2]
		if strings.HasPrefix(name, "loop") || strings.HasPrefix(name, "ram") || strings.HasPrefix(name, "dm-") {
			return
		}
		if isPartition(name) {
			return
		}
		cur.diskIO.readSectors += uint64(num(fields[5]))
		cur.diskIO.writeSectors += uint64(num(fields[9]))
		cur.diskIO.ioMillis += uint64(num(fields[12]))
	})
}

// isPartition reports whether a device name looks like a slice of another one:
// sda1, nvme0n1p2, vda3. Whole devices are what we want to sum.
func isPartition(name string) bool {
	if strings.HasPrefix(name, "nvme") {
		return strings.Contains(name, "p") && endsWithDigit(name) && strings.LastIndex(name, "p") > strings.Index(name, "n")
	}
	return endsWithDigit(name)
}

func endsWithDigit(s string) bool {
	return s != "" && s[len(s)-1] >= '0' && s[len(s)-1] <= '9'
}

func (c *Collector) readNetDev(_ Sample, cur *counters) {
	c.eachLine("proc/net/dev", func(line string) {
		name, rest, ok := strings.Cut(line, ":")
		if !ok {
			return
		}
		name = strings.TrimSpace(name)
		// Loopback is this box talking to itself; counting it would make an
		// internal chatter spike look like traffic from the world.
		if name == "lo" || strings.HasPrefix(name, "veth") || strings.HasPrefix(name, "docker") || strings.HasPrefix(name, "br-") {
			return
		}
		fields := strings.Fields(rest)
		if len(fields) < 9 {
			return
		}
		cur.net.rxBytes += uint64(num(fields[0]))
		cur.net.txBytes += uint64(num(fields[8]))
	})
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
