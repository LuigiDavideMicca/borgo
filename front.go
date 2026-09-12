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
// Not a switch: this is front mode when there is a render service to be
// the front of, which BORGO_RENDER_URL names and every borgo command sets.
// An app that uses borgo as its api alone - an embedder, a service with no
// pages - names none, and keeps the single listener serveContext binds.

const (
	// every request between the two processes carries the boot key here; the
	// public port strips it on the way in, so a client cannot present one
	internalKeyHeader = "X-Borgo-Internal"
	// the verified session's payload, base64url of the json the app stored:
	// the render service receives a fact go established rather than a cookie
	// to verify, because bun has never held SESSION_SECRET and still does
	// not. It does still see the browser's Cookie header - a loader's api
	// client forwards it to the internal listener, where this side verifies
	// it - so the claim is about the KEY, not about the credential
	sessionHeader = "X-Borgo-Session"
	// the hmac keys the session with 32 bytes; the key that guards the
	// listener carrying that session is held to the same floor
	internalKeyMinLen = 32
	defaultPublicPort = "3000"
	// how long the render service may take to answer with headers; the body
	// streams unbounded after that, an ssr page or an event stream alike
	defaultRenderTimeout = 30 * time.Second
	// a public port has clients that never finish: the old zero was safe
	// only because bun read every body before go saw it. Streams clear
	// their own deadlines (borgo.SSE), upgrades hijack the connection, and a
	// page that renders for a minute is broken whatever the deadline says
	defaultPublicTimeout = 60 * time.Second
	// BORGO_MAX_BODY's default, the number bun has always used
	defaultMaxBody = 32 << 20
	// the render service's fast-refresh channel, a websocket the browser
	// dials in dev; the orchestrator's own pokes below it go straight to the
	// render port and never through here
	devChannelPath = "/__borgo/dev"
)

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

// renderURL reads BORGO_RENDER_URL, where the bun render service listens,
// and is what decides the topology: a nil url with no error means nobody
// asked this binary to be a front, and it serves its api alone. A path,
// query or userinfo is refused - the url names a host, and anything else in
// it would be silently joined onto every forwarded request.
func renderURL() (*url.URL, error) {
	v := os.Getenv("BORGO_RENDER_URL")
	if v == "" {
		return nil, nil
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

// envMaxBody reads BORGO_MAX_BODY in bytes, the cap bun has always applied
// to what it read: 0 is no limit, a fraction or a sign is refused rather than
// floored (`=0.5` must not switch a limit off).
func envMaxBody() (int64, error) {
	v := os.Getenv("BORGO_MAX_BODY")
	if v == "" {
		return defaultMaxBody, nil
	}
	if strings.Trim(v, "0123456789") != "" {
		return 0, fmt.Errorf(`borgo: BORGO_MAX_BODY: invalid value %q (want a whole number of bytes; 0 means no limit; unset uses %d)`, v, defaultMaxBody)
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return 0, fmt.Errorf(`borgo: BORGO_MAX_BODY: invalid value %q (want a whole number of bytes; 0 means no limit; unset uses %d)`, v, defaultMaxBody)
	}
	return n, nil
}

// trustedProxies reads BORGO_TRUSTED_PROXIES: the peers whose X-Forwarded-*
// headers are believed. Unset trusts loopback and the private ranges - a
// reverse proxy on the same box or lan, which is every nginx and caddy
// recipe borgo emits; "none" trusts nobody; otherwise a comma-separated
// list of addresses or cidrs. A public port cannot believe a header anyone
// on the internet can write, and the old front believed the first hop
// because the first hop was always bun.
func trustedProxies() ([]*net.IPNet, error) {
	v := strings.TrimSpace(os.Getenv("BORGO_TRUSTED_PROXIES"))
	if v == "" {
		v = "127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7"
	}
	if strings.EqualFold(v, "none") {
		return nil, nil
	}
	var nets []*net.IPNet
	for _, part := range strings.Split(v, ",") {
		s := strings.TrimSpace(part)
		if s == "" {
			continue
		}
		if !strings.Contains(s, "/") {
			ip := net.ParseIP(s)
			if ip == nil {
				return nil, fmt.Errorf(`borgo: BORGO_TRUSTED_PROXIES: %q is not an ip address or cidr (unset trusts loopback and the private ranges; "none" trusts nobody)`, s)
			}
			bits := 32
			if ip.To4() == nil {
				bits = 128
			}
			s = fmt.Sprintf("%s/%d", ip, bits)
		}
		_, n, err := net.ParseCIDR(s)
		if err != nil {
			return nil, fmt.Errorf(`borgo: BORGO_TRUSTED_PROXIES: %q is not an ip address or cidr (unset trusts loopback and the private ranges; "none" trusts nobody)`, part)
		}
		nets = append(nets, n)
	}
	return nets, nil
}

func peerTrusted(remoteAddr string, trusted []*net.IPNet) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	for _, n := range trusted {
		if n.Contains(ip) {
			return true
		}
	}
	return false
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

// limitBody caps what a public handler may read: counted as it is read,
// never trusted from a declaration, so a chunked body cannot walk past it.
// Bind turns the reader's refusal into a 413 (BindError); a handler reading
// the body itself gets the error from Read.
func limitBody(maxBody int64, next http.Handler) http.Handler {
	if maxBody <= 0 {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Body != nil && r.Body != http.NoBody {
			r.Body = http.MaxBytesReader(w, r.Body, maxBody)
		}
		next.ServeHTTP(w, r)
	})
}

// frontOptions is what the public handler is configured with, read from the
// environment once by serveFront and handed in whole so tests can build the
// same handler without an environment.
type frontOptions struct {
	// the double-submit check bun ran before proxying /api
	csrf bool
	// headers on every response this side writes; nil adds nothing
	security *securityConfig
	// bytes a public /api handler may read; 0 is no limit
	maxBody int64
	// peers whose X-Forwarded-* are believed; nil believes nobody
	trusted []*net.IPNet
	// public/ as indexed at boot; nil forwards every file request
	assets *assetIndex
	// the page cache; nil in dev, where pages are never shared
	isr *isr
	// the counters behind /metrics; nil when BORGO_METRICS is off
	metrics *metrics
	// the request line, printed in dev only
	dev bool
	// api/middleware.go; nil when the app has none
	app *appMiddleware
}

// front is the public handler: the api and the files in-process, the rest
// forwarded.
type front struct {
	api      http.Handler
	assets   *assetIndex
	isr      *isr
	policies *policySource
	proxy    *httputil.ReverseProxy
	health   http.Handler
	metrics  http.Handler
	dev      bool
	// serveGuarded behind the app's middleware
	guarded http.Handler
}

// inProcess names what the api mux answers on the public port; /healthz
// and /metrics are the front's own, below.
func inProcess(cleaned string) bool {
	return cleaned == "/api" || strings.HasPrefix(cleaned, "/api/")
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
	// public request for one is answered as if it did not exist. One
	// exception, in dev only: the browser's fast-refresh channel lives on
	// the render service, and the browser can only reach it through here
	if internalName(cleaned) && !(f.dev && cleaned == devChannelPath) {
		http.NotFound(w, r)
		return
	}
	// the front's own endpoints: out of the counters, like on the bun side
	if cleaned == "/healthz" {
		f.health.ServeHTTP(w, r)
		return
	}
	if cleaned == "/metrics" {
		if f.metrics == nil {
			// off is off: never a page named /metrics rendered for whoever asks
			http.NotFound(w, r)
			return
		}
		f.metrics.ServeHTTP(w, r)
		return
	}
	// one spelling per page, before anything routes, caches or counts on it.
	// The render service applies the same rule (canonicalPath in router.ts),
	// and it applying it ALONE is what let one request for an alias turn the
	// cache off for the real page: see canonical.go. /api is exempt. And it
	// comes before the app's middleware, whose matcher must see one spelling
	if !inProcess(cleaned) && redirectToCanonical(w, r, canonicalPath(r.URL.EscapedPath())) {
		return
	}
	f.guarded.ServeHTTP(w, r)
}

// serveGuarded is everything the app's middleware stands in front of: the
// api, public files, the page cache and the render service, in that order.
func (f *front) serveGuarded(w http.ResponseWriter, r *http.Request) {
	cleaned := path.Clean(r.URL.Path)
	if inProcess(cleaned) {
		f.api.ServeHTTP(w, r)
		// the mux wrote the pattern it matched onto the request; a miss
		// is counted under the prefix, as the old front counted everything
		if r.Pattern != "" {
			setRouteLabel(r, r.Pattern)
		} else {
			setRouteLabel(r, "/api/*")
		}
		return
	}
	if f.assets != nil && f.assets.tryServe(w, r) {
		return
	}
	// a page that declared itself shareable: answered from the cache when
	// it can be; bypass means this visitor gets their own render, marked
	if f.policies != nil {
		if _, pattern, ok := f.policies.lookupPattern(cleaned); ok {
			setRouteLabel(r, pattern)
		}
	}
	if f.isr != nil {
		if policy, ok := f.policies.lookup(cleaned); ok && policy != nil {
			switch f.isr.handle(w, r, policy) {
			case isrServed:
				return
			case isrBypass:
				r = markBypass(r)
			}
		}
	}
	f.proxy.ServeHTTP(w, r)
}

// newFrontHandler builds the public handler. api is the mounted route mux,
// already wrapped by Middleware; renderer is where everything else goes.
func newFrontHandler(api http.Handler, opts frontOptions, renderer *url.URL, key string, timeout time.Duration) http.Handler {
	if opts.csrf {
		api = csrfMiddleware(api)
	}
	api = limitBody(opts.maxBody, api)
	transport := http.DefaultTransport.(*http.Transport).Clone()
	// one host, many concurrent pages: the default of two idle connections
	// per host would open a socket per request under any load
	transport.MaxIdleConnsPerHost = 256
	// headers only: an ssr page streams for as long as it streams
	transport.ResponseHeaderTimeout = timeout
	// the render service compresses nothing the browser did not ask for, and
	// nothing here must decompress what it did
	transport.DisableCompression = true

	// the cache has its own conversations with the render service, on the
	// same transport: the policy table once per boot, shared renders on demand
	rc := newRenderClient(renderer, key, transport, func(in *http.Request, out http.Header) {
		forwardFacts(in, out, opts.trusted)
	}, timeout)
	// the policy table also names pages for the counters, cache or no cache
	policies := &policySource{fetch: rc.policies}
	// and it is told the boot stamp of every shared render too, not only of
	// what the proxy carried: a render service restarted under a live front
	// answers cached traffic without the proxy ever seeing a response
	rc.onBoot = policies.sawBoot
	if opts.isr != nil {
		opts.isr.render = rc.shared
	}
	health := frontHealthz(newRenderProbe(renderer, key, transport))
	var metricsEndpoint http.Handler
	if opts.metrics != nil {
		metricsEndpoint = metricsHandler(opts.metrics)
	}

	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(renderer)
			// SetURL points Host at the renderer; the render service builds
			// absolute urls, checks websocket origins and keys its page cache
			// on the host the browser asked for, so that one travels
			pr.Out.Host = pr.In.Host
			// what a trusted proxy in front stated is kept and this hop
			// appended: the chain, and the scheme it saw - or a
			// tls-terminating nginx would have every websocket origin
			// compared against "http" and refused. From an untrusted peer
			// the same headers are the client's own claims, and the
			// forwarded facts are rebuilt from the connection alone
			trusted := peerTrusted(pr.In.RemoteAddr, opts.trusted)
			if trusted {
				pr.Out.Header["X-Forwarded-For"] = pr.In.Header["X-Forwarded-For"]
			}
			pr.SetXForwarded()
			if proto := pr.In.Header.Get("X-Forwarded-Proto"); trusted && proto != "" {
				pr.Out.Header.Set("X-Forwarded-Proto", proto)
			}
			// a client presenting either name is a client forging a fact
			// only this process may state: Set replaces, so the delete is
			// the statement, not the mechanism
			pr.Out.Header.Del(sessionHeader)
			pr.Out.Header.Del(sharedRenderHeader)
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
			// a proxied event stream ends with the server, like borgo.SSE's
			// own: Shutdown waits for every active request, and this one is a
			// ReverseProxy copy loop no latch reached, so with
			// BORGO_SHUTDOWN_TIMEOUT=0 the process never exited and with the
			// default it held the whole grace (found by the verifier of
			// phase 1). A document is not a stream and is left to finish
			if isEventStream(res.Header.Get("Content-Type")) && res.Request != nil {
				res.Body = endOnShutdown(res.Body, shutdownSignal(res.Request))
			}
			// an upgrade is the one response the wrapper around the public
			// port never sees: ReverseProxy hijacks the connection and writes
			// this response to the socket itself, headers and all. So the
			// headers go on here, where they are still a map. Everything else
			// is committed through securedWriter, which is where they belong
			// - by authorship, on the whole port, with no exceptions left
			if res.StatusCode == http.StatusSwitchingProtocols {
				opts.security.apply(res.Header)
			}
			// the stamp says which boot of the render service answered: a new
			// one may declare new pages, and the policy table is asked again
			if policies != nil {
				policies.sawBoot(res.Header.Get(bootHeader))
			}
			res.Header.Del(bootHeader)
			if res.Request != nil && isBypass(res.Request) {
				res.Header.Set(cacheStateHeader, "bypass")
			}
			return nil
		},
		Transport: transport,
		// every write reaches the client as it is made. ReverseProxy already
		// does that for a chunked response and an event stream, whatever
		// this says; what -1 decides is a response that declares its length
		// and writes it in parts, which at 0 would sit in a buffer until it
		// filled or ended
		FlushInterval: -1,
		ErrorHandler:  renderUnavailable,
	}
	f := &front{api: api, assets: opts.assets, isr: opts.isr, policies: policies, proxy: proxy, health: health, metrics: metricsEndpoint, dev: opts.dev}
	// api/middleware.go in front of everything the front does not answer
	// itself; middleware.go says why each position is where it is
	f.guarded = withAppMiddleware(opts.app, http.HandlerFunc(f.serveGuarded))
	var h http.Handler = f
	// on the whole public port, including the proxy's own refusals: by
	// authorship, not by path. The counters sit outside the headers, so a
	// refusal the headers wrapper writes is counted too
	return observeRequests(opts.metrics, opts.dev, opts.security.middleware(h))
}

// renderUnavailable answers for a render service that did not: the api is
// still up, so the page says so and asks the browser to come back rather
// than reading as an outage. A deadline reads as 504, anything else as 503.
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

// publicTimeouts gives the public server the deadlines newServer leaves at
// zero for the api behind bun, unless the operator set them.
func publicTimeouts(srv *http.Server) {
	if os.Getenv("BORGO_READ_TIMEOUT") == "" {
		srv.ReadTimeout = defaultPublicTimeout
	}
	if os.Getenv("BORGO_WRITE_TIMEOUT") == "" {
		srv.WriteTimeout = defaultPublicTimeout
	}
}

// forwardFacts states about the client what the proxy states on a forwarded
// request, for the shared renders the cache asks for: the same trust rule,
// so a loader building an absolute url builds the public one either way.
// forwardFacts states what this hop knows about the client. X-Forwarded-For,
// X-Forwarded-Host, X-Forwarded-Proto and Forwarded do NOT have to be
// stripped here first: httputil.ReverseProxy deletes those four from the
// outbound request before it calls Rewrite, which is why this function only
// sets. A borgo-owned list of the same four used to sit beside this one,
// reading like the guard while the standard library did the work - deleted,
// because a guard somebody may "keep working" without knowing where it lives
// is worse than no guard at all (the verifier of phase 1 found it dead).
func forwardFacts(in *http.Request, out http.Header, trusted []*net.IPNet) {
	peer, _, err := net.SplitHostPort(in.RemoteAddr)
	if err != nil {
		peer = in.RemoteAddr
	}
	believed := peerTrusted(in.RemoteAddr, trusted)
	chain := peer
	if prior := in.Header.Get("X-Forwarded-For"); believed && prior != "" {
		chain = prior + ", " + peer
	}
	out.Set("X-Forwarded-For", chain)
	out.Set("X-Forwarded-Host", in.Host)
	proto := "http"
	if in.TLS != nil {
		proto = "https"
	}
	if prior := in.Header.Get("X-Forwarded-Proto"); believed && prior != "" {
		proto = prior
	}
	out.Set("X-Forwarded-Proto", proto)
}
