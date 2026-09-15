package borgo

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSecurityHeadersByAuthorship(t *testing.T) {
	t.Setenv("BORGO_SECURITY_HEADERS", "")
	t.Setenv("BORGO_CSP", "")
	cfg, err := securityFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	h := cfg.middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/html":
			w.Header().Set("Content-Type", "TEXT/HTML; charset=utf-8")
			w.Write([]byte("<html>"))
		case "/svg":
			w.Header().Set("Content-Type", "image/svg+xml")
			w.Write([]byte("<svg/>"))
		case "/json":
			WriteJSON(w, 200, map[string]string{"ok": "yes"})
		case "/own":
			// a handler that decided its own values keeps them
			w.Header().Set("X-Frame-Options", "SAMEORIGIN")
			w.Header().Set("Content-Type", "text/html")
			w.Header().Set("Content-Security-Policy", "default-src 'none'")
			w.WriteHeader(200)
		case "/flush":
			// committed through Flush alone, as a stream is
			w.Header().Set("Content-Type", "text/html")
			w.(http.Flusher).Flush()
		}
	}))
	get := func(path string) http.Header {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		return w.Header()
	}
	for _, path := range []string{"/html", "/svg", "/json", "/flush"} {
		got := get(path)
		if got.Get("X-Content-Type-Options") != "nosniff" || got.Get("X-Frame-Options") != "DENY" || got.Get("Referrer-Policy") == "" {
			t.Errorf("%s: static headers missing: %v", path, got)
		}
	}
	for _, path := range []string{"/html", "/svg", "/flush"} {
		if got := get(path).Get("Content-Security-Policy"); got != cspDefault {
			t.Errorf("%s: csp %q", path, got)
		}
	}
	if got := get("/json").Get("Content-Security-Policy"); got != "" {
		t.Errorf("json carried a csp: %q", got)
	}
	own := get("/own")
	if own.Get("X-Frame-Options") != "SAMEORIGIN" || own.Get("Content-Security-Policy") != "default-src 'none'" {
		t.Errorf("a handler's own values were overwritten: %v", own)
	}
}

func TestSecuritySwitches(t *testing.T) {
	t.Setenv("BORGO_SECURITY_HEADERS", "0")
	cfg, err := securityFromEnv()
	if err != nil || cfg.enabled {
		t.Fatalf("BORGO_SECURITY_HEADERS=0: %v %v", cfg, err)
	}
	t.Setenv("BORGO_SECURITY_HEADERS", "maybe")
	if _, err := securityFromEnv(); err == nil {
		t.Error("BORGO_SECURITY_HEADERS=maybe was read as something")
	}
	t.Setenv("BORGO_SECURITY_HEADERS", "1\r")
	if _, err := securityFromEnv(); err == nil || !strings.Contains(err.Error(), "control character") {
		t.Errorf("a trailing CR was accepted: %v", err)
	}
	t.Setenv("BORGO_SECURITY_HEADERS", "")

	t.Setenv("BORGO_CSP", "0")
	cfg, err = securityFromEnv()
	if err != nil || !cfg.enabled || cfg.csp != "" {
		t.Fatalf("BORGO_CSP=0: headers on, csp off, got %+v %v", cfg, err)
	}
	t.Setenv("BORGO_CSP", "true")
	cfg, _ = securityFromEnv()
	if cfg.csp != cspDefault {
		t.Errorf("BORGO_CSP=true: %q", cfg.csp)
	}
	t.Setenv("BORGO_CSP", "default-src 'self'; script-src 'self'{nonce}")
	cfg, _ = securityFromEnv()
	if cfg.csp != "default-src 'self'; script-src 'self'" {
		t.Errorf("the nonce slot was not emptied: %q", cfg.csp)
	}
	t.Setenv("BORGO_CSP", "upgrade-insecure-requests;")
	if cfg, err = securityFromEnv(); err != nil || cfg.csp != "upgrade-insecure-requests;" {
		t.Errorf("a valueless directive with its semicolon is a policy: %v %v", cfg, err)
	}
	for _, bad := range []string{"yes", "upgrade-insecure-requests", "false;", "on;;", "default-src 'self'\n"} {
		t.Setenv("BORGO_CSP", bad)
		if _, err := securityFromEnv(); err == nil {
			t.Errorf("BORGO_CSP=%q was accepted", bad)
		}
	}
}

// Unwrap is load-bearing: borgo.SSE clears the server deadlines through
// http.ResponseController, and the websocket relay's upgrade hijacks through
// it. Without Unwrap both stop at this wrapper - every public event stream
// would be cut by the 60 s write deadline, silently
func TestSecuredWriterUnwrapsForTheResponseController(t *testing.T) {
	t.Setenv("BORGO_SECURITY_HEADERS", "")
	t.Setenv("BORGO_CSP", "")
	cfg, _ := securityFromEnv()
	// a channel, not two variables: the flush hands the client its response
	// before the handler has stored what the flush returned
	got := make(chan [2]error, 1)
	srv := httptest.NewServer(cfg.middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rc := http.NewResponseController(w)
		deadlineErr := rc.SetWriteDeadline(time.Time{})
		got <- [2]error{deadlineErr, rc.Flush()}
		w.Write([]byte("ok"))
	})))
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
	if res.Header.Get("X-Frame-Options") != "DENY" {
		t.Error("a response committed through Flush lost its headers")
	}
}
