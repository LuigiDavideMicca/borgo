//go:build freebsd || openbsd

package borgo

import (
	"context"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// procStatus reads the state letter of pid from ps(1), which reaches the
// kernel through libkvm's own copy of the layout rather than through the
// sysctl the watchdog parses: a test that shared the reading under test could
// not catch a bug in it. ps exits non-zero for a pid nobody owns, which is the
// "gone" this returns as an error.
func procStatus(pid int) (byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/bin/ps", "-o", "state=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return 0, fmt.Errorf("ps -p %d: %w", pid, err)
	}
	st := strings.TrimSpace(string(out))
	if st == "" {
		return 0, fmt.Errorf("ps reported no state for pid %d", pid)
	}
	return st[0], nil
}
