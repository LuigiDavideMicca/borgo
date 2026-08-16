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

// what a push travels with. Written once here and never again: a test that
// needs a different deadline passes its own settings rather than reaching into
// the ones every other caller is reading.
type pushSettings struct {
	// the caller gets out, it does not wait: the deadline rides on the
	// request, so a front server that accepts and never answers cannot hold
	// the api handler past it even if the client is reconfigured
	timeout time.Duration
	client  *http.Client
}

var defaultPush = pushSettings{timeout: pushTimeout, client: pushHTTPClient(pushTimeout)}

// a hung front server must not block the api handler that called Push
func pushHTTPClient(timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout, Transport: pushTransport(), CheckRedirect: refusePushRedirect}
}

// every push goes to the same host, and DefaultTransport parks only two idle
// connections per host: concurrent pushes would open a socket per call and
// burn through the ephemeral port range
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
// The payload type is visible to static analysis, so the plain name is the
// typed one - as with borgo.JSON[T] against WriteJSON. Called with literal
// topic and event strings, borgogen records T in the generated event map and
// the browser's subscribe callback for that topic is typed with it. Go infers
// T from data, so no call site has to spell it out. A dynamic topic or event
// name simply stays out of the map: the push still happens, the browser side
// stays untyped.
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

// where Push publishes, read once here so the boot check and the push itself
// cannot disagree about which host is being judged
// where Push publishes, and the name of the variable that said so: an error
// about FRONT_URL is no use to an operator who only ever set PORT.
// PORT is interpolated into a url, so anything but digits is somebody else's
// host: "@front.invalid:80" turns "localhost:" into credentials and the rest
// into the authority, which moved every push to another machine in silence.
// It is refused rather than defaulted around, or the silence just moves.
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

// digits only: Atoi accepts a leading sign, so "+80" passed a rule whose whole
// point is that anything but digits is somebody else's host
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
	// a query or a fragment swallows the path that is appended below - measured,
	// the publish call then arrives at "/" - and neither belongs on the base of
	// an internal endpoint
	if u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return fail("want a base url with no query or fragment")
	}
	// a colon left in the hostname means url.Parse read a second one in the
	// authority: since go 1.25 that is allowed by default, so "host:3000:9000"
	// parses with Hostname() = "host:3000" and Port() = "9000". The guard then
	// judges one host while the dialer looks up another - the same disagreement
	// the root-dot form had, arriving by a different road. Relying on a GODEBUG
	// default to be told about it is not a check
	if host := u.Hostname(); strings.Contains(host, ":") && !strings.HasPrefix(u.Host, "[") {
		return fail("host %q is not a host: an address with a port needs no second colon", host)
	}
	// url.Parse takes any run of digits as a port, so 99999 and 0 parse and then
	// fail at dial time. That delay is what this check exists to remove
	if p := u.Port(); p != "" && !validPort(p) {
		return fail("port %q is not between 1 and 65535", p)
	}
	// JoinPath cleans "/.." but not "%2e%2e", so an escaped pair survived into
	// the publish path and every push landed off it, with the boot silent
	if strings.Contains(strings.ToLower(u.EscapedPath()), "%2e") {
		return fail("path %q hides dot segments behind an escape", u.EscapedPath())
	}
	return u.JoinPath("__borgo/publish"), nil
}

// a publish endpoint has no reason to redirect, so one is a misconfiguration or
// somebody else answering. Following it would put X-Borgo-Key on the next hop -
// the client strips only Authorization and the cookie headers, and only across
// domains, so a custom header rides along - and that hop is one the first
// server chose, not one this side ever looked at. Re-running the guard per hop
// would not be enough: it reads the channel, not who is on the other end, so it
// would wave through a redirect from https://front to https://attacker. There
// is no second hop instead.
func refusePushRedirect(req *http.Request, via []*http.Request) error {
	return fmt.Errorf("borgo.Push: %s redirected the publish to %s, and a redirect is not followed: it would hand the request, and BORGO_PUSH_KEY with it, to a host this side never checked - point FRONT_URL at the front server itself", via[len(via)-1].URL.Host, req.URL)
}

// BORGO_PUSH_KEY authenticates every push, so the key does not leave the
// process unless something can keep it: https keeps it on the wire, a front
// server on this machine never puts it on one - true only because a redirect
// off this machine is refused rather than followed - and anything else needs an
// operator to have said BORGO_PUSH_INSECURE out loud. The failure direction is
// the key staying home, not travelling in clear.
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

// this machine, by exact name or by address, in the spellings that mean the
// same thing to everything that reads them: hostnames are case-insensitive and
// may carry the root dot.
//
// The inet_aton short forms - 127.1, 127.0.1, 2130706433, 0x7f000001,
// 0177.0.0.1 - are deliberately NOT read here, and this is not an oversight to
// repair. Go hands none of them to connect() as an address: measured on windows
// and on linux with the pure-go resolver, every one of them comes back "no such
// host" and every dial to one fails, because Go looks them up as names. On
// linux 0x7f000001 went further and was put on the wire to the DNS server,
// where it timed out - a name a DNS server is free to answer with any address
// at all. A guard that concluded "this machine" there would be authorising a
// key to travel to whatever the answer is.
//
// So: reading them requires a parser here to agree with every resolver
// everywhere, which is a premise that cannot be checked, and refusing a
// spelling nobody needs costs nothing - anyone who can write 2130706433 can
// write 127.0.0.1.
//
// A host merely *called* localhost.something is somebody else's.
func loopbackHost(host string) bool {
	host = strings.ToLower(host)
	// the address literal is read first, and unmodified: the root dot belongs to
	// the name branch, and trimming it before ParseIP made "127.0.0.1." this
	// machine here while the dialer looked it up as a name - a verdict reached
	// by reasoning where something else resolves, which is the whole reason the
	// inet_aton parser below is not here either
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback()
	}
	return strings.TrimSuffix(host, ".") == "localhost"
}
