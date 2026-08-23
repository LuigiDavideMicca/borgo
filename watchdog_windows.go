//go:build windows

package borgo

import (
	"errors"
	"syscall"
	"time"
)

// Only an unopenable parent is re-probed at this rate; every process borgo
// starts opens its parent and takes the handle wait below. Not lowered with
// the unix sibling's: the pid-reuse window is measured against this gap.
const parentPollInterval = 2 * time.Second

// An INFINITE wait cannot be cancelled and would pin a kernel handle on the
// parent for the life of the process, once per ServeContext run.
const parentWaitTick = 250 * time.Millisecond

// waitParentExit reports whether the process really exited: a cancelled watch
// learned nothing about it.
func waitParentExit(pid int, stop <-chan struct{}) bool {
	return waitProcessExit(pid, parentPollInterval, stop)
}

// A refused OpenProcess is not an exit: ERROR_ACCESS_DENIED is a live process
// out of reach (other elevation or user, an EDR hooking the call), so the wait
// degrades to polling, as the unix sibling treats EPERM. Any other failure is
// a pid no live process owns.
//
// The poll re-probes a bare pid, and windows reuses pids: measured, a freed
// pid came back after 740 spawns at the soonest (median 1540, 8 trials),
// against at most ~180 processes created in one 2 s gap. The handle path is
// not exposed: the handle names one process object for as long as it is held.
func waitProcessExit(pid int, poll time.Duration, stop <-chan struct{}) bool {
	for {
		h, err := syscall.OpenProcess(syscall.SYNCHRONIZE, false, uint32(pid))
		if err == nil {
			exited := waitHandle(h, stop)
			syscall.CloseHandle(h)
			return exited
		}
		if !errors.Is(err, syscall.ERROR_ACCESS_DENIED) {
			return true
		}
		select {
		case <-stop:
			return false
		case <-time.After(poll):
		}
	}
}

// processExited is not waitParentExit with a closed stop: waitHandle honours
// the stop before it ever waits, so every openable process would read as
// alive - and windows keeps a signaled process object openable for as long as
// anybody holds a handle on it, which is the ordinary corpse. A failed wait is
// alive: refusing a boot needs certainty, and the watch is still behind this.
func processExited(pid int) bool {
	h, err := syscall.OpenProcess(syscall.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		// denied is a live process out of reach, exactly as the wait reads it
		return !errors.Is(err, syscall.ERROR_ACCESS_DENIED)
	}
	defer syscall.CloseHandle(h)
	event, err := syscall.WaitForSingleObject(h, 0)
	return err == nil && event != uint32(syscall.WAIT_TIMEOUT)
}

// A failed wait is an exit: the handle is no longer telling this process
// anything, and the watchdog's job is to not outlive its parent.
func waitHandle(h syscall.Handle, stop <-chan struct{}) bool {
	for {
		select {
		case <-stop:
			return false
		default:
		}
		event, err := syscall.WaitForSingleObject(h, uint32(parentWaitTick/time.Millisecond))
		if err != nil {
			return true
		}
		if event != uint32(syscall.WAIT_TIMEOUT) {
			return true
		}
	}
}
