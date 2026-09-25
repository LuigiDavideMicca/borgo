package borgo

// Who may hold a topic, and who may publish to one. Before 0.30 a websocket
// topic authorized nothing: a client with no cookie read a private channel
// by guessing its name, "__count" included (piazza's P0). The relay asks
// these on every handshake and every publish, with the request the socket
// came in on, so a check reads the session with GetSession as a handler
// would - the front verified it, and the answer is shared across the request.

import (
	"log"
	"net/http"
	"runtime/debug"
	"sync"
	"sync/atomic"
)

// TopicCheck decides for one topic on one request. It runs once per topic on
// a handshake, before the socket is upgraded, and once per message a browser
// publishes; a page's own subscribe callback never sees a topic it refused.
type TopicCheck func(r *http.Request, topic string) bool

// written only under routesMu, before Serve latches the registry; read on
// every handshake and every publish, lock-free
var (
	subscribeCheck atomic.Pointer[TopicCheck]
	publishCheck   atomic.Pointer[TopicCheck]
)

// CanSubscribe registers the check every topic a socket asks for must pass.
// A refused topic closes the socket with 4403 and a reason naming the topic,
// which the browser's subscribe treats as final; "__count" is a subscription
// like any other, so a refused topic's count is never seen either.
//
// A socket is judged once, at its handshake, and keeps its topics until it
// ends: a session revoked or expired afterwards is refused at its next
// handshake, not cut mid-socket. The request's context lives as long as the
// socket, and ends with it or with the server's shutdown, so a check that
// waits on it is let go then.
//
// Without a check, borgo dev leaves every topic open and says so at startup;
// borgo start refuses every subscription, and says so too: a production
// relay with no rule is a relay with the wrong rule.
func CanSubscribe(check TopicCheck) {
	registerTopicCheck("CanSubscribe", &subscribeCheck, check)
}

// CanPublish registers the check a browser's publish must pass, for the
// topic it names. Without one, publishing follows CanSubscribe: a socket may
// publish to what it may hold. A refused message is dropped - the socket
// stays open, and the refusal is logged once per socket, so a page that
// publishes where it may only read does not flood the log.
//
// The session it reads is the one the handshake read: one check of the
// cookie per socket, not one per message, so a store behind CheckSession is
// asked once. Revocation takes effect at the next handshake.
func CanPublish(check TopicCheck) {
	registerTopicCheck("CanPublish", &publishCheck, check)
}

func registerTopicCheck(name string, slot *atomic.Pointer[TopicCheck], check TopicCheck) {
	if check == nil {
		panic("borgo." + name + ": nil check")
	}
	routesMu.Lock()
	defer routesMu.Unlock()
	if served {
		panic("borgo." + name + ": registered after borgo.Serve: the server is already mounted, so this check would never run; register it in init() or before calling Serve")
	}
	if !slot.CompareAndSwap(nil, &check) {
		panic("borgo." + name + ": a check is already registered; compose the conditions inside one")
	}
}

// wsTopicPolicy is what the relay consults: the checks as registered, and
// whether this is a dev run, decided once at startup.
type wsTopicPolicy struct {
	dev bool
}

// subscribeRefusal is why a socket may not hold the topic, or "". The
// verdict comes first: the reason reaches the page cut to a close frame's
// 123 bytes, and the topic is the page's own string
func (p wsTopicPolicy) subscribeRefusal(r *http.Request, topic string) string {
	check := subscribeCheck.Load()
	if check == nil {
		if p.dev {
			return ""
		}
		// a shorter sentence and a shorter topic: the close frame carries 123
		// bytes, and the verdict has to fit with room for the "..."
		return "refused: no borgo.CanSubscribe registered, production admits nothing - topic " + shownTopic(topic, 10)
	}
	if !runTopicCheck("CanSubscribe", *check, r, topic, nil) {
		return "refused by borgo.CanSubscribe: topic " + shownTopic(topic, 40)
	}
	return ""
}

// shownTopic is the topic as a refusal names it: cut to units of utf-16, as
// the client counts, with "..." when cut
func shownTopic(topic string, units int) string {
	shown := utf16Prefix(topic, units)
	if shown != topic {
		return jsQuote(shown) + "..."
	}
	return jsQuote(topic)
}

// publishAllowed decides a browser's publish to a topic its socket holds:
// the topic passed CanSubscribe at the handshake, and CanPublish, if any,
// decides again now. said is the socket's "already logged" flag
func (p wsTopicPolicy) publishAllowed(r *http.Request, topic string, said *atomic.Bool) bool {
	check := publishCheck.Load()
	if check == nil {
		return true
	}
	return runTopicCheck("CanPublish", *check, r, topic, said)
}

// the stack of a panicking check, once per process and per check: the store
// behind a check being down is the likeliest way to hit it, and every
// message of every socket would then carry two kilobytes of it
var topicCheckStackOnce sync.Map // check name -> *sync.Once

// a check that panics is a check that did not say yes: failing open would
// hand a private topic to whoever hits the panic. Said once per socket when
// the caller has a flag for it, and once per handshake otherwise
func runTopicCheck(name string, check TopicCheck, r *http.Request, topic string, said *atomic.Bool) (ok bool) {
	defer func() {
		if p := recover(); p != nil {
			ok = false
			// the socket's one line may have been an ordinary refusal: the
			// process's first panic of this check is said regardless
			first := said == nil || said.CompareAndSwap(false, true)
			stack := ""
			once, _ := topicCheckStackOnce.LoadOrStore(name, &sync.Once{})
			once.(*sync.Once).Do(func() {
				stack = " (the stack, once per process)\n" + string(debug.Stack())
				first = true
			})
			if !first {
				return
			}
			log.Printf("borgo: %s panicked on %s for topic %s: %v - refused%s", name, r.URL.Path, shownTopic(topic, 40), p, stack)
		}
	}()
	// the request as it came: a session read inside goes through CheckSession
	// as a handler's would, so a revoked session holds no topic. Nothing here
	// marks the request as "inside a session check" - that would answer the
	// read with the envelope alone and skip the revocation
	return check(r, topic)
}

// wsPolicyNotice is the line startup prints about the relay's rule, or ""
// when a check is registered and there is nothing to say.
func wsPolicyNotice(dev bool) string {
	if subscribeCheck.Load() != nil {
		return ""
	}
	if dev {
		return "realtime: BORGO_DEV=1 and no borgo.CanSubscribe registered - every topic is open to every socket; unset BORGO_DEV in production, where a relay with no check refuses every subscription"
	}
	return "realtime: no borgo.CanSubscribe registered - every subscription is refused (4403); register one in api/ to open topics"
}
