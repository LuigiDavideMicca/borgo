package borgo

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"runtime/debug"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// SessionInfo is what a CheckSession check sees of a session whose signature
// and expiry have already verified.
type SessionInfo struct {
	// IssuedAt is when SetSession wrote the session, to the millisecond. A
	// session written before borgo recorded it reads as the Unix epoch, so
	// any cutoff revokes it.
	IssuedAt time.Time
	// Data is the JSON the app stored. The reads after the check share it:
	// decode it, do not modify it.
	Data json.RawMessage
}

type sessionCheckFunc func(*http.Request, SessionInfo) bool

// sessionCheck is read on every session read, so it is lock-free; it is
// written only under routesMu, before Serve latches the registry.
var sessionCheck atomic.Pointer[sessionCheckFunc]

// CheckSession registers the check Go runs on every session that verified,
// before anything reads it: GetSession, the Auth guard, and the session the
// front hands the render service. A false answer makes the request one
// without a session - so does a panic, which is logged. The cookie is not
// rewritten: revocation is decided when a session is read.
//
// Under Serve the check runs at most once per request, however many reads
// the request makes. Without a check nothing changes and nothing is paid.
// The cheapest check needs no session store: a cutoff per user, "everything
// issued before T", compared against IssuedAt.
func CheckSession(check func(r *http.Request, s SessionInfo) bool) {
	if check == nil {
		panic("borgo.CheckSession: nil check")
	}
	routesMu.Lock()
	defer routesMu.Unlock()
	if served {
		panic("borgo.CheckSession: registered after borgo.Serve: the server is already mounted, so this check would never run; register it in init() or before calling Serve")
	}
	f := sessionCheckFunc(check)
	if !sessionCheck.CompareAndSwap(nil, &f) {
		panic("borgo.CheckSession: a check is already registered; compose the conditions inside one")
	}
}

// A check that panics is a check that did not say yes: failing open would
// hand a revoked session back the moment the store behind the check is down.
func runSessionCheck(check sessionCheckFunc, r *http.Request, info SessionInfo) (ok bool) {
	defer func() {
		if p := recover(); p != nil {
			log.Printf("borgo: CheckSession panicked on %s %s: %v - the request proceeds without a session\n%s", r.Method, r.URL.Path, p, debug.Stack())
			ok = false
		}
	}()
	// a check that reads the session it is judging would recurse into itself,
	// or deadlock on the request's shared answer: inside, a read is answered
	// with the verified session, unchecked - it is the check's own input
	return check(r.WithContext(context.WithValue(r.Context(), inSessionCheckKey{}, true)), info)
}

type inSessionCheckKey struct{}

func checkedSession(r *http.Request, check sessionCheckFunc) (json.RawMessage, bool) {
	envelope, ok := verifiedEnvelope(r)
	if !ok || !runSessionCheck(check, r, SessionInfo{IssuedAt: time.UnixMilli(envelope.Iat), Data: envelope.Data}) {
		return nil, false
	}
	return envelope.Data, true
}

type sessionOnceKey struct{}

// sessionOnce is one request's answer. It is keyed on the Cookie header it
// was computed from: a handler that swaps the cookie mid-request reads the
// new one, not an answer about the old.
type sessionOnce struct {
	mu      sync.Mutex
	done    bool
	cookies string
	data    json.RawMessage
	ok      bool
}

func (o *sessionOnce) read(r *http.Request, check sessionCheckFunc) (json.RawMessage, bool) {
	cookies := strings.Join(r.Header.Values("Cookie"), "\n")
	o.mu.Lock()
	defer o.mu.Unlock()
	if !o.done {
		o.data, o.ok = checkedSession(r, check)
		o.cookies, o.done = cookies, true
		return o.data, o.ok
	}
	if o.cookies == cookies {
		return o.data, o.ok
	}
	return checkedSession(r, check)
}

// withSessionOnce gives every request through a door its own answer to share:
// the app's middleware, the handler and the front's hand-off to the render
// service each read the session, and a check that queries a store would
// otherwise query it once per read. Built after the registry latched, so no
// check means no wrapper at all.
func withSessionOnce(next http.Handler) http.Handler {
	if sessionCheck.Load() == nil {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), sessionOnceKey{}, &sessionOnce{})))
	})
}
