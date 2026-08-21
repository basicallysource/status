package host

import (
	"path/filepath"
	"strings"
)

// The individual /proc readers. Each one is free to find nothing: a kernel
// without pressure accounting, a box with no swap, a fixture directory holding
// three files. Missing keys are the honest report of that.

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
// Deliberately skips loop, ram and device-mapper entries, and skips partitions —
// counting sda and sda1 both would double every byte.
func (c *Collector) readDiskstats(cur *counters) {
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

func (c *Collector) readNetDev(cur *counters) {
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
