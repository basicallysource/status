//go:build linux

package main

import "syscall"

// readDiskUsage asks the filesystem how full it is, with one statfs syscall.
//
// This is the cheap way and the only acceptable one. `du` on a deploy directory
// walks every inode under it, and on these boxes that is the single measurement
// that costs real I/O — on a box already struggling for I/O, measuring it would
// be part of the problem.
func (c *Collector) readDiskUsage(s Sample) {
	for label, path := range c.disks() {
		var fs syscall.Statfs_t
		if err := syscall.Statfs(path, &fs); err != nil {
			continue
		}
		total := float64(fs.Blocks) * float64(fs.Bsize)
		if total <= 0 {
			continue
		}
		// Bavail, not Bfree: Bfree counts the reserved blocks only root may use,
		// so it reports space that a service filling the disk cannot have.
		avail := float64(fs.Bavail) * float64(fs.Bsize)
		s[label+"_pct"] = round1((total - avail) * 100 / total)
		s[label+"_free_gb"] = round1(avail / 1e9)
	}
}
