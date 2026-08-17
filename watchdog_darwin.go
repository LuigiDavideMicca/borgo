//go:build darwin

package borgo

import (
	"syscall"
	"unsafe"
)

// the mib for kern.proc.pid.<pid>, the reading ps(1) itself takes
const (
	ctlKern     = 1
	kernProc    = 14
	kernProcPID = 1
)

// kinfoProcSysctl asks the kernel for pid's kinfo_proc and reports the reading
// raw: the byte count the kernel claims, the buffer it was handed, and the
// errno. Nothing is decided here - kinfoProcDecide does that in a file with no
// build tag, which is what makes the darwin answer testable off darwin.
//
// syscall.Sysctl is name-based and cannot address a per-pid node, and the
// package's mib-taking sysctl is unexported, so the call is made directly.
// On darwin syscall.Syscall6 is not the deprecated syscall(2) shim: it traps
// into the kernel itself (SYSCALL with 0x2000000+trap on amd64, SVC $0x80 on
// arm64), which is the ABI Apple does not promise, where libSystem is. The
// libc route is golang.org/x/sys/unix, one more module in the go.mod of a
// framework - measured as a go.sum line every consumer inherits on every
// platform - for a risk with a live precedent the other way: openbsd 7.5 did
// remove indirect syscalls, and go rerouted exactly SYS___SYSCTL to the libc
// stub rather than break the callers. So the trap stays and the failure is
// made legible instead: a dispatch that stops working answers ENOSYS, which
// kinfoReadAnomaly says out loud.
func kinfoProcSysctl(pid int) (int, []byte, int) {
	mib := [4]int32{ctlKern, kernProc, kernProcPID, int32(pid)}
	buf := make([]byte, kinfoProcSize)
	n := uintptr(len(buf))
	_, _, errno := syscall.Syscall6(
		syscall.SYS___SYSCTL,
		uintptr(unsafe.Pointer(&mib[0])),
		uintptr(len(mib)),
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(unsafe.Pointer(&n)),
		0,
		0,
	)
	// a pid nobody owns is reported as success with nothing written
	return int(n), buf, int(errno)
}

// processIsCorpse asks the kernel for the process's state. darwin has no /proc
// to read, and kill(pid, 0) succeeds on a zombie, so without this a macOS api
// boots under a supervisor that has already exited, mounts the registry, binds
// the port and serves forever under a dead parent.
//
// Every failure answers no. A refused or unavailable sysctl leaves this branch
// exactly where the signal probe alone left it, which is what the platform did
// before this file existed: nothing here can refuse a boot on its own, that
// takes a reading whose length and pid both check out. A failure that cannot
// mean "the parent is gone" is logged once on the way past, which changes no
// answer and is the only thing that tells a broken darwin branch from a
// working one.
func processIsCorpse(pid int) bool {
	if pid <= 0 {
		return false
	}
	n, buf, errno := kinfoProcSysctl(pid)
	return kinfoProcDecide(pid, n, buf, errno)
}
