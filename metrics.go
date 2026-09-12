package borgo

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Prometheus text exposition on the go front, enabled with BORGO_METRICS=1:
// the same three series the bun front server exposed, under the same names
// and help strings so a dashboard built on 0.2x keeps reading, with one
// difference the topology makes possible - an api request is labelled with
// its own route pattern, where the old front folded every api call into
// "/api/*" because it never saw the mux. Patterns keep the cardinality
// bounded by the route table; past maxRoutes the rest fold into "other".
//
// The per-request line the old front printed in dev (METHOD path status ms)
// is printed here too, in dev only, from the same wrapper.

var histogramBuckets = [...]float64{0.005, 0.025, 0.1, 0.5, 1, 5}

const maxMetricRoutes = 100

type series struct {
	count   int64
	sum     float64
	buckets [len(histogramBuckets)]int64
}

type metrics struct {
	mu        sync.Mutex
	start     time.Time
	requests  map[string]int64 // route + "\x00" + status
	durations map[string]*series
	order     []string // routes in first-seen order, for a stable exposition
}

func newMetrics(start time.Time) *metrics {
	return &metrics{start: start, requests: map[string]int64{}, durations: map[string]*series{}}
}

// metricsEnabled reads BORGO_METRICS with the ParseBool grammar; the pre-0.21
// name METRICS is deliberately not aliased, as on the bun side.
func metricsEnabled() (bool, error) {
	v := os.Getenv("BORGO_METRICS")
	if v == "" {
		return false, nil
	}
	on, err := strconv.ParseBool(v)
	if err != nil {
		return false, fmt.Errorf(`borgo: BORGO_METRICS: invalid value %q (want "1"/"true" or "0"/"false"; unset means off)`, v)
	}
	return on, nil
}

func (m *metrics) observe(route string, status int, seconds float64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, known := m.durations[route]; !known && len(m.durations) >= maxMetricRoutes {
		route = "other"
	}
	m.requests[route+"\x00"+strconv.Itoa(status)]++
	s := m.durations[route]
	if s == nil {
		s = &series{}
		m.durations[route] = s
		m.order = append(m.order, route)
	}
	s.count++
	s.sum += seconds
	for i, b := range histogramBuckets {
		if seconds <= b {
			s.buckets[i]++
		}
	}
}

func escapeLabel(s string) string {
	return strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`).Replace(s)
}

func (m *metrics) render(now time.Time) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var b strings.Builder
	b.WriteString("# HELP borgo_http_requests_total requests handled by the front server\n")
	b.WriteString("# TYPE borgo_http_requests_total counter\n")
	keys := make([]string, 0, len(m.requests))
	for k := range m.requests {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		route, status, _ := strings.Cut(k, "\x00")
		fmt.Fprintf(&b, "borgo_http_requests_total{route=\"%s\",status=\"%s\"} %d\n", escapeLabel(route), status, m.requests[k])
	}
	b.WriteString("# HELP borgo_http_request_duration_seconds request duration by route pattern\n")
	b.WriteString("# TYPE borgo_http_request_duration_seconds histogram\n")
	for _, route := range m.order {
		s := m.durations[route]
		label := escapeLabel(route)
		for i, bound := range histogramBuckets {
			fmt.Fprintf(&b, "borgo_http_request_duration_seconds_bucket{route=\"%s\",le=\"%s\"} %d\n", label, strconv.FormatFloat(bound, 'f', -1, 64), s.buckets[i])
		}
		fmt.Fprintf(&b, "borgo_http_request_duration_seconds_bucket{route=\"%s\",le=\"+Inf\"} %d\n", label, s.count)
		fmt.Fprintf(&b, "borgo_http_request_duration_seconds_sum{route=\"%s\"} %s\n", label, strconv.FormatFloat(s.sum, 'f', -1, 64))
		fmt.Fprintf(&b, "borgo_http_request_duration_seconds_count{route=\"%s\"} %d\n", label, s.count)
	}
	b.WriteString("# HELP borgo_process_uptime_seconds seconds since the front server started\n")
	b.WriteString("# TYPE borgo_process_uptime_seconds gauge\n")
	fmt.Fprintf(&b, "borgo_process_uptime_seconds %s\n", strconv.FormatFloat(now.Sub(m.start).Seconds(), 'f', -1, 64))
	return b.String()
}

// routeLabel is what the front decided a request was, for the counters: an
// api pattern, a page pattern, or nothing - assets, the health and metrics
// endpoints stay out of the counters, as they did on the bun side
type routeLabel struct{ pattern string }

type routeLabelKey struct{}

func withRouteLabel(r *http.Request) (*http.Request, *routeLabel) {
	l := &routeLabel{}
	return r.WithContext(context.WithValue(r.Context(), routeLabelKey{}, l)), l
}

func labelOf(r *http.Request) *routeLabel {
	l, _ := r.Context().Value(routeLabelKey{}).(*routeLabel)
	return l
}

// setRouteLabel records the pattern the front matched; a request that
// matched nothing keeps an empty label and is not counted
func setRouteLabel(r *http.Request, pattern string) {
	if l := labelOf(r); l != nil {
		l.pattern = pattern
	}
}

// statusWriter learns the status a response went out with, committing on
// the first of WriteHeader, Write or Flush like the security wrapper
type statusWriter struct {
	http.ResponseWriter
	status int
}

func (s *statusWriter) commit(code int) {
	if s.status == 0 {
		s.status = code
	}
}

func (s *statusWriter) WriteHeader(code int) {
	s.commit(code)
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusWriter) Write(b []byte) (int, error) {
	s.commit(http.StatusOK)
	return s.ResponseWriter.Write(b)
}

func (s *statusWriter) Flush() {
	s.commit(http.StatusOK)
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (s *statusWriter) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// observeRequests wraps the public handler: a label the front sets, a status
// the writer learns, a duration, and in dev the request line
func observeRequests(m *metrics, dev bool, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		r, label := withRouteLabel(r)
		sw := &statusWriter{ResponseWriter: w}
		next.ServeHTTP(sw, r)
		status := sw.status
		if status == 0 {
			// a handler that returned without writing: net/http sends 200
			status = http.StatusOK
		}
		elapsed := time.Since(started)
		if dev && !strings.HasPrefix(r.URL.Path, "/assets/") && r.URL.Path != "/favicon.ico" {
			log.Printf("%-4s %-24s %d %s", r.Method, r.URL.Path, status, elapsed.Round(100*time.Microsecond))
		}
		if m != nil && label.pattern != "" {
			m.observe(label.pattern, status, elapsed.Seconds())
		}
	})
}

// metricsHandler answers /metrics, out of the counters itself
func metricsHandler(m *metrics) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		fmt.Fprint(w, m.render(time.Now()))
	})
}
