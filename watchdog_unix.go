//go:build !windows

package borgo

import (
	"bytes"
	"os"
	"strconv"
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
//
// A signal probe alone cannot answer this. A process that has exited but whose
// status nobody has collected keeps its pid and keeps accepting signals, so
// kill(pid, 0) succeeds on a corpse and the probe read it as alive: the api
// booted under a supervisor that was already dead, mounted the registry, bound
// the port and served requests nobody was watching. The windows sibling never
// had the case - a signaled process object is openable but its wait is
// satisfied - and states the same rule from the other side.
func processExited(pid int) bool {
	err := syscall.Kill(pid, 0)
	if err != nil && err != syscall.EPERM {
		return true
	}
	// EPERM included: a corpse keeps the credentials that refused the signal,
	// and /proc is readable regardless of them
	return processIsCorpse(pid)
}

// processIsCorpse reports whether pid names a process that has already exited
// and is only waiting to be reaped. Uncertainty answers no: refusing a boot
// needs certainty the parent is gone, and the watch still runs behind the
// probe to catch what it missed. That is also what makes this safe off linux -
// where there is no /proc/<pid>/stat the answer is always no, which is exactly
// what this file did before.
func processIsCorpse(pid int) bool {
	stat, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return false
	}
	// field 2 is the comm, in parentheses and unescaped, so a process called
	// "my prog (x)" defeats any split on whitespace or on the first ")": only
	// the last one is certainly the closing one
	comm := bytes.LastIndexByte(stat, ')')
	if comm < 0 {
		return false
	}
	rest := bytes.TrimLeft(stat[comm+1:], " ")
	if len(rest) == 0 {
		return false
	}
	// Z is a corpse; X and x are the moment after, when it is being torn down
	return rest[0] == 'Z' || rest[0] == 'X' || rest[0] == 'x'
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
// orphan the api. The direct branch needs nothing more: a process is
// reparented when its parent exits, not when somebody finally reaps it, so
// getppid changes even while the parent is still an uncollected corpse.
//
// For any other pid the probe is all there is, and it is the same probe
// serveContext uses at boot - including its reading of a corpse as gone.
// Polling kill(pid, 0) alone kept the api serving forever under a supervisor
// that had exited into a zombie, which is the orphan this file exists to
// prevent.
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
