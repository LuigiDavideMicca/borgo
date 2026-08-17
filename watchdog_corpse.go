package borgo

import (
	"bytes"
	"encoding/binary"
	"log"
	"strconv"
	"sync/atomic"
)

// This file holds the part of the corpse question that is a decision rather
// than a syscall, so it can be tested on any machine - including one with
// neither /proc nor darwin. Every unsure answer here is false: refusing a boot
// needs certainty the parent is gone, so the worst a wrong platform branch can
// do is leave the behaviour that was there before it.

// procStatCorpse decides from the contents of /proc/<pid>/stat.
//
// Field 1 is the pid the kernel is describing. If it is not the one asked
// about, this /proc is not the one whose pids this process signals - a foreign
// namespace mounted over it - and a stranger's state must not decide the boot.
//
// Field 2 is the comm, in parentheses and unescaped, so a process called
// "my prog (x)" defeats any split on whitespace or on the first ")": only the
// last one is certainly the closing paren.
func procStatCorpse(pid int, stat []byte) bool {
	if pid <= 0 {
		return false
	}
	sp := bytes.IndexByte(stat, ' ')
	if sp <= 0 {
		return false
	}
	got, err := strconv.Atoi(string(stat[:sp]))
	if err != nil || got != pid {
		return false
	}
	comm := bytes.LastIndexByte(stat, ')')
	if comm < sp {
		return false
	}
	rest := bytes.TrimLeft(stat[comm+1:], " ")
	if len(rest) == 0 {
		return false
	}
	// Z is a corpse; X and x are the moment after, when it is being torn down
	return rest[0] == 'Z' || rest[0] == 'X' || rest[0] == 'x'
}

// darwin's struct kinfo_proc, LP64. Both darwin architectures are
// little-endian and share this layout; the three numbers are cross-checked
// against the struct golang.org/x/sys/unix generates from the system headers,
// for darwin/arm64 and darwin/amd64 alike, and nothing reads them at runtime.
const (
	kinfoProcSize = 648 // sizeof(struct kinfo_proc)
	kinfoStatOff  = 36  // offsetof(kp_proc.p_stat)
	kinfoPidOff   = 40  // offsetof(kp_proc.p_pid)
	sZomb         = 5   // SZOMB
)

// kinfoProcCorpse decides from one kern.proc.pid reading.
//
// buf must be exactly the struct the kernel reported: a short or long reading
// is a layout this code does not know, and an unknown layout is "alive". A pid
// nobody owns is reported as a reading of length zero, which the same check
// catches.
//
// The pid the kernel put in the struct then has to be the one asked about.
// That is the guard against the failure this file cannot be tested for from
// here: if the offsets are wrong, the state byte belongs to some other field
// and could read as SZOMB by accident, which would refuse every boot on macOS.
// A mismatched pid turns that misparse into "alive" instead.
//
// A range check on the state would add nothing - garbage equal to SZOMB passes
// it by construction - so the size and the pid are the whole guard.
func kinfoProcCorpse(pid int, buf []byte) bool {
	if pid <= 0 || len(buf) != kinfoProcSize {
		return false
	}
	if int(int32(binary.LittleEndian.Uint32(buf[kinfoPidOff:]))) != pid {
		return false
	}
	return buf[kinfoStatOff] == sZomb
}

// darwin's errno numbers, named here rather than imported, so this file keeps
// no build tag and the classifier below is testable on any machine.
const (
	darwinENOMEM = 12
	darwinENOSYS = 78
)

// kinfoProcDecide is the whole darwin answer, given one raw reading: n is the
// byte count the kernel claims, buf the buffer it was handed, errno 0 on
// success. Splitting it from the syscall this way is what lets the darwin
// branch - the anomaly report included - be exercised from a machine that has
// no darwin kernel.
func kinfoProcDecide(pid, n int, buf []byte, errno int) bool {
	if a := kinfoReadAnomaly(pid, n, buf, errno); a != "" {
		reportKinfoAnomaly(pid, a)
	}
	if errno != 0 || n != kinfoProcSize || n > len(buf) {
		return false
	}
	return kinfoProcCorpse(pid, buf[:n])
}

// kinfoReadAnomaly names the way a kern.proc.pid reading is structurally
// wrong, and answers "" when it is not.
//
// Every failure of this branch answers "alive", by design, so a darwin branch
// that never worked at all is indistinguishable from one that does. This
// changes none of those answers - refusing a boot still takes certainty - it
// only makes the mute failure legible.
//
// Which is why the line drawn here is the whole work. A parent that has been
// reaped, or was never there, is the frequent and legitimate case and has to
// stay silent: darwin reports it as a success that wrote nothing, and there is
// no reading of the errno list from here that says which number some kernel
// spells it with. So only errnos that cannot describe a missing process count.
// ENOSYS is one - it says no syscall ran at all, whoever owned the pid - and
// so is ENOMEM, which says the kernel wants to write more than this code
// believes a kinfo_proc is.
//
// A pid of 0 inside a full struct is not counted against the offsets: a zeroed
// buffer reads that way, and pid 0 is a real process on darwin, so it is not
// evidence that the layout is wrong.
func kinfoReadAnomaly(pid, n int, buf []byte, errno int) string {
	if pid <= 0 {
		return ""
	}
	switch {
	case errno == darwinENOSYS:
		return "the sysctl did not dispatch (ENOSYS)"
	case errno == darwinENOMEM:
		return "the kernel wants " + strconv.Itoa(n) + " bytes for a kinfo_proc, this code has " + strconv.Itoa(kinfoProcSize) + " (ENOMEM)"
	case errno != 0:
		return ""
	case n == 0:
		return ""
	case n != kinfoProcSize:
		return "the kernel wrote " + strconv.Itoa(n) + " bytes of kinfo_proc, this code expects " + strconv.Itoa(kinfoProcSize)
	case len(buf) < kinfoPidOff+4:
		return ""
	}
	got := int(int32(binary.LittleEndian.Uint32(buf[kinfoPidOff:])))
	if got != 0 && got != pid {
		return "offset " + strconv.Itoa(kinfoPidOff) + " holds pid " + strconv.Itoa(got) + ", not the one asked about"
	}
	return ""
}

var (
	kinfoAnomalyLogged atomic.Bool
	kinfoAnomalyLogf   = log.Printf
)

// reportKinfoAnomaly says once, for the life of the process, that the darwin
// reading is broken in a way that cannot mean "the parent is gone". Once:
// waitParentExit re-probes every two seconds and a line per probe would be the
// reason nobody reads any of them.
func reportKinfoAnomaly(pid int, what string) {
	if kinfoAnomalyLogged.Swap(true) {
		return
	}
	kinfoAnomalyLogf("borgo: reading kern.proc.pid.%d: %s; from here on every parent reads as alive on macOS, which is what this platform did before the check existed - an api can outlive the supervisor that started it", pid, what)
}
