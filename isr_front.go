package borgo

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// The page cache's two conversations with the render service: the policy
// table it declares once per boot, and the shared renders it produces on
// request. Both ride the same transport the proxy uses, with the boot key.

// policySource is the table as the render service last declared it, keyed
// to the boot stamp it declared it under: a restarted render service
// (a deploy, a crash) may have new pages, and the stamp on every proxied
// response says when to ask again.
//
// Read the way the health probe reads: one fetch in flight at a time, shared
// by whoever asks meanwhile, outside the lock, and a failure remembered for
// a second - the verifier measured five page requests against a hung render
// service queuing behind five thirty-second fetches, one at a time, because
// each took the mutex and fetched for itself.
type policySource struct {
	mu       sync.Mutex
	boot     string
	entries  []policyEntry
	loaded   bool
	inflight chan struct{}
	failedAt time.Time
	// said once per outage, not once per page request
	failedOnce bool
	fetch      func() (boot string, entries []policyEntry, err error)
	now        func() time.Time
}

const policyRetryAfter = time.Second

// table returns the entries, loading them if nobody has; false while the
// render service is not answering, in which case pages are served fresh
func (p *policySource) table() ([]policyEntry, bool) {
	now := p.now
	if now == nil {
		now = time.Now
	}
	p.mu.Lock()
	if p.loaded {
		entries := p.entries
		p.mu.Unlock()
		return entries, true
	}
	if !p.failedAt.IsZero() && now().Sub(p.failedAt) < policyRetryAfter {
		p.mu.Unlock()
		return nil, false
	}
	if p.inflight != nil {
		wait := p.inflight
		p.mu.Unlock()
		<-wait
		p.mu.Lock()
		entries, ok := p.entries, p.loaded
		p.mu.Unlock()
		return entries, ok
	}
	done := make(chan struct{})
	p.inflight = done
	p.mu.Unlock()

	boot, entries, err := p.fetch()

	p.mu.Lock()
	p.inflight = nil
	if err != nil {
		p.failedAt = now()
		if !p.failedOnce {
			p.failedOnce = true
			log.Printf("borgo: page policies not read from the render service (%v): pages served fresh until it answers", err)
		}
		p.mu.Unlock()
		close(done)
		return nil, false
	}
	p.boot, p.entries, p.loaded, p.failedAt, p.failedOnce = boot, entries, true, time.Time{}, false
	p.mu.Unlock()
	close(done)
	return entries, true
}

// lookupPattern is the policy and the pattern a path matched, for the cache
// and the counters: a page is a page whether or not it declared a policy
func (p *policySource) lookupPattern(pathname string) (*isrPolicy, string, bool) {
	entries, ok := p.table()
	if !ok {
		return nil, "", false
	}
	pth := strings.TrimRight(pathname, "/")
	if pth == "" {
		pth = "/"
	}
	for _, e := range entries {
		if matchPattern(e.pattern, pth) {
			return e.policy, e.pattern, true
		}
	}
	return nil, "", false
}

func (p *policySource) lookup(pathname string) (*isrPolicy, bool) {
	policy, _, ok := p.lookupPattern(pathname)
	return policy, ok
}

// sawBoot is told the stamp every proxied response carried; a different
// one than the table was read under invalidates the table, not the cache -
// the same build's copies are still that build's
func (p *policySource) sawBoot(stamp string) {
	if stamp == "" {
		return
	}
	p.mu.Lock()
	if p.loaded && stamp != p.boot {
		p.loaded = false
	}
	p.mu.Unlock()
}

// renderClient talks to the render service outside the proxy: the policy
// table, and shared renders that must be read whole before they are judged.
type renderClient struct {
	renderer *url.URL
	key      string
	client   *http.Client
	table    *http.Client
	forward  func(in *http.Request, out http.Header)
}

const policyFetchWait = 2 * time.Second

func newRenderClient(renderer *url.URL, key string, transport http.RoundTripper, forward func(*http.Request, http.Header)) *renderClient {
	client := &http.Client{Transport: transport, Timeout: sharedRenderWait}
	// a 3xx from the render service is the render's answer, never a place
	// to go: a guard's redirect to /login must reach unstorable and bypass,
	// where a followed redirect fetched /login as a shared render - no csrf
	// mint, nothing for the residue check to see - and cached the login page
	// under the guarded page's key for everyone; and across hosts the client
	// would have carried this boot's key to whatever Location named (found
	// by the verifier of this step, with the real client the test had mocked)
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	// the table is a few kilobytes of json, not a render: a hung render
	// service must not hold the first page request for thirty seconds
	table := &http.Client{Transport: transport, Timeout: policyFetchWait, CheckRedirect: client.CheckRedirect}
	return &renderClient{renderer: renderer, key: key, client: client, table: table, forward: forward}
}

func (c *renderClient) policies() (string, []policyEntry, error) {
	req, err := http.NewRequest(http.MethodGet, c.renderer.String()+routesPath, nil)
	if err != nil {
		return "", nil, err
	}
	req.Header.Set(internalKeyHeader, c.key)
	res, err := c.table.Do(req)
	if err != nil {
		return "", nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return "", nil, fmt.Errorf("%s answered %d", routesPath, res.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil {
		return "", nil, err
	}
	return parsePolicyTable(raw)
}

// shared renders one page as nobody. The request arrives anonymised - no
// cookie, no authorization, no session fact, no negotiation, which is the
// one place that property is built (anonymised, isr.go) - and the forwarded
// facts are the same the proxy would state, so a loader that builds an
// absolute url builds the public one.
func (c *renderClient) shared(anon *http.Request) (int, http.Header, string, error) {
	target := *c.renderer
	target.Path = anon.URL.Path
	target.RawPath = anon.URL.RawPath
	target.RawQuery = anon.URL.RawQuery
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, target.String(), nil)
	if err != nil {
		return 0, nil, "", err
	}
	for name, values := range anon.Header {
		req.Header[name] = values
	}
	req.Host = anon.Host
	c.forward(anon, req.Header)
	req.Header.Set(internalKeyHeader, c.key)
	req.Header.Set(sharedRenderHeader, "1")
	res, err := c.client.Do(req)
	if err != nil {
		return 0, nil, "", err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return 0, nil, "", err
	}
	return res.StatusCode, res.Header, string(body), nil
}

// bypassKey marks a request the cache handed back as unstorable: the proxy
// forwards the visitor's own render and stamps the state so curl can see why
// the page is never cached
type bypassKeyType struct{}

var bypassKey bypassKeyType

func markBypass(r *http.Request) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), bypassKey, true))
}

func isBypass(r *http.Request) bool {
	v, _ := r.Context().Value(bypassKey).(bool)
	return v
}

// isrPersistFromEnv is where the copies survive a restart: BORGO_CACHE_DIR,
// keyed to the build that rendered them.
func isrPersistFromEnv(outputs buildOutputs) *isrPersist {
	dir := os.Getenv(cacheDirEnv)
	if dir == "" {
		dir = defaultCacheDir
	}
	return &isrPersist{dir: dir, buildID: buildIDFromInventory(outputs)}
}

var errNoRenderer = errors.New("no render service")

// keep the imports honest while the draft settles
var (
	_ = base64.StdEncoding
	_ = strings.TrimSpace
	_ = time.Second
)
