//go:build windows

package borgo

import (
	"errors"
	"os"
	"os/exec"
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

	// the wait never ends for a process that never exits, so end it with the
	// test rather than leaving it parked for the rest of the binary's life
	stop := make(chan struct{})
	defer close(stop)
	exited := make(chan struct{})
	go func() {
		defer close(exited)
		waitProcessExit(pid, 50*time.Millisecond, stop)
	}()

	select {
	case <-exited:
		t.Fatalf("waitProcessExit(%d) reported a live but unopenable process as exited; the api would shut down at boot", pid)
	case <-time.After(500 * time.Millisecond):
	}
}

// the poll is the degraded path, so its cancellation matters as much as the
// blocking one's: a run that ends must not leave a watcher probing a pid it no
// longer cares about
func TestWaitProcessExitStopsPolling(t *testing.T) {
	pid := deniedPID(t)

	stop := make(chan struct{})
	returned := make(chan bool, 1)
	go func() { returned <- waitProcessExit(pid, 50*time.Millisecond, stop) }()
	time.Sleep(200 * time.Millisecond)
	close(stop)

	select {
	case exited := <-returned:
		if exited {
			t.Fatal("a cancelled poll reported the process as exited")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("waitProcessExit ignored its stop while polling")
	}
}

// the other half: a pid no live process owns answers ERROR_INVALID_PARAMETER,
// and that really does mean gone - the poll must not swallow the one case the
// watchdog exists for
func TestWaitParentExitReturnsWhenTheProcessIsGone(t *testing.T) {
	pid := deadPID(t)

	reported := make(chan bool, 1)
	go func() { reported <- waitProcessExit(pid, 50*time.Millisecond, nil) }()

	select {
	case exited := <-reported:
		if !exited {
			t.Fatalf("waitProcessExit(%d) returned without reporting the exit it observed", pid)
		}
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

	stop := make(chan struct{})
	defer close(stop)
	exited := make(chan struct{})
	go func() {
		defer close(exited)
		waitProcessExit(self, 50*time.Millisecond, stop)
	}()
	select {
	case <-exited:
		t.Fatal("waitProcessExit returned for a process that is still running")
	case <-time.After(500 * time.Millisecond):
	}
}

// the blocking wait holds a kernel handle on the parent, so it has to release
// it when the run that opened it ends - not when the process does
func TestWaitProcessExitReleasesTheHandleWhenStopped(t *testing.T) {
	self := syscall.Getpid()
	h, err := syscall.OpenProcess(syscall.SYNCHRONIZE, false, uint32(self))
	if err != nil {
		t.Skipf("cannot open this process: %v", err)
	}
	syscall.CloseHandle(h)

	stop := make(chan struct{})
	returned := make(chan bool, 1)
	go func() { returned <- waitProcessExit(self, 50*time.Millisecond, stop) }()
	time.Sleep(200 * time.Millisecond)
	close(stop)

	select {
	case exited := <-returned:
		if exited {
			t.Fatal("a cancelled wait reported the process as exited")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("waitProcessExit stayed in its wait: the goroutine and the process handle it holds are pinned for the life of the process")
	}
}

// A signaled process object stays openable for as long as anybody holds a
// handle on it, so "OpenProcess succeeded" is not "the process is alive". The
// probe was waitParentExit with an already-closed stop, and waitHandle honours
// the stop before it ever asks the handle: every openable pid, corpse or not,
// came back alive. serveContext then mounted, latched the registry, tripped the
// watch on the parent it had just cleared, served nothing and returned nil.
func TestProcessExitedSeesACorpseSomebodyStillHolds(t *testing.T) {
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	if err := cmd.Start(); err != nil {
		t.Skipf("could not start a child: %v", err)
	}
	pid := cmd.Process.Pid
	// this handle is what keeps the dead child's process object addressable,
	// standing in for the launcher that has not reaped its own child yet
	h, err := syscall.OpenProcess(syscall.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		cmd.Wait()
		t.Skipf("cannot open the child: %v", err)
	}
	defer syscall.CloseHandle(h)
	if err := cmd.Wait(); err != nil {
		t.Skipf("the child exited with %v", err)
	}

	if !processExited(pid) {
		t.Fatal("a corpse whose handle is still open read as alive: the boot goes on to mount, latch the registry and shut down having served nothing")
	}
}

// and the live process this one is running in is not a corpse
func TestProcessExitedSaysNoForALiveProcess(t *testing.T) {
	if processExited(syscall.Getpid()) {
		t.Fatal("this process reported itself as exited")
	}
}

// alive and out of reach is alive: a supervisor at another elevation must not
// refuse the boot
func TestProcessExitedSaysNoForAnUnreachableProcess(t *testing.T) {
	if processExited(deniedPID(t)) {
		t.Fatal("a live process this one may not open read as exited: a supervisor at another elevation would refuse every boot")
	}
}
