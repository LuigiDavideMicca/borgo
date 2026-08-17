package borgo

import (
	"bytes"
	"encoding/binary"
	"strconv"
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
