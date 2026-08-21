package host

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// Per-service memory, read straight out of cgroup v2.
//
// This is the reader that earns the whole program. On 2026-08-20 hive-backend
// leaked to 2.2 GB on a 3.9 GB box and served 502s for six hours, and the
// box-level number would have shown a busy machine without saying which process
// was eating it. `memory.current` for one unit says exactly that, and it is a
// file read — no docker API call, no `ps` sweep, no fork.
//
// It also carries `memory.events`, where the kernel counts how many times this
// cgroup hit its own limit. A service being repeatedly OOM-killed inside its
// limit is invisible in every box-level metric: the box is fine, the service is
// dying, and that difference is the entire question during an incident.

// cgroupRoot is where systemd mounts cgroup v2 on every box we run.
const cgroupRoot = "sys/fs/cgroup"

// readServices records memory for each configured unit.
//
// Names are given in config rather than discovered, because "every cgroup on the
// box" is hundreds of rows a minute of mostly nothing, and the handful that
// matter are known: the bot on blip, the containers on hive-prod.
func (c *Collector) readServices(s Sample) {
	for _, unit := range c.services {
		label, path := serviceLabel(unit), c.serviceDir(unit)
		if path == "" {
			continue
		}
		if v, ok := c.cgroupNumber(filepath.Join(path, "memory.current")); ok {
			s["svc_"+label+"_mem_mb"] = round1(v / 1e6)
		}
		if v, ok := c.cgroupNumber(filepath.Join(path, "memory.peak")); ok {
			s["svc_"+label+"_mem_peak_mb"] = round1(v / 1e6)
		}
		// oom_kill counts kills inside this cgroup; oom counts times it hit the
		// limit and had to reclaim hard, which starts happening well before
		// anything dies and is the earlier warning.
		c.eachLine(filepath.Join(path, "memory.events"), func(line string) {
			key, value, ok := strings.Cut(line, " ")
			if !ok {
				return
			}
			if key == "oom" || key == "oom_kill" {
				s["svc_"+label+"_"+key] = int64(num(value))
			}
		})
	}
}

// serviceDir resolves a unit or container name to its cgroup directory, or ""
// if it is not running. A stopped service has no cgroup at all, which is why an
// absent key here means "not running" rather than "zero bytes".
func (c *Collector) serviceDir(unit string) string {
	// A systemd service: balloon-bot.service.
	candidate := filepath.Join(cgroupRoot, "system.slice", unit)
	if fi, err := os.Stat(c.path(candidate)); err == nil && fi.IsDir() {
		return candidate
	}
	// A docker container. The scope is named for the container's full 64-char
	// id, which nothing else on the box knows, so the name has to be looked up.
	if id, ok := c.dockerContainers()[unit]; ok {
		return filepath.Join(cgroupRoot, "system.slice", "docker-"+id+".scope")
	}
	return ""
}

// dockerContainers maps a running container's name to its full id.
//
// Driven from the cgroup directory rather than from docker's state directory,
// which matters: /var/lib/docker/containers accumulates every container that has
// ever run here, and reading all of it once a minute to find four would be
// exactly the kind of growing cost this collector is supposed to not have. The
// cgroup only holds what is running now.
//
// Not `docker ps`: that is a fork and a round trip to a daemon which, on the box
// where this matters most, is the daemon under strain.
func (c *Collector) dockerContainers() map[string]string {
	out := map[string]string{}
	scopes, err := filepath.Glob(c.path(cgroupRoot, "system.slice", "docker-*.scope"))
	if err != nil {
		return out
	}
	for _, scope := range scopes {
		id := strings.TrimSuffix(strings.TrimPrefix(filepath.Base(scope), "docker-"), ".scope")
		if len(id) < 12 {
			continue
		}
		var cfg struct {
			Name string `json:"Name"`
		}
		raw, err := os.ReadFile(c.path("var/lib/docker/containers", id, "config.v2.json"))
		if err != nil || json.Unmarshal(raw, &cfg) != nil {
			continue
		}
		// Docker stores it with a leading slash, as a path.
		if name := strings.TrimPrefix(cfg.Name, "/"); name != "" {
			out[name] = id
		}
	}
	return out
}

// serviceLabel turns a unit name into something safe to use as a metric key:
// "balloon-bot.service" -> "balloon_bot".
func serviceLabel(unit string) string {
	name := strings.TrimSuffix(strings.TrimSuffix(unit, ".service"), ".scope")
	return strings.NewReplacer("-", "_", ".", "_", "/", "_").Replace(name)
}

func (c *Collector) cgroupNumber(rel string) (float64, bool) {
	raw := strings.TrimSpace(c.readFile(rel))
	// "max" is a limit that is not set, not a quantity.
	if raw == "" || raw == "max" {
		return 0, false
	}
	return num(raw), true
}
