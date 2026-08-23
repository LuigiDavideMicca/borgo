//go:build freebsd && (amd64 || arm64)

package borgo

import "unsafe"

var bsdKinfo = freebsdKinfo

// The C layout as cgo -godefs reads it from sys/user.h, amd64 and arm64 alike,
// untouched fields collapsed into runs of the same width. golang.org/x/sys/unix
// carries no kinfo_proc for freebsd, so this is the witness the numbers in
// watchdog_corpse.go are held against: disagree and the package does not build.
type freebsdKinfoProc struct {
	Structsize int32
	Layout     int32
	_          [8]int64 // ki_args .. ki_wchan
	Pid        int32
	_          [5]int32 // ki_ppid .. ki_tsid
	_          [2]int16
	_          uint32      // ki_tdev
	_          [4][16]byte // the four sigsets
	_          [5]uint32   // ki_uid .. ki_svgid
	_          [2]int16
	_          [16]uint32 // ki_groups
	_          [6]int64   // ki_size .. ki_ssize
	_          [2]uint16
	_          [5]uint32 // ki_pctcpu .. ki_cow
	_          [7]int64  // ki_runtime, ki_start, ki_childtime, ki_flag, ki_kiflag
	_          int32     // ki_traceflag
	Stat       int8
	_          [5]int8
	_          [158]int8 // ki_tdname .. ki_sparestrings
	_          [13]int32 // ki_spareints .. ki_tid
	_          [4]uint8  // ki_pri
	_          [36]int64 // ki_rusage, ki_rusage_ch
	_          [24]int64 // ki_pcb .. ki_tdflags
}

var (
	_ [freebsdKinfoSize - unsafe.Sizeof(freebsdKinfoProc{})]struct{}
	_ [unsafe.Sizeof(freebsdKinfoProc{}) - freebsdKinfoSize]struct{}
	_ [freebsdKinfoPidOff - unsafe.Offsetof(freebsdKinfoProc{}.Pid)]struct{}
	_ [unsafe.Offsetof(freebsdKinfoProc{}.Pid) - freebsdKinfoPidOff]struct{}
	_ [freebsdKinfoStatOff - unsafe.Offsetof(freebsdKinfoProc{}.Stat)]struct{}
	_ [unsafe.Offsetof(freebsdKinfoProc{}.Stat) - freebsdKinfoStatOff]struct{}
)

// kern.proc.pid.<pid>: the kernel writes one whole struct kinfo_proc
func bsdKinfoMib(pid int) []int32 {
	return []int32{1, 14, 1, int32(pid)}
}
