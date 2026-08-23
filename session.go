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

// The error is SESSION_SECURE's, a value not a panic: an embedder mounting
// these handlers on its own server never passes through CheckEnv. The cookie
// returned alongside it carries no Secure attribute and is only fit for
// deletion - SetSession refuses it, ClearSession uses it.
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

// A value not understood is a refusal, not a silent fallback: a misread here
// fails open (a cookie sent back over plain http). Not an == "1" test, which
// read SESSION_SECURE=true as "not 1".
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

// ErrNoSessionSecret is returned by SetSession when SESSION_SECRET is unset
// or shorter than sessionSecretMinLen.
var ErrNoSessionSecret = errors.New("borgo: SESSION_SECRET must be set to at least 32 bytes to use sessions (openssl rand -base64 48)")

// The output size of the hash it keys. Below it one captured cookie is an
// offline oracle on the key.
const sessionSecretMinLen = 32

// A secret too short is reported as absent, not as its own case: every guard
// that refuses without a secret then covers the weak key too, including for
// an embedder that never calls Serve.
func sessionSecret() string {
	secret := os.Getenv("SESSION_SECRET")
	if len(secret) < sessionSecretMinLen {
		return ""
	}
	return secret
}

// building an hmac is most of the cost of verifying a session. Pooled macs
// are rebuilt when the secret changes, so a rotation takes effect immediately.
type sessionSigner struct {
	secret string
	mac    hash.Hash
	buf    []byte
	sum    []byte
}

var sessionSigners sync.Pool

// sessionSign takes the key rather than reading it: a second read of mutable
// process state can disagree with the caller's check, and with an empty
// secret hmac.Equal on two empty slices is TRUE - a cookie shaped "<payload>."
// verified. The caller is responsible for having refused an unusable key.
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
// browser deletes the cookie, and a copy kept elsewhere does not verify.
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
	// GetSession's check is exclusive, so Exp == now stays valid for the rest
	// of the current second
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
	// -1 is what net/http serializes as Max-Age=0, the deletion; a MaxAge of 0
	// omits the attribute, a browser-session cookie, so no non-positive age
	// may reach it - a sub-second age would truncate to that same 0, and a
	// >68-year one would overflow the 32-bit int
	cookie.MaxAge = -1
	if maxAge > 0 {
		cookie.MaxAge = int(max(1, min(int64(maxAge/time.Second), math.MaxInt32)))
	}
	if n := len(cookie.String()); n > sessionCookieMaxLen {
		return fmt.Errorf("borgo: session cookie is %d bytes, over the %d-byte browser limit; store a smaller principal (see Auth.Principal)", n, sessionCookieMaxLen)
	}
	http.SetCookie(w, cookie)
	// best effort: recoverMiddleware's exit is the airtight guard, and only
	// the pipeline borgo.Serve builds has it. On an embedder's own mux this
	// closes the common order, cache then session, and nothing can close the
	// rest - a handler may set Cache-Control after this returns
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

// A request can carry several cookies of the same name (a sibling subdomain
// can toss one in) and r.Cookie hands back the first: enough to swap the
// victim's session for the attacker's own without touching a signature. Junk
// duplicates are skipped; a second cookie that also verifies is ambiguous, no
// session.
func sessionPayload(r *http.Request) (string, bool) {
	// hmac keyed on the empty string is a MAC anyone can compute: a deploy
	// that loses SESSION_SECRET must log everyone out, not let everyone in
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
		// deleting beats refusing: Secure does not gate this overwrite from an
		// https origin, and a logout that failed would leave the session live
		log.Printf("borgo: %v; clearing the session cookie without Secure", err)
	}
	cookie.MaxAge = -1
	http.SetCookie(w, cookie)
	// best effort, as in SetSession
	privateIfCookies(w.Header())
}
