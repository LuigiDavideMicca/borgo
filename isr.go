package borgo

import (
	"bytes"
	"compress/gzip"
	"container/list"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ISR on the go front: a shared html cache for pages that declare themselves
// shareable, ported from isr.ts with its doctrine intact. The property that
// must never fail is the guard, so it is built first and everything sits
// behind it: a page enters the cache only if it was rendered from an
// anonymised request, came back 200, set no cookie under any spelling, and
// its bytes carry no per-request residue. The one exception is the csp nonce:
// the stored copy keeps its render's nonce as the substitution key, and every
// replay swaps it for a fresh one in body and header alike. A page that fails
// the guard is served fresh every time and says so once; the failure
// direction is always "no caching", never "shared what was personal".
//
// What is different from the bun side is only who does what: the render
// service declares each page's policy once (ROUTES_PATH) and renders shared
// copies on request (SHARED_RENDER_HEADER); this side keys, stores, replays,
// invalidates and persists. borgo.Revalidate and RevalidateTag become local
// calls.

const (
	cacheStateHeader    = "X-Borgo-Cache"
	renderErroredHeader = "X-Borgo-Render-Errored"
	sharedRenderHeader  = "X-Borgo-Shared"
	bootHeader          = "X-Borgo-Boot"
	routesPath          = "/__borgo/routes"
	// bounded: the key includes the query string, and an attacker who can
	// vary a query must not grow the cache without limit. lru, because
	// refusing new entries would let the same attacker pin the cache full
	maxCachedPages   = 512
	defaultCacheDir  = ".borgo/cache/html"
	csrfFieldName    = "__borgo_csrf"
	cacheDirEnv      = "BORGO_CACHE_DIR"
	sharedRenderWait = 30 * time.Second
)

// --- policies ---------------------------------------------------------------

type isrPolicy struct {
	manual  bool
	seconds float64
	tags    []string
}

type policyEntry struct {
	pattern string
	policy  *isrPolicy // nil: not cacheable
}

// normalizeTag is the one spelling of a tag on both sides of the bridge:
// what the page declares and what Go sends must meet on equal bytes. The
// render service sends tags already NFC-normalised and trimmed; this side
// trims, and does not carry a unicode table for the rest.
func normalizeTag(tag string) string { return strings.TrimSpace(tag) }

// parsePolicyTable reads what ROUTES_PATH answers.
func parsePolicyTable(raw []byte) (boot string, entries []policyEntry, err error) {
	var parsed struct {
		Boot   json.RawMessage `json:"boot"`
		Routes []struct {
			Pattern string          `json:"pattern"`
			Seconds json.RawMessage `json:"seconds"`
			Tags    []string        `json:"tags"`
		} `json:"routes"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return "", nil, err
	}
	for _, r := range parsed.Routes {
		if r.Pattern == "" {
			continue
		}
		e := policyEntry{pattern: r.Pattern}
		switch s := strings.TrimSpace(string(r.Seconds)); {
		case s == `"manual"`:
			e.policy = &isrPolicy{manual: true}
		case s == "" || s == "null":
		default:
			var seconds float64
			if json.Unmarshal(r.Seconds, &seconds) == nil && seconds > 0 {
				e.policy = &isrPolicy{seconds: seconds}
			}
		}
		if e.policy != nil {
			for _, t := range r.Tags {
				if t = normalizeTag(t); t != "" {
					e.policy.tags = append(e.policy.tags, t)
				}
			}
		}
		entries = append(entries, e)
	}
	return strings.Trim(string(parsed.Boot), `"`), entries, nil
}

// matchPattern is router.ts's, so the front and the render service agree on
// which page a path is: same number of segments, ":param" takes a non-empty
// segment, a static segment matches its plain or percent-encoded spelling.
func matchPattern(pattern, path string) bool {
	pp := strings.Split(pattern, "/")
	sp := strings.Split(path, "/")
	if len(pp) != len(sp) {
		return false
	}
	for i := range pp {
		if strings.HasPrefix(pp[i], ":") {
			if sp[i] == "" {
				return false
			}
			continue
		}
		if pp[i] == sp[i] {
			continue
		}
		if decoded, err := url.PathUnescape(sp[i]); err == nil && pp[i] == decoded {
			continue
		}
		return false
	}
	return true
}

func matchPolicy(entries []policyEntry, pathname string) (*isrPolicy, bool) {
	p := strings.TrimRight(pathname, "/")
	if p == "" {
		p = "/"
	}
	for _, e := range entries {
		if matchPattern(e.pattern, p) {
			return e.policy, true
		}
	}
	return nil, false
}

// --- the guard --------------------------------------------------------------

var (
	csrfFieldRe   = regexp.MustCompile(`<input\b[^>]*\bname="` + csrfFieldName + `"`)
	nonceTagRe    = regexp.MustCompile(`(?i)<(?:script|style)\b[^>]*\snonce="`)
	nonceAttrRe   = regexp.MustCompile(`<[^>]*\snonce="([^"]*)"`)
	cspNonceRe    = regexp.MustCompile(`'nonce-([^']+)'`)
	errUnstorable = errors.New("unstorable")
)

// remintableNonce: the render's own nonce, from the csp header, only if every
// nonce attribute in the body equals it - a page nonced by anything other
// than this render is not ours to re-mint. Safe because the key was minted
// during the render itself: content that wants to smuggle a nonce past the
// swap would have to contain a value that did not exist when it was written.
func remintableNonce(h http.Header, html string) string {
	m := cspNonceRe.FindStringSubmatch(h.Get("Content-Security-Policy"))
	if m == nil {
		return ""
	}
	for _, attr := range nonceAttrRe.FindAllStringSubmatch(html, -1) {
		if attr[1] != m[1] {
			return ""
		}
	}
	return m[1]
}

// unstorable is the storability question, asked of the finished response:
// the reason, or "" when the copy may be shared.
func unstorable(status int, h http.Header, html string) string {
	if status != 200 {
		return "status " + http.StatusText(status)
	}
	// react completes a render whose suspense boundary threw as a 200: the
	// fallback plus its retry script. the render service marks it, because
	// a degraded document one hiccup produced must not become everyone's
	if errored := h.Get(renderErroredHeader); errored != "" {
		return "the render errored (" + errored + ") and completed as its fallback"
	}
	if enc := h.Get("Content-Encoding"); enc != "" {
		return "the body is " + enc + "-coded and cannot be inspected"
	}
	if len(h.Values("Set-Cookie")) > 0 {
		return "the response sets a cookie, and a shared copy would hand it to everyone"
	}
	var residue []string
	if csrfFieldRe.MatchString(html) {
		residue = append(residue, "a <CsrfField /> token")
	}
	if nonceTagRe.MatchString(html) && remintableNonce(h, html) == "" {
		residue = append(residue, "a csp nonce")
	}
	if len(residue) > 0 {
		return "the page carries " + strings.Join(residue, " and ") + " - per-request, like the exporter refuses"
	}
	return ""
}

// transientHeader names what a stored copy must not carry into a replay
var transientHeader = map[string]bool{
	bootHeader: true, "Date": true, "Content-Length": true, "Content-Encoding": true,
	"Transfer-Encoding": true, "Connection": true, "Keep-Alive": true,
}

// --- the cache --------------------------------------------------------------

type cachedPage struct {
	body     []byte
	gz       []byte // absent for nonced pages: those differ per replay
	nonce    string
	status   int
	headers  [][2]string
	storedAt time.Time
	tags     []string
}

type pageCache struct {
	order  *list.List // front = least recently used
	pages  map[string]*list.Element
	byTag  map[string]map[string]bool
	onDrop func(key string)
}

type cacheItem struct {
	key   string
	entry *cachedPage
}

func newPageCache(onDrop func(string)) *pageCache {
	return &pageCache{order: list.New(), pages: map[string]*list.Element{}, byTag: map[string]map[string]bool{}, onDrop: onDrop}
}

func (c *pageCache) get(key string) *cachedPage {
	el := c.pages[key]
	if el == nil {
		return nil
	}
	c.order.MoveToBack(el)
	return el.Value.(*cacheItem).entry
}

func fresh(entry *cachedPage, policy *isrPolicy, now time.Time) bool {
	if policy.manual {
		return true
	}
	return now.Sub(entry.storedAt) < time.Duration(policy.seconds*float64(time.Second))
}

func (c *pageCache) store(key string, entry *cachedPage) {
	if el := c.pages[key]; el != nil {
		c.remove(key, false)
	}
	el := c.order.PushBack(&cacheItem{key: key, entry: entry})
	c.pages[key] = el
	for _, tag := range entry.tags {
		keys := c.byTag[tag]
		if keys == nil {
			keys = map[string]bool{}
			c.byTag[tag] = keys
		}
		keys[key] = true
	}
	for c.order.Len() > maxCachedPages {
		oldest := c.order.Front().Value.(*cacheItem).key
		c.remove(oldest, true)
	}
}

func (c *pageCache) remove(key string, notify bool) {
	el := c.pages[key]
	if el == nil {
		return
	}
	entry := el.Value.(*cacheItem).entry
	c.order.Remove(el)
	delete(c.pages, key)
	for _, tag := range entry.tags {
		if keys := c.byTag[tag]; keys != nil {
			delete(keys, key)
			if len(keys) == 0 {
				delete(c.byTag, tag)
			}
		}
	}
	if notify && c.onDrop != nil {
		c.onDrop(key)
	}
}

func (c *pageCache) invalidatePath(path string) int {
	dropped := 0
	for key := range c.pages {
		if pathMatchesKey(path, key) {
			c.remove(key, true)
			dropped++
		}
	}
	return dropped
}

func (c *pageCache) invalidateTag(tag string) int {
	dropped := 0
	for key := range c.byTag[tag] {
		c.remove(key, true)
		dropped++
	}
	return dropped
}

func (c *pageCache) size() int { return c.order.Len() }

// pathMatchesKey: exact, a query variant, or under a trailing star, in both
// the raw and the decoded spelling - decoding both sides can only drop MORE,
// which is the safe direction for an invalidation.
func pathMatchesKey(path, key string) bool {
	matches := func(p, k string) bool {
		if strings.HasSuffix(p, "/*") {
			base := strings.TrimSuffix(p, "/*")
			if base == "" {
				base = "/"
			}
			return k == base || strings.HasPrefix(k, base+"?") || strings.HasPrefix(k, strings.TrimSuffix(p, "*"))
		}
		if strings.HasSuffix(p, "*") {
			return strings.HasPrefix(k, strings.TrimSuffix(p, "*"))
		}
		return k == p || strings.HasPrefix(k, p+"?")
	}
	decoded := func(s string) string {
		if d, err := url.PathUnescape(s); err == nil {
			return d
		}
		return s
	}
	return matches(path, key) || matches(decoded(path), decoded(key))
}

// --- the orchestrator -------------------------------------------------------

type isrPersist struct {
	dir     string
	buildID string
}

type flightMeta struct {
	doomed bool
	tags   []string
	done   chan struct{}
	result *cachedPage
	err    error
}

type isrRefusal struct {
	at   time.Time
	tags []string
}

// sharedRenderer asks the render service for the copy it may share: the
// request already anonymised, the response fully read.
type sharedRenderer func(r *http.Request) (status int, header http.Header, html string, err error)

type isr struct {
	mu    sync.Mutex
	cache *pageCache
	// bumped under the lock by every store and every drop of a key: a save
	// still in flight when its key moved on writes to temp files and finds
	// the generation gone before the rename, so an invalidated copy cannot
	// come back on the next restart and two saves cannot interleave
	saveGen map[string]uint64
	// one counter for every key, never repeating: a dropped key may leave the
	// map and a save in flight can still never see its own generation again
	lastGen  uint64
	inflight map[string]*flightMeta
	noted    map[string]bool
	notedAge []string
	refused  map[string]isrRefusal
	log      func(string)
	now      func() time.Time
	persist  *isrPersist
	mint     func() string
	render   sharedRenderer
}

func newIsr(render sharedRenderer, persist *isrPersist, logf func(string)) *isr {
	i := &isr{
		saveGen:  map[string]uint64{},
		inflight: map[string]*flightMeta{},
		noted:    map[string]bool{},
		refused:  map[string]isrRefusal{},
		log:      logf,
		now:      time.Now,
		persist:  persist,
		mint:     mintNonce,
		render:   render,
	}
	i.cache = newPageCache(i.removeSaved)
	if persist != nil {
		i.loadSaved()
	}
	return i
}

func mintNonce() string {
	var b [16]byte
	rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// note says a thing once per key, bounded like the cache and against the
// same attacker: the key carries the query string.
func (i *isr) note(key, line string) {
	if i.noted[key] {
		return
	}
	if len(i.notedAge) >= maxCachedPages {
		delete(i.noted, i.notedAge[0])
		i.notedAge = i.notedAge[1:]
	}
	i.noted[key] = true
	i.notedAge = append(i.notedAge, key)
	i.log(line)
}

type isrOutcome int

const (
	isrNotMine isrOutcome = iota
	isrServed
	isrBypass
)

// handle answers from the cache when it can. isrBypass means the page opted
// in but its shared render cannot be shared (a cookie, a csrf field, a
// guard's redirect): the caller forwards the REAL request, tokens minted and
// guards honoured, marked bypass so curl can see why it is never cached.
func (i *isr) handle(w http.ResponseWriter, r *http.Request, policy *isrPolicy) isrOutcome {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return isrNotMine
	}
	// the cleaned path, the spelling the policy was looked up under and the
	// one the render service normalises to: an alias with dot segments must
	// not hold a copy of its own that Revalidate never names
	key := path.Clean(r.URL.Path)
	if r.URL.RawQuery != "" {
		key += "?" + r.URL.RawQuery
	}
	now := i.now()

	i.mu.Lock()
	if ref, ok := i.refused[key]; ok {
		if policy.manual || now.Sub(ref.at) < time.Duration(policy.seconds*float64(time.Second)) {
			i.mu.Unlock()
			return isrBypass
		}
		delete(i.refused, key)
	}
	entry := i.cache.get(key)
	if entry != nil && fresh(entry, policy, now) {
		i.mu.Unlock()
		i.respond(w, r, entry, "hit")
		return isrServed
	}
	if entry != nil {
		// stale is still a page: served now, replaced in the background,
		// one regeneration however wide the burst
		i.regenerate(key, r, policy, true)
		i.mu.Unlock()
		i.respond(w, r, entry, "stale")
		return isrServed
	}
	flight := i.regenerate(key, r, policy, false)
	i.mu.Unlock()
	<-flight.done
	if flight.err != nil || flight.result == nil {
		return isrBypass
	}
	i.respond(w, r, flight.result, "miss")
	return isrServed
}

// regenerate is single-flight per key; called with the lock held. In the
// background (stale) nobody waits for the result; a regeneration that fails
// leaves the last good copy serving, said once.
func (i *isr) regenerate(key string, r *http.Request, policy *isrPolicy, background bool) *flightMeta {
	if running := i.inflight[key]; running != nil {
		return running
	}
	// registered before the render starts: an invalidation arriving while
	// the render is in flight dooms it, or the copy it read from the old
	// data would be stored after the drop and rise again
	meta := &flightMeta{tags: policy.tags, done: make(chan struct{})}
	i.inflight[key] = meta
	anon := anonymised(r)
	go func() {
		defer func() {
			i.mu.Lock()
			delete(i.inflight, key)
			i.mu.Unlock()
			close(meta.done)
		}()
		status, header, html, err := i.render(anon)
		i.mu.Lock()
		defer i.mu.Unlock()
		if err != nil {
			meta.err = err
			if background {
				i.note("regen:"+key, key+": regeneration failed, serving the last good copy ("+err.Error()+")")
			}
			return
		}
		if reason := unstorable(status, header, html); reason != "" {
			i.note("store:"+key, key+": declares revalidate but "+reason+" - served fresh, never cached")
			meta.err = errUnstorable
			// a doomed refusal marks nothing: the data changed under it
			if meta.doomed {
				return
			}
			i.refused[key] = isrRefusal{at: i.now(), tags: policy.tags}
			for len(i.refused) > maxCachedPages {
				for k := range i.refused {
					delete(i.refused, k)
					break
				}
			}
			i.cache.remove(key, true)
			return
		}
		body := []byte(html)
		entry := &cachedPage{
			body:     body,
			nonce:    remintableNonce(header, html),
			status:   status,
			storedAt: i.now(),
			tags:     policy.tags,
		}
		if entry.nonce == "" {
			entry.gz = gzipBytes(body)
		}
		for name, values := range header {
			// the stamp is the proxy's business and never reaches the public;
			// the date and the length belong to each replay, not to the copy
			if transientHeader[name] {
				continue
			}
			for _, v := range values {
				entry.headers = append(entry.headers, [2]string{name, v})
			}
		}
		sort.SliceStable(entry.headers, func(a, b int) bool { return entry.headers[a][0] < entry.headers[b][0] })
		meta.result = entry
		// doomed: served once to this flight's waiters, never stored
		if !meta.doomed {
			i.cache.store(key, entry)
			i.saveEntry(key, entry)
		}
		delete(i.noted, "regen:"+key)
	}()
	return meta
}

// anonymised: the copy is rendered as nobody - no cookies, no
// authorization, plain GET, identity coding - so the shared property holds
// by construction instead of by trust in every loader.
func anonymised(r *http.Request) *http.Request {
	anon := r.Clone(context.Background())
	anon.Method = http.MethodGet
	anon.Body = http.NoBody
	anon.ContentLength = 0
	anon.Header = r.Header.Clone()
	for _, name := range []string{"Cookie", "Authorization", "Accept-Encoding", "Content-Length", "Content-Type"} {
		anon.Header.Del(name)
	}
	return anon
}

func gzipBytes(b []byte) []byte {
	var buf bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&buf, gzip.BestSpeed)
	zw.Write(b)
	zw.Close()
	return buf.Bytes()
}

// respond replays the stored copy: the identity is stored, the coding is
// negotiated per replay, and a nonced page gets a fresh nonce everywhere the
// render put the old one - body and csp header agree.
func (i *isr) respond(w http.ResponseWriter, r *http.Request, entry *cachedPage, state string) {
	h := w.Header()
	for _, kv := range entry.headers {
		h.Add(kv[0], kv[1])
	}
	h.Set(cacheStateHeader, state)
	wantsGzip := pickEncoding(r.Header.Get("Accept-Encoding"), []string{"gzip"}) == "gzip"
	var body []byte
	if entry.nonce != "" {
		fresh := i.mint()
		html := strings.ReplaceAll(string(entry.body), entry.nonce, fresh)
		if csp := h.Get("Content-Security-Policy"); csp != "" {
			h.Set("Content-Security-Policy", strings.ReplaceAll(csp, entry.nonce, fresh))
		}
		if wantsGzip {
			body = gzipBytes([]byte(html))
		} else {
			body = []byte(html)
		}
	} else if entry.gz != nil && wantsGzip {
		body = entry.gz
	} else {
		body = entry.body
	}
	if wantsGzip && (entry.nonce != "" || entry.gz != nil) {
		h.Set("Content-Encoding", "gzip")
	}
	h.Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(entry.status)
	if r.Method != http.MethodHead {
		w.Write(body)
	}
}

func (i *isr) invalidatePath(path string) int {
	i.mu.Lock()
	defer i.mu.Unlock()
	dropped := i.cache.invalidatePath(path)
	// a refusal is state about the data too: the operator saying "this
	// changed" is what lets a page turned personal be tried again
	for key := range i.refused {
		if pathMatchesKey(path, key) {
			delete(i.refused, key)
		}
	}
	for key, meta := range i.inflight {
		if pathMatchesKey(path, key) {
			meta.doomed = true
		}
	}
	i.log("revalidate " + path + ": " + strconv.Itoa(dropped) + " cached " + plural(dropped, "copy", "copies") + " dropped")
	return dropped
}

func (i *isr) invalidateTag(rawTag string) int {
	tag := normalizeTag(rawTag)
	i.mu.Lock()
	defer i.mu.Unlock()
	dropped := i.cache.invalidateTag(tag)
	for key, ref := range i.refused {
		if contains(ref.tags, tag) {
			delete(i.refused, key)
		}
	}
	for _, meta := range i.inflight {
		if contains(meta.tags, tag) {
			meta.doomed = true
		}
	}
	i.log("revalidate tag " + tag + ": " + strconv.Itoa(dropped) + " cached " + plural(dropped, "copy", "copies") + " dropped")
	return dropped
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// --- persistence ------------------------------------------------------------

type savedMeta struct {
	Key      string      `json:"key"`
	Status   int         `json:"status"`
	Headers  [][2]string `json:"headers"`
	StoredAt int64       `json:"storedAt"`
	Tags     []string    `json:"tags"`
	Nonce    string      `json:"nonce,omitempty"`
	BuildID  string      `json:"buildId"`
	// the meta vouches for the body's length: a crash mid-write leaves a
	// valid json beside a truncated html, undetectable by parsing
	Bytes int `json:"bytes"`
}

func (i *isr) fileFor(key string) string {
	sum := sha256.Sum256([]byte(key))
	return filepath.Join(i.persist.dir, hex.EncodeToString(sum[:])[:32])
}

// saveEntry is fire and forget: a disk that stopped taking writes must not
// slow a response down, and the cache keeps working from memory - said once.
func (i *isr) saveEntry(key string, entry *cachedPage) {
	if i.persist == nil {
		return
	}
	// called under the lock by regenerate
	i.lastGen++
	gen := i.lastGen
	i.saveGen[key] = gen
	base := i.fileFor(key)
	meta := savedMeta{Key: key, Status: entry.status, Headers: append([][2]string{}, entry.headers...), StoredAt: entry.storedAt.UnixMilli(), Tags: append([]string{}, entry.tags...), Nonce: entry.nonce, BuildID: i.persist.buildID, Bytes: len(entry.body)}
	body := entry.body
	go func() {
		// unique temp names per save: two saves of one key ms apart must not
		// share a scratch file either
		tmp := fmt.Sprintf("%s.%d.tmp", base, gen)
		raw, err := json.Marshal(meta)
		if err == nil {
			err = os.MkdirAll(i.persist.dir, 0o755)
		}
		if err == nil {
			err = os.WriteFile(tmp+".html", body, 0o644)
		}
		if err == nil {
			err = os.WriteFile(tmp+".json", raw, 0o644)
		}
		if err == nil {
			// the pair lands only if the key is still on this generation: an
			// invalidation or a newer store in between wins, and the temp
			// files go instead of the pair
			i.mu.Lock()
			current := i.saveGen[key] == gen
			if current {
				err = os.Rename(tmp+".html", base+".html")
				if err == nil {
					err = os.Rename(tmp+".json", base+".json")
				}
			}
			i.mu.Unlock()
			if !current {
				os.Remove(tmp + ".html")
				os.Remove(tmp + ".json")
				return
			}
		}
		if err != nil {
			os.Remove(tmp + ".html")
			os.Remove(tmp + ".json")
			i.mu.Lock()
			i.note("persist", "isr cache not persisted ("+err.Error()+") - serving from memory only")
			i.mu.Unlock()
		}
	}()
}

// removeSaved runs under the lock, from the cache's drop: the key's
// generation is gone, so a save in flight finds none and lands nowhere
func (i *isr) removeSaved(key string) {
	if i.persist == nil {
		return
	}
	delete(i.saveGen, key)
	base := i.fileFor(key)
	os.Remove(base + ".html")
	os.Remove(base + ".json")
}

// loadSaved restores what the last run of this build wrote: wrong build,
// malformed shape or torn html sweeps the pair; an html without its json
// twin is swept too; entries return oldest first so the lru order matches.
func (i *isr) loadSaved() {
	names, err := os.ReadDir(i.persist.dir)
	if err != nil {
		return
	}
	type loaded struct {
		key   string
		entry *cachedPage
	}
	var found []loaded
	jsonBases := map[string]bool{}
	for _, d := range names {
		name := d.Name()
		if strings.HasSuffix(name, ".tmp.json") || strings.HasSuffix(name, ".tmp.html") {
			// a save that never landed: swept with the orphans below
			os.Remove(filepath.Join(i.persist.dir, name))
			continue
		}
		if !strings.HasSuffix(name, ".json") {
			continue
		}
		base := filepath.Join(i.persist.dir, strings.TrimSuffix(name, ".json"))
		jsonBases[strings.TrimSuffix(name, ".json")] = true
		entry, key, ok := i.readSaved(base)
		if !ok {
			os.Remove(base + ".json")
			os.Remove(base + ".html")
			continue
		}
		found = append(found, loaded{key, entry})
	}
	for _, d := range names {
		name := d.Name()
		if strings.HasSuffix(name, ".html") && !jsonBases[strings.TrimSuffix(name, ".html")] {
			os.Remove(filepath.Join(i.persist.dir, name))
		}
	}
	sort.Slice(found, func(a, b int) bool { return found[a].entry.storedAt.Before(found[b].entry.storedAt) })
	for _, f := range found {
		i.cache.store(f.key, f.entry)
	}
}

func (i *isr) readSaved(base string) (*cachedPage, string, bool) {
	raw, err := os.ReadFile(base + ".json")
	if err != nil {
		return nil, "", false
	}
	var meta savedMeta
	if json.Unmarshal(raw, &meta) != nil || meta.BuildID != i.persist.buildID || meta.Key == "" || meta.Tags == nil || meta.Headers == nil || meta.Status == 0 {
		return nil, "", false
	}
	body, err := os.ReadFile(base + ".html")
	if err != nil || len(body) != meta.Bytes {
		return nil, "", false
	}
	entry := &cachedPage{body: body, nonce: meta.Nonce, status: meta.Status, headers: meta.Headers, storedAt: time.UnixMilli(meta.StoredAt), tags: meta.Tags}
	if entry.nonce == "" {
		entry.gz = gzipBytes(body)
	}
	return entry, meta.Key, true
}

// buildIDFromInventory keys the persisted copies to the build that rendered
// them, the same way hashed asset names are: a new build writes new names,
// and every copy the old one rendered is swept at boot.
func buildIDFromInventory(outputs buildOutputs) string {
	names := make([]string, 0, len(outputs.sizes))
	for name := range outputs.sizes {
		names = append(names, name)
	}
	sort.Strings(names)
	h := sha256.New()
	for _, name := range names {
		io.WriteString(h, name)
		io.WriteString(h, "=")
		io.WriteString(h, strconv.FormatInt(outputs.sizes[name], 10))
		io.WriteString(h, ";")
	}
	return hex.EncodeToString(h.Sum(nil))[:16]
}

// --- the process-wide instance, for Revalidate and RevalidateTag ------------

var (
	frontIsrMu sync.RWMutex
	frontIsr   *isr
)

func setFrontIsr(i *isr) {
	frontIsrMu.Lock()
	frontIsr = i
	frontIsrMu.Unlock()
}

func localIsr() *isr {
	frontIsrMu.RLock()
	defer frontIsrMu.RUnlock()
	return frontIsr
}
