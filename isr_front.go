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
type policySource struct {
	mu      sync.Mutex
	boot    string
	entries []policyEntry
	loaded  bool
	fetch   func() (boot string, entries []policyEntry, err error)
	// said once per failure, not once per page request
	failedOnce bool
}

func (p *policySource) lookup(pathname string) (*isrPolicy, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.loaded {
		boot, entries, err := p.fetch()
		if err != nil {
			if !p.failedOnce {
				p.failedOnce = true
				log.Printf("borgo: page policies not read from the render service (%v): pages served fresh until it answers", err)
			}
			return nil, false
		}
		p.boot, p.entries, p.loaded, p.failedOnce = boot, entries, true, false
	}
	return matchPolicy(p.entries, pathname)
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
	forward  func(in *http.Request, out http.Header)
}

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
	return &renderClient{renderer: renderer, key: key, client: client, forward: forward}
}

func (c *renderClient) policies() (string, []policyEntry, error) {
	req, err := http.NewRequest(http.MethodGet, c.renderer.String()+routesPath, nil)
	if err != nil {
		return "", nil, err
	}
	req.Header.Set(internalKeyHeader, c.key)
	res, err := c.client.Do(req)
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

// shared renders one page as nobody. The request is the anonymised one;
// the forwarded facts are the same the proxy would state, so a loader that
// builds an absolute url builds the public one.
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
	req.Header.Del(sessionHeader)
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
