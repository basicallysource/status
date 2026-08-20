// status-collector reports one box to status.basically.website, once a minute.
//
// It replaces a hand-installed shell script, and the reason is not that Go is
// nicer than bash. It is that nobody could tell what was actually running on a
// box without going and reading it — which is the same failure this whole
// project exists to fix. Docker's healthchecks reported green through a six-hour
// outage because the thing reporting was accountable to nothing outside itself.
// A collector that drifts silently is a monitor you cannot trust. This one
// carries a version, says it on every report, and updates itself from a signed
// release, so "what is running on blip" is a question with an answer.
//
// The second reason is that rates need memory. /proc/stat counts since boot, so
// CPU-busy is only meaningful as a delta between two readings, and a script that
// exits cannot subtract. Being resident is what buys the CPU breakdown, the I/O
// rates, and noticing an OOM kill between one minute and the next.
//
// What it is not: a decision-maker. It reports; the worker decides what is an
// outage. Nothing here alerts, retries into a queue, or holds state that matters
// past the next tick. If this program dies the box goes silent, and silence is
// already the loudest thing the status page knows how to say.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

// version is set at build time with -ldflags. "dev" means somebody ran this
// from a laptop, and it shows up on the status page as exactly that.
var version = "dev"

type Config struct {
	Host       string        // the box's name; must match the token's host: scope
	Token      string        // scoped credential, from the env file
	StatusURL  string        // where reports go
	Monitor    string        // optional: also send a service heartbeat for this monitor
	Unit       string        // optional: the systemd unit whose liveness the heartbeat reports
	Services   []string      // units or containers to record memory for
	Disks      []string      // label=path pairs to measure
	Interval   time.Duration //
	UpdateFrom string        // GitHub repo to self-update from; empty disables
}

func main() {
	once := flag.Bool("once", false, "collect and print one sample, then exit")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	// --version is what the updater runs against a freshly downloaded binary
	// before putting it in place. It is a smoke test: a truncated download or a
	// binary for the wrong architecture fails here rather than after the swap,
	// when the running collector is already gone.
	if *showVersion {
		fmt.Println(version)
		return
	}

	cfg := loadConfig()
	collector := NewCollector("/")

	if *once {
		// Twice, a second apart: the first reading has no previous counters to
		// subtract from, so printing it would show levels and no rates and look
		// like the rate readers were broken.
		collector.Collect(time.Now())
		time.Sleep(time.Second)
		fmt.Println(prettyJSON(collector.sample(cfg, time.Now())))
		return
	}

	if cfg.Host == "" || cfg.Token == "" {
		log.Fatal("HOST and BEAT_TOKEN are required; see collector/README.md")
	}
	log.Printf("status-collector %s reporting %s to %s every %s", version, cfg.Host, cfg.StatusURL, cfg.Interval)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	run(ctx, cfg, collector)
}

func run(ctx context.Context, cfg Config, collector *Collector) {
	reporter := NewReporter(cfg)
	// Prime the counters so the first report a minute from now carries rates.
	collector.Collect(time.Now())

	ticker := time.NewTicker(cfg.Interval)
	defer ticker.Stop()
	updates := time.NewTicker(updateInterval)
	defer updates.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Print("stopping")
			return
		case now := <-ticker.C:
			// A report that fails is logged and dropped, never retried and never
			// spooled. A queue of stale samples replayed later would let a box
			// that was dead for an hour backfill an hour of "I was fine", which
			// is worse than the gap it fills — the gap is true.
			reporter.Send(ctx, collector.sample(cfg, now))
		case <-updates.C:
			if cfg.UpdateFrom != "" {
				selfUpdate(ctx, cfg.UpdateFrom)
			}
		}
	}
}

// sample builds one report: everything read from the box, plus who and what
// version is saying it.
func (c *Collector) sample(cfg Config, now time.Time) Sample {
	s := c.Collect(now)
	c.readServices(s, cfg.Services)
	s["cpus"] = numCPU()
	// The collector's own version rides on every sample, which is what makes a
	// drifted box visible instead of merely suspected.
	s["collector"] = version
	return s
}

func loadConfig() Config {
	cfg := Config{
		Host:       env("HOST", ""),
		Token:      env("BEAT_TOKEN", ""),
		StatusURL:  strings.TrimSuffix(env("STATUS_URL", "https://status.basically.website"), "/"),
		Monitor:    env("MONITOR", ""),
		Unit:       env("UNIT", ""),
		Services:   splitList(env("SERVICES", "")),
		Disks:      splitList(env("DISKS", "disk=/")),
		UpdateFrom: env("UPDATE_FROM", "basicallysource/status"),
	}
	cfg.Interval = 60 * time.Second
	if d, err := time.ParseDuration(env("INTERVAL", "")); err == nil && d >= time.Second {
		cfg.Interval = d
	}
	return cfg
}

// disks resolves the DISKS setting into label -> path.
func (c *Collector) disks() map[string]string {
	out := map[string]string{}
	for _, item := range splitList(env("DISKS", "disk=/")) {
		if label, path, ok := strings.Cut(item, "="); ok {
			out[label] = path
		}
	}
	return out
}

func splitList(raw string) []string {
	var out []string
	for _, part := range strings.Split(raw, ",") {
		if part = strings.TrimSpace(part); part != "" {
			out = append(out, part)
		}
	}
	return out
}

func env(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}
