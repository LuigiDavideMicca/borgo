package borgo

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"log"
	"strconv"
	"strings"
	"testing"
)

// These run everywhere, windows included: the readings are injected, so the
// decision the watchdog makes about a parent is testable on a machine that has
// neither /proc nor a darwin kernel. Everything that needs a real corpse lives
// in the per-platform test files.

// procStatLine builds a /proc/<pid>/stat line: pid, comm in parens, state,
// then the numeric tail the parser must not read the state from.
func procStatLine(pid int, comm string, state string) []byte {
	return []byte(strconv.Itoa(pid) + " (" + comm + ") " + state +
		" 1 " + strconv.Itoa(pid) + " " + strconv.Itoa(pid) + " 0 -1 4194560 0 0 0 0\n")
}

func TestProcStatCorpseReadsTheStateAfterTheComm(t *testing.T) {
	cases := []struct {
		state string
		want  bool
	}{
		{"Z", true},
		{"X", true},
		{"x", true},
		{"R", false},
		{"S", false},
		{"D", false},
		{"T", false},
		{"I", false},
	}
	for _, c := range cases {
		if got := procStatCorpse(4242, procStatLine(4242, "sh", c.state)); got != c.want {
			t.Errorf("state %q read as corpse=%t, want %t", c.state, got, c.want)
		}
	}
}

// The comm is unescaped, so a process called "my prog (x)" carries both a
// space and a paren. Splitting on whitespace, or on the first ")", reads part
// of the name as the state and every corpse comes back alive.
func TestProcStatCorpseReadsPastACommWithParens(t *testing.T) {
	if !procStatCorpse(4242, procStatLine(4242, "my prog (x)", "Z")) {
		t.Fatal("a zombie whose name contains a paren read as alive: the state came from the wrong field")
	}
}

// and the other way round: a live process whose name contains ") Z (" must not
// be read as a corpse, or its perfectly healthy supervisor refuses the boot
func TestProcStatCorpseSaysNoForALiveNameThatLooksLikeAZombie(t *testing.T) {
	if procStatCorpse(4242, procStatLine(4242, "a) Z (b", "S")) {
		t.Fatal("a live process named like a zombie read as a corpse: the state came from inside its name")
	}
}

// Field 1 is the pid the kernel is describing. A reading about somebody else
// is a reading this process cannot use - it means /proc is not the one whose
// pids it signals - and a stranger's state must never decide the boot.
func TestProcStatCorpseRefusesAReadingAboutAnotherPid(t *testing.T) {
	if procStatCorpse(4242, procStatLine(99, "sh", "Z")) {
		t.Fatal("a stat naming pid 99 answered the question about pid 4242")
	}
}

func TestProcStatCorpseIsUnsureOnAnythingItCannotRead(t *testing.T) {
	cases := []struct {
		name string
		pid  int
		stat string
	}{
		{"empty", 4242, ""},
		{"no space at all", 4242, "4242"},
		{"space first", 4242, " 4242 (sh) Z 1"},
		{"pid not a number", 4242, "42x2 (sh) Z 1"},
		{"no closing paren", 4242, "4242 (sh Z 1"},
		{"paren before the pid field ends", 4242, "4242) (sh Z 1"},
		{"nothing after the comm", 4242, "4242 (sh)"},
		{"only spaces after the comm", 4242, "4242 (sh)   "},
		{"pid zero", 0, "0 (sh) Z 1"},
		{"pid negative", -1, "-1 (sh) Z 1"},
	}
	for _, c := range cases {
		if procStatCorpse(c.pid, []byte(c.stat)) {
			t.Errorf("%s: %q read as a corpse; unsure has to answer alive", c.name, c.stat)
		}
	}
}

// The layout is written out again here rather than taken from the code under
// test: a builder that shared the constants would move with them, and moving
// an offset is exactly the mistake that decides what byte the watchdog calls
// the state of a supervisor.
const (
	darwinKinfoSize = 648
	darwinStatOff   = 36
	darwinPidOff    = 40
	darwinSZOMB     = 5
)

// kinfoBuf builds one kern.proc.pid reading: the whole struct, with the pid
// and state bytes where darwin puts them.
func kinfoBuf(pid int, state byte) []byte {
	buf := make([]byte, darwinKinfoSize)
	binary.LittleEndian.PutUint32(buf[darwinPidOff:], uint32(int32(pid)))
	buf[darwinStatOff] = state
	return buf
}

func TestKinfoProcCorpseSeesAZombie(t *testing.T) {
	if !kinfoProcCorpse(4242, kinfoBuf(4242, darwinSZOMB)) {
		t.Fatal("a kinfo_proc in SZOMB read as alive: on macOS the api boots under a supervisor that has already exited")
	}
}

func TestKinfoProcCorpseSaysNoForEveryLivingState(t *testing.T) {
	// SIDL, SRUN, SSLEEP, SSTOP, and 0 for a slot nothing filled in
	for _, state := range []byte{0, 1, 2, 3, 4} {
		if kinfoProcCorpse(4242, kinfoBuf(4242, state)) {
			t.Errorf("p_stat %d read as a corpse: a live supervisor would have its boot refused", state)
		}
	}
}

// The guard that makes this branch safe to ship unexecuted. If the offsets are
// wrong the state byte belongs to some other field and can read as SZOMB by
// accident, which on macOS refuses every boot. A pid that is not the one asked
// about proves exactly that, and answers alive.
func TestKinfoProcCorpseRefusesAReadingAboutAnotherPid(t *testing.T) {
	if kinfoProcCorpse(4242, kinfoBuf(99, darwinSZOMB)) {
		t.Fatal("a kinfo_proc naming pid 99 answered the question about pid 4242: a misparse would refuse every boot on macOS")
	}
}

// pid is an int and p_pid is 32 bits: a pid that only matches once truncated
// is not a match.
func TestKinfoProcCorpseRefusesAPidThatOnlyMatchesTruncated(t *testing.T) {
	var hi int64 = 1<<32 + 4242
	if int64(int(hi)) != hi {
		t.Skip("pid is 32 bits here, nothing to truncate")
	}
	wide := int(hi)
	if kinfoProcCorpse(wide, kinfoBuf(4242, darwinSZOMB)) {
		t.Fatalf("pid %d was answered by a reading about pid 4242", wide)
	}
}

// A reading that is not the whole struct is a layout this code does not know,
// and a pid nobody owns is reported as a reading of length zero.
func TestKinfoProcCorpseRefusesAReadingOfTheWrongLength(t *testing.T) {
	full := kinfoBuf(4242, darwinSZOMB)
	cases := []struct {
		name string
		buf  []byte
	}{
		{"empty, which is how darwin reports a pid nobody owns", nil},
		{"one byte short", full[:darwinKinfoSize-1]},
		{"one byte long", append(append([]byte(nil), full...), 0)},
		{"only as far as the two fields it reads", full[:darwinPidOff+4]},
	}
	for _, c := range cases {
		if kinfoProcCorpse(4242, c.buf) {
			t.Errorf("%s: read as a corpse", c.name)
		}
	}
}

// SZOMB one byte off the state field must not be read as the state.
func TestKinfoProcCorpseDoesNotFindTheStateNextToIt(t *testing.T) {
	for _, off := range []int{darwinStatOff - 1, darwinStatOff + 1} {
		buf := kinfoBuf(4242, 0)
		buf[off] = darwinSZOMB
		if kinfoProcCorpse(4242, buf) {
			t.Errorf("SZOMB at offset %d was read as the state at %d", off, darwinStatOff)
		}
	}
}

func TestKinfoProcCorpseRefusesANonPid(t *testing.T) {
	for _, pid := range []int{0, -1} {
		if kinfoProcCorpse(pid, kinfoBuf(pid, darwinSZOMB)) {
			t.Errorf("pid %d read as a corpse", pid)
		}
	}
}

// The errno numbers, written out again rather than taken from the code under
// test, for the same reason the offsets are.
const (
	errnoESRCH   = 3
	errnoENOMEM  = 12
	errnoEINVAL  = 22
	errnoENOSYS  = 78
	errnoEPERM   = 1
	errnoSuccess = 0
)

// The frequent, legitimate case. A parent that has been reaped, or a pid that
// never existed, must not spend the one line that says this branch is broken -
// and neither must any errno that could be how some darwin spells it, which is
// every errno but the two that cannot describe a missing process.
func TestKinfoReadAnomalyIsSilentOnEverythingThatCouldBeAMissingParent(t *testing.T) {
	full := kinfoBuf(4242, darwinSZOMB)
	cases := []struct {
		name  string
		n     int
		buf   []byte
		errno int
	}{
		{"success with nothing written, which is how darwin reports a pid nobody owns", 0, make([]byte, darwinKinfoSize), errnoSuccess},
		// on an errno the kernel need not touch the length at all, and the
		// caller seeded it with the size of the buffer it offered: these carry
		// the full size on purpose, or the errno arm is never the thing that
		// keeps them quiet
		{"ESRCH", darwinKinfoSize, kinfoBuf(99, darwinSZOMB), errnoESRCH},
		{"EPERM", darwinKinfoSize, kinfoBuf(99, darwinSZOMB), errnoEPERM},
		{"EINVAL", darwinKinfoSize, kinfoBuf(99, darwinSZOMB), errnoEINVAL},
		{"an errno nothing here has a name for", darwinKinfoSize, kinfoBuf(99, darwinSZOMB), 42},
		{"a whole struct about the pid asked about", darwinKinfoSize, full, errnoSuccess},
		{"a whole struct holding pid 0, which a zeroed buffer also reads as", darwinKinfoSize, make([]byte, darwinKinfoSize), errnoSuccess},
	}
	for _, c := range cases {
		if a := kinfoReadAnomaly(4242, c.n, c.buf, c.errno); a != "" {
			t.Errorf("%s: reported as %q", c.name, a)
		}
	}
}

// ENOSYS cannot mean "the process is gone": it means no syscall ran at all.
// This is the shape a darwin that stops accepting the direct trap would take,
// and today it answers "alive" for every parent without a word.
func TestKinfoReadAnomalyNamesASyscallThatDidNotDispatch(t *testing.T) {
	a := kinfoReadAnomaly(4242, 0, make([]byte, darwinKinfoSize), errnoENOSYS)
	if !strings.Contains(a, "ENOSYS") {
		t.Fatalf("a sysctl that did not dispatch was reported as %q: a darwin branch that never ran looks exactly like one that works", a)
	}
}

// ENOMEM says the kernel wants to write more than this code believes a
// kinfo_proc is - the struct grew - which also cannot mean a missing process.
func TestKinfoReadAnomalyNamesAKernelThatWantsMoreThanThisStruct(t *testing.T) {
	a := kinfoReadAnomaly(4242, 720, make([]byte, darwinKinfoSize), errnoENOMEM)
	if !strings.Contains(a, "ENOMEM") || !strings.Contains(a, "720") {
		t.Fatalf("a grown kinfo_proc was reported as %q", a)
	}
}

func TestKinfoReadAnomalyNamesAReadingOfUnexpectedLength(t *testing.T) {
	for _, n := range []int{1, darwinKinfoSize - 1, darwinKinfoSize + 1} {
		a := kinfoReadAnomaly(4242, n, make([]byte, darwinKinfoSize), errnoSuccess)
		if !strings.Contains(a, strconv.Itoa(n)) {
			t.Errorf("a %d-byte reading was reported as %q", n, a)
		}
	}
}

// The offsets are the part no machine here can check. A full struct that names
// somebody else is the proof they are wrong, and it is silent today.
func TestKinfoReadAnomalyNamesAStructAboutAnotherPid(t *testing.T) {
	a := kinfoReadAnomaly(4242, darwinKinfoSize, kinfoBuf(99, darwinSZOMB), errnoSuccess)
	if !strings.Contains(a, "99") {
		t.Fatalf("a struct naming pid 99 for a question about 4242 was reported as %q: wrong offsets stay invisible", a)
	}
}

func TestKinfoReadAnomalySaysNothingAboutANonPid(t *testing.T) {
	for _, pid := range []int{0, -1} {
		if a := kinfoReadAnomaly(pid, 0, nil, errnoENOSYS); a != "" {
			t.Errorf("pid %d reported as %q", pid, a)
		}
	}
}

// The log has to be provable, or nobody knows whether it works. It also has to
// be said once: waitParentExit re-probes every two seconds.
func TestReportKinfoAnomalySpeaksOnceForTheLifeOfTheProcess(t *testing.T) {
	var lines []string
	restore := captureKinfoAnomaly(t, &lines)
	defer restore()

	reportKinfoAnomaly(4242, "the sysctl did not dispatch (ENOSYS)")
	reportKinfoAnomaly(4242, "the sysctl did not dispatch (ENOSYS)")
	reportKinfoAnomaly(7, "offset 40 holds pid 9, not the one asked about")

	if len(lines) != 1 {
		t.Fatalf("%d lines logged, want 1: %q", len(lines), lines)
	}
	for _, want := range []string{"kern.proc.pid.4242", "ENOSYS", "alive"} {
		if !strings.Contains(lines[0], want) {
			t.Errorf("the line does not say %q: %q", want, lines[0])
		}
	}
}

// The whole darwin answer, from a raw reading, on a machine with no darwin: a
// broken reading still answers alive, and says so exactly once.
func TestKinfoProcDecideAnswersAliveAndSpeaksWhenTheReadingIsBroken(t *testing.T) {
	var lines []string
	restore := captureKinfoAnomaly(t, &lines)
	defer restore()

	if kinfoProcDecide(4242, 0, make([]byte, darwinKinfoSize), errnoENOSYS) {
		t.Fatal("a sysctl that did not dispatch refused a boot: the error direction is the one thing this branch may not change")
	}
	if len(lines) != 1 {
		t.Fatalf("%d lines logged for a broken reading, want 1", len(lines))
	}
}

// and a good reading decides, silently, in both directions
func TestKinfoProcDecideReadsAGoodStructWithoutAWord(t *testing.T) {
	var lines []string
	restore := captureKinfoAnomaly(t, &lines)
	defer restore()

	if !kinfoProcDecide(4242, darwinKinfoSize, kinfoBuf(4242, darwinSZOMB), errnoSuccess) {
		t.Fatal("a zombie read as alive: on macOS the api boots under a supervisor that has already exited")
	}
	if kinfoProcDecide(4242, darwinKinfoSize, kinfoBuf(4242, 3), errnoSuccess) {
		t.Fatal("a sleeping process read as a corpse: its boot would be refused")
	}
	if kinfoProcDecide(4242, 0, make([]byte, darwinKinfoSize), errnoSuccess) {
		t.Fatal("a pid nobody owns read as a corpse")
	}
	if len(lines) != 0 {
		t.Fatalf("a good reading logged %q", lines)
	}
}

// Every test above swaps the log function out, so all of them would still pass
// with the real one wired to nothing. This one leaves it alone and reads what
// actually reaches the log package.
func TestReportKinfoAnomalyReachesTheRealLog(t *testing.T) {
	var buf bytes.Buffer
	prevOut, prevFlags := log.Writer(), log.Flags()
	log.SetOutput(&buf)
	log.SetFlags(0)
	kinfoAnomalyLogged.Store(false)
	defer func() {
		log.SetOutput(prevOut)
		log.SetFlags(prevFlags)
		kinfoAnomalyLogged.Store(false)
	}()

	reportKinfoAnomaly(4242, "the sysctl did not dispatch (ENOSYS)")

	got := buf.String()
	for _, want := range []string{"borgo:", "kern.proc.pid.4242", "ENOSYS", "alive"} {
		if !strings.Contains(got, want) {
			t.Errorf("the line that reached the log does not say %q: %q", want, got)
		}
	}
}

// captureKinfoAnomaly redirects the one anomaly line into lines and re-arms the
// once, restoring both.
func captureKinfoAnomaly(t *testing.T, lines *[]string) func() {
	t.Helper()
	prev := kinfoAnomalyLogf
	kinfoAnomalyLogf = func(format string, args ...any) {
		*lines = append(*lines, fmt.Sprintf(format, args...))
	}
	kinfoAnomalyLogged.Store(false)
	return func() {
		kinfoAnomalyLogf = prev
		kinfoAnomalyLogged.Store(false)
	}
}

// The three numbers this file hardcodes are darwin's, and they were taken from
// the struct golang.org/x/sys/unix generates from the system headers. Nothing
// at runtime can check them, so they are pinned here: a change to any of them
// is a change to what byte the watchdog calls the state of a supervisor.
func TestKinfoLayoutIsTheOneThatWasCrossChecked(t *testing.T) {
	got := strings.Join([]string{
		strconv.Itoa(kinfoProcSize),
		strconv.Itoa(kinfoStatOff),
		strconv.Itoa(kinfoPidOff),
		strconv.Itoa(sZomb),
	}, " ")
	const want = "648 36 40 5"
	if got != want {
		t.Fatalf("kinfo_proc layout is now %q, was %q: re-check it against darwin's headers for both architectures before changing this", got, want)
	}
}

// freebsd's and openbsd's layouts, written out again rather than taken from
// the code under test, for the same reason darwin's are. These are the whole
// BSD answer that can be tested from here: no kernel of either is available to
// this package's tests, so the syscall, the mib and the C layout's agreement
// with these numbers rest on the compile-time witnesses in the tagged files.
const (
	bsdFreebsdSize    = 1088
	bsdFreebsdPidOff  = 72
	bsdFreebsdStatOff = 388
	bsdOpenbsdSize    = 312
	bsdOpenbsdPidOff  = 108
	bsdOpenbsdStatOff = 304
	bsdSZOMB          = 5
	bsdOpenbsdSDEAD   = 6
	bsdFreebsdSWAIT   = 6
)

// freebsdBuf builds one freebsd reading: the whole struct, opening with its
// own size as the kernel writes it into ki_structsize
func freebsdBuf(pid int, state byte) []byte {
	buf := make([]byte, bsdFreebsdSize)
	binary.LittleEndian.PutUint32(buf, bsdFreebsdSize)
	binary.LittleEndian.PutUint32(buf[bsdFreebsdPidOff:], uint32(int32(pid)))
	buf[bsdFreebsdStatOff] = state
	return buf
}

// openbsdBuf builds one openbsd reading: the prefix this code asks for
func openbsdBuf(pid int, state byte) []byte {
	buf := make([]byte, bsdOpenbsdSize)
	binary.LittleEndian.PutUint32(buf[bsdOpenbsdPidOff:], uint32(int32(pid)))
	buf[bsdOpenbsdStatOff] = state
	return buf
}

type bsdCase struct {
	name   string
	layout bsdKinfoLayout
	size   int
	pidOff int
	build  func(pid int, state byte) []byte
	dead   []byte
	alive  []byte
}

func bsdCases() []bsdCase {
	return []bsdCase{
		{"freebsd", freebsdKinfo, bsdFreebsdSize, bsdFreebsdPidOff, freebsdBuf,
			[]byte{bsdSZOMB},
			[]byte{0, 1, 2, 3, 4, bsdFreebsdSWAIT, 7}},
		{"openbsd", openbsdKinfo, bsdOpenbsdSize, bsdOpenbsdPidOff, openbsdBuf,
			[]byte{bsdSZOMB, bsdOpenbsdSDEAD},
			[]byte{0, 1, 2, 3, 4, 7}},
	}
}

func TestBsdKinfoCorpseSeesACorpse(t *testing.T) {
	for _, c := range bsdCases() {
		for _, st := range c.dead {
			if !bsdKinfoCorpse(c.layout, 4242, c.size, c.build(4242, st), 0) {
				t.Errorf("%s: state %d read as alive: the api boots under a supervisor that has already exited", c.name, st)
			}
		}
	}
}

func TestBsdKinfoCorpseSaysNoForEveryLivingState(t *testing.T) {
	for _, c := range bsdCases() {
		for _, st := range c.alive {
			if bsdKinfoCorpse(c.layout, 4242, c.size, c.build(4242, st), 0) {
				t.Errorf("%s: living state %d read as a corpse: every boot is refused", c.name, st)
			}
		}
	}
}

// A misparse - offsets pointing into some other field - has to read as alive,
// and the pid in the struct is the guard: a reading about another pid, or one
// that only matches once truncated to 32 bits, is not about the parent.
func TestBsdKinfoCorpseRefusesAReadingAboutAnotherPid(t *testing.T) {
	for _, c := range bsdCases() {
		if bsdKinfoCorpse(c.layout, 4242, c.size, c.build(99, bsdSZOMB), 0) {
			t.Errorf("%s: a reading naming pid 99 answered the question about pid 4242", c.name)
		}
		var hi int64 = 1<<32 + 4242
		if int64(int(hi)) != hi {
			continue
		}
		if bsdKinfoCorpse(c.layout, int(hi), c.size, c.build(4242, bsdSZOMB), 0) {
			t.Errorf("%s: pid %d was answered by a reading about pid 4242", c.name, hi)
		}
	}
}

// A failed call, or a reading that is not the exact length, is a layout this
// code does not know - including the kernel saying it wrote more or less than
// the buffer holds, and a zero-length success, which is how a pid nobody owns
// comes back.
func TestBsdKinfoCorpseRefusesAFailedOrOddSizedReading(t *testing.T) {
	for _, c := range bsdCases() {
		full := c.build(4242, bsdSZOMB)
		cases := []struct {
			what  string
			n     int
			buf   []byte
			errno int
		}{
			{"ESRCH", c.size, full, 3},
			{"EPERM", c.size, full, 1},
			{"ENOMEM", c.size, full, 12},
			{"nothing written", 0, full, 0},
			{"one byte short", c.size - 1, full, 0},
			{"one byte long", c.size + 1, append(append([]byte{}, full...), 0), 0},
			{"n past the buffer", c.size, full[:c.size-1], 0},
		}
		for _, k := range cases {
			if bsdKinfoCorpse(c.layout, 4242, k.n, k.buf, k.errno) {
				t.Errorf("%s: %s read as a corpse", c.name, k.what)
			}
		}
	}
}

// freebsd's reading opens with its own byte count, and a header that does not
// say what this code believes is a struct from another release.
func TestBsdKinfoCorpseRefusesAFreebsdStructOfAnotherSize(t *testing.T) {
	buf := freebsdBuf(4242, bsdSZOMB)
	binary.LittleEndian.PutUint32(buf, bsdFreebsdSize+8)
	if bsdKinfoCorpse(freebsdKinfo, 4242, bsdFreebsdSize, buf, 0) {
		t.Fatal("a kinfo_proc whose ki_structsize is not this code's read as a corpse")
	}
}

// SZOMB next to the state byte, on either side, must not count
func TestBsdKinfoCorpseDoesNotFindTheStateNextToIt(t *testing.T) {
	for _, c := range bsdCases() {
		for _, off := range []int{c.layout.statOff - 1, c.layout.statOff + 1} {
			buf := c.build(4242, 0)
			buf[off] = bsdSZOMB
			if bsdKinfoCorpse(c.layout, 4242, c.size, buf, 0) {
				t.Errorf("%s: SZOMB at offset %d read as the state", c.name, off)
			}
		}
	}
}

func TestBsdKinfoCorpseRefusesANonPid(t *testing.T) {
	for _, c := range bsdCases() {
		for _, pid := range []int{0, -1} {
			if bsdKinfoCorpse(c.layout, pid, c.size, c.build(pid, bsdSZOMB), 0) {
				t.Errorf("%s: pid %d read as a corpse", c.name, pid)
			}
		}
	}
}

// An arch with no cross-checked layout is a zero layout, and nothing can make
// it a corpse - not even a reading that would be one under every other layout.
func TestBsdKinfoCorpseIsUnsureWithAZeroLayout(t *testing.T) {
	buf := freebsdBuf(4242, bsdSZOMB)
	if bsdKinfoCorpse(bsdKinfoLayout{}, 4242, 0, buf, 0) || bsdKinfoCorpse(bsdKinfoLayout{}, 4242, len(buf), buf, 0) {
		t.Fatal("a zero layout read a corpse")
	}
}

// The layouts pinned, as darwin's are: a change to any of these numbers is a
// change to what byte the watchdog calls the state of a supervisor.
func TestBsdKinfoLayoutsAreTheOnesThatWereCrossChecked(t *testing.T) {
	pin := func(l bsdKinfoLayout) string {
		return fmt.Sprintf("%d %d %d %d %d %v", l.size, l.pidOff, l.statOff, l.corpse, l.dead, l.sized)
	}
	for _, c := range []struct{ name, want, got string }{
		{"freebsd", "1088 72 388 5 5 true", pin(freebsdKinfo)},
		{"openbsd", "312 108 304 5 6 false", pin(openbsdKinfo)},
	} {
		if c.got != c.want {
			t.Errorf("%s kinfo_proc layout is now %q, was %q: re-check it against the headers before changing this", c.name, c.got, c.want)
		}
	}
}

// A layout whose offsets point past the bytes it asks for is a layout this
// code does not know, and it answers alive rather than reading past the end.
func TestBsdKinfoCorpseRefusesALayoutThatPointsPastTheReading(t *testing.T) {
	buf := make([]byte, 16)
	binary.LittleEndian.PutUint32(buf, 4242)
	for _, l := range []bsdKinfoLayout{
		{size: 16, pidOff: 0, statOff: 16},
		{size: 16, pidOff: 0, statOff: -1},
		{size: 16, pidOff: 13, statOff: 4},
		{size: 16, pidOff: -1, statOff: 4},
	} {
		if bsdKinfoCorpse(l, 4242, 16, buf, 0) {
			t.Errorf("layout %+v read a corpse out of 16 bytes that only name the pid", l)
		}
	}
}
