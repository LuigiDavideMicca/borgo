//go:build windows

package borgo

import (
	"path/filepath"
	"syscall"
	"testing"
)

// the 8.3 spelling the disk also answers to, "" when the volume makes none
func shortName(t *testing.T, path string) string {
	t.Helper()
	long, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return ""
	}
	buf := make([]uint16, 512)
	n, err := syscall.GetShortPathName(long, &buf[0], uint32(len(buf)))
	if err != nil || n == 0 {
		return ""
	}
	return filepath.Base(syscall.UTF16ToString(buf[:n]))
}
