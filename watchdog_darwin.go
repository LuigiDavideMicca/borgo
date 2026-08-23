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

// kinfoProcSysctl reports the reading raw; kinfoProcDecide decides, with no
// build tag. syscall.Sysctl is name-based and cannot address a per-pid node,
// so the call is made directly.
//
// On darwin syscall.Syscall6 traps into the kernel (SYSCALL 0x2000000+trap on
// amd64, SVC $0x80 on arm64), the ABI Apple does not promise; libSystem is.
// The libc route costs a golang.org/x/sys dependency every consumer inherits,
// against a precedent the other way: when openbsd 7.5 removed indirect
// syscalls, go rerouted exactly SYS___SYSCTL to the libc stub. So the trap
// stays, and a dispatch that stops working answers ENOSYS, which
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

// darwin has no /proc, and kill(pid, 0) succeeds on a zombie. Every failure
// answers no: a refused or unavailable sysctl leaves the platform where the
// signal probe alone left it.
func processIsCorpse(pid int) bool {
	if pid <= 0 {
		return false
	}
	n, buf, errno := kinfoProcSysctl(pid)
	return kinfoProcDecide(pid, n, buf, errno)
}
