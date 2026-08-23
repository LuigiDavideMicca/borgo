package borgo

import (
	"bytes"
	"encoding/binary"
	"log"
	"strconv"
	"sync/atomic"
)

// The decisions of the corpse question, with no build tag so they are testable
// on any machine. Every unsure answer is false: refusing a boot needs certainty
// the parent is gone, so a wrong platform branch can only leave the behaviour
// that was there before it.

// A pid in field 1 that is not the one asked about is a foreign /proc (a
// namespace mounted over it): a stranger's state must not decide the boot.
// The comm in field 2 is unescaped, so "my prog (x)" defeats a split on
// whitespace or on the first ")": only the last one is certainly the closing
// paren.
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

// darwin's struct kinfo_proc, LP64, identical and little-endian on arm64 and
// amd64. Taken from golang.org/x/sys/unix's generated struct for both; nothing
// at runtime checks them, so watchdog_corpse_test.go pins them.
const (
	kinfoProcSize = 648 // sizeof(struct kinfo_proc)
	kinfoStatOff  = 36  // offsetof(kp_proc.p_stat)
	kinfoPidOff   = 40  // offsetof(kp_proc.p_pid)
	sZomb         = 5   // SZOMB
)

// The size and the pid are the whole guard against wrong offsets, which
// cannot be tested from here: with them wrong the state byte belongs to some
// other field and could read as SZOMB, refusing every boot on macOS. A range
// check on the state adds nothing - garbage equal to SZOMB passes it. A pid
// nobody owns is a reading of length zero.
func kinfoProcCorpse(pid int, buf []byte) bool {
	if pid <= 0 || len(buf) != kinfoProcSize {
		return false
	}
	if int(int32(binary.LittleEndian.Uint32(buf[kinfoPidOff:]))) != pid {
		return false
	}
	return buf[kinfoStatOff] == sZomb
}

// darwin's errno numbers, not imported, so this file keeps no build tag
const (
	darwinENOMEM = 12
	darwinENOSYS = 78
)

// kinfoProcDecide is the whole darwin answer given one raw reading: n is the
// byte count the kernel claims, errno 0 on success.
func kinfoProcDecide(pid, n int, buf []byte, errno int) bool {
	if a := kinfoReadAnomaly(pid, n, buf, errno); a != "" {
		reportKinfoAnomaly(pid, a)
	}
	if errno != 0 || n != kinfoProcSize || n > len(buf) {
		return false
	}
	return kinfoProcCorpse(pid, buf[:n])
}

// kinfoReadAnomaly names a structurally wrong reading, "" otherwise. It
// changes no answer: every failure is still "alive", this only makes a darwin
// branch that never worked distinguishable from one that does.
//
// A reaped or never-there parent is the frequent, legitimate case and stays
// silent: darwin reports it as a success that wrote nothing, and no errno can
// be read from here as "missing process". Only errnos that cannot describe one
// count: ENOSYS (no syscall ran) and ENOMEM (the kernel wants more bytes than
// this code believes a kinfo_proc is). Pid 0 in a full struct is not evidence
// against the offsets: a zeroed buffer reads that way, and pid 0 is a real
// process on darwin.
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

// Once for the life of the process: waitParentExit re-probes four times a
// second, and a line per probe would be the reason nobody reads any of them.
func reportKinfoAnomaly(pid int, what string) {
	if kinfoAnomalyLogged.Swap(true) {
		return
	}
	kinfoAnomalyLogf("borgo: reading kern.proc.pid.%d: %s; from here on every parent reads as alive on macOS, which is what this platform did before the check existed - an api can outlive the supervisor that started it", pid, what)
}

type bsdKinfoLayout struct {
	size    int  // bytes one reading must be, exactly
	pidOff  int  // int32 pid, little-endian on every arch covered
	statOff int  // one byte of state
	corpse  byte // the state a collected-but-unreaped process shows
	dead    byte // a second dead state, or corpse again where there is none
	sized   bool // the reading opens with its own byte count as an int32
}

// freebsd LP64 (amd64, arm64), held against the C layout at compile time in
// watchdog_bsd_freebsd.go. The kernel writes KINFO_PROC_SIZE into
// ki_structsize as the first int32, so a reading is checked against its own
// header. 6 is SWAIT, a living state: only 5 counts.
const (
	freebsdKinfoSize    = 1088 // sizeof(struct kinfo_proc)
	freebsdKinfoPidOff  = 72   // offsetof(ki_pid)
	freebsdKinfoStatOff = 388  // offsetof(ki_stat)
	freebsdSZomb        = 5
)

var freebsdKinfo = bsdKinfoLayout{
	size:    freebsdKinfoSize,
	pidOff:  freebsdKinfoPidOff,
	statOff: freebsdKinfoStatOff,
	corpse:  freebsdSZomb,
	dead:    freebsdSZomb,
	sized:   true,
}

// openbsd, held against the C layout at compile time in
// watchdog_bsd_openbsd.go. Its kinfo_proc is the same bytes on every arch and
// grows only at the tail, and the caller names the element size it wants: so
// this asks for a prefix ending at p_comm, past p_stat, and never depends on
// the whole struct's size for the release it runs on. SDEAD 6 is the moment
// before SZOMB, both dead.
const (
	openbsdKinfoPrefix  = 312 // offsetof(p_comm): the bytes asked for
	openbsdKinfoPidOff  = 108 // offsetof(p_pid)
	openbsdKinfoStatOff = 304 // offsetof(p_stat)
	openbsdSZomb        = 5
	openbsdSDead        = 6
)

var openbsdKinfo = bsdKinfoLayout{
	size:    openbsdKinfoPrefix,
	pidOff:  openbsdKinfoPidOff,
	statOff: openbsdKinfoStatOff,
	corpse:  openbsdSZomb,
	dead:    openbsdSDead,
}

// bsdKinfoCorpse decides from one kern.proc.pid reading: n is what the kernel
// says it wrote, errno 0 on success. Every unsure answer is alive, so a wrong
// layout leaves the platform where kill(pid, 0) alone left it.
func bsdKinfoCorpse(l bsdKinfoLayout, pid, n int, buf []byte, errno int) bool {
	if pid <= 0 || errno != 0 || n != l.size || len(buf) < n {
		return false
	}
	if l.pidOff < 0 || l.statOff < 0 || l.pidOff+4 > n || l.statOff >= n {
		return false
	}
	if l.sized && int(binary.LittleEndian.Uint32(buf)) != l.size {
		return false
	}
	if int(int32(binary.LittleEndian.Uint32(buf[l.pidOff:]))) != pid {
		return false
	}
	st := buf[l.statOff]
	return st == l.corpse || st == l.dead
}
