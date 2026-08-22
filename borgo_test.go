package borgo

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestHealthz(t *testing.T) {
	rec := httptest.NewRecorder()
	healthz(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("content-type = %q", ct)
	}
	var body struct {
		Status string   `json:"status"`
		Uptime *float64 `json:"uptime"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Status != "ok" || body.Uptime == nil || *body.Uptime < 0 {
		t.Errorf("body wrong: %s", rec.Body.String())
	}
}

// Version is hand-written in the source and bumped by the release, so the one
// failure mode is drifting from what was actually released. The release
// manifest is the source of truth for both halves; if they ever disagree the
// build says so rather than shipping a constant that lies.
func TestVersionMatchesManifest(t *testing.T) {
	raw, err := os.ReadFile(".release-please-manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest map[string]string
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	// the go module is the repository root and is tagged with the same tag as
	// packages/borgo (include-component-in-tag: false), so that is its version
	want, ok := manifest["packages/borgo"]
	if !ok {
		t.Fatalf("no packages/borgo entry in the release manifest: %v", manifest)
	}
	if Version != want {
		t.Fatalf("borgo.Version = %q, release manifest says %q; bump the constant in borgo.go with the release", Version, want)
	}
}

func TestVersionIsSemver(t *testing.T) {
	if !regexp.MustCompile(`^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`).MatchString(Version) {
		t.Fatalf("Version = %q, want a bare semver like 0.21.0 (no leading v)", Version)
	}
}

func TestHandleValidation(t *testing.T) {
	ok := func(http.ResponseWriter, *http.Request) {}
	// only the accepted patterns reach the global registry, so they carry a
	// per-run segment: the rest are rejected before it
	run := patternSeq.Add(1)
	cases := []struct {
		name      string
		pattern   string
		handler   http.HandlerFunc
		wantPanic string
	}{
		{"valid", fmt.Sprintf("GET /api/v%d/ok", run), ok, ""},
		{"valid with param", fmt.Sprintf("DELETE /api/v%d/ok/{id}", run), ok, ""},
		{"missing method", "/api/x", ok, "pattern must be"},
		{"lowercase method", "get /api/x", ok, "pattern must be"},
		{"no space", "GET/api/x", ok, "pattern must be"},
		{"path without slash", "GET api/x", ok, "pattern must be"},
		{"nil handler", "GET /api/nil", nil, "nil handler"},
		{"duplicate", fmt.Sprintf("GET /api/v%d/ok", run), ok, "registered twice"},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			defer func() {
				r := recover()
				if c.wantPanic == "" {
					if r != nil {
						t.Fatalf("unexpected panic: %v", r)
					}
					return
				}
				msg, _ := r.(string)
				if r == nil || !strings.Contains(msg, c.wantPanic) {
					t.Fatalf("want panic containing %q, got %v", c.wantPanic, r)
				}
			}()
			Handle(c.pattern, c.handler)
		})
	}
}

// the registry is package-global, so every run needs fresh patterns
var patternSeq atomic.Int64

func uniquePattern(suffix string) string {
	return fmt.Sprintf("GET /api/t%d/%s", patternSeq.Add(1), suffix)
}

func TestHandleIsConcurrencySafe(t *testing.T) {
	const n = 64
	patterns := make([]string, n)
	for i := range patterns {
		patterns[i] = uniquePattern("concurrent")
	}
	var wg sync.WaitGroup
	for _, pattern := range patterns {
		wg.Add(1)
		go func() {
			defer wg.Done()
			Handle(pattern, func(http.ResponseWriter, *http.Request) {})
		}()
	}
	wg.Wait()

	routesMu.Lock()
	defer routesMu.Unlock()
	for _, pattern := range patterns {
		if _, ok := routes[pattern]; !ok {
			t.Fatalf("route %q lost in the race", pattern)
		}
	}
}

// a route registered after Serve snapshotted the registry would never be
// mounted; a silent dead route is worse than a crash
func TestHandleAfterServePanics(t *testing.T) {
	routesMu.Lock()
	served = true
	routesMu.Unlock()
	defer func() {
		routesMu.Lock()
		served = false
		routesMu.Unlock()
		msg, _ := recover().(string)
		if !strings.Contains(msg, "after borgo.Serve") {
			t.Fatalf("want panic naming the late registration, got %q", msg)
		}
	}()
	Handle(uniquePattern("too-late"), func(http.ResponseWriter, *http.Request) {})
}

// a recovered panic must leave the registry usable for the next caller
func TestHandleRecoversAndStaysUsable(t *testing.T) {
	func() {
		defer func() { recover() }()
		Handle(uniquePattern("{bad"), func(http.ResponseWriter, *http.Request) {})
	}()
	done := make(chan struct{})
	go func() {
		defer close(done)
		Handle(uniquePattern("after-panic"), func(http.ResponseWriter, *http.Request) {})
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("registry deadlocked after a rejected pattern")
	}
}

// THE P3: a hand-set BORGO_PARENT_PID that is not the parent is accepted, and
// said. Measured before this existed: an api booted under a live pid that was
// not its parent printed nothing and ran on the probe alone, the getppid
// branch of waitParentExit off on every platform at once, nobody told. The
// pid stays the env's, never the parent's; one line at boot, only on mismatch,
// so the normal boot stays silent and the line gets read. serve-entry.ts says
// the same line under the same condition.
func TestWarnParentMismatch(t *testing.T) {
	capture := func(pid, ppid int) string {
		var logs strings.Builder
		log.SetOutput(&logs)
		defer log.SetOutput(os.Stderr)
		warnParentMismatch(pid, ppid)
		return logs.String()
	}
	if got := capture(4321, 4321); got != "" {
		t.Fatalf("the parent itself printed %q, want silence", got)
	}
	if got := capture(0, 4321); got != "" {
		t.Fatalf("no watch printed %q, want silence", got)
	}
	got := capture(100, 200)
	for _, want := range []string{"BORGO_PARENT_PID=100", "parent (200)", "reparent branch is off", "only the probe is watching"} {
		if !strings.Contains(got, want) {
			t.Fatalf("mismatch line %q lacks %q", got, want)
		}
	}
}

// The line comes out of a real boot, after the probe: a pid already gone is
// the refusal it always was, with no mismatch line beside it, and the parent
// itself boots silent.
func TestServeContextSaysParentMismatchAfterTheProbe(t *testing.T) {
	boot := func(t *testing.T, pid int) (logs string, err error) {
		t.Helper()
		restoreRegistry(t)
		var sb strings.Builder
		log.SetOutput(&sb)
		defer log.SetOutput(os.Stderr)
		port := freePort(t)
		t.Setenv("API_PORT", port)
		t.Setenv("BORGO_PARENT_PID", strconv.Itoa(pid))
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		errCh := make(chan error, 1)
		go func() { errCh <- ServeContext(ctx) }()
		deadline := time.Now().Add(10 * time.Second)
		for {
			select {
			case err := <-errCh:
				return sb.String(), err
			default:
			}
			if res, err := http.Get("http://127.0.0.1:" + port + "/healthz"); err == nil {
				res.Body.Close()
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("ServeContext neither came up nor refused")
			}
			time.Sleep(20 * time.Millisecond)
		}
		cancel()
		select {
		case err := <-errCh:
			return sb.String(), err
		case <-time.After(15 * time.Second):
			t.Fatal("ServeContext did not return after its context was cancelled")
			return "", nil
		}
	}
	const line = "is not this process's parent"

	t.Run("the real parent boots silent", func(t *testing.T) {
		logs, err := boot(t, os.Getppid())
		if err != nil {
			t.Fatalf("ServeContext returned %v under a live parent", err)
		}
		if strings.Contains(logs, line) {
			t.Fatalf("the parent itself was reported as a mismatch:\n%s", logs)
		}
	})
	t.Run("a live pid that is not the parent is said once", func(t *testing.T) {
		// this process: alive, certainly not its own parent
		logs, err := boot(t, os.Getpid())
		if err != nil {
			t.Fatalf("ServeContext returned %v: a mismatch is an advisory, never a refusal", err)
		}
		want := "BORGO_PARENT_PID=" + strconv.Itoa(os.Getpid()) + " is not this process's parent (" + strconv.Itoa(os.Getppid()) + ")"
		if n := strings.Count(logs, line); n != 1 || !strings.Contains(logs, want) {
			t.Fatalf("want exactly one line containing %q, got %d in:\n%s", want, n, logs)
		}
	})
	t.Run("a pid already gone is the refusal, not a mismatch", func(t *testing.T) {
		logs, err := boot(t, deadPID(t))
		if err == nil || !strings.Contains(err.Error(), "has already exited") {
			t.Fatalf("ServeContext returned %v, want the already-exited refusal", err)
		}
		if strings.Contains(logs, line) {
			t.Fatalf("a dead pid was also reported as a mismatch:\n%s", logs)
		}
	})
}
