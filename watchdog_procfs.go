//go:build !windows && !darwin && !freebsd && !openbsd

package borgo

import (
	"os"
	"strconv"
)

// Unreadable is "no": without a procfs (solaris, netbsd until somebody mounts
// one) processExited is the signal probe alone.
func processIsCorpse(pid int) bool {
	if pid <= 0 {
		return false
	}
	stat, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return false
	}
	return procStatCorpse(pid, stat)
}
