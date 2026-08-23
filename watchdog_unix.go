//go:build !windows

package borgo

import (
	"os"
	"syscall"
	"time"
)

// The longest an api serves after its supervisor died. Matches the windows
// handle-wait tick, not that sibling's 2 s poll. Measured on wsl2: getppid
// 272 ns a call, kill(0) plus /proc/stat 24 us.
const parentPollInterval = 250 * time.Millisecond

// processExited answers now; a cancellable wait reused as a synchronous probe
// answers the cancellation, not the question.
//
// kill(pid, 0) alone succeeds on a zombie: an unreaped process keeps its pid
// and keeps accepting signals, so the api booted under a supervisor that was
// already dead and served to nobody.
func processExited(pid int) bool {
	err := syscall.Kill(pid, 0)
	if err != nil && err != syscall.EPERM {
		return true
	}
	// EPERM included: a corpse keeps the credentials that refused the signal,
	// and /proc is readable regardless of them
	return processIsCorpse(pid)
}

// processIsCorpse is per platform (watchdog_procfs.go, watchdog_darwin.go,
// watchdog_bsd*.go) and every one answers no when it cannot tell: refusing a
// boot needs certainty, and the watch still runs behind the probe.

// waitParentExit reports whether the process really exited: a cancelled watch
// learned nothing about it. There is no portable blocking wait on a non-child.
//
// For the direct parent, reparenting (getppid) is the evidence, not a probe on
// the pid: it survives the freed pid being reused, and it happens when the
// parent exits, not when somebody finally reaps it.
func waitParentExit(pid int, stop <-chan struct{}) bool {
	direct := os.Getppid() == pid
	for {
		if direct {
			if os.Getppid() != pid {
				return true
			}
		} else if processExited(pid) {
			return true
		}
		select {
		case <-stop:
			return false
		case <-time.After(parentPollInterval):
		}
	}
}
