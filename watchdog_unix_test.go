//go:build !windows

package borgo

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// helper roles: the test binary re-execs itself to build a process chain it
// could not build from inside one process.
const (
	helperRoleEnv = "BORGO_WATCHDOG_HELPER_ROLE"
	helperDirEnv  = "BORGO_WATCHDOG_HELPER_DIR"
	helperPPIDEnv = "BORGO_WATCHDOG_HELPER_PPID"
)

// procStatus reads the state letter of pid from /proc/<pid>/status, not from
// the /proc/<pid>/stat the watchdog parses: a test that shared the parser
// could not catch a bug in it.
func procStatus(pid int) (byte, error) {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/status")
	if err != nil {
		return 0, err
	}
	for _, line := range strings.Split(string(b), "\n") {
		rest, ok := strings.CutPrefix(line, "State:")
		if !ok {
			continue
		}
		if rest = strings.TrimSpace(rest); rest == "" {
			return 0, fmt.Errorf("empty State line for pid %d", pid)
		}
		return rest[0], nil
	}
	return 0, fmt.Errorf("no State line for pid %d", pid)
}

// stateOf is procStatus for an error message, where "gone" is an answer.
func stateOf(pid int) string {
	st, err := procStatus(pid)
	if err != nil {
		return "gone"
	}
	return string(rune(st))
}

func requireProc(t *testing.T) {
	t.Helper()
	if _, err := procStatus(os.Getpid()); err != nil {
		t.Skipf("no readable /proc on %s: %v", runtime.GOOS, err)
	}
}

func helperEnvFor(role, dir string, ppid int) []string {
	env := make([]string, 0, len(os.Environ())+3)
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "BORGO_WATCHDOG_HELPER_") {
			env = append(env, kv)
		}
	}
	env = append(env, helperRoleEnv+"="+role, helperDirEnv+"="+dir)
	if ppid > 0 {
		env = append(env, helperPPIDEnv+"="+strconv.Itoa(ppid))
	}
	return env
}

// spawn forks and execs path with no controlling fds. The result is this
// process's own child, so nothing else can reap it - which is what the zombie
// cases rest on. It leads its own process group: a shell asked to sleep forks
// the sleep, and killing only the shell left the sleep running past the end of
// the test.
func spawn(path string, argv, env []string) (int, error) {
	null, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		return 0, err
	}
	defer null.Close()
	if env == nil {
		env = os.Environ()
	}
	fd := null.Fd()
	return syscall.ForkExec(path, append([]string{path}, argv...), &syscall.ProcAttr{
		Env:   env,
		Files: []uintptr{fd, fd, fd},
		Sys:   &syscall.SysProcAttr{Setpgid: true},
	})
}

func startChild(t *testing.T, path string, argv, env []string) int {
	t.Helper()
	pid, err := spawn(path, argv, env)
	if err != nil {
		t.Skipf("fork/exec %s: %v", path, err)
	}
	t.Cleanup(func() { reapChild(t, pid) })
	return pid
}

// reapChild leaves nothing behind: no live process and no corpse. It is safe
// to call on a child already waited for, so a test may reap early and still
// keep the cleanup.
func reapChild(t *testing.T, pid int) {
	t.Helper()
	syscall.Kill(-pid, syscall.SIGKILL)
	syscall.Kill(pid, syscall.SIGKILL)
	done := make(chan error, 1)
	go func() {
		var ws syscall.WaitStatus
		_, err := syscall.Wait4(pid, &ws, 0, nil)
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil && err != syscall.ECHILD {
			t.Errorf("wait4(%d): %v", pid, err)
		}
	case <-time.After(10 * time.Second):
		t.Errorf("child %d never reaped: the test leaves a process behind", pid)
		return
	}
	if st, err := procStatus(pid); err == nil && st == 'Z' {
		t.Errorf("child %d is still a zombie after being reaped", pid)
	}
	// and its group has to be empty too: a shell reaped while the sleep it
	// forked kept running is the leak this cleanup exists to prevent
	deadline := time.Now().Add(5 * time.Second)
	for syscall.Kill(-pid, 0) != syscall.ESRCH {
		if time.Now().After(deadline) {
			t.Errorf("process group %d still has members after child %d was reaped", pid, pid)
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// waitState polls until pid reaches state, and fails rather than hanging.
func waitState(t *testing.T, pid int, state byte) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		st, err := procStatus(pid)
		if err == nil && st == state {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("pid %d never reached state %c (last %q, err %v)", pid, state, stateOf(pid), err)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// waitFile returns the contents of path once it exists, or nil at the
// deadline: the helper chain reports through files, and a helper that never
// reports must fail the test rather than park it.
func waitFile(path string, d time.Duration) []byte {
	deadline := time.Now().Add(d)
	for {
		if b, err := os.ReadFile(path); err == nil && len(b) > 0 {
			return b
		}
		if time.Now().After(deadline) {
			return nil
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// deadPID returns a pid no live process owns.
func deadPID(t *testing.T) int {
	t.Helper()
	for _, pid := range []int{4000000, 3999983, 4194301} {
		if err := syscall.Kill(pid, 0); err == syscall.ESRCH {
			return pid
		}
	}
	t.Skip("could not find a pid no live process owns")
	return 0
}

// unreachablePID returns a pid naming a live process this one may not signal.
func unreachablePID(t *testing.T) int {
	t.Helper()
	const init = 1
	if err := syscall.Kill(init, 0); err != syscall.EPERM {
		t.Skipf("kill(%d, 0) answered %v, not EPERM, so it cannot stand in for a supervisor out of reach", init, err)
	}
	return init
}

// shNamed copies /bin/sh to a file called name and returns the path. The
// kernel takes comm from the basename, so this is the only way to get a
// process whose name carries the spaces and parentheses /proc/<pid>/stat does
// not escape.
func shNamed(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile("/bin/sh")
	if err != nil {
		t.Skipf("no /bin/sh to copy: %v", err)
	}
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, b, 0o755); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	return path
}

func TestProcessExitedSaysNoForALiveProcess(t *testing.T) {
	if processExited(os.Getpid()) {
		t.Fatal("this process reported itself as exited")
	}
}

// alive and out of reach is alive: a supervisor that dropped privileges for
// the api must not refuse the boot.
func TestProcessExitedSaysNoForAnUnreachableProcess(t *testing.T) {
	pid := unreachablePID(t)
	if processExited(pid) {
		t.Fatalf("live process %d, which this one may not signal, read as exited: every boot under a supervisor running as another user would be refused", pid)
	}
}

func TestProcessExitedSaysYesForAPidNobodyOwns(t *testing.T) {
	pid := deadPID(t)
	if !processExited(pid) {
		t.Fatalf("pid %d, which no process owns, read as alive", pid)
	}
}

func TestProcessExitedSaysYesForAReapedChild(t *testing.T) {
	requireProc(t)
	pid := startChild(t, "/bin/sh", []string{"-c", "exit 0"}, nil)
	waitState(t, pid, 'Z')
	reapChild(t, pid)
	if !processExited(pid) {
		t.Fatalf("reaped child %d read as alive", pid)
	}
}

// A zombie has exited; only its exit status is still owed to somebody. It
// keeps accepting signals, so kill(pid, 0) succeeds on it and the probe read
// it as alive: serveContext then let the boot go on under a supervisor that
// was already dead, mounted the registry, bound the port and served requests
// nobody was watching.
func TestProcessExitedSeesAZombieChild(t *testing.T) {
	requireProc(t)
	pid := startChild(t, "/bin/sh", []string{"-c", "exit 0"}, nil)
	waitState(t, pid, 'Z')
	if err := syscall.Kill(pid, 0); err != nil {
		t.Skipf("kill(%d, 0) already answers %v for a zombie here, so this kernel does not have the case", pid, err)
	}
	if !processExited(pid) {
		t.Fatalf("zombie %d read as alive: the api boots under a supervisor that has already exited", pid)
	}
}

// the same corpse, made by a signal rather than an exit: this is the shape a
// force-killed supervisor leaves
func TestProcessExitedSeesASignalledZombieChild(t *testing.T) {
	requireProc(t)
	pid := startChild(t, "/bin/sh", []string{"-c", "sleep 30"}, nil)
	if err := syscall.Kill(pid, syscall.SIGKILL); err != nil {
		t.Fatalf("kill(%d, SIGKILL): %v", pid, err)
	}
	waitState(t, pid, 'Z')
	if !processExited(pid) {
		t.Fatalf("SIGKILLed zombie %d read as alive", pid)
	}
}

// Field 2 of /proc/<pid>/stat is the comm in parentheses, unescaped, and a
// process may be called "my prog (x)". Splitting on whitespace reads "prog" as
// the state and every corpse comes back alive again.
func TestProcessExitedSeesAZombieNamedWithParentheses(t *testing.T) {
	requireProc(t)
	sh := shNamed(t, "my prog (x)")
	pid := startChild(t, sh, []string{"-c", "exit 0"}, nil)
	waitState(t, pid, 'Z')
	if !processExited(pid) {
		t.Fatalf("zombie %d named %q read as alive: the state was taken from the wrong field", pid, filepath.Base(sh))
	}
}

// and the other way round: a live process whose name contains ") Z (" must not
// be read as a corpse. Stopping at the first ")" refuses its boot for a
// supervisor that is perfectly healthy.
func TestProcessExitedSaysNoForALiveProcessNamedLikeAZombie(t *testing.T) {
	requireProc(t)
	sh := shNamed(t, "a) Z (b")
	pid := startChild(t, sh, []string{"-c", "sleep 30"}, nil)
	waitState(t, pid, 'S')
	if processExited(pid) {
		t.Fatalf("live process %d named %q read as exited: the state was taken from inside its name", pid, filepath.Base(sh))
	}
}

// Reading the state is the only part of this that needs /proc, and off linux
// there is none. A pid with no /proc entry is the nearest thing to darwin this
// machine has: unsure must answer "not a corpse", which leaves processExited
// exactly where the signal probe alone left it rather than reading every
// unreadable parent as gone.
func TestProcessIsCorpseIsUnsureWithoutAProcEntry(t *testing.T) {
	requireProc(t)
	pid := deadPID(t)
	if _, err := os.Stat("/proc/" + strconv.Itoa(pid) + "/stat"); err == nil {
		t.Skipf("/proc/%d/stat exists after all", pid)
	}
	if processIsCorpse(pid) {
		t.Fatal("a pid with no /proc entry read as a corpse: on darwin and the BSDs, where that is every pid, a live parent would read as gone and refuse the boot")
	}
}

// waitParentExit's non-direct branch is the one borgo uses whenever the pid it
// is told to watch is not its own parent - a supervisor that spawned the api
// through a shell. It probed with kill(pid, 0), which a zombie answers, so the
// poll ran forever and the api outlived the supervisor it was watching.
func TestWaitParentExitReturnsWhenTheWatchedProcessIsAZombie(t *testing.T) {
	requireProc(t)
	pid := startChild(t, "/bin/sh", []string{"-c", "exit 0"}, nil)
	waitState(t, pid, 'Z')
	if pid == os.Getppid() {
		t.Skip("the zombie is this process's own parent, which is the other branch")
	}

	stop := make(chan struct{})
	defer close(stop)
	returned := make(chan bool, 1)
	go func() { returned <- waitParentExit(pid, stop) }()

	select {
	case exited := <-returned:
		if !exited {
			t.Fatal("waitParentExit returned without reporting the exit it observed")
		}
	case <-time.After(15 * time.Second):
		t.Fatalf("waitParentExit never saw zombie %d go: the api keeps serving under a dead supervisor", pid)
	}
}

func TestWaitParentExitKeepsWatchingALiveProcess(t *testing.T) {
	pid := startChild(t, "/bin/sh", []string{"-c", "sleep 30"}, nil)

	stop := make(chan struct{})
	defer close(stop)
	returned := make(chan bool, 1)
	go func() { returned <- waitParentExit(pid, stop) }()

	select {
	case <-returned:
		t.Fatalf("waitParentExit reported live process %d as exited", pid)
	case <-time.After(500 * time.Millisecond):
	}
}

// The direct branch watches getppid instead of the pid. Reparenting happens
// when the parent exits, not when somebody finally reaps it, so this branch
// should see a parent that is still an unreaped corpse - but that is a claim
// about the kernel, and the difference between fixing one branch and two, so
// it is measured: this process forks a helper that forks a grandchild and then
// exits, and nothing here reaps the helper, leaving exactly the corpse.
func TestWaitParentExitSeesADirectParentThatBecameAZombie(t *testing.T) {
	requireProc(t)
	exe, err := os.Executable()
	if err != nil {
		t.Skipf("cannot find this test binary: %v", err)
	}
	dir := t.TempDir()
	parent := startChild(t, exe, []string{"-test.run=^TestHelperZombieParent$"}, helperEnvFor("parent", dir, 0))

	pidb := waitFile(filepath.Join(dir, "child.pid"), 20*time.Second)
	if pidb == nil {
		t.Fatalf("the helper parent %d never reported its child (state %q)", parent, stateOf(parent))
	}
	grand, err := strconv.Atoi(strings.TrimSpace(string(pidb)))
	if err != nil {
		t.Fatalf("helper parent wrote %q as its child pid: %v", pidb, err)
	}
	// the grandchild is not this process's child, so it cannot be waited for
	// here: killing it by pid is all there is, and its new parent reaps it
	t.Cleanup(func() { syscall.Kill(-grand, syscall.SIGKILL) })

	waitState(t, parent, 'Z')

	res := waitFile(filepath.Join(dir, "result"), 30*time.Second)
	if res == nil {
		t.Fatalf("the grandchild %d never reported: waitParentExit did not see its direct parent %d go (state %q)", grand, parent, stateOf(parent))
	}
	var seen int
	var exited bool
	var state rune
	if _, err := fmt.Sscanf(string(res), "ppid=%d exited=%t state=%c", &seen, &exited, &state); err != nil {
		t.Fatalf("could not read the grandchild's report %q: %v", res, err)
	}
	if seen != parent {
		t.Fatalf("the chain did not hold: the grandchild's parent was %d, not the helper %d, so the direct branch was never taken", seen, parent)
	}
	if state != 'Z' {
		t.Fatalf("the parent was in state %c when the watch returned, not a corpse: the case was not built", state)
	}
	if !exited {
		t.Fatal("waitParentExit did not report a direct parent that had exited but not been reaped: the api outlives the supervisor it was told to watch")
	}
}

// TestHelperZombieParent is the middle of that chain: it forks the grandchild,
// waits for it to be inside the watch so the watch really starts on a live
// direct parent, and exits. Its own parent never reaps it, so it stays a
// corpse for the rest of the test.
func TestHelperZombieParent(t *testing.T) {
	if os.Getenv(helperRoleEnv) != "parent" {
		t.Skip("helper process only")
	}
	dir := os.Getenv(helperDirEnv)
	exe, err := os.Executable()
	if err != nil {
		os.Exit(3)
	}
	pid, err := spawn(exe, []string{"-test.run=^TestHelperWatchesItsParent$"}, helperEnvFor("child", dir, os.Getpid()))
	if err != nil {
		os.Exit(4)
	}
	if err := os.WriteFile(filepath.Join(dir, "child.pid"), []byte(strconv.Itoa(pid)), 0o644); err != nil {
		os.Exit(5)
	}
	if waitFile(filepath.Join(dir, "ready"), 20*time.Second) == nil {
		os.Exit(6)
	}
	time.Sleep(200 * time.Millisecond)
	os.Exit(0)
}

// TestHelperWatchesItsParent is the end of the chain: it runs the watch borgo
// runs, on a parent that is about to become an unreaped corpse, and reports
// what it saw.
func TestHelperWatchesItsParent(t *testing.T) {
	if os.Getenv(helperRoleEnv) != "child" {
		t.Skip("helper process only")
	}
	dir := os.Getenv(helperDirEnv)
	ppid, err := strconv.Atoi(os.Getenv(helperPPIDEnv))
	if err != nil {
		os.Exit(3)
	}
	seen := os.Getppid()
	if err := os.WriteFile(filepath.Join(dir, "ready"), []byte("1"), 0o644); err != nil {
		os.Exit(4)
	}

	stop := make(chan struct{})
	timer := time.AfterFunc(20*time.Second, func() { close(stop) })
	exited := waitParentExit(ppid, stop)
	timer.Stop()

	state := rune('?')
	if st, err := procStatus(ppid); err == nil {
		state = rune(st)
	}
	os.WriteFile(filepath.Join(dir, "result"), []byte(fmt.Sprintf("ppid=%d exited=%t state=%c", seen, exited, state)), 0o644)
	os.Exit(0)
}
