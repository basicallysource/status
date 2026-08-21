// status-collector reports one box to status.basically.website, once a minute.
//
// It replaces a hand-installed shell script, and the reason is not that Go is
// nicer than bash. It is that nobody could tell what was actually running on a
// box without going and reading it — which is the same failure this whole
// project exists to fix. Docker's healthchecks reported green through a six-hour
// outage because the thing reporting was accountable to nothing outside itself.
// A collector that drifts silently is a monitor you cannot trust. This one
// carries a version, says it on every report, and updates itself from a
// published release, so "what is running on blip" is a question with an answer.
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
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/basicallysource/status/collector/internal/host"
	"github.com/basicallysource/status/collector/internal/report"
	"github.com/basicallysource/status/collector/internal/selfupdate"
)

// version is set at build time with -ldflags. "dev" means somebody ran this
// from a laptop, and it shows up on the status page as exactly that.
var version = "dev"

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

	cfg := load()
	collector := host.New(host.Options{Root: "/", Disks: cfg.disks, Services: cfg.services})

	if *once {
		// Twice, a second apart: the first reading has no previous counters to
		// subtract from, so printing it would show levels and no rates and look
		// like the rate readers were broken.
		collector.Collect(time.Now())
		time.Sleep(time.Second)
		fmt.Println(prettyJSON(sample(collector, time.Now())))
		return
	}

	if cfg.host == "" || cfg.token == "" {
		log.Fatal("HOST and BEAT_TOKEN are required; see collector/README.md")
	}
	log.Printf("status-collector %s reporting %s to %s every %s", version, cfg.host, cfg.statusURL, cfg.interval)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	run(ctx, cfg, collector)
}

func run(ctx context.Context, cfg config, collector *host.Collector) {
	reporter := report.New(report.Options{
		StatusURL: cfg.statusURL,
		Host:      cfg.host,
		Token:     cfg.token,
		Monitor:   cfg.monitor,
		Unit:      cfg.unit,
		Version:   version,
	})
	// Prime the counters so the first report a minute from now carries rates.
	collector.Collect(time.Now())

	ticker := time.NewTicker(cfg.interval)
	defer ticker.Stop()

	// Check for a new version shortly after starting, not a full interval
	// later. A box that was off for a week should come back current rather than
	// spend half an hour on whatever it was running when it stopped — and if a
	// bad version is crash-looping, this is the path that pulls the fix.
	// Not instantly: a restart loop should not hammer GitHub either.
	updates := time.NewTimer(2 * time.Minute)
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
			reporter.Send(ctx, sample(collector, now))
		case <-updates.C:
			if cfg.updateFrom != "" && selfupdate.Run(ctx, cfg.updateFrom, version) {
				// Exit cleanly and let systemd start the new binary.
				os.Exit(0)
			}
			updates.Reset(selfupdate.Interval)
		}
	}
}

// sample is one report: everything read from the box, plus the version of the
// thing saying it. The collector's own version rides on every sample, which is
// what makes a drifted box visible instead of merely suspected.
func sample(collector *host.Collector, now time.Time) host.Sample {
	s := collector.Collect(now)
	s["collector"] = version
	return s
}

func prettyJSON(v any) string {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return fmt.Sprintf("%v", v)
	}
	return string(b)
}
