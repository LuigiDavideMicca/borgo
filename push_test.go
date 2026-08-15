package borgo

import (
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
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
	t.Parallel()
	if defaultPush.client.Timeout <= 0 {
		t.Fatal("the push client must carry a timeout, or a hung front server blocks handlers forever")
	}
	if defaultPush.timeout <= 0 {
		t.Fatal("the push deadline must be positive, or the request carries no deadline at all")
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

// a front server that accepts the connection and then never answers: the
// caller gets out on its own deadline, it does not wait for the destination.
// The settings carry no client timeout at all, so what is proven is the
// deadline on the request and not the client's.
func TestPushDoesNotBlockOnHungFrontServer(t *testing.T) {
	addr := hungFrontServer(t)
	t.Setenv("FRONT_URL", "http://"+addr)

	deadline := 300 * time.Millisecond
	settings := shortPush(deadline)

	done := make(chan error, 1)
	start := time.Now()
	go func() { done <- pushWith(settings, "live", "x", "y") }()

	budget := 20 * deadline
	select {
	case err := <-done:
		if err == nil {
			t.Fatalf("want an error from a server that never answered, got nil after %v", time.Since(start))
		}
		if elapsed := time.Since(start); elapsed > budget {
			t.Fatalf("Push took %v, over its %v deadline: %v", elapsed, deadline, err)
		}
	case <-time.After(budget):
		t.Fatalf("Push still blocked %v after the front server accepted and stopped answering: the caller is hostage to the destination, want a deadline of %v on the request", budget, deadline)
	}
}

// a deadline shortened for one test is that test's own: it does not reach the
// settings every other caller reads. These subtests run at the same time on
// purpose - shortening a shared deadline instead would be both a data race and,
// while the window is open, a wrong answer to "does the client have a timeout".
func TestPushSettingsAreNotShared(t *testing.T) {
	t.Setenv("FRONT_URL", "http://"+hungFrontServer(t))

	for i := range 6 {
		t.Run("short-deadline-"+strconv.Itoa(i), func(t *testing.T) {
			t.Parallel()
			if err := pushWith(shortPush(50*time.Millisecond), "live", "x", "y"); err == nil {
				t.Error("want an error from a server that never answered")
			}
		})
	}
	t.Run("shared-settings-untouched", func(t *testing.T) {
		t.Parallel()
		for range 2000 {
			if defaultPush.timeout != pushTimeout || defaultPush.client.Timeout != pushTimeout {
				t.Fatalf("another test's deadline reached the shared settings: %v / %v", defaultPush.timeout, defaultPush.client.Timeout)
			}
		}
	})
}

// the settings a test pushes with: its own client, so the shared one is neither
// read nor written here. No client timeout, so a deadline that fires is the
// request's.
func shortPush(d time.Duration) pushSettings {
	client := pushHTTPClient(0)
	return pushSettings{timeout: d, client: client}
}

// a listener that accepts and holds every connection open without answering
func hungFrontServer(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var held []net.Conn
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			held = append(held, conn)
			mu.Unlock()
		}
	}()
	t.Cleanup(func() {
		ln.Close()
		mu.Lock()
		defer mu.Unlock()
		for _, conn := range held {
			conn.Close()
		}
	})
	return ln.Addr().String()
}

// FRONT_URL is the whole evidence about the channel the key would travel on:
// the scheme first, the host second. A spelling counts as this machine only
// when nothing that reads it could disagree - case and the root dot cannot be
// read two ways, the inet_aton short forms can.
func TestPushKeyDoesNotTravelInClear(t *testing.T) {
	cases := []struct {
		front, want string
	}{
		{"https://front.invalid", ""},
		{"http://front.invalid", "cross the network in clear"},
		{"http://127.0.0.1:1", ""},
		{"http://localhost:1", ""},
		{"http://[::1]:1", ""},
		{"http://0.0.0.0:1", "cross the network in clear"},
		{"http://localhost.attacker.tld", "cross the network in clear"},

		// the same machine, spelled the other ways that mean the same thing
		// to everything that reads them
		{"HTTP://LOCALHOST:1", ""},
		{"http://LocalHost:1", ""},
		{"HTTP://127.0.0.1:1", ""},
		{"http://localhost.:1", ""}, // the root dot: an absolute name for it
		// NOT on the address form: the dialer looks "127.0.0.1." up as a name,
		// so reading it as this machine here is a verdict something else does
		// not share - measured, it dials and gets "lookup 127.0.0.1.: no such
		// host". The root dot belongs to the name branch only
		{"http://127.0.0.1.:1", "cross the network in clear"},
		{"http://127.0.0.2.:1", "cross the network in clear"},
		{"http://[::ffff:127.0.0.1]:1", ""},
		{"http://[::FFFF:127.0.0.1]:1", ""},

		// The inet_aton short forms are refused ON PURPOSE, and this is not a
		// gap to close. They are not illegitimate - they are the spellings we
		// and the resolver may not agree on: glibc and Windows connect to
		// 127.0.0.1, Go's own resolver (netgo, the common build on Linux)
		// looks them up as names and can land anywhere. Teaching the guard to
		// parse them would put a promise here that no parser can keep on every
		// platform. Anyone who can write these can write 127.0.0.1.
		{"http://127.1:1", "cross the network in clear"},
		{"http://127.0.1:1", "cross the network in clear"},
		{"http://2130706433:1", "cross the network in clear"},
		{"http://0x7f000001:1", "cross the network in clear"},
		{"http://0177.0.0.1:1", "cross the network in clear"},
		{"http://134744072:1", "cross the network in clear"}, // 8.8.8.8, likewise

		// not this machine at all
		{"http://127.0.0.1.attacker.tld", "cross the network in clear"},
		{"http://999.0.0.1:1", "cross the network in clear"},

		{"front.invalid:3000", "want an http:// or https:// url"},
		{"ftp://front.invalid", "want an http:// or https:// url"},
		{"http://", "want an http:// or https:// url"},
		{"http://front.invalid/%zz", "FRONT_URL"},
		{"", ""}, // unset means the front server is on this machine
	}

	t.Setenv("BORGO_PUSH_KEY", "s3cret")
	settings := shortPush(300 * time.Millisecond)

	for _, c := range cases {
		t.Run(c.front, func(t *testing.T) {
			t.Setenv("FRONT_URL", c.front)
			err := pushWith(settings, "live", "x", "y")
			if c.want != "" {
				if err == nil || !strings.Contains(err.Error(), c.want) {
					t.Fatalf("FRONT_URL=%q: want the key held back with %q, got %v", c.front, c.want, err)
				}
				return
			}
			// unreachable on purpose: any error must come from the wire,
			// not from the guard
			if err != nil && (strings.Contains(err.Error(), "cross the network in clear") || strings.Contains(err.Error(), "FRONT_URL")) {
				t.Fatalf("FRONT_URL=%q: this channel may carry the key, but Push refused: %v", c.front, err)
			}
		})
	}

	// the exported entry point asks the same question - the cases above run
	// through its body, but the one line that delegates to it could go missing
	t.Run("through Push itself", func(t *testing.T) {
		t.Setenv("FRONT_URL", "http://front.invalid")
		if err := Push("live", "x", "y"); err == nil || !strings.Contains(err.Error(), "cross the network in clear") {
			t.Fatalf("want the guard reached through Push, got %v", err)
		}
	})
}

// the same address, the same reachable server: what changes is whether there
// is a key to protect. Nothing may reach the wire when there is.
func TestPushHoldsKeyBackWithoutSendingIt(t *testing.T) {
	var seen atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen.Add(1)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	// 0.0.0.0 connects to this machine but is not a loopback address: a
	// reachable destination the guard must still refuse
	_, port, err := net.SplitHostPort(strings.TrimPrefix(server.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("FRONT_URL", "http://0.0.0.0:"+port)

	if err := Push("live", "x", "y"); err != nil {
		t.Skipf("0.0.0.0 is not reachable here, nothing to prove: %v", err)
	}
	if seen.Load() != 1 {
		t.Fatalf("keyless push did not arrive: the test proves nothing about the guard")
	}

	t.Setenv("BORGO_PUSH_KEY", "s3cret")
	if err := Push("live", "x", "y"); err == nil {
		t.Fatal("want the push refused: the key would have gone out in clear")
	}
	if got := seen.Load(); got != 1 {
		t.Fatalf("front server saw %d requests: the refused push went out anyway", got)
	}

	// and an operator who says so out loud gets the old behaviour back
	t.Setenv("BORGO_PUSH_INSECURE", "1")
	if err := Push("live", "x", "y"); err != nil {
		t.Fatalf("BORGO_PUSH_INSECURE=1: %v", err)
	}
	if got := seen.Load(); got != 2 {
		t.Fatalf("front server saw %d requests, want 2", got)
	}
}

// a switch that decides whether a secret goes on the wire cannot guess at a
// value nobody can read
func TestPushInsecureRefusesUnreadableValue(t *testing.T) {
	t.Setenv("FRONT_URL", "http://front.invalid")
	t.Setenv("BORGO_PUSH_KEY", "s3cret")
	t.Setenv("BORGO_PUSH_INSECURE", "yes-please")
	err := Push("live", "x", "y")
	if err == nil || !strings.Contains(err.Error(), "BORGO_PUSH_INSECURE") {
		t.Fatalf("want BORGO_PUSH_INSECURE refused as unreadable, got %v", err)
	}
}

// the two halves of BORGO_PUSH_KEY, from this side: with no key here nothing
// is presented at all - which is what makes the front server's own rule
// ("a key arrived but I have none" is refused, not waved through) reachable.
// A header sent from nowhere would turn every keyless push into that case.
func TestPushPresentsNoKeyWhenUnset(t *testing.T) {
	var present bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, present = r.Header["X-Borgo-Key"]
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	t.Setenv("FRONT_URL", server.URL)
	t.Setenv("BORGO_PUSH_KEY", "")
	if err := Push("live", "x", "y"); err != nil {
		t.Fatal(err)
	}
	if present {
		t.Fatal("X-Borgo-Key sent with BORGO_PUSH_KEY unset: the front server sees a half-configured pair and refuses every push")
	}
}

// the guard vets the host FRONT_URL names, and that is the only host it can
// vet: a hop chosen by the first server was never looked at. The return value
// cannot show whether the key left - only the bytes arriving at the second hop
// can, so this reads them off a raw listener.
func TestPushKeyDoesNotFollowRedirect(t *testing.T) {
	tap := newWireTap(t)
	front := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://"+tap.addr+"/__borgo/publish", http.StatusTemporaryRedirect)
	}))
	defer front.Close()

	// the default shape of a borgo deployment: the front server is on this
	// machine, so the guard lets the key through to it
	t.Setenv("FRONT_URL", front.URL)
	t.Setenv("BORGO_PUSH_KEY", "s3cret")

	err := Push("live", "x", "y")
	tap.mustStaySilent(t)
	if err == nil {
		t.Fatal("Push reported success on a redirected publish: nothing arrived at a front server")
	}
	if !strings.Contains(err.Error(), "redirect") {
		t.Errorf("the error does not say what happened: %v", err)
	}
}

// the escape hatch opens the first hop, never the ones after it
func TestPushInsecureStillDoesNotFollowRedirect(t *testing.T) {
	tap := newWireTap(t)
	front := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://"+tap.addr+"/__borgo/publish", http.StatusTemporaryRedirect)
	}))
	defer front.Close()

	t.Setenv("FRONT_URL", front.URL)
	t.Setenv("BORGO_PUSH_KEY", "s3cret")
	t.Setenv("BORGO_PUSH_INSECURE", "1")

	if err := Push("live", "x", "y"); err == nil {
		t.Fatal("want the redirect refused even with BORGO_PUSH_INSECURE=1")
	}
	tap.mustStaySilent(t)
}

// a listener that speaks no http: it records whatever is written at it, so a
// header that should never have been sent is visible as bytes
type wireTap struct {
	addr string
	hit  chan struct{}
	mu   sync.Mutex
	got  []byte
}

func newWireTap(t *testing.T) *wireTap {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	tap := &wireTap{addr: ln.Addr().String(), hit: make(chan struct{})}
	var once sync.Once
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				conn.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
				b, _ := io.ReadAll(io.LimitReader(conn, 64<<10))
				tap.mu.Lock()
				tap.got = append(tap.got, b...)
				tap.mu.Unlock()
				once.Do(func() { close(tap.hit) })
			}()
		}
	}()
	t.Cleanup(func() { ln.Close() })
	return tap
}

func (tap *wireTap) mustStaySilent(t *testing.T) {
	t.Helper()
	select {
	case <-tap.hit:
		tap.mu.Lock()
		got := string(tap.got)
		tap.mu.Unlock()
		leaked := ""
		if strings.Contains(got, "s3cret") {
			leaked = " - BORGO_PUSH_KEY is in them"
		}
		t.Fatalf("the second hop was written to%s:\n%s", leaked, got)
	case <-time.After(750 * time.Millisecond):
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

// The key crossing the network in clear is the one event that leaves no other
// trace: no request fails, nothing is logged, and the operator learns it from
// somebody else. Every input is environment, so the boot can say it - and the
// boot is where whoever deployed is still watching.
func TestCheckPushEnvSaysAtBootWhatPushWouldSayHoursLater(t *testing.T) {
	cases := []struct {
		name     string
		key      string
		frontURL string
		insecure string
		wantErr  string
		wantLog  string
		quiet    bool
	}{
		{name: "no key, nothing to leak", frontURL: "http://front.invalid", quiet: true},
		// a destination no push could reach is broken with or without a secret,
		// and reading the key first is what left it for the first publish
		{
			name:     "no key, but a FRONT_URL nobody could push to still stops the boot",
			frontURL: "ftp://front.invalid",
			wantErr:  "FRONT_URL",
		},
		{name: "https keeps it covered", key: "k", frontURL: "https://front.invalid", quiet: true},
		{name: "loopback never leaves", key: "k", frontURL: "http://127.0.0.1:3000", quiet: true},
		{name: "unset FRONT_URL is this machine", key: "k", quiet: true},
		{
			name: "clear to another host: every push will fail, and the boot says so",
			key:  "k", frontURL: "http://front.invalid:3000",
			wantLog: "would cross the network in clear",
		},
		{
			name: "escape hatch open: the key really does travel in clear",
			key:  "k", frontURL: "http://front.invalid:3000", insecure: "1",
			wantLog: "crosses the network in clear to front.invalid:3000",
		},
		{
			name: "a security switch nobody can read stops the boot",
			key:  "k", frontURL: "http://front.invalid:3000", insecure: "perhaps",
			wantErr: "BORGO_PUSH_INSECURE",
		},
		{
			name: "a FRONT_URL no push could use stops the boot",
			key:  "k", frontURL: "ftp://front.invalid",
			wantErr: "FRONT_URL",
		},
	}

	// PORT is the front server's, read separately and possibly fine there, so a
	// default it cannot build is said rather than fatal - and it names PORT,
	// because FRONT_URL is a variable this operator never set
	t.Run("a broken default names PORT, and does not stop a boot that may not need it", func(t *testing.T) {
		var logs strings.Builder
		log.SetOutput(&logs)
		defer log.SetOutput(os.Stderr)

		t.Setenv("BORGO_PUSH_KEY", "k")
		t.Setenv("FRONT_URL", "")
		t.Setenv("BORGO_PUSH_INSECURE", "")
		t.Setenv("PORT", "3000 ")

		if err := checkPushEnv(); err != nil {
			t.Fatalf("checkPushEnv() = %v, want nil: PORT belongs to the front server, and this api may never push", err)
		}
		got := logs.String()
		if !strings.Contains(got, "PORT") {
			t.Fatalf("checkPushEnv() logged %q, want it to name PORT rather than the FRONT_URL nobody set", got)
		}
	})

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var logs strings.Builder
			log.SetOutput(&logs)
			defer log.SetOutput(os.Stderr)

			t.Setenv("BORGO_PUSH_KEY", c.key)
			t.Setenv("FRONT_URL", c.frontURL)
			t.Setenv("BORGO_PUSH_INSECURE", c.insecure)
			t.Setenv("PORT", "")

			err := checkPushEnv()

			switch {
			case c.wantErr != "":
				if err == nil {
					t.Fatalf("checkPushEnv() = nil; the boot continued with %s and a key that cannot be placed", c.wantErr)
				}
				if !strings.Contains(err.Error(), c.wantErr) {
					t.Fatalf("checkPushEnv() = %v, want it to name %s", err, c.wantErr)
				}
			case err != nil:
				t.Fatalf("checkPushEnv() = %v, want nil: an app that never pushes must still boot", err)
			}

			got := logs.String()
			if c.quiet && got != "" {
				t.Fatalf("checkPushEnv() said %q; nothing is wrong here and a boot that cries wolf is read as noise", got)
			}
			if c.wantLog != "" && !strings.Contains(got, c.wantLog) {
				t.Fatalf("checkPushEnv() logged %q, want it to contain %q", got, c.wantLog)
			}
		})
	}
}

// PORT is interpolated into a url, and an "@" in it turns "localhost:" into
// credentials while the rest becomes the authority. Measured before the fix:
// every push arrived at a listener of somebody else's choosing, the front
// server got nothing, and the boot said not one word - and with no key set
// there is no guard anywhere on that path.
func TestPortCannotMoveThePushToAnotherHost(t *testing.T) {
	var frontHits, otherHits atomic.Int64
	front := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		frontHits.Add(1)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer front.Close()
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		otherHits.Add(1)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer other.Close()

	_, otherPort, err := net.SplitHostPort(strings.TrimPrefix(other.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}

	for _, port := range []string{
		"@127.0.0.1:" + otherPort,
		"3000@127.0.0.1:" + otherPort,
		":80",
		"3000:80",
		"99999", "65536", "0", "-1", "3000 ", "abc", "80#", "80?",
	} {
		t.Run(port, func(t *testing.T) {
			t.Setenv("FRONT_URL", "")
			t.Setenv("PORT", port)
			t.Setenv("BORGO_PUSH_KEY", "")

			before := otherHits.Load()
			if err := Push("live", "x", "y"); err == nil {
				t.Fatalf("Push() = nil with PORT=%q: a value that is not a port must not build a destination", port)
			}
			if got := otherHits.Load(); got != before {
				t.Fatalf("PORT=%q sent the push to another host: it arrived there %d times", port, got-before)
			}
		})
	}

	// and the honest control: a real port still works, or the guard above is
	// only proving that nothing ever pushes
	t.Setenv("FRONT_URL", front.URL)
	t.Setenv("PORT", "")
	if err := Push("live", "x", "y"); err != nil {
		t.Fatalf("Push() = %v with a good FRONT_URL: the refusals above prove nothing if this fails too", err)
	}
	if frontHits.Load() != 1 {
		t.Fatalf("front server saw %d pushes, want 1", frontHits.Load())
	}
}

// a query or fragment on the base swallows the publish path: measured, the
// request arrived at "/" instead of "/__borgo/publish", so every push was a 404
// against a real front server while the boot stayed silent
func TestABaseThatSwallowsThePublishPathIsRefused(t *testing.T) {
	for _, base := range []string{
		"http://localhost:3000/?x=1",
		"http://localhost:3000/#frag",
		"http://localhost:3000/?",
		"http://localhost:99999",
		"http://localhost:0",
	} {
		t.Setenv("FRONT_URL", base)
		t.Setenv("BORGO_PUSH_KEY", "")
		if err := Push("live", "x", "y"); err == nil {
			t.Errorf("Push() = nil with FRONT_URL=%q, want a refusal before the request", base)
		}
	}
}

// go 1.25 lets url.Parse read a second colon in the authority, so
// "127.0.0.1:3000:9000" parses with Hostname()="127.0.0.1:3000". The boot said
// nothing, the push died at the dial, and with a key set the guard judged a
// host the dialer would never use. Being told about that by a GODEBUG default
// is not a check.
func TestADestinationTheDialerWouldReadDifferentlyIsRefused(t *testing.T) {
	front := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer front.Close()
	host, port, err := net.SplitHostPort(strings.TrimPrefix(front.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}

	for _, base := range []string{
		"http://" + host + ":" + port + ":9000",
		"http://" + host + ":" + port + ":",
		"http://" + host + "/%2e%2e",
		"http://" + host + "/%2E%2E/x",
	} {
		t.Setenv("FRONT_URL", base)
		t.Setenv("BORGO_PUSH_KEY", "")
		if err := Push("live", "x", "y"); err == nil {
			t.Errorf("Push() = nil with FRONT_URL=%q: refusing before the request is the point", base)
		}
		// and the boot must never be quieter than the push
		t.Setenv("BORGO_PUSH_KEY", "k")
		if err := checkPushEnv(); err == nil {
			t.Errorf("checkPushEnv() = nil with FRONT_URL=%q: the boot stayed quieter than the push", base)
		}
	}

	// honest control: the same server, addressed properly, still works
	t.Setenv("FRONT_URL", front.URL)
	t.Setenv("BORGO_PUSH_KEY", "")
	if err := Push("live", "x", "y"); err != nil {
		t.Fatalf("Push() = %v against a good base: the refusals above prove nothing if this fails too", err)
	}
}

// the rule says digits, and Atoi accepts a leading sign
func TestASignedPortIsNotAPort(t *testing.T) {
	for _, p := range []string{"+80", "-80", " 80", "80 ", "0x50", "8e1", ""} {
		if validPort(p) {
			t.Errorf("validPort(%q) = true, want false", p)
		}
	}
	for _, p := range []string{"1", "80", "3000", "65535", "080"} {
		if !validPort(p) {
			t.Errorf("validPort(%q) = false, want true", p)
		}
	}
}
