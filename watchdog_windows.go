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
// The polling path re-probes a bare pid, and windows reuses pids: if the
// unreachable parent exits and its number is handed to a process this one CAN
// open, the poll waits on a stranger. The blocking path is not exposed to it -
// the handle is taken once, up front, and names one process object for as long
// as it is held, whatever happens to the number.
//
// An earlier note here prescribed the cure as "a change to how borgo dev starts
// the api". Measured, that is wrong twice over, so it is corrected rather than
// carried:
//
//   - the api never reaches this poll. It is only entered after
//     ERROR_ACCESS_DENIED, and a Bun.spawn'd api opens its borgo parent with
//     SYNCHRONIZE without trouble - so it takes the handle path, which no reused
//     pid can reach. TestAChildOpensItsOwnParentSoTheWaitTakesTheHandlePath
//     holds that premise instead of assuming it.
//   - and the api is not where the exposure is. The one watch on windows that
//     nothing else covers is `borgo dev` watching its LAUNCHER, a shell borgo
//     does not start and cannot hand anything to. Every process borgo does
//     start is in bun's job object, which takes it down with its parent -
//     measured for a bun child and a go child alike - so changing how the api
//     is started reaches only the sites that were already covered.
//
// The window itself was measured rather than assumed: a freed pid came back
// after 740 spawns at the soonest (median 1540, 8 trials), while this machine
// creates at most ~180 processes inside one 2 s poll gap.
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

// processExited reports whether the process is already gone, asked and answered
// now. It cannot be waitParentExit with a closed stop: a cancellable wait
// reused as a synchronous probe answers the cancellation, not the question -
// waitHandle honours the closed stop before it ever calls WaitForSingleObject,
// so every openable process reads as alive. Windows keeps a signaled process
// object openable for as long as anybody holds a handle on it, so that "alive"
// covers the ordinary corpse: an api whose supervisor died while its own
// launcher still held it booted, mounted, tripped the watch and shut down
// having served nothing.
//
// A zero timeout asks the handle instead. A wait that fails is read as alive:
// refusing a boot needs certainty the parent is gone, and the watch is still
// behind this to catch what the probe missed.
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
