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

// parentWaitTick bounds each blocking wait on an open handle. The wait itself
// wants to be INFINITE, but an uninterruptible wait cannot be cancelled: the
// goroutine stays parked for the life of the process and pins a kernel handle
// on the parent, once per ServeContext run. Waiting in ticks costs four
// kernel waits a second, all of them idle, and lets the run that started the
// watch end it.
const parentWaitTick = 250 * time.Millisecond

// waitParentExit blocks until the process is gone, or until stop closes. It
// reports whether the process really exited: a cancelled watch learned nothing
// about it. SYNCHRONIZE is the only right the wait needs, and a parent grants
// it to children implicitly.
func waitParentExit(pid int, stop <-chan struct{}) bool {
	return waitProcessExit(pid, parentPollInterval, stop)
}

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
//
// The polling path re-probes a bare pid, and windows reuses pids. If the
// unreachable parent exits and its number is handed to a process this one CAN
// open, the poll takes the handle and waits on a stranger: the api outlives
// its supervisor, which is the orphan this file exists to prevent, in the one
// path that cannot see enough to tell. Closing it needs an identity the pid
// does not carry - the parent's creation time, or a handle inherited at spawn
// - and that is a change to how borgo dev starts the api, not to this wait.
// The blocking path is not exposed to it: the handle is taken once, up front,
// and names one process for as long as it is held.
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

// waitHandle blocks until the process behind h exits or stop closes, reporting
// which. A failed wait is treated as an exit: the handle is no longer telling
// this process anything, and the watchdog's job is to not outlive its parent.
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
