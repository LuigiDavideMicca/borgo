package borgo

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"math"
	"net/http"
	"os"
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

func newSessionCookie() *http.Cookie {
	return &http.Cookie{
		Name:     sessionCookie,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   os.Getenv("SESSION_SECURE") == "1",
	}
}

type sessionEnvelope struct {
	Exp  int64           `json:"exp"`
	Data json.RawMessage `json:"data"`
}

// ErrNoSessionSecret is returned by SetSession when SESSION_SECRET is unset.
// It is an error rather than a panic because the app is already serving: a
// login that answers 500 is recoverable, a panicking handler is not.
var ErrNoSessionSecret = errors.New("borgo: SESSION_SECRET must be set to use sessions (any long random string)")

func sessionSecret() string { return os.Getenv("SESSION_SECRET") }

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

func sessionSign(payload string) string {
	secret := sessionSecret()
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
// it. Set SESSION_SECURE=1 to add the Secure attribute behind https. A
// maxAge of zero or less writes an already-expired session.
func SetSession(w http.ResponseWriter, v any, maxAge time.Duration) error {
	if sessionSecret() == "" {
		return ErrNoSessionSecret
	}
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	envelope, err := json.Marshal(sessionEnvelope{Exp: time.Now().Add(maxAge).Unix(), Data: data})
	if err != nil {
		return err
	}
	payload := base64.RawURLEncoding.EncodeToString(envelope)
	cookie := newSessionCookie()
	cookie.Value = payload + "." + sessionSign(payload)
	// int(maxAge.Seconds()) would overflow a 32-bit int for a >68-year age,
	// and a negative MaxAge serializes as Max-Age=0: the browser would delete
	// the session the moment it was issued
	cookie.MaxAge = int(min(int64(maxAge/time.Second), math.MaxInt32))
	if n := len(cookie.String()); n > sessionCookieMaxLen {
		return fmt.Errorf("borgo: session cookie is %d bytes, over the %d-byte browser limit; store a smaller principal (see Auth.Principal)", n, sessionCookieMaxLen)
	}
	http.SetCookie(w, cookie)
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
	if sessionSecret() == "" {
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
		if !hmac.Equal([]byte(sessionSign(payload)), []byte(sig)) {
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
	cookie := newSessionCookie()
	cookie.MaxAge = -1
	http.SetCookie(w, cookie)
}
