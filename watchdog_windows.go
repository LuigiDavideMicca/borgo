//go:build windows

package borgo

import (
	"errors"
	"syscall"
	"time"
)

// parentPollInterval is how often waitParentExit re-probes a parent whose
// handle it cannot open; it matches the unix sibling's poll.
const parentPollInterval = 2 * time.Second

// waitParentExit blocks until the process is gone. SYNCHRONIZE is the only
// right the wait needs, and a parent grants it to children implicitly.
func waitParentExit(pid int) { waitProcessExit(pid, parentPollInterval) }

// waitProcessExit is waitParentExit with the poll interval spelled out, so a
// test need not wait it out.
//
// A refused OpenProcess is not an exit. ERROR_ACCESS_DENIED means the process
// is alive and merely out of reach - a supervisor running at a different
// elevation or as another user, or an EDR hooking the call - so the wait
// degrades to polling, exactly as the unix sibling treats EPERM. Reporting the
// parent gone there shut the api down seconds after boot with a perfectly
// healthy supervisor; against PID 4 it returned instantly. Any other failure
// (ERROR_INVALID_PARAMETER, for a pid no live process owns) really does mean
// there is nothing left to wait for.
func waitProcessExit(pid int, poll time.Duration) {
	for {
		h, err := syscall.OpenProcess(syscall.SYNCHRONIZE, false, uint32(pid))
		if err == nil {
			syscall.WaitForSingleObject(h, syscall.INFINITE)
			syscall.CloseHandle(h)
			return
		}
		if !errors.Is(err, syscall.ERROR_ACCESS_DENIED) {
			return
		}
		time.Sleep(poll)
	}
}
