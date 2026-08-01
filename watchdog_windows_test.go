//go:build windows

package borgo

import (
	"errors"
	"syscall"
	"testing"
	"time"
)

// deniedPID returns a pid that names a live process this process may not open.
// The probe is the same call the watchdog makes, so a run that *can* open it -
// an elevated one, say - skips instead of hanging in the infinite wait.
func deniedPID(t *testing.T) int {
	t.Helper()
	// 4 is the System process: always running, never openable from an
	// ordinary token
	const system = 4
	h, err := syscall.OpenProcess(syscall.SYNCHRONIZE, false, system)
	if err == nil {
		syscall.CloseHandle(h)
		t.Skip("this process may open the System process, so it cannot stand in for an unreachable parent")
	}
	if !errors.Is(err, syscall.ERROR_ACCESS_DENIED) {
		t.Skipf("OpenProcess(%d) failed with %v, not access-denied", system, err)
	}
	return system
}

// deadPID returns a pid no live process owns.
func deadPID(t *testing.T) int {
	t.Helper()
	// windows pids are multiples of four, so an odd one names nothing - but
	// probe rather than trust it
	for _, pid := range []int{999999999, 999999995, 123456789} {
		h, err := syscall.OpenProcess(syscall.SYNCHRONIZE, false, uint32(pid))
		if err == nil {
			syscall.CloseHandle(h)
			continue
		}
		if !errors.Is(err, syscall.ERROR_ACCESS_DENIED) {
			return pid
		}
	}
	t.Skip("could not find a pid no live process owns")
	return 0
}

// A parent borgo may not open is alive, not gone. Treating any OpenProcess
// failure as an exit made waitParentExit return instantly for a supervisor at
// a different elevation or under another user - or with an EDR hooking the
// call - and serveContext then logged "parent process exited" and shut the api
// down seconds after boot with a perfectly healthy supervisor. The unix
// sibling gets this right for EPERM; this is the same case.
func TestWaitParentExitPollsWhenOpenProcessIsDenied(t *testing.T) {
	pid := deniedPID(t)

	// the wait never ends for a process that never exits, so this goroutine
	// stays parked for the rest of the binary's life; the short poll keeps it
	// cheap
	exited := make(chan struct{})
	go func() {
		defer close(exited)
		waitProcessExit(pid, 50*time.Millisecond)
	}()

	select {
	case <-exited:
		t.Fatalf("waitProcessExit(%d) reported a live but unopenable process as exited; the api would shut down at boot", pid)
	case <-time.After(500 * time.Millisecond):
	}
}

// the other half: a pid no live process owns answers ERROR_INVALID_PARAMETER,
// and that really does mean gone - the poll must not swallow the one case the
// watchdog exists for
func TestWaitParentExitReturnsWhenTheProcessIsGone(t *testing.T) {
	pid := deadPID(t)

	exited := make(chan struct{})
	go func() {
		defer close(exited)
		waitProcessExit(pid, 50*time.Millisecond)
	}()

	select {
	case <-exited:
	case <-time.After(10 * time.Second):
		t.Fatalf("waitProcessExit(%d) never returned for a pid no process owns", pid)
	}
}

// a process this one owns still gets the blocking wait, not the poll
func TestWaitParentExitWaitsForAnOpenableProcess(t *testing.T) {
	self := syscall.Getpid()
	h, err := syscall.OpenProcess(syscall.SYNCHRONIZE, false, uint32(self))
	if err != nil {
		t.Skipf("cannot open this process: %v", err)
	}
	syscall.CloseHandle(h)

	exited := make(chan struct{})
	go func() {
		defer close(exited)
		waitProcessExit(self, 50*time.Millisecond)
	}()
	select {
	case <-exited:
		t.Fatal("waitProcessExit returned for a process that is still running")
	case <-time.After(500 * time.Millisecond):
	}
}
