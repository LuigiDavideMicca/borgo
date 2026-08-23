package borgo

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const pushTimeout = 5 * time.Second

// a test that needs a different deadline passes its own settings: defaultPush
// is read by every other caller
type pushSettings struct {
	// on the request, not only on the client: a front server that accepts and
	// never answers cannot hold the api handler past it
	timeout time.Duration
	client  *http.Client
}

var defaultPush = pushSettings{timeout: pushTimeout, client: pushHTTPClient(pushTimeout)}

func pushHTTPClient(timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout, Transport: pushTransport(), CheckRedirect: refusePushRedirect}
}

// every push goes to one host and DefaultTransport keeps 2 idle connections
// per host: concurrent pushes would open a socket per call
func pushTransport() *http.Transport {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.MaxIdleConnsPerHost = 64
	return t
}

// Push publishes an event to every browser subscribed to a websocket topic
// on the front server (see the subscribe helper in the borgo npm package).
// The front server is assumed on localhost; set FRONT_URL when it is not,
// and BORGO_PUSH_KEY on both sides when pushing across hosts - over https, or
// with BORGO_PUSH_INSECURE if the clear-text hop is a deliberate one.
//
// Called with literal topic and event strings, borgogen records T in the
// generated event map and the browser's subscribe callback for that topic is
// typed with it. A dynamic topic or event name stays out of the map: the push
// still happens, the browser side stays untyped.
func Push[T any](topic, event string, data T) error {
	return pushWith(defaultPush, topic, event, data)
}

func pushWith[T any](s pushSettings, topic, event string, data T) error {
	payload, err := json.Marshal(map[string]any{"topic": topic, "event": event, "data": data})
	if err != nil {
		return err
	}

	base, from, err := pushBase()
	if err != nil {
		return err
	}
	endpoint, err := pushEndpoint(base, from)
	if err != nil {
		return err
	}
	key := os.Getenv("BORGO_PUSH_KEY")
	if key != "" {
		if err := pushKeyMayTravel(endpoint); err != nil {
			return err
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), s.timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if key != "" {
		req.Header.Set("X-Borgo-Key", key)
	}

	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	// drain so the keep-alive connection is reusable
	io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
	if resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("borgo.Push: front server responded %d", resp.StatusCode)
	}
	return nil
}

// read by the boot check and by the push itself, so the two cannot disagree on
// the host being judged. PORT is interpolated into a url, so anything but
// digits is somebody else's host: "@front.invalid:80" turns "localhost:" into
// credentials and the rest into the authority. Refused, not defaulted around.
func pushBase() (base, from string, err error) {
	if v := os.Getenv("FRONT_URL"); v != "" {
		return v, "FRONT_URL", nil
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	if !validPort(port) {
		return "", "PORT", fmt.Errorf(
			"borgo.Push: PORT %q is not a port between 1 and 65535, so there is no default front server to publish to (set FRONT_URL, or fix PORT)", port)
	}
	return "http://localhost:" + port, "PORT", nil
}

// digits only: Atoi alone accepts "+80"
func validPort(p string) bool {
	if p == "" || strings.ContainsFunc(p, func(r rune) bool { return r < '0' || r > '9' }) {
		return false
	}
	n, err := strconv.Atoi(p)
	return err == nil && n >= 1 && n <= 65535
}

func pushEndpoint(base, from string) (*url.URL, error) {
	fail := func(format string, a ...any) (*url.URL, error) {
		return nil, fmt.Errorf("borgo.Push: %s %q: %s", from, base, fmt.Sprintf(format, a...))
	}
	u, err := url.Parse(strings.TrimRight(base, "/"))
	if err != nil {
		return fail("%v", err)
	}
	if (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fail("want an http:// or https:// url with a host")
	}
	// JoinPath keeps both, so they would ride on every publish
	if u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return fail("want a base url with no query or fragment")
	}
	// with go.mod below 1.26 url.Parse accepts "host:3000:9000" (urlstrictcolons
	// is off), giving Hostname() "host:3000" and Port() "9000": the guard would
	// judge one host while the dialer looks up another
	if host := u.Hostname(); strings.Contains(host, ":") && !strings.HasPrefix(u.Host, "[") {
		return fail("host %q is not a host: an address with a port needs no second colon", host)
	}
	// url.Parse takes any run of digits as a port: 99999 and 0 would fail at dial
	if p := u.Port(); p != "" && !validPort(p) {
		return fail("port %q is not between 1 and 65535", p)
	}
	// JoinPath cleans "/.." but not "%2e%2e"
	if strings.Contains(strings.ToLower(u.EscapedPath()), "%2e") {
		return fail("path %q hides dot segments behind an escape", u.EscapedPath())
	}
	return u.JoinPath("__borgo/publish"), nil
}

// http.Client strips only Authorization and cookies across domains, so
// X-Borgo-Key would follow a redirect to a host this side never checked. Not
// re-checked per hop: pushKeyMayTravel reads the channel, not who is on it,
// and would wave https://front -> https://attacker through
func refusePushRedirect(req *http.Request, via []*http.Request) error {
	return fmt.Errorf("borgo.Push: %s redirected the publish to %s, and a redirect is not followed: it would hand the request, and BORGO_PUSH_KEY with it, to a host this side never checked - point FRONT_URL at the front server itself", via[len(via)-1].URL.Host, req.URL)
}

// the key leaves the process only over https, to this machine (sound only
// because refusePushRedirect exists), or with BORGO_PUSH_INSECURE said out
// loud. Failure direction: the key stays home
func pushKeyMayTravel(u *url.URL) error {
	if u.Scheme == "https" || loopbackHost(u.Hostname()) {
		return nil
	}
	v := os.Getenv("BORGO_PUSH_INSECURE")
	if v != "" {
		insecure, err := strconv.ParseBool(v)
		if err != nil {
			return fmt.Errorf("borgo.Push: BORGO_PUSH_INSECURE: invalid value %q (want 1/true or 0/false; unset means the key stays home)", v)
		}
		if insecure {
			return nil
		}
	}
	return fmt.Errorf("borgo.Push: BORGO_PUSH_KEY is set and FRONT_URL is %s://%s, so the key would cross the network in clear: use https, a front server on this machine, or set BORGO_PUSH_INSECURE=1 to send it anyway", u.Scheme, u.Host)
}

// the inet_aton short forms (127.1, 2130706433, 0x7f000001, 0177.0.0.1) are
// deliberately not read: Go dials them as names, and a DNS server is free to
// answer a name with any address. Same reason the root dot is not trimmed
// before ParseIP: "127.0.0.1." is a name to the dialer. localhost.something is
// somebody else's host
func loopbackHost(host string) bool {
	host = strings.ToLower(host)
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback()
	}
	return strings.TrimSuffix(host, ".") == "localhost"
}
