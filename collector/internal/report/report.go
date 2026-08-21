// Package report sends a sample to the status page.
//
// Two endpoints, and they answer different questions on purpose. /host/<name>
// is how hard this machine is working, which is ours and never rendered.
// /beat/<monitor> is whether a service is alive, which is the customer's
// question and appears on the public page. A box that runs no monitored service
// only ever calls the first.
package report

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/basicallysource/status/collector/internal/host"
)

// Where the release agent on a box records what it installed and what it is in
// the middle of installing. Read, never written: reporting them is what lets the
// page tell a restart from an outage.
const (
	installedVersionFile = "/var/lib/balloon-release/installed/bot"
	pendingDeployFile    = "/run/balloon-deploy"
)

type Options struct {
	StatusURL string // https://status.basically.website
	Host      string // the box's name; must match the token's host: scope
	Token     string // scoped credential
	Monitor   string // optional: also send a service heartbeat for this monitor
	Unit      string // optional: the systemd unit whose liveness that heartbeat reports
	Version   string // the collector's own version, for the User-Agent
}

type Reporter struct {
	opts   Options
	client *http.Client
}

func New(opts Options) *Reporter {
	opts.StatusURL = strings.TrimSuffix(opts.StatusURL, "/")
	return &Reporter{
		opts: opts,
		// A timeout well under the tick interval. A request that hung longer
		// than a minute would let attempts overlap and stack up, which is how a
		// monitor becomes the load it is supposed to be watching for.
		client: &http.Client{Timeout: 20 * time.Second},
	}
}

func (r *Reporter) Send(ctx context.Context, s host.Sample) {
	r.post(ctx, "/host/"+r.opts.Host, s)
	if r.opts.Monitor == "" {
		return
	}
	r.post(ctx, "/beat/"+r.opts.Monitor, r.serviceBeat(s))
}

// serviceBeat is the small public-facing subset: is the unit up, how full is
// the disk it needs, and what version is on it. Deliberately not the whole
// sample — the box's vitals are not a service's status, and the two get mixed
// up the moment they travel together.
func (r *Reporter) serviceBeat(s host.Sample) host.Sample {
	beat := host.Sample{"service": r.unitState()}
	if v, ok := s["disk_pct"]; ok {
		beat["disk_pct"] = v
	}
	if v := readTrimmed(installedVersionFile); v != "" {
		beat["version"] = v
	}
	// The release agent rewrites this file on every poll that still has work to
	// do, so an untouched one is the opinion of an agent that is no longer
	// running.
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
	if r.opts.Unit == "" {
		return "unknown"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// The exit code is not the signal: `is-active` exits non-zero for a unit
	// that is merely stopped, and still prints the word. No output at all is the
	// command itself having failed, and we never claim "inactive" on that.
	out, _ := exec.CommandContext(ctx, "systemctl", "is-active", r.opts.Unit).Output()
	if state := strings.TrimSpace(string(out)); state != "" {
		return state
	}
	return "unknown"
}

func (r *Reporter) post(ctx context.Context, path string, body host.Sample) {
	payload, err := json.Marshal(body)
	if err != nil {
		log.Printf("could not encode %s: %v", path, err)
		return
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.opts.StatusURL+path, bytes.NewReader(payload))
	if err != nil {
		log.Printf("could not build request for %s: %v", path, err)
		return
	}
	req.Header.Set("Authorization", "Bearer "+r.opts.Token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "status-collector/"+r.opts.Version)

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

func readTrimmed(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// freshFlag returns a file's contents only if it was written recently. A stale
// file is a claim nobody has renewed, and treating it as current is how a
// finished deploy goes on excusing a real outage.
func freshFlag(path string, within time.Duration) string {
	fi, err := os.Stat(path)
	if err != nil || time.Since(fi.ModTime()) > within {
		return ""
	}
	value := readTrimmed(path)
	if len(value) > 64 {
		value = value[:64]
	}
	return value
}
