package borgo

import (
	"encoding/binary"
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
	const wide = 1<<32 + 4242
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
