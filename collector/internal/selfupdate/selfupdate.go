// Package selfupdate keeps the collector current.
//
// The whole point of replacing the shell script was that a hand-installed thing
// drifts where nobody can see it. A program that ships with a version and then
// never updates has the same disease with better manners, so this checks for a
// newer release and installs it.
//
// Pull, not push, for the same reason every other agent here pulls: these boxes
// take no inbound connection from CI, so shipping never depends on GitHub being
// able to reach us. A check that does not happen costs one interval.
//
// The safety is in the order of operations. Download to a temp file beside the
// destination, verify the checksum published with the release, run the new
// binary's own --version as a smoke test, and only then rename(2) it into place
// — an atomic swap on the same filesystem, so there is no moment where the path
// holds half a binary. The old one is kept as .prev. If the new one cannot
// start, systemd restarts the service and the operator has something to roll
// back to.
package selfupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Interval is how often to look. Long on purpose: a version behind for half an
// hour costs nothing, and a fleet asking GitHub every minute is a fleet that
// gets rate-limited on the day it needs the fix.
const Interval = 30 * time.Minute

type release struct {
	TagName string `json:"tag_name"`
	Assets  []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
	} `json:"assets"`
}

// Run installs the latest release if it is not the one already running, and
// reports whether it did. The caller is expected to exit on true: systemd's
// Restart=always is the whole restart mechanism, so nothing here has to know
// how to exec itself.
func Run(ctx context.Context, repo, current string) bool {
	latest, err := latestRelease(ctx, repo, current)
	if err != nil {
		log.Printf("could not check for updates: %v", err)
		return false
	}
	want := strings.TrimPrefix(latest.TagName, "collector-")
	if want == "" || want == current {
		return false
	}
	// A binary built from a laptop should not be silently replaced by CI's idea
	// of current: somebody is debugging, and pulling the rug is unkind.
	if current == "dev" {
		log.Printf("release %s is available; not replacing a dev build", want)
		return false
	}
	if err := install(ctx, latest, want, current); err != nil {
		log.Printf("update to %s failed, staying on %s: %v", want, current, err)
		return false
	}
	log.Printf("updated %s -> %s, restarting", current, want)
	return true
}

func latestRelease(ctx context.Context, repo, current string) (*release, error) {
	url := fmt.Sprintf("https://api.github.com/repos/%s/releases/latest", repo)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "status-collector/"+current)
	res, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("github said %s", res.Status)
	}
	var out release
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&out); err != nil {
		return nil, err
	}
	return &out, nil
}

func install(ctx context.Context, latest *release, want, current string) error {
	binaryURL, sumURL := "", ""
	for _, a := range latest.Assets {
		switch a.Name {
		case "status-collector-linux-amd64":
			binaryURL = a.URL
		case "status-collector-linux-amd64.sha256":
			sumURL = a.URL
		}
	}
	if binaryURL == "" || sumURL == "" {
		return fmt.Errorf("release %s has no linux-amd64 binary and checksum", want)
	}

	self, err := os.Executable()
	if err != nil {
		return err
	}
	self, err = filepath.EvalSymlinks(self)
	if err != nil {
		return err
	}

	// Same directory as the destination, so the rename below is a rename and not
	// a copy across filesystems — the atomicity depends on it.
	tmp, err := os.CreateTemp(filepath.Dir(self), ".status-collector-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	hasher := sha256.New()
	if err := download(ctx, binaryURL, current, io.MultiWriter(tmp, hasher)); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}

	expected, err := fetchString(ctx, sumURL, current)
	if err != nil {
		return err
	}
	got := hex.EncodeToString(hasher.Sum(nil))
	if sum, _, _ := strings.Cut(strings.TrimSpace(expected), " "); !strings.EqualFold(sum, got) {
		return fmt.Errorf("checksum mismatch: release says %s, download is %s", sum, got)
	}
	if err := os.Chmod(tmpName, 0o755); err != nil {
		return err
	}

	// Smoke test before the swap. Catches an incompatible architecture, a
	// corrupt file that happened to match a corrupt checksum, and a build that
	// cannot start at all — while the running collector is still the old one.
	check, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	out, err := exec.CommandContext(check, tmpName, "--version").Output()
	if err != nil {
		return fmt.Errorf("the downloaded binary would not run: %w", err)
	}
	if reported := strings.TrimSpace(string(out)); reported != want {
		return fmt.Errorf("release %s contains a binary that says it is %s", want, reported)
	}

	// Keep the outgoing one. A rollback is then a move, not a download, which
	// matters on the box where the network is the thing that broke.
	_ = os.Rename(self, self+".prev")
	if err := os.Rename(tmpName, self); err != nil {
		_ = os.Rename(self+".prev", self) // put it back rather than leave nothing
		return err
	}
	return nil
}

func download(ctx context.Context, url, current string, dst io.Writer) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "status-collector/"+current)
	res, err := (&http.Client{Timeout: 5 * time.Minute}).Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("downloading %s: %s", url, res.Status)
	}
	// Bounded: a redirect to something enormous should fail, not fill the disk
	// of the box we are here to keep an eye on.
	_, err = io.Copy(dst, io.LimitReader(res.Body, 64<<20))
	return err
}

func fetchString(ctx context.Context, url, current string) (string, error) {
	var sb strings.Builder
	if err := download(ctx, url, current, &sb); err != nil {
		return "", err
	}
	return sb.String(), nil
}
