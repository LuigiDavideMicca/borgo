package borgo

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
)

func TestPush(t *testing.T) {
	type received struct {
		path, key string
		body      map[string]any
	}
	var got received
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.path = r.URL.Path
		got.key = r.Header.Get("X-Borgo-Key")
		json.NewDecoder(r.Body).Decode(&got.body)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	t.Setenv("FRONT_URL", server.URL)
	t.Setenv("BORGO_PUSH_KEY", "s3cret")

	if err := Push("live", "task-created", "hello"); err != nil {
		t.Fatal(err)
	}
	if got.path != "/__borgo/publish" || got.key != "s3cret" {
		t.Errorf("request wrong: %+v", got)
	}
	if got.body["topic"] != "live" || got.body["event"] != "task-created" || got.body["data"] != "hello" {
		t.Errorf("payload wrong: %+v", got.body)
	}
}

type pushPayload struct {
	Title string `json:"title"`
}

// Push carries its payload type in its signature - this only compiles if Push
// has exactly one type parameter, which is what borgogen reads to type the
// browser's subscribe callback. The whole typed-events feature rests on it.
var _ func(string, string, pushPayload) error = Push[pushPayload]

// the typed path end to end: T inferred from the argument, payload on the wire
func TestPushIsTypedAndInferred(t *testing.T) {
	var got map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&got)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	t.Setenv("FRONT_URL", server.URL)

	// no type argument written anywhere: Go infers T = pushPayload
	if err := Push("live", "created", pushPayload{Title: "t"}); err != nil {
		t.Fatal(err)
	}
	data, ok := got["data"].(map[string]any)
	if got["topic"] != "live" || got["event"] != "created" || !ok || data["title"] != "t" {
		t.Fatalf("payload wrong: %+v", got)
	}

	// an explicit type argument is accepted too
	got = nil
	if err := Push[pushPayload]("live", "created", pushPayload{Title: "explicit"}); err != nil {
		t.Fatal(err)
	}
	if data, ok := got["data"].(map[string]any); !ok || data["title"] != "explicit" {
		t.Fatalf("explicit instantiation payload wrong: %+v", got)
	}
}

// every pre-0.21 call shape that Go can still infer must compile and behave
func TestPushAcceptsUntypedCallSites(t *testing.T) {
	var seen int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen++
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	t.Setenv("FRONT_URL", server.URL)

	var anyPayload any = map[string]int{"id": 1}
	calls := []func() error{
		func() error { return Push("live", "a", anyPayload) },             // T = any, as before
		func() error { return Push("live", "b", map[string]int{"i": 1}) }, // T inferred
		func() error { return Push("live", "c", "plain") },
		func() error { return Push("live", "d", 7) },
		func() error { return Push[any]("live", "e", nil) }, // the one shape that needs help
	}
	for i, call := range calls {
		if err := call(); err != nil {
			t.Fatalf("call %d: %v", i, err)
		}
	}
	if seen != len(calls) {
		t.Fatalf("front server saw %d pushes, want %d", seen, len(calls))
	}
}

func TestPushClientHasTimeout(t *testing.T) {
	if pushClient.Timeout <= 0 {
		t.Fatal("pushClient must carry a timeout, or a hung front server blocks handlers forever")
	}
}

// pushes go to one host: without a raised idle-connection cap, concurrent
// pushes open a socket per call and eat the ephemeral port range
func TestPushReusesConnections(t *testing.T) {
	const workers, each = 16, 50
	var requests, opened atomic.Int64
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusNoContent)
	}))
	server.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			opened.Add(1)
		}
	}
	server.Start()
	defer server.Close()
	t.Setenv("FRONT_URL", server.URL)

	var wg sync.WaitGroup
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range each {
				if err := Push("live", "created", map[string]int{"id": 1}); err != nil {
					t.Error(err)
					return
				}
			}
		}()
	}
	wg.Wait()

	if got := requests.Load(); got != workers*each {
		t.Fatalf("front server saw %d pushes, want %d", got, workers*each)
	}
	// generous: reuse should keep this near the worker count, a fresh
	// connection per push would be workers*each
	if got := opened.Load(); got > workers*each/4 {
		t.Fatalf("%d connections opened for %d pushes: they are not being reused", got, workers*each)
	}
}

func TestPushRejected(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "forbidden", http.StatusForbidden)
	}))
	defer server.Close()

	t.Setenv("FRONT_URL", server.URL)
	// an untyped nil is the one payload Go cannot infer T from: spell it out
	if err := Push[any]("live", "x", nil); err == nil {
		t.Fatal("want error on non-204 response")
	}
}
