//go:build !windows && !darwin

package borgo

import (
	"os"
	"strconv"
)

// processIsCorpse reads the state from /proc/<pid>/stat. Unreadable is "no":
// where there is no procfs - freebsd and openbsd out of the box, solaris,
// netbsd until somebody mounts one - this leaves processExited exactly where
// the signal probe alone left it.
//
// /proc is readable whatever credentials refused the signal, which is why
// processExited asks even after EPERM.
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
