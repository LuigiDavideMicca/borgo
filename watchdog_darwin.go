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

// kinfoProcRead returns the kernel's kinfo_proc for pid, or an error.
//
// syscall.Sysctl is name-based and cannot address a per-pid node, and the
// package's mib-taking sysctl is unexported, so the call is made directly. It
// is kept apart from the decision so a test on a real darwin can prove the
// syscall worked and the struct is the one this code hardcodes - a failure
// there is otherwise silent, because a failed read degrades to the answer this
// platform gave before.
func kinfoProcRead(pid int) ([]byte, error) {
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
	if errno != 0 {
		return nil, errno
	}
	if n > uintptr(len(buf)) {
		return nil, syscall.EIO
	}
	// a pid nobody owns is reported as success with nothing written
	return buf[:n], nil
}

// processIsCorpse asks the kernel for the process's state. darwin has no /proc
// to read, and kill(pid, 0) succeeds on a zombie, so without this a macOS api
// boots under a supervisor that has already exited, mounts the registry, binds
// the port and serves forever under a dead parent.
//
// Every failure answers no. A refused or unavailable sysctl leaves this branch
// exactly where the signal probe alone left it, which is what the platform did
// before this file existed: nothing here can refuse a boot on its own, that
// takes a reading whose length and pid both check out.
func processIsCorpse(pid int) bool {
	if pid <= 0 {
		return false
	}
	buf, err := kinfoProcRead(pid)
	if err != nil {
		return false
	}
	return kinfoProcCorpse(pid, buf)
}
