//go:build (freebsd && (amd64 || arm64)) || (openbsd && (386 || amd64 || arm || arm64 || riscv64))

package borgo

import (
	"syscall"
	"unsafe"
)

// bsdKinfoSysctl asks the kernel for pid's kinfo_proc through the mib each
// platform spells kern.proc.pid with, and reports the reading raw: bytes the
// kernel claims, the buffer, the errno. bsdKinfoCorpse decides, in a file with
// no build tag, which is what makes the answer testable off these kernels.
//
// syscall.Sysctl is name-based and cannot address a per-pid node, and the
// package's mib-taking sysctl is unexported, so the call is made directly. On
// openbsd, where 7.5 removed indirect syscalls, syscall.Syscall6 reroutes
// SYS___SYSCTL through the libc stub itself; on freebsd it is the trap the
// standard library uses.
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

// processIsCorpse asks the kernel for the process's state: neither freebsd nor
// openbsd mounts a /proc, and kill(pid, 0) succeeds on a zombie. Every failure
// answers no, so this branch can only ever add a corpse it is certain of to
// what the signal probe alone saw.
func processIsCorpse(pid int) bool {
	if pid <= 0 {
		return false
	}
	n, buf, errno := bsdKinfoSysctl(pid)
	return bsdKinfoCorpse(bsdKinfo, pid, n, buf, errno)
}
