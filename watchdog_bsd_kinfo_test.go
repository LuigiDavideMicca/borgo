//go:build (freebsd && (amd64 || arm64)) || (openbsd && (386 || amd64 || arm || arm64 || riscv64))

package borgo

import (
	"encoding/binary"
	"os"
	"strconv"
	"testing"
)

// None of what follows has run: no freebsd or openbsd machine was available
// when this branch was written. Every failure of the branch answers "alive" by
// design, so until this file runs on one, a BSD branch that never worked at
// all is indistinguishable from one that works. This test is the measurement:
// the syscall really runs, the kernel really writes the bytes this code asks
// for, and the pid and state really sit at the offsets it hardcodes.
func TestBsdKinfoReadFindsThisProcessWhereThisCodeExpectsIt(t *testing.T) {
	self := os.Getpid()
	n, buf, errno := bsdKinfoSysctl(self)
	if errno != 0 {
		t.Fatalf("sysctl kern.proc.pid.%d failed: errno %d - this branch answers 'alive' for every parent and the fix is not in effect", self, errno)
	}
	if n != bsdKinfo.size {
		t.Fatalf("the kernel wrote %d bytes of kinfo_proc, this code expects %d: the struct is not the one these offsets were taken from", n, bsdKinfo.size)
	}
	if bsdKinfo.sized {
		if got := int(binary.LittleEndian.Uint32(buf)); got != bsdKinfo.size {
			t.Fatalf("ki_structsize is %d, this code expects %d", got, bsdKinfo.size)
		}
	}
	if got := int(int32(binary.LittleEndian.Uint32(buf[bsdKinfo.pidOff:]))); got != self {
		t.Fatalf("offset %d holds pid %d, this process is %s: the layout is wrong and the state byte belongs to another field", bsdKinfo.pidOff, got, strconv.Itoa(self))
	}
	// SRUN is 2 and SSLEEP 3 on both kernels, the only states a process
	// running this test can be in, and SIDL 1 the moment before them
	if st := buf[bsdKinfo.statOff]; st != 1 && st != 2 && st != 3 {
		t.Fatalf("offset %d holds %d for this running process, which is none of SIDL, SRUN, SSLEEP", bsdKinfo.statOff, st)
	}
}

func TestBsdKinfoReadReportsNothingForAPidNobodyOwns(t *testing.T) {
	pid := deadPID(t)
	n, _, errno := bsdKinfoSysctl(pid)
	if errno == 0 && n == bsdKinfo.size {
		t.Fatalf("sysctl returned a whole kinfo_proc for pid %d, which no process owns", pid)
	}
	if processIsCorpse(pid) {
		t.Fatalf("pid %d read as a corpse", pid)
	}
}

// The corpse reading on its own, with the signal probe out of the way: this is
// the case kill(pid, 0) cannot see, and the reason this branch exists.
func TestProcessIsCorpseSeesAZombieChild(t *testing.T) {
	requireProcState(t)
	pid := startChild(t, "/bin/sh", []string{"-c", "exit 0"}, nil)
	waitState(t, pid, 'Z')
	if !processIsCorpse(pid) {
		t.Fatalf("zombie %d read as alive: the api boots under a supervisor that has already exited", pid)
	}
}

// and a live child must not be, or every boot on this platform is refused
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
	n, _, errno := bsdKinfoSysctl(pid)
	if errno != 0 || n != bsdKinfo.size {
		t.Fatalf("sysctl kern.proc.pid.%d returned %d bytes, errno %d: a supervisor out of signal reach is undiagnosable here", pid, n, errno)
	}
	if processIsCorpse(pid) {
		t.Fatalf("live process %d, which this one may not signal, read as a corpse: its boot would be refused", pid)
	}
}
