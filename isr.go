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
	maxCachedPages  = 512
	defaultCacheDir = ".borgo/cache/html"
	csrfFieldName   = "__borgo_csrf"
	cacheDirEnv     = "BORGO_CACHE_DIR"
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
	// the render telling us the copy is not universal. Accept-Encoding is the
	// one axis this cache negotiates itself, per replay, so it is not a
	// refusal; anything else - a language, a client hint, an api version -
	// names a header this copy depended on and the next visitor may not send
	if vary := varyBeyondEncoding(h); vary != "" {
		return "the response varies on " + vary + ", which a shared copy cannot honour"
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

// varyBeyondEncoding names the first axis a response declares that this
// cache cannot negotiate itself, or "" when it declares none. Read as one
// folded list across repeated field lines, case-insensitively, like every
// other header grammar here: a cache is allowed to be pedantic and a
// framework has to be. "*" means "never shared" and is named as itself.
func varyBeyondEncoding(h http.Header) string {
	for _, line := range h.Values("Vary") {
		for _, field := range strings.Split(line, ",") {
			field = strings.TrimSpace(field)
			if field == "" || strings.EqualFold(field, "Accept-Encoding") {
				continue
			}
			return field
		}
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
// keyHostSep separates the host from the path inside a key. A NUL can
// reach neither half - net/http refuses it in a header value and a url
// cannot carry it - so no host and no query can spell a separator and
// collide with another site's copy.
const keyHostSep = "\x00"

// cacheKey is the identity of a shared copy: scheme, host, path, query.
func cacheKey(r *http.Request) string {
	// the scheme too: a page that builds its public url from it rendered once
	// for http and was served to https visitors (found by hunt 3)
	scheme := requestScheme(r)
	// the path as written, in its one spelling: decoded, an escaped "?" would
	// read as the start of the query and share a key with it
	key := scheme + "://" + cacheHost(r.Host, scheme) + keyHostSep + canonicalPath(r.URL.EscapedPath())
	if r.URL.RawQuery != "" {
		key += "?" + r.URL.RawQuery
	}
	return key
}

// cacheHost is one spelling per host: case folded (dns is), the scheme's
// own default port dropped (a browser omits it, a proxy may not - and only
// that one: :80 on https is another origin, found by hunt 3), and the
// separator and path characters removed rather than trusted - a Host is a
// client's string, and an absolute-form request target can put anything in
// it.
func cacheHost(host, scheme string) string {
	host = strings.ToLower(host)
	if scheme == "https" {
		host = strings.TrimSuffix(host, ":443")
	} else {
		host = strings.TrimSuffix(host, ":80")
	}
	return strings.Map(func(r rune) rune {
		if r == 0 || r == '/' || r == '?' || r == '#' {
			return -1
		}
		return r
	}, host)
}

// keyPath is the path half of a key: what Revalidate names, and what a log
// line should show.
func keyPath(key string) string {
	if _, p, ok := strings.Cut(key, keyHostSep); ok {
		return p
	}
	return key
}

// keyLabel renders a key for a human: "https://app.example/news?page=2".
func keyLabel(key string) string {
	if host, p, ok := strings.Cut(key, keyHostSep); ok {
		return host + p
	}
	return key
}

// revalidatePath is a Revalidate argument in the spelling keys are stored
// in: "/news/" and "/x/../news" dropped nothing, while the copy they named
// kept serving (found by hunt 3). A trailing * or /* is the call's own
// grammar and stays
func revalidatePath(p string) string {
	switch {
	case strings.HasSuffix(p, "/*"):
		base := canonicalPath(strings.TrimSuffix(p, "/*"))
		if base == "/" {
			return "/*"
		}
		return base + "/*"
	case strings.HasSuffix(p, "*"):
		return canonicalPath(strings.TrimSuffix(p, "*")) + "*"
	}
	return canonicalPath(p)
}

// pathMatchesKey answers whether a Revalidate path names this key. The host
// is not part of the question: the operator is saying the data changed, and
// the data is not one vhost's.
func pathMatchesKey(path, key string) bool {
	key = keyPath(key)
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
	// how a saved file is read at boot; nil is os.ReadFile. A test stands in
	// a disk that answers an error which is not "absent"
	readFile func(string) ([]byte, error)
}

// what a boot does with one saved pair
type savedVerdict int

const (
	savedLoad savedVerdict = iota
	// another build's, malformed, torn, or missing a half: never servable
	savedSweep
	// could not be read at this moment - a file held open by another process,
	// a scanner opening what was just renamed: left for the next boot
	savedUnreadable
)

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
	// set when the refusal is about the render service rather than about the
	// page: a transport failure or a deadline, which says nothing about
	// whether the page is shareable. It expires on its own clock, short, and
	// it expires even under "manual" - a page is not condemned forever
	// because the render service was restarting
	cool time.Duration
}

// renderFailureCool is how long a page is left alone after its shared
// render failed to arrive at all. Long enough that a restarting render
// service is not re-asked by every request, short enough that the page is
// cacheable again a moment after it comes back.
const renderFailureCool = 5 * time.Second

// trimRefused keeps the refusal memory bounded like the cache, dropping the
// OLDEST rather than whatever range hands over first - map order could evict
// the refusal recorded one line earlier, and the page would then be
// re-rendered and re-refused on the next request instead of bypassing (found
// by the verifier of this phase). Called with the lock held.
func (i *isr) trimRefused() {
	for len(i.refused) > maxCachedPages {
		oldest, at := "", time.Time{}
		for k, ref := range i.refused {
			if at.IsZero() || ref.at.Before(at) {
				oldest, at = k, ref.at
			}
		}
		delete(i.refused, oldest)
	}
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
	// queued under the lock, done after it: file removals and log lines.
	// Both used to happen inline, where a slow disk or a stalled stderr
	// held the mutex every page request takes
	sweep   []string
	pending []string
	log     func(string)
	now     func() time.Time
	persist *isrPersist
	mint    func() string
	render  sharedRenderer
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
	i.cache = newPageCache(i.forgetSaved)
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
// same attacker: the key carries the query string. Called with i.mu held, so
// it only QUEUES the line - writing it here meant that a stderr which
// stopped draining (a blocking container log driver, a supervisor that piped
// and stopped reading) held the mutex every page request takes, and the
// whole page surface stopped with it (found by the verifier of this phase).
// drain() writes it after the unlock.
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
	i.pending = append(i.pending, line)
}

// forget drops a key's memo from both halves of the record: the map AND the
// ring. Leaving the key in the ring let the ring fill with entries the map
// no longer had, which shrinks the real dedup window and can evict a
// different live key's memo early, re-saying a line meant to be said once
// (found by the verifier of this phase). Called with the lock held.
func (i *isr) forget(key string) {
	if !i.noted[key] {
		return
	}
	delete(i.noted, key)
	for at, k := range i.notedAge {
		if k == key {
			i.notedAge = append(i.notedAge[:at], i.notedAge[at+1:]...)
			break
		}
	}
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
	// the host, then the cleaned path: the spelling the policy was looked up
	// under and the one the render service normalises to, so an alias with dot
	// segments cannot hold a copy of its own that Revalidate never names.
	//
	// The host is in the key because it is in the answer. The render service
	// receives the host the browser stated - it builds absolute urls from it,
	// and a loader may put it in a canonical link, an og:url or a mail link -
	// so a copy stored without it is a copy of somebody else's site. One
	// request carrying Host: evil.example stored the render that every later
	// visitor of the real host was then served (found by the verifier of this
	// phase; the bun cache this replaced keyed on the host and the port of
	// that property was what dropped it).
	key := cacheKey(r)
	now := i.now()

	i.mu.Lock()
	if ref, ok := i.refused[key]; ok {
		held := policy.manual || now.Sub(ref.at) < time.Duration(policy.seconds*float64(time.Second))
		if ref.cool > 0 {
			// the render service's failure, not the page's: its own short
			// clock, and it runs out under "manual" too
			held = now.Sub(ref.at) < ref.cool
		}
		if held {
			i.mu.Unlock()
			return isrBypass
		}
		delete(i.refused, key)
	}
	// nothing under this lock writes a file or a line: the eviction that
	// does happens in regenerate's goroutine, which drains itself
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
	// joined only while it may still answer for the data as it is now. A
	// doomed flight read the data BEFORE the invalidation that doomed it, so
	// a request arriving after Revalidate returned must not be handed it:
	// that request would be answered from data the operator already said was
	// gone, with the invalidation reporting success (found by the verifier of
	// this phase). The flight's own waiters are a different case and keep it -
	// their request was already in flight when the drop landed.
	if running := i.inflight[key]; running != nil && !running.doomed {
		return running
	}
	// registered before the render starts: an invalidation arriving while
	// the render is in flight dooms it, or the copy it read from the old
	// data would be stored after the drop and rise again
	meta := &flightMeta{tags: policy.tags, done: make(chan struct{})}
	i.inflight[key] = meta
	anon := anonymised(r)
	go func() {
		// registered first so it runs LAST: after the unlock, and after the
		// defer below closes done. It writes files and log lines, and doing
		// that under the mutex stopped every page request; doing it before
		// done closes would hold this flight's waiters behind a stalled
		// stderr instead, which is the same stall one layer in
		defer i.drain()
		defer func() {
			i.mu.Lock()
			// only if this flight is still the registered one: a doomed
			// flight is replaced by a fresh one while it runs, and deleting
			// the key blindly would unregister its successor and let a
			// third request start a second concurrent render of it
			if i.inflight[key] == meta {
				delete(i.inflight, key)
			}
			i.mu.Unlock()
			close(meta.done)
		}()
		// net/http gives every request goroutine a recover; this one does
		// work on behalf of a request and had opted out of that, so a panic
		// in a render - or in anything it calls - took the whole front down,
		// api included, with every request in flight and the api the 503
		// page promises is still up (found by the verifier of this phase).
		// The flight fails instead and its waiters bypass to their own
		// render. Registered after the cleanup above, so it runs before it:
		// the error has to be written while done is still open, or a waiter
		// reads a field this is writing
		defer func() {
			if p := recover(); p != nil {
				i.mu.Lock()
				meta.err = fmt.Errorf("the render panicked: %v", p)
				i.mu.Unlock()
				i.log(keyLabel(key) + ": the render panicked and was contained (" + fmt.Sprint(p) + ")")
			}
		}()
		status, header, html, err := i.render(anon)
		i.mu.Lock()
		defer i.mu.Unlock()
		if err != nil {
			meta.err = err
			if background {
				i.note("regen:"+key, keyLabel(key)+": regeneration failed, serving the last good copy ("+err.Error()+")")
				return
			}
			// a cold page whose shared render failed: without a memory of it
			// every single request paid for a shared render that failed the
			// same way and then for its own render through the bypass, twice
			// the work per visitor for as long as the failure lasted (found
			// by the verifier of this phase, measuring a render that stalled
			// past the deadline). Short, and not the policy's window: this
			// says the render service is unwell, not that the page is
			// unshareable, so it must clear itself
			if !meta.doomed {
				i.refused[key] = isrRefusal{at: i.now(), tags: policy.tags, cool: renderFailureCool}
				i.trimRefused()
			}
			return
		}
		if reason := unstorable(status, header, html); reason != "" {
			i.note("store:"+key, keyLabel(key)+": declares revalidate but "+reason+" - served fresh, never cached")
			meta.err = errUnstorable
			// a doomed refusal marks nothing: the data changed under it
			if meta.doomed {
				return
			}
			i.refused[key] = isrRefusal{at: i.now(), tags: policy.tags}
			i.trimRefused()
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
		i.forget("regen:" + key)
	}()
	return meta
}

// anonymised: the copy is rendered as nobody - no cookies, no
// authorization, no session fact, plain GET, identity coding, and none of
// the negotiation a render could personalise on - so the shared property
// holds by construction instead of by trust in every loader.
const anonHeaderLimit = 1024

func anonymised(r *http.Request) *http.Request {
	anon := r.Clone(context.Background())
	anon.Method = http.MethodGet
	anon.Body = http.NoBody
	anon.ContentLength = 0
	// what reaches a shared render is chosen, not what is left after a
	// list of exclusions: every header a client sent rode along, so one of
	// 16 kB made the render service answer 431, recorded as the page's own
	// refusal - one request turned the cache off (found by hunt 3) - and
	// any header a loader read was baked into everybody's copy. Gone with
	// the rest: cookies, authorization, the session and locals the front
	// states about somebody, the peer and every proxy's spelling of the
	// visitor's address, and the negotiation a render could personalise on.
	// What stays: Accept and User-Agent - a render that cannot see the
	// agent at all is a different render - and the two forwarded facts
	// forwardFacts reads from a trusted proxy: the scheme the page's public
	// url needs, and the chain it deletes again for a shared render. Each
	// only at a size no render service refuses
	anon.Header = http.Header{}
	for _, name := range []string{"Accept", "User-Agent", "X-Forwarded-Proto", "X-Forwarded-For"} {
		if v := r.Header.Values(name); len(v) > 0 && len(strings.Join(v, ", ")) <= anonHeaderLimit {
			anon.Header[name] = append([]string(nil), v...)
		}
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
	// this writer negotiates, so it says so itself. A replay with a gzip
	// representation carried only whatever Vary the render had stored, and
	// survived only because the render service puts one on every page and
	// unstorable forbids any other: any page path that answered without it
	// shipped a gzip body a shared cache would hand to a client that cannot
	// read it (found by the verifier of phase 1). The same guard gzip.go and
	// static.go apply, for the same reason. Set whether or not THIS client
	// took the gzip, because the response varies by what it asked
	if entry.nonce != "" || entry.gz != nil {
		varyAcceptEncoding(h)
	}
	h.Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(entry.status)
	if r.Method != http.MethodHead {
		w.Write(body)
	}
}

func (i *isr) invalidatePath(path string) int {
	path = revalidatePath(path)
	i.mu.Lock()
	defer i.drain()
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
	i.pending = append(i.pending, "revalidate "+path+": "+strconv.Itoa(dropped)+" cached "+plural(dropped, "copy", "copies")+" dropped")
	return dropped
}

func (i *isr) invalidateTag(rawTag string) int {
	tag := normalizeTag(rawTag)
	i.mu.Lock()
	defer i.drain()
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
	i.pending = append(i.pending, "revalidate tag "+tag+": "+strconv.Itoa(dropped)+" cached "+plural(dropped, "copy", "copies")+" dropped")
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
	// and for its content. The pair is written as two renames, so a crash
	// between them leaves one file from this save beside one from the last;
	// equal lengths pass the check above and load a body with the wrong
	// meta - wrong headers, wrong storedAt and, worst, the wrong Nonce, so
	// every replay substitutes a nonce that is not in the body and the
	// browser refuses every script on the page until the entry ages out
	// (found by the verifier of this phase). A digit that changed, or a
	// timestamp of equal width, is enough to reach it
	Sum string `json:"sum"`
}

// bodySum is what the meta vouches with: a short content hash, not a
// cryptographic commitment - the attacker it defends against is a crash
func bodySum(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])[:16]
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
	meta := savedMeta{Key: key, Status: entry.status, Headers: append([][2]string{}, entry.headers...), StoredAt: entry.storedAt.UnixMilli(), Tags: append([]string{}, entry.tags...), Nonce: entry.nonce, BuildID: i.persist.buildID, Bytes: len(entry.body), Sum: bodySum(entry.body)}
	body := entry.body
	go func() {
		// unique temp names per save: two saves of one key ms apart must not
		// share a scratch file either
		// the generation makes it unique inside this process; the random suffix
		// makes it unique across processes. Two boots over one BORGO_CACHE_DIR -
		// a blue/green deploy on a shared volume, two replicas on one mount, a
		// restart overlapping the old process - both wrote <key>.1.tmp for their
		// first save of a page, so one could interleave its body with the
		// other's meta (found by the verifier of this phase, who read it and
		// could not reproduce it; narrow is not the same as closed)
		tmp := fmt.Sprintf("%s.%d.%s.tmp", base, gen, mintNonce()[:8])
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
			// this goroutine is the last one holding that line: nobody else
			// will unlock after it
			i.drain()
		}
	}()
}

// forgetSaved is the cache's eviction hook, and it does no io: it is called
// with i.mu held, from a page request's own eviction and from
// Revalidate/RevalidateTag, and two file removals per dropped key meant that
// RevalidateTag on a tag held by 400 pages performed 800 synchronous
// deletions while every page request blocked on the same mutex (found by the
// verifier of this phase). The keys are queued and swept after the unlock.
func (i *isr) forgetSaved(key string) {
	if i.persist == nil {
		return
	}
	delete(i.saveGen, key)
	i.sweep = append(i.sweep, key)
}

// drain does the work that was queued while the lock was held: the file
// removals and the log lines. Called after every unlock that may have
// queued something, never with the lock held.
func (i *isr) drain() {
	i.mu.Lock()
	sweep, lines := i.sweep, i.pending
	i.sweep, i.pending = nil, nil
	i.mu.Unlock()
	for _, key := range sweep {
		base := i.fileFor(key)
		os.Remove(base + ".html")
		os.Remove(base + ".json")
	}
	for _, line := range lines {
		i.log(line)
	}
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
	unreadable := 0
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
		entry, key, verdict := i.readSaved(base)
		switch verdict {
		case savedSweep:
			os.Remove(base + ".json")
			os.Remove(base + ".html")
			continue
		case savedUnreadable:
			unreadable++
			continue
		}
		found = append(found, loaded{key, entry})
	}
	// said, because a boot that serves cold for no visible reason is the thing
	// an operator would otherwise chase
	if unreadable > 0 {
		i.log(fmt.Sprintf("cache: %d saved %s could not be read at boot and %s left on disk; served fresh until a boot reads them",
			unreadable, plural(unreadable, "page", "pages"), plural(unreadable, "was", "were")))
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

// readSaved told a read error apart from nothing: every one swept the pair, so
// a file another process held open at the moment of a boot threw a warm copy
// away as if it were torn
func (i *isr) readSaved(base string) (*cachedPage, string, savedVerdict) {
	read := i.persist.readFile
	if read == nil {
		read = os.ReadFile
	}
	raw, err := read(base + ".json")
	if err != nil {
		return nil, "", readVerdict(err)
	}
	var meta savedMeta
	if json.Unmarshal(raw, &meta) != nil || meta.BuildID != i.persist.buildID || meta.Key == "" || meta.Tags == nil || meta.Headers == nil || meta.Status == 0 {
		return nil, "", savedSweep
	}
	body, err := read(base + ".html")
	if err != nil {
		return nil, "", readVerdict(err)
	}
	if len(body) != meta.Bytes || meta.Sum == "" || bodySum(body) != meta.Sum {
		return nil, "", savedSweep
	}
	entry := &cachedPage{body: body, nonce: meta.Nonce, status: meta.Status, headers: meta.Headers, storedAt: time.UnixMilli(meta.StoredAt), tags: meta.Tags}
	if entry.nonce == "" {
		entry.gz = gzipBytes(body)
	}
	return entry, meta.Key, savedLoad
}

// a half that is gone makes a pair that will never be whole again; any other
// read error says something about this moment, not about the pair
func readVerdict(err error) savedVerdict {
	if os.IsNotExist(err) {
		return savedSweep
	}
	return savedUnreadable
}

// buildIDFromInventory keys the persisted copies to the build that rendered
// them: every borgo build records its own id, and every copy an older one
// rendered is swept at boot. The hashed names alone were the key, and a
// build that changed only a loader - stripped from every client chunk -
// kept serving the old build's pages (found by hunt 3).
func buildIDFromInventory(outputs buildOutputs) string {
	names := make([]string, 0, len(outputs.sizes))
	for name := range outputs.sizes {
		names = append(names, name)
	}
	sort.Strings(names)
	h := sha256.New()
	io.WriteString(h, outputs.build)
	io.WriteString(h, ";")
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
