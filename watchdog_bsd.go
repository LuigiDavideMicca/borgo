//go:build (freebsd && (amd64 || arm64)) || (openbsd && (386 || amd64 || arm || arm64 || riscv64))

package borgo

import (
	"syscall"
	"unsafe"
)

// bsdKinfoSysctl reports the reading raw; bsdKinfoCorpse decides, with no
// build tag. syscall.Sysctl is name-based and cannot address a per-pid node,
// so the call is made directly: on openbsd, where 7.5 removed indirect
// syscalls, syscall.Syscall6 reroutes SYS___SYSCTL through the libc stub
// itself; on freebsd it is the trap the standard library uses.
func bsdKinfoSysctl(pid int) (int, []byte, int) {
	mib := bsdKinfoMib(pid)
	buf := make([]byte, bsdKinfo.size)
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
	return int(n), buf, int(errno)
}

// Neither freebsd nor openbsd mounts a /proc, and kill(pid, 0) succeeds on a
// zombie. Every failure answers no.
func processIsCorpse(pid int) bool {
	if pid <= 0 {
		return false
	}
	n, buf, errno := bsdKinfoSysctl(pid)
	return bsdKinfoCorpse(bsdKinfo, pid, n, buf, errno)
}
