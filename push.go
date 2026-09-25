package borgo

import (
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
)

// the relay of this process: built by Serve for the public port, or by
// Realtime for an embedder, and read by every Push
var processRelay atomic.Pointer[wsRelay]

// Push publishes an event to every browser subscribed to a websocket topic
// (see the subscribe helper in the borgo npm package). The relay lives in
// this process since 0.30: a push is a call, not a request, and there is no
// front server to reach, no key to share, and no network for the key to
// cross. An event no subscriber can ever receive is an error - a topic no
// handshake could name, or an event over the largest message a socket may
// carry - and an event on a topic nobody holds right now is delivered to
// nobody, and is not.
//
// Called with literal topic and event strings, borgogen records T in the
// generated event map and the browser's subscribe callback for that topic is
// typed with it. A dynamic topic or event name stays out of the map: the push
// still happens, the browser side stays untyped.
func Push[T any](topic, event string, data T) error {
	relay := processRelay.Load()
	if relay == nil {
		return fmt.Errorf("borgo.Push: no relay in this process: borgo.Serve mounts one at /ws, and a server of your own mounts borgo.Realtime() there")
	}
	return relay.publishEvent(topic, event, data)
}

// Realtime is the websocket relay as an http.Handler, for an app that mounts
// borgo's handlers on a server of its own: mount it at /ws, behind whatever
// guards that server puts in front of the api, and borgo.Push reaches its
// subscribers. Serve mounts the same relay itself. The one relay per
// process: a second call returns the first.
func Realtime() http.Handler {
	if relay := processRelay.Load(); relay != nil {
		return relay
	}
	opts, err := wsRelayOptionsFromEnv(nil)
	if err != nil {
		// an embedder's environment is judged by CheckEnv as Serve's is; here
		// the refusal is a handler that says why, since there is no boot to stop
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, err.Error(), http.StatusInternalServerError)
		})
	}
	relay := newWSRelay(opts)
	if !processRelay.CompareAndSwap(nil, relay) {
		return processRelay.Load()
	}
	return relay
}

// wsRelayOptionsFromEnv is what the relay needs from the environment: the
// trusted proxies (for the scheme an Origin is compared against), the
// no-Origin switch, and whether this is a dev run.
func wsRelayOptionsFromEnv(security *securityConfig) (wsRelayOptions, error) {
	// the 101 is written to the hijacked socket, past every wrapper that adds
	// the security headers: the relay adds them itself, from the server's
	// config when it has one and from the environment otherwise
	if security == nil {
		var err error
		if security, err = securityFromEnv(); err != nil {
			return wsRelayOptions{}, err
		}
	}
	trusted, err := trustedProxies()
	if err != nil {
		return wsRelayOptions{}, err
	}
	allowNoOrigin, err := wsAllowNoOriginFromEnv()
	if err != nil {
		return wsRelayOptions{}, err
	}
	dev, _ := strconv.ParseBool(os.Getenv("BORGO_DEV"))
	return wsRelayOptions{security: security, trusted: trusted, allowNoOrigin: allowNoOrigin, dev: dev}, nil
}

// mountRelay makes the process's relay from the environment, once, and hands
// it to whoever serves /ws. Serve calls it; an embedder gets the same through
// Realtime.
func mountRelay(security *securityConfig) (*wsRelay, error) {
	if relay := processRelay.Load(); relay != nil {
		return relay, nil
	}
	opts, err := wsRelayOptionsFromEnv(security)
	if err != nil {
		return nil, err
	}
	relay := newWSRelay(opts)
	if !processRelay.CompareAndSwap(nil, relay) {
		return processRelay.Load(), nil
	}
	return relay, nil
}

// retiredPushEnv refuses the variables of the push road that is gone. Through
// 0.22 a push was a request to the front server, and these named the key
// it carried and the road without one; since 0.30 the relay is in the
// process and a push is a call. A deployment upgraded with them still set
// would run on a rule that no longer exists - a key that authorizes nothing
// - so the boot stops and says which, rather than the operator trusting a
// key nobody reads. FRONT_URL, which named the front server, is not here:
// the name is an app's to declare now, on both halves (env.ts says the
// same), and a value left over from 0.22 is a url nothing posts to.
func retiredPushEnv() error {
	var set []string
	for _, name := range []string{"BORGO_PUSH_KEY", "BORGO_PUSH_INSECURE"} {
		if os.Getenv(name) != "" {
			set = append(set, name)
		}
	}
	if len(set) == 0 {
		return nil
	}
	verb := "are"
	if len(set) == 1 {
		verb = "is"
	}
	return fmt.Errorf("borgo: %s %s retired in 0.30: borgo.Push publishes inside this process, and the relay answers /ws on the public port - there is no key to share and nothing to post to. Unset %s (docs/migration-0.30.md)",
		strings.Join(set, ", "), verb, strings.Join(set, ", "))
}

// Revalidate drops the page cache's copy of a page that declared
// `export const revalidate`. The natural call site is the handler that just
// wrote the data the page renders. An exact path drops the page and its
// query variants; a trailing star drops the prefix: Revalidate("/blog/*").
// In dev there is no cache and the call is a no-op, so application code
// behaves the same in both modes; so is it in an api with no pages.
func Revalidate(path string) error {
	// refused before either branch: a call that names no page answered nil
	// in front mode, where a blank path or one without its slash matches no
	// key, while the same call in dev was an error
	if strings.TrimSpace(path) == "" {
		return fmt.Errorf("borgo.Revalidate: an empty path names no page")
	}
	if !strings.HasPrefix(path, "/") {
		return fmt.Errorf("borgo.Revalidate: %q is not a path: a page is named as it is requested, starting with /", path)
	}
	if i := localIsr(); i != nil {
		i.invalidatePath(path)
	}
	return nil
}

// RevalidateTag drops every cached page that listed the tag in its `tags`
// export - one call from the handler that wrote the posts, and every page
// depending on them re-renders on its next request.
func RevalidateTag(tag string) error {
	if normalizeTag(tag) == "" {
		return fmt.Errorf("borgo.RevalidateTag: an empty tag names no pages")
	}
	if i := localIsr(); i != nil {
		i.invalidateTag(tag)
	}
	return nil
}
