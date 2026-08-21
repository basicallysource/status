package main

import (
	"os"
	"strings"
	"time"
)

// Configuration is the environment file and nothing else — no flags that change
// behaviour, no config format to parse. systemd already knows how to hold an
// EnvironmentFile at mode 600, and a credential belongs in one of those rather
// than on a command line, where it would be in the process list of every other
// user on the box.
type config struct {
	host       string            // the box's name; must match the token's host: scope
	token      string            // scoped credential
	statusURL  string            // where reports go
	monitor    string            // optional: also send a service heartbeat for this monitor
	unit       string            // optional: the systemd unit that heartbeat reports on
	services   []string          // units or containers to record memory for
	disks      map[string]string // label -> mount point
	interval   time.Duration
	updateFrom string // GitHub repo to self-update from; empty disables
}

func load() config {
	cfg := config{
		host:       env("HOST", ""),
		token:      env("BEAT_TOKEN", ""),
		statusURL:  strings.TrimSuffix(env("STATUS_URL", "https://status.basically.website"), "/"),
		monitor:    env("MONITOR", ""),
		unit:       env("UNIT", ""),
		services:   splitList(env("SERVICES", "")),
		disks:      splitPairs(env("DISKS", "disk=/")),
		interval:   60 * time.Second,
		updateFrom: env("UPDATE_FROM", "basicallysource/status"),
	}
	if d, err := time.ParseDuration(env("INTERVAL", "")); err == nil && d >= time.Second {
		cfg.interval = d
	}
	return cfg
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

// splitPairs reads "disk=/,data=/mnt/15m" into a label -> path map.
func splitPairs(raw string) map[string]string {
	out := map[string]string{}
	for _, item := range splitList(raw) {
		if label, path, ok := strings.Cut(item, "="); ok {
			out[strings.TrimSpace(label)] = strings.TrimSpace(path)
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
