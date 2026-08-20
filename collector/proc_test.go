package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The fixtures under testdata/box are a real box's /proc and /sys, trimmed.
// Every reader points at a root, so all of this runs on the Mac these machines
// are managed from — no Linux, no container, no root.

const fixture = "testdata/box"

func at(sec int) time.Time { return time.Unix(int64(sec), 0) }

func TestLevelsAreReadStraightOff(t *testing.T) {
	s := NewCollector(fixture).Collect(at(0))
	want := map[string]any{
		"load1":         1.28,
		"load15":        1.72,
		"procs_running": 3.0,
		"procs_blocked": 1.0,
		"uptime_s":      int64(12599113),
		"oom_kills":     int64(3),
	}
	for k, v := range want {
		if s[k] != v {
			t.Errorf("%s = %v, want %v", k, s[k], v)
		}
	}
}

func TestMemoryUsesAvailableNotFree(t *testing.T) {
	s := NewCollector(fixture).Collect(at(0))
	// MemFree is 220160 kB of 4009152, which would read as 94.5% used and be
	// alarming nonsense. MemAvailable is 2208768, so 44.9% is the truth.
	if got := s["mem_pct"]; got != 44.9 {
		t.Errorf("mem_pct = %v, want 44.9 (from MemAvailable, not MemFree)", got)
	}
	if got := s["swap_pct"]; got != 3.4 {
		t.Errorf("swap_pct = %v, want 3.4", got)
	}
}

func TestSwapPercentIsZeroWhenThereIsNoSwap(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, "proc/meminfo", "MemTotal: 1000 kB\nMemAvailable: 500 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n")
	s := NewCollector(root).Collect(at(0))
	// Not absent and not a divide by zero: a box with no swap is using none of
	// it, and that is a different claim from "not measured".
	if got := s["swap_pct"]; got != 0.0 {
		t.Errorf("swap_pct = %v, want 0", got)
	}
}

func TestPressureIsRecordedForEveryResource(t *testing.T) {
	s := NewCollector(fixture).Collect(at(0))
	want := map[string]any{
		"psi_cpu_some":    1.75,
		"psi_memory_some": 12.4,
		"psi_memory_full": 9.9,
		"psi_io_some":     3.3,
		"psi_io_full":     2.1,
	}
	for k, v := range want {
		if s[k] != v {
			t.Errorf("%s = %v, want %v", k, s[k], v)
		}
	}
	// The fixture's cpu file has no `full` line. Real kernels vary on this, and
	// that is the point: a key absent from the source is absent from the sample
	// rather than filled in with a zero, which a chart would draw as a
	// measurement we never took.
	if _, ok := s["psi_cpu_full"]; ok {
		t.Error("psi_cpu_full should be absent when the source has no full line")
	}
}

func TestFirstSampleHasNoRates(t *testing.T) {
	s := NewCollector(fixture).Collect(at(0))
	for _, k := range []string{"cpu_busy_pct", "cpu_steal_pct", "disk_read_mb_s", "net_rx_mb_s", "ctxt_per_sec"} {
		if _, ok := s[k]; ok {
			t.Errorf("%s should be absent on the first sample; there is nothing to subtract from", k)
		}
	}
	// Levels are still there. A restart costs the rates for one interval, not
	// the whole report.
	if _, ok := s["mem_pct"]; !ok {
		t.Error("levels should be present on the first sample")
	}
}

func TestCPUIsBrokenOutIncludingSteal(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, "proc/stat", "cpu  100 10 100 800 10 0 10 20\n")
	c := NewCollector(root)
	c.Collect(at(0))
	// 20 more jiffies of steal out of 200 elapsed: the hypervisor gave 10% of
	// this box's time to somebody else. Nothing else on the machine can tell
	// you that, and over a month it is the difference between "our code got
	// slower" and "our neighbour got busier".
	writeFixture(t, root, "proc/stat", "cpu  140 10 120 920 10 0 10 40\n")
	s := c.Collect(at(60))
	if got := s["cpu_steal_pct"]; got != 10.0 {
		t.Errorf("cpu_steal_pct = %v, want 10", got)
	}
	for _, k := range []string{"cpu_user_pct", "cpu_system_pct", "cpu_iowait_pct", "cpu_busy_pct"} {
		if _, ok := s[k]; !ok {
			t.Errorf("%s missing from the second sample", k)
		}
	}
}

func TestNoElapsedJiffiesMeansNoPercentages(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, "proc/stat", "cpu  100 0 100 800 0 0 0 0\n")
	c := NewCollector(root)
	c.Collect(at(0))
	// Identical counters: the box did not advance. A percentage of nothing is
	// not zero, it is undefined, and reporting 0% busy would be a lie a chart
	// would happily draw.
	s := c.Collect(at(60))
	if _, ok := s["cpu_busy_pct"]; ok {
		t.Error("cpu_busy_pct should be absent when no jiffies elapsed")
	}
}

func TestRatesAreComputedAgainstElapsedTime(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, "proc/stat", "cpu  100 0 100 800 0 0 0 0\nctxt 1000\nprocesses 100\n")
	c := NewCollector(root)
	c.Collect(at(0))
	// 600 more context switches over 60 seconds is 10/sec.
	writeFixture(t, root, "proc/stat", "cpu  200 0 200 1600 0 0 0 0\nctxt 1600\nprocesses 100\n")
	s := c.Collect(at(60))
	if got := s["ctxt_per_sec"]; got != 10.0 {
		t.Errorf("ctxt_per_sec = %v, want 10", got)
	}
	// user went 100->200 and system 100->200 of a 1000-jiffy span: 10% each,
	// and busy is everything that was not idle.
	if got := s["cpu_user_pct"]; got != 10.0 {
		t.Errorf("cpu_user_pct = %v, want 10", got)
	}
	if got := s["cpu_busy_pct"]; got != 20.0 {
		t.Errorf("cpu_busy_pct = %v, want 20", got)
	}
}

func TestCountersGoingBackwardsAreNotNegativeRates(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, "proc/stat", "cpu  100 0 100 800 0 0 0 0\nctxt 99999\nprocesses 500\n")
	c := NewCollector(root)
	c.Collect(at(0))
	// A reboot: every counter since boot restarts at something smaller.
	writeFixture(t, root, "proc/stat", "cpu  1 0 1 8 0 0 0 0\nctxt 10\nprocesses 2\n")
	s := c.Collect(at(60))
	if got := s["ctxt_per_sec"]; got != 0.0 {
		t.Errorf("ctxt_per_sec = %v after a reboot, want 0 — a rate is never negative", got)
	}
}

func TestDiskAndNetworkSkipWhatWouldDoubleCount(t *testing.T) {
	c := NewCollector(fixture)
	c.Collect(at(0))
	c.Collect(at(60))
	// vda and vda1 are the same bytes counted twice; loop0 is a squashfs mount.
	if got := c.prev.diskIO.readSectors; got != 40000000 {
		t.Errorf("read sectors = %d, want 40000000 (vda only, not vda1 or loop0)", got)
	}
	// lo is this box talking to itself and docker0 is container-to-container;
	// counting either would make internal chatter look like real traffic.
	if got := c.prev.net.rxBytes; got != 5000000 {
		t.Errorf("rx bytes = %d, want 5000000 (eth0 only)", got)
	}
}

func TestPartitionDetection(t *testing.T) {
	for name, want := range map[string]bool{
		"sda": false, "sda1": true, "vda": false, "vda15": true,
		"nvme0n1": false, "nvme0n1p1": true, "xvdf": false,
	} {
		if got := isPartition(name); got != want {
			t.Errorf("isPartition(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestPerServiceMemoryIsReadFromCgroups(t *testing.T) {
	s := Sample{}
	NewCollector(fixture).readServices(s, []string{"balloon-bot.service"})
	if got := s["svc_balloon_bot_mem_mb"]; got != 1073.7 {
		t.Errorf("svc_balloon_bot_mem_mb = %v, want 1073.7", got)
	}
	if got := s["svc_balloon_bot_mem_peak_mb"]; got != 1610.6 {
		t.Errorf("peak = %v, want 1610.6", got)
	}
	// The counters that say a service is being killed inside its own limit
	// while the box looks fine.
	if got := s["svc_balloon_bot_oom_kill"]; got != int64(1) {
		t.Errorf("oom_kill = %v, want 1", got)
	}
	if got := s["svc_balloon_bot_oom"]; got != int64(2) {
		t.Errorf("oom = %v, want 2", got)
	}
}

func TestAStoppedServiceReportsNothingRatherThanZero(t *testing.T) {
	s := Sample{}
	NewCollector(fixture).readServices(s, []string{"not-running.service"})
	// Absent, not 0. "Using no memory" and "not running" are different facts,
	// and a zero would draw a line along the bottom of a chart as if it were.
	if len(s) != 0 {
		t.Errorf("a stopped service produced %v, want nothing", s)
	}
}

func TestNothingPanicsOnABoxMissingEverything(t *testing.T) {
	// An empty root stands in for an old kernel with no PSI, a container with
	// no cgroup files, a box with no swap. Each reader contributes nothing and
	// none of them takes the others down.
	s := NewCollector(t.TempDir()).Collect(at(0))
	NewCollector(t.TempDir()).readServices(s, []string{"whatever.service"})
}

func TestServiceLabelsAreSafeMetricKeys(t *testing.T) {
	for unit, want := range map[string]string{
		"balloon-bot.service": "balloon_bot",
		"hive-backend":        "hive_backend",
		"traefik.scope":       "traefik",
	} {
		if got := serviceLabel(unit); got != want {
			t.Errorf("serviceLabel(%q) = %q, want %q", unit, got, want)
		}
	}
}

func writeFixture(t *testing.T, root, rel, body string) {
	t.Helper()
	full := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestDockerContainersAreFoundByName(t *testing.T) {
	// Docker names its cgroup scope for the container's full 64-char id, which
	// nothing else on the box knows, so a name in config has to be resolved
	// through docker's own state before any memory can be read for it.
	s := Sample{}
	NewCollector(fixture).readServices(s, []string{"hive-backend"})
	if got := s["svc_hive_backend_mem_mb"]; got != 2147.5 {
		t.Errorf("svc_hive_backend_mem_mb = %v, want 2147.5", got)
	}
	if got := s["svc_hive_backend_oom"]; got != int64(1) {
		t.Errorf("svc_hive_backend_oom = %v, want 1", got)
	}
}

func TestOnlyRunningContainersAreLookedUp(t *testing.T) {
	// The map is built from cgroup scopes, which only exist for running
	// containers — not from /var/lib/docker/containers, which keeps a directory
	// for every container that ever ran here and would grow without bound.
	found := NewCollector(fixture).dockerContainers()
	if len(found) != 1 {
		t.Errorf("found %d containers, want 1 (only the one with a live scope)", len(found))
	}
	if _, ok := found["hive-backend"]; !ok {
		t.Errorf("hive-backend not resolved: %v", found)
	}
}
