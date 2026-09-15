package borgo

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// the exposition the bun front server produced, line for line, so a
// dashboard built on it keeps reading
func TestMetricsExpositionMatchesTheFrontServers(t *testing.T) {
	start := time.Date(2026, 9, 12, 12, 0, 0, 0, time.UTC)
	m := newMetrics(start)
	m.observe("GET /api/tasks", 200, 0.004)
	m.observe("GET /api/tasks", 200, 0.3)
	m.observe("GET /api/tasks", 500, 2)
	m.observe(`/weird"route\n`, 404, 0.01)
	out := m.render(start.Add(90 * time.Second))

	for _, want := range []string{
		"# HELP borgo_http_requests_total requests handled by the front server",
		"# TYPE borgo_http_requests_total counter",
		`borgo_http_requests_total{route="GET /api/tasks",status="200"} 2`,
		`borgo_http_requests_total{route="GET /api/tasks",status="500"} 1`,
		`borgo_http_requests_total{route="/weird\"route\\n",status="404"} 1`,
		"# TYPE borgo_http_request_duration_seconds histogram",
		`borgo_http_request_duration_seconds_bucket{route="GET /api/tasks",le="0.005"} 1`,
		`borgo_http_request_duration_seconds_bucket{route="GET /api/tasks",le="0.5"} 2`,
		`borgo_http_request_duration_seconds_bucket{route="GET /api/tasks",le="5"} 3`,
		`borgo_http_request_duration_seconds_bucket{route="GET /api/tasks",le="+Inf"} 3`,
		`borgo_http_request_duration_seconds_sum{route="GET /api/tasks"} 2.304`,
		`borgo_http_request_duration_seconds_count{route="GET /api/tasks"} 3`,
		"# TYPE borgo_process_uptime_seconds gauge",
		"borgo_process_uptime_seconds 90",
	} {
		if !strings.Contains(out, want+"\n") {
			t.Errorf("missing line %q in:\n%s", want, out)
		}
	}
}

func TestMetricsCardinalityIsBoundedByTheRouteTable(t *testing.T) {
	m := newMetrics(time.Now())
	for i := 0; i < maxMetricRoutes+20; i++ {
		m.observe("/page-"+strings.Repeat("x", i%7)+string(rune('a'+i%26))+strings.Repeat("y", i/26), 200, 0.01)
	}
	out := m.render(time.Now())
	if !strings.Contains(out, `route="other"`) {
		t.Error("routes past the cap did not fold into other")
	}
	if n := strings.Count(out, "_count{"); n > maxMetricRoutes+1 {
		t.Errorf("%d route series, want at most %d", n, maxMetricRoutes+1)
	}
}

func TestObserveRequestsCountsWhatTheFrontLabelled(t *testing.T) {
	m := newMetrics(time.Now())
	var hits int32
	h := observeRequests(m, false, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		switch r.URL.Path {
		case "/api/hello":
			setRouteLabel(r, "GET /api/hello")
			w.WriteHeader(201)
		case "/news":
			setRouteLabel(r, "/news")
			w.(http.Flusher).Flush() // committed through flush alone: a stream
		case "/assets/x.js":
			// no label: assets stay out of the counters
			w.Write([]byte("js"))
		case "/silent":
			setRouteLabel(r, "/silent")
			// returns without writing: net/http sends 200
		}
	}))
	for _, p := range []string{"/api/hello", "/news", "/assets/x.js", "/silent"} {
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", p, nil))
	}
	out := m.render(time.Now())
	for _, want := range []string{
		`borgo_http_requests_total{route="GET /api/hello",status="201"} 1`,
		`borgo_http_requests_total{route="/news",status="200"} 1`,
		`borgo_http_requests_total{route="/silent",status="200"} 1`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	if strings.Contains(out, "assets") || strings.Contains(out, `route=""`) {
		t.Errorf("an unlabelled request was counted:\n%s", out)
	}
	if n := strings.Count(out, "requests_total{"); n != 3 {
		t.Errorf("%d request series, want 3", n)
	}
	if atomic.LoadInt32(&hits) != 4 {
		t.Errorf("handler ran %d times", hits)
	}
}

func TestMetricsSwitchGrammar(t *testing.T) {
	t.Setenv("BORGO_METRICS", "")
	if on, err := metricsEnabled(); on || err != nil {
		t.Errorf("unset: %v %v", on, err)
	}
	t.Setenv("BORGO_METRICS", "1")
	if on, err := metricsEnabled(); !on || err != nil {
		t.Errorf("1: %v %v", on, err)
	}
	t.Setenv("BORGO_METRICS", "yes")
	if _, err := metricsEnabled(); err == nil {
		t.Error("BORGO_METRICS=yes was read as something")
	}
}

func TestRenderProbeSharesOneProbePerSecond(t *testing.T) {
	var probes int32
	p := &renderProbe{now: time.Now, probe: func() string {
		atomic.AddInt32(&probes, 1)
		time.Sleep(20 * time.Millisecond)
		return "reachable"
	}}
	done := make(chan string, 8)
	for i := 0; i < 8; i++ {
		go func() { done <- p.reachability() }()
	}
	for i := 0; i < 8; i++ {
		if got := <-done; got != "reachable" {
			t.Errorf("got %q", got)
		}
	}
	if atomic.LoadInt32(&probes) != 1 {
		t.Errorf("a burst of 8 ran %d probes, want 1", probes)
	}
	// and after the second, one more
	p.at = time.Now().Add(-2 * time.Second)
	p.reachability()
	if atomic.LoadInt32(&probes) != 2 {
		t.Errorf("after the memo expired: %d probes, want 2", probes)
	}
}

func TestFrontHealthzReportsTheRenderService(t *testing.T) {
	p := &renderProbe{now: time.Now, probe: func() string { return "down" }}
	w := httptest.NewRecorder()
	frontHealthz(p).ServeHTTP(w, httptest.NewRequest("GET", "/healthz", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"status":"degraded"`) || !strings.Contains(w.Body.String(), `"render":"down"`) {
		t.Errorf("degraded: %d %s", w.Code, w.Body.String())
	}
	p = &renderProbe{now: time.Now, probe: func() string { return "reachable" }}
	w = httptest.NewRecorder()
	frontHealthz(p).ServeHTTP(w, httptest.NewRequest("GET", "/healthz", nil))
	if !strings.Contains(w.Body.String(), `"status":"ok"`) {
		t.Errorf("ok: %s", w.Body.String())
	}
}

// the production chain, both wrappers: the controller must reach the real
// writer through observeRequests as through the security middleware, or
// every public event stream is cut by the write deadline
func TestObserveRequestsUnwrapsForTheResponseController(t *testing.T) {
	t.Setenv("BORGO_SECURITY_HEADERS", "")
	t.Setenv("BORGO_CSP", "")
	cfg, _ := securityFromEnv()
	// a channel, not two variables: the flush hands the client its response
	// before the handler has stored what the flush returned
	got := make(chan [2]error, 1)
	chain := observeRequests(newMetrics(time.Now()), false, cfg.middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rc := http.NewResponseController(w)
		deadlineErr := rc.SetWriteDeadline(time.Time{})
		got <- [2]error{deadlineErr, rc.Flush()}
		w.Write([]byte("ok"))
	})))
	srv := httptest.NewServer(chain)
	defer srv.Close()
	res, err := http.Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	var errs [2]error
	select {
	case errs = <-got:
	case <-time.After(5 * time.Second):
		t.Fatal("the handler never ran")
	}
	if deadlineErr, flushErr := errs[0], errs[1]; deadlineErr != nil || flushErr != nil {
		t.Errorf("the controller could not reach the real writer: deadline %v, flush %v", deadlineErr, flushErr)
	}
}

// one fetch in flight at a time, shared, and a failure remembered: five
// page requests against a hung render service must not queue behind five
// fetches one at a time
func TestPolicySourceFetchesOnceAndRemembersAFailure(t *testing.T) {
	var fetches int32
	now := time.Now()
	p := &policySource{now: func() time.Time { return now }, fetch: func() (string, []policyEntry, error) {
		atomic.AddInt32(&fetches, 1)
		time.Sleep(30 * time.Millisecond)
		return "", nil, errors.New("hung")
	}}
	started := time.Now()
	done := make(chan bool, 5)
	for i := 0; i < 5; i++ {
		go func() { _, _, ok := p.lookupPattern("/x"); done <- ok }()
	}
	for i := 0; i < 5; i++ {
		if <-done {
			t.Error("a table was found from a failing fetch")
		}
	}
	if atomic.LoadInt32(&fetches) != 1 || time.Since(started) > 200*time.Millisecond {
		t.Errorf("5 lookups: %d fetches in %v, want 1 in one fetch's time", fetches, time.Since(started))
	}
	// within the second nobody fetches again
	p.lookupPattern("/x")
	if atomic.LoadInt32(&fetches) != 1 {
		t.Errorf("a failure was not remembered: %d fetches", fetches)
	}
	// after it, one more, and a table that now answers is kept
	now = now.Add(2 * time.Second)
	p.fetch = func() (string, []policyEntry, error) {
		atomic.AddInt32(&fetches, 1)
		return "b1", []policyEntry{{pattern: "/x"}}, nil
	}
	if _, pattern, ok := p.lookupPattern("/x"); !ok || pattern != "/x" || atomic.LoadInt32(&fetches) != 2 {
		t.Errorf("after the memo: ok=%v pattern=%q fetches=%d", ok, pattern, fetches)
	}
	p.lookupPattern("/x")
	if atomic.LoadInt32(&fetches) != 2 {
		t.Errorf("a loaded table was fetched again: %d", fetches)
	}
}
