package borgo

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"log"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	sessionCookie = "borgo_session"
	// browsers silently drop cookies over 4 KB, which would surface as a
	// login loop of 200 responses
	sessionCookieMaxLen = 4096
)

// newSessionCookie builds the cookie SetSession and ClearSession write. The
// error is SESSION_SECURE's, and it comes back as a value rather than a panic
// because this runs inside a request: an embedder that mounts these handlers
// on its own server never passes through CheckEnv, and a typo used to reach it
// as a panicking handler on the first login.
//
// The cookie returned alongside an error carries no Secure attribute and is
// only fit for deletion - SetSession refuses it, ClearSession uses it.
func newSessionCookie() (*http.Cookie, error) {
	secure, err := sessionSecure()
	return &http.Cookie{
		Name:     sessionCookie,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   secure,
	}, err
}

// sessionSecure reads SESSION_SECURE, which adds the Secure attribute to the
// session cookie. Like BORGO_HASH_SLOTS and the BORGO_*_TIMEOUT family, a
// value that is not understood is a refusal rather than a silent fallback:
// this was an == "1" test, so SESSION_SECURE=true - the spelling every other
// boolean env in the ecosystem takes - read as "not 1" and quietly issued a
// session cookie the browser would send back over plain http. The failure
// direction of a misread here is open, so it must not be silent.
//
// CheckEnv reads it at startup, so a typo fails the boot rather than the first
// request that writes a cookie. Serve and ServeContext call CheckEnv; an
// embedder mounting these handlers on its own mux has to call it itself, and
// until it does the refusal still arrives - as SetSession's error, with no
// cookie issued.
func sessionSecure() (bool, error) {
	v := os.Getenv("SESSION_SECURE")
	if v == "" {
		return false, nil
	}
	secure, err := strconv.ParseBool(v)
	if err != nil {
		return false, fmt.Errorf(`borgo: SESSION_SECURE: invalid value %q (want "1"/"true" or "0"/"false"; unset means not secure)`, v)
	}
	return secure, nil
}

type sessionEnvelope struct {
	Exp  int64           `json:"exp"`
	Data json.RawMessage `json:"data"`
}

// ErrNoSessionSecret is returned by SetSession when SESSION_SECRET is unset,
// or set to something too short to be a key (see sessionSecretMinLen).
// It is an error rather than a panic because the app is already serving: a
// login that answers 500 is recoverable, a panicking handler is not.
var ErrNoSessionSecret = errors.New("borgo: SESSION_SECRET must be set to at least 32 bytes to use sessions (openssl rand -base64 48)")

// sessionSecretMinLen is the shortest SESSION_SECRET borgo will sign with, and
// it is the output size of the hash it keys. Below it the cookie's security
// stops being "nobody can produce this HMAC" and becomes "nobody has bothered
// to search for the key yet" - one captured cookie is an offline oracle, and a
// handful of bytes falls in seconds.
const sessionSecretMinLen = 32

// sessionSecret returns the signing key, or "" when there is nothing usable.
// A secret too short is reported as absent rather than as its own case on
// purpose: every guard in this package already refuses to issue or verify
// without a secret, so one definition of "usable" makes all of them cover the
// weak key too. Serve refuses to start on a short one, loudly, which is where
// a deploy should learn about it; this is what keeps an embedder that never
// calls Serve from signing with it anyway.
func sessionSecret() string {
	secret := os.Getenv("SESSION_SECRET")
	if len(secret) < sessionSecretMinLen {
		return ""
	}
	return secret
}

// building an hmac is most of the cost of verifying a session, and every
// guarded request verifies one. Pooled macs are rebuilt only when the secret
// changes, so rotating SESSION_SECRET still takes effect immediately.
type sessionSigner struct {
	secret string
	mac    hash.Hash
	buf    []byte
	sum    []byte
}

var sessionSigners sync.Pool

// sessionSign takes the key rather than reading it, and that is the whole
// point. It used to call sessionSecret() itself, which meant a caller checked
// the secret and the signer then read it AGAIN from mutable process state - two
// reads of one variable, with no guarantee they agree. A rotation that blanks
// SESSION_SECRET between them made the signer return the empty string, and
// hmac.Equal on two empty slices is TRUE: a cookie shaped "<payload>." with no
// signature at all verified, and Authed admitted whatever principal the
// attacker wrote. One read, passed down, makes the disagreement impossible to
// express. The caller is responsible for having refused an unusable key.
func sessionSign(payload, secret string) string {
	s, _ := sessionSigners.Get().(*sessionSigner)
	if s == nil || s.secret != secret {
		s = &sessionSigner{secret: secret, mac: hmac.New(sha256.New, []byte(secret))}
	}
	s.mac.Reset()
	s.buf = append(s.buf[:0], payload...)
	s.mac.Write(s.buf)
	s.sum = s.mac.Sum(s.sum[:0])
	sig := base64.RawURLEncoding.EncodeToString(s.sum)
	sessionSigners.Put(s)
	return sig
}

// SetSession stores v, JSON-encoded and HMAC-signed with SESSION_SECRET, in
// an http-only cookie. The expiry is signed too, so a client cannot extend
// it. Set SESSION_SECURE=1 (or "true") to add the Secure attribute behind
// https. A maxAge of zero or less writes an already-expired session: the
// browser deletes the cookie on arrival, and the envelope it carries is
// already past, so a copy of it kept elsewhere does not verify either.
func SetSession(w http.ResponseWriter, v any, maxAge time.Duration) error {
	secret := sessionSecret()
	if secret == "" {
		return ErrNoSessionSecret
	}
	cookie, err := newSessionCookie()
	if err != nil {
		return err
	}
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	// zero is "expired", not "expires now": Unix() truncates to the second and
	// GetSession's check is exclusive, so an Exp of exactly now would keep the
	// session valid for the rest of the current second - a logout that leaves
	// the principal usable
	exp := time.Now().Add(maxAge)
	if maxAge <= 0 {
		exp = time.Now().Add(-time.Second)
	}
	envelope, err := json.Marshal(sessionEnvelope{Exp: exp.Unix(), Data: data})
	if err != nil {
		return err
	}
	payload := base64.RawURLEncoding.EncodeToString(envelope)
	cookie.Value = payload + "." + sessionSign(payload, secret)
	// -1 is what net/http serializes as Max-Age=0, the deletion. A cookie
	// MaxAge of 0 is the attribute being omitted altogether, which is a
	// browser-session cookie that outlives nothing but the window - the
	// opposite of the expiry this documents - so no non-positive age may reach
	// it. Above, int(maxAge.Seconds()) would overflow a 32-bit int for a
	// >68-year age, and a sub-second age would truncate to that same 0
	cookie.MaxAge = -1
	if maxAge > 0 {
		cookie.MaxAge = int(max(1, min(int64(maxAge/time.Second), math.MaxInt32)))
	}
	if n := len(cookie.String()); n > sessionCookieMaxLen {
		return fmt.Errorf("borgo: session cookie is %d bytes, over the %d-byte browser limit; store a smaller principal (see Auth.Principal)", n, sessionCookieMaxLen)
	}
	http.SetCookie(w, cookie)
	// best effort, and only that. recoverMiddleware's exit is the airtight
	// guard, and it exists only inside the pipeline borgo.Serve builds; on an
	// embedder's own mux this call is what closes the common order, cache then
	// session. It cannot close all of them: a handler is always free to set
	// Cache-Control after this returns, and borgo.SSE and borgo.NoCache both
	// do. Guarding one more setter would move the gap rather than shut it -
	// borgo.Middleware is the way an embedder gets the real thing
	privateIfCookies(w.Header())
	return nil
}

// GetSession verifies the session cookie's signature and expiry and decodes
// its payload into T. The second return is false for a missing, tampered or
// expired session.
func GetSession[T any](r *http.Request) (T, bool) {
	var zero T
	payload, ok := sessionPayload(r)
	if !ok {
		return zero, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return zero, false
	}
	var envelope sessionEnvelope
	if json.Unmarshal(raw, &envelope) != nil || time.Now().Unix() > envelope.Exp {
		return zero, false
	}
	var v T
	if json.Unmarshal(envelope.Data, &v) != nil {
		return zero, false
	}
	return v, true
}

// sessionPayload returns the signed payload of the request's session cookie.
// A request can carry several cookies of the same name - a sibling subdomain
// or a http-only-less path can toss one in - and net/http hands back the first
// one, which is enough for an attacker to swap the victim's session for one of
// their own without ever touching the signature. Junk duplicates are skipped
// and a second cookie that also verifies is treated as ambiguous: no session.
func sessionPayload(r *http.Request) (string, bool) {
	// Without a secret there is nothing to verify against: hmac keyed on the
	// empty string is a MAC anyone can compute, so every forged cookie would
	// verify and Authed would admit an attacker-chosen principal. SetSession
	// already refuses to issue in that state; refusing to accept is the half
	// that matters, because the failure direction here is open, not closed.
	// A deploy that loses SESSION_SECRET must log everyone out, not let
	// everyone in as anybody.
	secret := sessionSecret()
	if secret == "" {
		return "", false
	}
	var found string
	var valid int
	for _, cookie := range r.CookiesNamed(sessionCookie) {
		// nothing this server issued is over the limit, so an oversized value
		// is junk: reject it before hashing it
		if len(cookie.Value) > sessionCookieMaxLen {
			continue
		}
		dot := strings.LastIndexByte(cookie.Value, '.')
		if dot < 0 {
			continue
		}
		payload, sig := cookie.Value[:dot], cookie.Value[dot+1:]
		if !hmac.Equal([]byte(sessionSign(payload, secret)), []byte(sig)) {
			continue
		}
		if valid++; valid > 1 {
			return "", false
		}
		found = payload
	}
	return found, valid == 1
}

// ClearSession deletes the session cookie.
func ClearSession(w http.ResponseWriter) {
	cookie, err := newSessionCookie()
	if err != nil {
		// deleting beats refusing. The Secure attribute does not gate this
		// overwrite from an https origin, so a clear without it still logs the
		// user out, while a logout handler that failed on a misspelt
		// SESSION_SECURE would leave the session live
		log.Printf("borgo: %v; clearing the session cookie without Secure", err)
	}
	cookie.MaxAge = -1
	http.SetCookie(w, cookie)
	// a logout is as cacheable-looking as a login and just as unshareable; see
	// SetSession for why this runs at the cookie, and why it is best effort
	privateIfCookies(w.Header())
}
