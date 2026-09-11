package borgo

import (
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path"
	"strconv"
	"strings"
	"time"
)

// Front mode: the go binary answers the public port itself. /api and /healthz
// are served in-process; everything else - pages, assets, the websocket
// relay, the dev channel - is forwarded to the bun render service over a
// loopback connection that both sides authenticate with a key minted for
// this boot. The api routes are also mounted on a second, loopback-only
// listener for the render service's loaders to call.
//
// Measured before it was built (bench/results/spikes): net/http alone
// answers /api at four times the throughput of the same handler reached
// through the bun proxy, because a call that took fifty microseconds was
// paying a process hop. Pages pay that hop now instead, where a render of
// milliseconds does not notice it.
//
// BORGO_FRONT=1 switches it on. While the switch exists the old topology
// keeps working unchanged; it is removed once every responsibility has
// moved across (the 0.30 plan, phase 1).

const (
	// every request between the two processes carries the boot key here; the
	// public port strips it on the way in, so a client cannot present one
	internalKeyHeader = "X-Borgo-Internal"
	// the verified session's payload, base64url of the json the app stored:
	// the render service receives a fact go established, never the cookie
	// to re-verify - bun has never held SESSION_SECRET and still does not
	sessionHeader = "X-Borgo-Session"
	// the hmac keys the session with 32 bytes; the key that guards the
	// listener carrying that session is held to the same floor
	internalKeyMinLen = 32
	defaultPublicPort = "3000"
	// how long the render service may take to answer with headers; the body
	// streams unbounded after that, an ssr page or an event stream alike
	defaultRenderTimeout = 30 * time.Second
)

// frontEnabled reads BORGO_FRONT with the ParseBool grammar every other
// switch uses; unset is off.
func frontEnabled() (bool, error) {
	v := os.Getenv("BORGO_FRONT")
	if v == "" {
		return false, nil
	}
	on, err := strconv.ParseBool(v)
	if err != nil {
		return false, fmt.Errorf(`borgo: BORGO_FRONT: invalid value %q (want "1"/"true" or "0"/"false"; unset means off)`, v)
	}
	return on, nil
}

// internalKey reads BORGO_INTERNAL_KEY. Front mode refuses to start without
// one: the loopback listeners are reachable by every process on the box,
// and a key is what turns them from an api into a cable between two
// processes that recognise each other.
func internalKey() (string, error) {
	key := os.Getenv("BORGO_INTERNAL_KEY")
	if len(key) < internalKeyMinLen {
		return "", fmt.Errorf("borgo: BORGO_INTERNAL_KEY must be set to at least %d bytes in front mode: the supervisor mints one per boot (openssl rand -base64 48 by hand)", internalKeyMinLen)
	}
	return key, nil
}

// renderURL reads BORGO_RENDER_URL, where the bun render service listens. A
// path, query or userinfo is refused: the url names a host, and anything
// else in it would be silently joined onto every forwarded request.
func renderURL() (*url.URL, error) {
	v := os.Getenv("BORGO_RENDER_URL")
	if v == "" {
		return nil, errors.New("borgo: BORGO_RENDER_URL must be set in front mode (the render service's address, e.g. http://127.0.0.1:3600)")
	}
	u, err := url.Parse(v)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("borgo: BORGO_RENDER_URL: invalid url %q (want http://host:port)", v)
	}
	if u.Path != "" && u.Path != "/" || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return nil, fmt.Errorf("borgo: BORGO_RENDER_URL: %q must name a host only, no path, query or credentials", v)
	}
	u.Path = ""
	return u, nil
}

// envPublicPort reads PORT with envPort's grammar: refused, never defaulted
// onto a typo.
func envPublicPort() (string, error) {
	v := os.Getenv("PORT")
	if v == "" {
		return defaultPublicPort, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 || n > 65535 || strings.Trim(v, "0123456789") != "" {
		return "", fmt.Errorf(`borgo: PORT: invalid port %q (want 0-65535; unset uses %s)`, v, defaultPublicPort)
	}
	return v, nil
}

// keysEqual compares in constant time; a length mismatch is a mismatch, not
// a shortcut a timing can see.
func keysEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// requireInternalKey guards the loopback listener: a request without this
// boot's key is answered 403 and logged with the peer, because a stranger on
// the box has found a listener that was never meant for it.
func requireInternalKey(key string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !keysEqual(r.Header.Get(internalKeyHeader), key) {
			log.Printf("borgo: internal listener refused %s %s from %s: missing or wrong %s", r.Method, r.URL.Path, r.RemoteAddr, internalKeyHeader)
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// front is the public handler: the api in-process, the rest forwarded.
type front struct {
	api   http.Handler
	proxy *httputil.ReverseProxy
}

// inProcess names what the go binary answers itself on the public port.
// /metrics stays with the render service until the counters move (phase 1,
// step 4): a label table that lives in two processes is two tables.
func inProcess(cleaned string) bool {
	return cleaned == "/api" || strings.HasPrefix(cleaned, "/api/") || cleaned == "/healthz"
}

// internalName is a path the two processes use between themselves.
func internalName(cleaned string) bool {
	return cleaned == "/__borgo" || strings.HasPrefix(cleaned, "/__borgo/")
}

func (f *front) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// decided on the cleaned path: go leaves dot segments in URL.Path and the
	// render service normalises them, so /x/../__borgo/publish would pass a
	// prefix test here and land on the publish handler there (found by the
	// verifier of this step). The request itself travels as written; only
	// the decision is taken on what it will mean at the far end
	cleaned := path.Clean(r.URL.Path)
	// the names the two processes use between themselves are not urls: a
	// public request for one is answered as if it did not exist
	if internalName(cleaned) {
		http.NotFound(w, r)
		return
	}
	if inProcess(cleaned) {
		f.api.ServeHTTP(w, r)
		return
	}
	f.proxy.ServeHTTP(w, r)
}

// newFrontHandler builds the public handler. api is the mounted route mux,
// already wrapped by Middleware; csrf adds the double-submit check bun ran
// before proxying, which /api would otherwise lose the moment it stopped
// passing through bun; renderer is where everything else goes.
func newFrontHandler(api http.Handler, csrf bool, renderer *url.URL, key string, timeout time.Duration) http.Handler {
	if csrf {
		api = csrfMiddleware(api)
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	// one host, many concurrent pages: the default of two idle connections
	// per host would open a socket per request under any load
	transport.MaxIdleConnsPerHost = 256
	// headers only: an ssr page streams for as long as it streams
	transport.ResponseHeaderTimeout = timeout
	// the render service compresses nothing the browser did not ask for, and
	// nothing here must decompress what it did
	transport.DisableCompression = true

	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(renderer)
			// SetURL points Host at the renderer; the render service builds
			// absolute urls, checks websocket origins and keys its page cache
			// on the host the browser asked for, so that one travels
			pr.Out.Host = pr.In.Host
			// the chain a proxy in front of this one built is kept and this
			// hop appended, as the old front did; the scheme it saw is kept
			// too, or a tls-terminating nginx would have every websocket
			// origin compared against "http" and refused. The same trust the
			// old topology extended to the first hop; a trusted-proxy policy
			// narrows it in step 2
			pr.Out.Header["X-Forwarded-For"] = pr.In.Header["X-Forwarded-For"]
			pr.SetXForwarded()
			if proto := pr.In.Header.Get("X-Forwarded-Proto"); proto != "" {
				pr.Out.Header.Set("X-Forwarded-Proto", proto)
			}
			// a client presenting either name is a client forging a fact
			// only this process may state: Set replaces, so the deletes are
			// the statement, not the mechanism
			pr.Out.Header.Del(sessionHeader)
			pr.Out.Header.Set(internalKeyHeader, key)
			if data, ok := sessionData(pr.In); ok {
				pr.Out.Header.Set(sessionHeader, base64.RawURLEncoding.EncodeToString(data))
			}
		},
		// the render service sets neither; if it ever did, the names stay
		// between the two processes
		ModifyResponse: func(res *http.Response) error {
			res.Header.Del(internalKeyHeader)
			res.Header.Del(sessionHeader)
			return nil
		},
		Transport: transport,
		// every byte reaches the client as it arrives: a streaming ssr page
		// and an event stream both depend on it
		FlushInterval: -1,
		ErrorHandler:  renderUnavailable,
	}
	return &front{api: api, proxy: proxy}
}

// renderUnavailable answers for a render service that did not: the api is
// still up, so the page says so and asks the browser to come back rather
// than reading as an outage. A deadline reads as 504, anything else as 503.
//
// The security headers the render service would have put on this page are
// missing until the front owns them (phase 1, step 2); the page carries no
// script and no markup from the request, which is what they would guard.
func renderUnavailable(w http.ResponseWriter, r *http.Request, err error) {
	status := http.StatusServiceUnavailable
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		status = http.StatusGatewayTimeout
	}
	log.Printf("borgo: render service did not answer %s %s: %v", r.Method, r.URL.Path, err)
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Retry-After", "2")
	w.WriteHeader(status)
	if status == http.StatusGatewayTimeout {
		fmt.Fprint(w, "the page took too long to render; the api is up - retry in a moment\n")
		return
	}
	fmt.Fprint(w, "the page service is unavailable; the api is up - retry in a moment\n")
}
