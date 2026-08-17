//go:build darwin

package borgo

import (
	"context"
	"encoding/binary"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"
)

// procStatus reads the state letter of pid from ps(1), which reaches the
// kernel through libproc rather than through the sysctl the watchdog parses: a
// test that shared the reading under test could not catch a bug in it. ps
// exits non-zero for a pid nobody owns, which is the "gone" this returns as an
// error.
func procStatus(pid int) (byte, error) {
	// every wait in this package is on a deadline, ps included: a hung ps
	// would park the test rather than fail it
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/bin/ps", "-o", "state=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return 0, fmt.Errorf("ps -p %d: %w", pid, err)
	}
	st := strings.TrimSpace(string(out))
	if st == "" {
		return 0, fmt.Errorf("ps reported no state for pid %d", pid)
	}
	return st[0], nil
}

// The one thing this branch cannot be shipped without measuring somewhere: the
// syscall really runs, the kernel really writes a whole kinfo_proc, and the
// pid and state really sit at the offsets this code hardcodes. Every other
// failure in this file is silent by design - a read that fails answers "alive",
// which is what darwin did before - so without this test a darwin branch that
// never worked at all would look exactly like a darwin branch that works.
func TestKinfoProcReadFindsThisProcessWhereThisCodeExpectsIt(t *testing.T) {
	self := os.Getpid()
	buf, err := kinfoProcRead(self)
	if err != nil {
		t.Fatalf("sysctl kern.proc.pid.%d failed: %v - the darwin branch answers 'alive' for every parent and the fix is not in effect", self, err)
	}
	if len(buf) != kinfoProcSize {
		t.Fatalf("the kernel wrote %d bytes of kinfo_proc, this code expects %d: the struct is not the one these offsets were taken from", len(buf), kinfoProcSize)
	}
	if got := int(int32(binary.LittleEndian.Uint32(buf[kinfoPidOff:]))); got != self {
		t.Fatalf("offset %d holds pid %d, this process is %d: the layout is wrong and the state byte belongs to another field", kinfoPidOff, got, self)
	}
	// SRUN and SSLEEP are the only states a process running this test can be
	// in; anything else means the state offset points somewhere else
	if st := buf[kinfoStatOff]; st != 2 && st != 3 {
		t.Fatalf("offset %d holds %d for this running process, which is neither SRUN nor SSLEEP", kinfoStatOff, st)
	}
}

// darwin reports a pid nobody owns as a success that wrote nothing, and a
// reading that is not the whole struct is never a corpse.
func TestKinfoProcReadReportsNothingForAPidNobodyOwns(t *testing.T) {
	pid := deadPID(t)
	buf, err := kinfoProcRead(pid)
	if err == nil && len(buf) == kinfoProcSize {
		t.Fatalf("sysctl returned a whole kinfo_proc for pid %d, which no process owns", pid)
	}
	if processIsCorpse(pid) {
		t.Fatalf("pid %d read as a corpse", pid)
	}
}

// The corpse reading on its own, with the signal probe out of the way: this is
// the case kill(pid, 0) cannot see, and the reason this file exists.
func TestProcessIsCorpseSeesAZombieChild(t *testing.T) {
	requireProcState(t)
	pid := startChild(t, "/bin/sh", []string{"-c", "exit 0"}, nil)
	waitState(t, pid, 'Z')
	if !processIsCorpse(pid) {
		t.Fatalf("zombie %d read as alive: the api boots under a supervisor that has already exited", pid)
	}
}

// and a live child must not be, or every macOS boot is refused
func TestProcessIsCorpseSaysNoForALiveChild(t *testing.T) {
	requireProcState(t)
	pid := startChild(t, "/bin/sh", []string{"-c", "sleep 30"}, nil)
	waitState(t, pid, 'S')
	if processIsCorpse(pid) {
		t.Fatalf("live process %d read as a corpse", pid)
	}
}

// kern.proc.pid is readable for a process this one may not signal, so a
// supervisor that dropped privileges for the api is still diagnosable - and
// still has to read as alive.
func TestProcessIsCorpseReadsAProcessItMayNotSignal(t *testing.T) {
	pid := unreachablePID(t)
	buf, err := kinfoProcRead(pid)
	if err != nil || len(buf) != kinfoProcSize {
		t.Fatalf("sysctl kern.proc.pid.%d returned %d bytes, %v: a supervisor out of signal reach is undiagnosable here", pid, len(buf), err)
	}
	if processIsCorpse(pid) {
		t.Fatalf("live process %d, which this one may not signal, read as a corpse: its boot would be refused", pid)
	}
}
