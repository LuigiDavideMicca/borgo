package borgo

import (
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
)

// The security headers the bun front server has always put on what it
// answers, on the go side for front mode: the same three static headers on
// every response borgo authors, and the nonce-less csp on documents. The
// nonced csp of a rendered page stays where the render is until the page
// cache moves (phase 1, step 3); until then the render service still sets
// it, and this side adds nothing a response already carries.
//
// Authorship, not path: the old front learned that a path test for /api
// also exempted borgo's own 403 and 502 on that path, which then went out
// bare. Here every response written on the public port passes through, and
// "already present" is the only exemption.

// cspDefault is CSP_DEFAULT in util.ts, byte for byte; {nonce} is the
// per-render slot, absent from what this side applies.
const cspDefault = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; " +
	"form-action 'self'; img-src 'self' data: blob:; font-src 'self' data:; " +
	"style-src 'self' 'unsafe-inline'; connect-src 'self'; script-src 'self'"

var staticSecurity = [...][2]string{
	{"X-Content-Type-Options", "nosniff"},
	{"Referrer-Policy", "strict-origin-when-cross-origin"},
	{"X-Frame-Options", "DENY"},
}

// a boolean spelling is the switch and never a policy: `false` must not ship
// Content-Security-Policy: false, which browsers discard while scanners count
var cspSwitchWords = map[string]bool{
	"0": true, "1": true, "t": true, "f": true, "true": true, "false": true, "yes": true, "no": true,
	"on": true, "off": true, "enable": true, "disable": true, "enabled": true, "disabled": true,
	"none": true, "null": true, "nil": true, "unset": true, "default": true,
}

type securityConfig struct {
	// nil: BORGO_SECURITY_HEADERS=0, nothing is added
	enabled bool
	// the csp applied to documents this side writes, without a nonce slot;
	// "" when BORGO_CSP=0
	csp string
}

// envTextRefusal is envText in util.ts: a control character is refused for
// every variable alike, because a .env authored on windows puts \r on every
// line and a header value would carry it or silently drop it.
func envTextRefusal(name, v string) error {
	for i, r := range v {
		if r < 0x20 || r == 0x7f {
			return fmt.Errorf("borgo: %s: invalid value %q (a control character at position %d; a trailing \\r is what a .env file authored on windows puts on every line - strip it rather than letting borgo guess)", name, v, i)
		}
	}
	return nil
}

// cspSetting is BORGO_CSP's grammar, mirrored from util.ts: a switch word
// turns the header off or asks for the default, one bare word is refused
// because a mistyped switch and a valueless directive share that shape, and
// anything else is the operator's policy with {nonce} as the per-render slot.
func cspSetting() (policy string, enabled bool, err error) {
	raw := os.Getenv("BORGO_CSP")
	if raw == "" {
		return cspDefault, true, nil
	}
	if err := envTextRefusal("BORGO_CSP", raw); err != nil {
		return "", false, err
	}
	if on, err := strconv.ParseBool(raw); err == nil {
		if !on {
			return "", false, nil
		}
		return cspDefault, true, nil
	}
	bare := strings.TrimSpace(strings.Join(strings.FieldsFunc(raw, func(r rune) bool { return r == ';' || r == ' ' || r == '\t' }), " "))
	if cspSwitchWords[strings.ToLower(bare)] {
		return "", false, fmt.Errorf(`borgo: BORGO_CSP: %q is a switch word borgo does not read (want "1"/"true" or "0"/"false")`, raw)
	}
	if !strings.Contains(raw, ";") && len(strings.Fields(raw)) < 2 {
		return "", false, fmt.Errorf("borgo: BORGO_CSP: %q is a single bare word, which is the one shape a mistyped switch and a valueless directive share - so borgo cannot tell which you meant. If you wanted the header off, write \"0\" or \"false\" (\"1\"/\"true\" asks for borgo's own policy, unset means the same). If it was a policy, it is missing the punctuation that makes it one: give the directive a value (%q) or end it with a semicolon (%q), both of which are valid csp", raw, raw+" 'none'", raw+";")
	}
	return raw, true, nil
}

// securityFromEnv reads BORGO_SECURITY_HEADERS and BORGO_CSP once, before a
// port is bound: unset and empty keep every header, unreadable refuses.
func securityFromEnv() (*securityConfig, error) {
	if v := os.Getenv("BORGO_SECURITY_HEADERS"); v != "" {
		if err := envTextRefusal("BORGO_SECURITY_HEADERS", v); err != nil {
			return nil, err
		}
		on, err := strconv.ParseBool(v)
		if err != nil {
			return nil, fmt.Errorf(`borgo: BORGO_SECURITY_HEADERS: invalid value %q (want "1"/"true" or "0"/"false"; unset means every header on)`, v)
		}
		if !on {
			return &securityConfig{enabled: false}, nil
		}
	}
	policy, enabled, err := cspSetting()
	if err != nil {
		return nil, err
	}
	cfg := &securityConfig{enabled: true}
	if enabled {
		cfg.csp = strings.ReplaceAll(policy, "{nonce}", "")
	}
	return cfg, nil
}

// apply adds what is absent. rfc 9110 §8.3.1: the media type is compared
// case-insensitively, an action or loader guard may hand back TEXT/HTML.
func (c *securityConfig) apply(h http.Header) {
	if c == nil || !c.enabled {
		return
	}
	for _, kv := range staticSecurity {
		if h.Get(kv[0]) == "" {
			h.Set(kv[0], kv[1])
		}
	}
	if c.csp == "" || h.Get("Content-Security-Policy") != "" {
		return
	}
	ct := strings.ToLower(h.Get("Content-Type"))
	if strings.HasPrefix(ct, "text/html") || strings.HasPrefix(ct, "image/svg+xml") {
		h.Set("Content-Security-Policy", c.csp)
	}
}

// secureMiddleware applies the config to every response the wrapped handler
// commits, at the moment its headers are decided.
func (c *securityConfig) middleware(next http.Handler) http.Handler {
	if c == nil || !c.enabled {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(&securedWriter{ResponseWriter: w, cfg: c}, r)
	})
}

// securedWriter adds the headers on the first commit, whichever path takes
// it: WriteHeader, Write, or Flush. Unwrap keeps ResponseController and the
// flusher reaching the real writer, as recoverWriter does.
type securedWriter struct {
	http.ResponseWriter
	cfg       *securityConfig
	committed bool
}

func (s *securedWriter) commit() {
	if s.committed {
		return
	}
	s.committed = true
	s.cfg.apply(s.Header())
}

func (s *securedWriter) WriteHeader(code int) {
	s.commit()
	s.ResponseWriter.WriteHeader(code)
}

func (s *securedWriter) Write(b []byte) (int, error) {
	s.commit()
	return s.ResponseWriter.Write(b)
}

func (s *securedWriter) Flush() {
	s.commit()
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (s *securedWriter) Unwrap() http.ResponseWriter { return s.ResponseWriter }
