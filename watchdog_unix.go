//go:build !windows

package borgo

import (
	"os"
	"syscall"
	"time"
)

// parentPollInterval is how often waitParentExit re-probes the parent; it
// matches the windows sibling's poll.
const parentPollInterval = 2 * time.Second

// processExited reports whether the process is already gone, asked and answered
// now: a cancellable wait reused as a synchronous probe answers the
// cancellation, not the question. EPERM is a live process this one may not
// signal, exactly as the poll reads it.
func processExited(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err != nil && err != syscall.EPERM
}

// waitParentExit polls until the process named by pid is gone or stop closes,
// reporting whether the process really exited - a cancelled watch learned
// nothing about it, and every ServeContext run ends its own watcher rather
// than leaving a goroutine parked for the life of the process. There is no
// portable blocking wait on a non-child process.
//
// When pid is this process's direct parent - the usual borgo dev/start shape -
// the poll watches getppid instead of probing the pid: reparenting to init (or
// a subreaper) is observable even after the freed pid is reused, where a
// kill-0 probe would read the recycled pid as the parent still running and
// orphan the api. For any other pid the kill-0 probe is all there is; EPERM
// means the process exists but belongs to a user this one may not signal - a
// supervisor that dropped privileges for the api - so it counts as alive:
// treating it as an error would shut the api down seconds after boot.
func waitParentExit(pid int, stop <-chan struct{}) bool {
	direct := os.Getppid() == pid
	for {
		if direct {
			if os.Getppid() != pid {
				return true
			}
		} else if err := syscall.Kill(pid, 0); err != nil && err != syscall.EPERM {
			return true
		}
		select {
		case <-stop:
			return false
		case <-time.After(parentPollInterval):
		}
	}
}
