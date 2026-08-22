//go:build openbsd && (386 || amd64 || arm || arm64 || riscv64)

package borgo

import "unsafe"

var bsdKinfo = openbsdKinfo

// openbsdKinfoProc is the C layout as cgo -godefs reads it from sys/sysctl.h,
// amd64 and 386 alike, with the fields this code never touches collapsed into
// runs of the same width. golang.org/x/sys/unix carries no kinfo_proc for
// openbsd, so this is the witness: the offsets in watchdog_corpse.go have to
// agree with it both ways, and the prefix asked for has to end at p_comm,
// inside it, or the package does not build.
type openbsdKinfoProc struct {
	_    [12]uint64 // p_forw .. p_ru
	_    [3]int32   // p_eflag p_exitsig p_flag
	Pid  int32
	_    [4]int32   // p_ppid .. p_tpgid
	_    [4]uint32  // p_uid .. p_rgid
	_    [16]uint32 // p_groups
	_    [2]int16
	_    [9]uint32 // p_tdev .. p_schedflags
	_    [4]uint64 // p_uticks .. p_tracep
	_    [6]int32  // p_traceflag .. p_sigcatch
	Stat int8
	_    [3]uint8
	_    [2]uint16
	Comm [24]int8
	_    [8]int8 // p_wmesg
	_    uint64  // p_wchan
	_    [32]int8
	_    [4]int32 // p_vm_rssize .. p_vm_ssize
	_    int64
	_    uint64
	_    [5]uint32
	_    [4]byte
	_    [14]uint64 // p_uru_*
	_    [6]uint32
	_    [8]int8 // p_emul
	_    [3]uint64
	_    [2]int32
}

var (
	_ [openbsdKinfoPidOff - unsafe.Offsetof(openbsdKinfoProc{}.Pid)]struct{}
	_ [unsafe.Offsetof(openbsdKinfoProc{}.Pid) - openbsdKinfoPidOff]struct{}
	_ [openbsdKinfoStatOff - unsafe.Offsetof(openbsdKinfoProc{}.Stat)]struct{}
	_ [unsafe.Offsetof(openbsdKinfoProc{}.Stat) - openbsdKinfoStatOff]struct{}
	_ [openbsdKinfoPrefix - unsafe.Offsetof(openbsdKinfoProc{}.Comm)]struct{}
	_ [unsafe.Offsetof(openbsdKinfoProc{}.Comm) - openbsdKinfoPrefix]struct{}
	_ [unsafe.Sizeof(openbsdKinfoProc{}) - openbsdKinfoPrefix]struct{}
)

// kern.proc.pid.<pid>, then the element size this code knows and a count of
// one: the kernel writes that many bytes of its kinfo_proc
func bsdKinfoMib(pid int) []int32 {
	return []int32{1, 66, 1, int32(pid), openbsdKinfoPrefix, 1}
}
