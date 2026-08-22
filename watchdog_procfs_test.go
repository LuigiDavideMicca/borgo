//go:build !windows && !darwin && !freebsd && !openbsd

package borgo

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// procStatus reads the state letter of pid from /proc/<pid>/status, not from
// the /proc/<pid>/stat the watchdog parses: a test that shared the parser could
// not catch a bug in it.
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

// Field 2 of /proc/<pid>/stat is the comm in parentheses, unescaped, and a
// process may be called "my prog (x)". Splitting on whitespace reads "prog" as
// the state and every corpse comes back alive again. The parser is covered on
// injected lines everywhere; this is the same case on a real kernel.
func TestProcessExitedSeesAZombieNamedWithParentheses(t *testing.T) {
	requireProcState(t)
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
	requireProcState(t)
	sh := shNamed(t, "a) Z (b")
	pid := startChild(t, sh, []string{"-c", "sleep 30"}, nil)
	waitState(t, pid, 'S')
	if processExited(pid) {
		t.Fatalf("live process %d named %q read as exited: the state was taken from inside its name", pid, filepath.Base(sh))
	}
}

// The reading is a file, and off procfs there is none. A pid with no entry
// must answer "not a corpse" rather than leave every unreadable parent read as
// gone.
func TestProcessIsCorpseIsUnsureWithoutAProcEntry(t *testing.T) {
	requireProcState(t)
	pid := deadPID(t)
	if _, err := os.Stat("/proc/" + strconv.Itoa(pid) + "/stat"); err == nil {
		t.Skipf("/proc/%d/stat exists after all", pid)
	}
	if processIsCorpse(pid) {
		t.Fatal("a pid with no /proc entry read as a corpse: a live parent would read as gone and refuse the boot")
	}
}

// The pid guard on a real kernel: /proc/self/stat describes this process, and
// asking about it under any other pid must not be answered.
func TestProcStatCorpseRefusesARealReadingAboutAnotherPid(t *testing.T) {
	requireProcState(t)
	stat, err := os.ReadFile("/proc/self/stat")
	if err != nil {
		t.Skipf("no /proc/self/stat: %v", err)
	}
	if procStatCorpse(os.Getpid()+1, stat) {
		t.Fatal("this process's own stat answered a question about a different pid")
	}
}
