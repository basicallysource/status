//go:build !linux

package main

// The collector only ever runs on Linux. This exists so the package still
// builds and its tests still run on the Mac these boxes are managed from —
// every other reader here works from files under a fixture root and is fully
// testable, and losing that to one syscall would be a bad trade.
func (c *Collector) readDiskUsage(_ Sample) {}
