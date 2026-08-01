package borgo

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
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
