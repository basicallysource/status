package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// Sending a sample to the status page.
//
// Two endpoints, and they answer different questions on purpose. /host/<name>
// is how hard this machine is working, which is ours and never rendered.
// /beat/<monitor> is whether a service is alive, which is the customer's
// question and appears on the public page. A box that runs no monitored service
// only ever calls the first.

type Reporter struct {
	cfg    Config
	client *http.Client
}

func NewReporter(cfg Config) *Reporter {
	return &Reporter{
		cfg: cfg,
		// A timeout well under the tick interval. A request that hung longer
		// than a minute would let attempts overlap and stack up, which is how a
		// monitor becomes the load it is supposed to be watching for.
		client: &http.Client{Timeout: 20 * time.Second},
	}
}

func (r *Reporter) Send(ctx context.Context, s Sample) {
	r.post(ctx, "/host/"+r.cfg.Host, s)
	if r.cfg.Monitor == "" {
		return
	}
	r.post(ctx, "/beat/"+r.cfg.Monitor, r.serviceBeat(s))
}

// serviceBeat is the small public-facing subset: is the unit up, how full is
// the disk it needs, and what version is on it. Deliberately not the whole
// sample — the box's vitals are not a service's status, and the two get mixed
// up the moment they travel together.
func (r *Reporter) serviceBeat(s Sample) Sample {
	beat := Sample{"service": r.unitState()}
	if v, ok := s["disk_pct"]; ok {
		beat["disk_pct"] = v
	}
	if v := readTrimmed(installedVersionFile); v != "" {
		beat["version"] = v
	}
	// The release agent rewrites this file on every poll that still has work to
	// do, so an untouched one is the opinion of an agent that is no longer
	// running. Reporting it is what lets the page tell a restart from an outage.
	if v := freshFlag(pendingDeployFile, 5*time.Minute); v != "" {
		beat["deploying"] = v
	}
	return beat
}

// unitState asks systemd whether the unit is up.
//
// The one place this program shells out, and it is worth being uncomfortable
// about. There is no file that answers "is this unit active" — the cgroup
// existing means the unit has processes, which is close but reports a unit
// wedged in `activating` as healthy. `systemctl is-active` is one short-lived
// process a minute against a number that decides whether the public page says
// there is an outage, and being right there matters more than the fork.
func (r *Reporter) unitState() string {
	if r.cfg.Unit == "" {
		return "unknown"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "systemctl", "is-active", r.cfg.Unit).Output()
	state := strings.TrimSpace(string(out))
	if state == "" {
		if err != nil {
			return "unknown" // never claim "inactive" on the strength of a failed command
		}
		return "unknown"
	}
	return state
}

func (r *Reporter) post(ctx context.Context, path string, body Sample) {
	payload, err := json.Marshal(body)
	if err != nil {
		log.Printf("could not encode %s: %v", path, err)
		return
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.cfg.StatusURL+path, bytes.NewReader(payload))
	if err != nil {
		log.Printf("could not build request for %s: %v", path, err)
		return
	}
	req.Header.Set("Authorization", "Bearer "+r.cfg.Token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "status-collector/"+version)

	res, err := r.client.Do(req)
	if err != nil {
		// Expected and survivable: a dropped network, a Cloudflare blip. The
		// gap in the data is the honest record of it.
		log.Printf("could not report %s: %v", path, err)
		return
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		// 401 here means the token is not scoped to this name, which is a
		// misconfiguration a human has to fix, so say so rather than counting it.
		log.Printf("reporting %s was refused: %s", path, res.Status)
	}
}

func numCPU() int { return runtime.NumCPU() }

func prettyJSON(v any) string {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return fmt.Sprintf("%v", v)
	}
	return string(b)
}
