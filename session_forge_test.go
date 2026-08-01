package borgo

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// forgeSession builds the cookie an attacker would build: the payload borgo
// itself would sign, MAC'd with the key borgo would use when SESSION_SECRET is
// unset - the empty string, which is not a secret at all.
func forgeSession(t *testing.T, principal any, key string) string {
	t.Helper()
	data, err := json.Marshal(principal)
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(struct {
		Exp  int64           `json:"exp"`
		Data json.RawMessage `json:"data"`
	}{Exp: time.Now().Add(time.Hour).Unix(), Data: data})
	if err != nil {
		t.Fatal(err)
	}
	payload := base64.RawURLEncoding.EncodeToString(body)
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(payload))
	return payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// A server running without SESSION_SECRET must not accept sessions - it must
// refuse them. Signing with an unset secret keys the hmac on the empty string,
// which anybody can reproduce, so every guarded route would open to a
// principal of the attacker's choosing. The dangerous shape is that the app
// looks broken rather than compromised: login answers 500 the whole time.
func TestForgedSessionIsRefusedWithoutSecret(t *testing.T) {
	t.Setenv("SESSION_SECRET", "")

	req := httptest.NewRequest(http.MethodGet, "/admin", nil)
	req.AddCookie(&http.Cookie{
		Name:  sessionCookie,
		Value: forgeSession(t, map[string]string{"user": "root", "admin": "yes"}, ""),
	})

	if _, ok := GetSession[map[string]string](req); ok {
		t.Error("a session forged against the empty secret was accepted")
	}
	if hasValidSession(req) {
		t.Error("hasValidSession accepted a forged session")
	}

	var reached bool
	rec := httptest.NewRecorder()
	Authed(func(http.ResponseWriter, *http.Request) { reached = true })(rec, req)
	if reached {
		t.Error("Authed ran the handler for a forged session")
	}
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("Authed answered %d, want 401", rec.Code)
	}
}

// The guard must key on the secret being absent, not on the signature being
// empty: a real secret still has to verify real sessions.
func TestSessionsStillWorkWithASecret(t *testing.T) {
	t.Setenv("SESSION_SECRET", "a-real-secret-of-respectable-length")

	rec := httptest.NewRecorder()
	if err := SetSession(rec, map[string]string{"user": "luigi"}, time.Hour); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/admin", nil)
	for _, cookie := range rec.Result().Cookies() {
		req.AddCookie(cookie)
	}
	got, ok := GetSession[map[string]string](req)
	if !ok || got["user"] != "luigi" {
		t.Fatalf("a legitimately issued session did not verify: %v ok=%v", got, ok)
	}

	// and a cookie forged against the empty key does not ride in on it
	forged := httptest.NewRequest(http.MethodGet, "/admin", nil)
	forged.AddCookie(&http.Cookie{Name: sessionCookie, Value: forgeSession(t, map[string]string{"user": "root"}, "")})
	if _, ok := GetSession[map[string]string](forged); ok {
		t.Error("a forged session verified against a real secret")
	}
}

// Rotating the secret to a new value must invalidate what the old one signed,
// which is the same guard read from the other side.
func TestSessionsDoNotSurviveASecretRotation(t *testing.T) {
	t.Setenv("SESSION_SECRET", "the-first-secret-long-enough-to-use")
	rec := httptest.NewRecorder()
	if err := SetSession(rec, map[string]string{"user": "luigi"}, time.Hour); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/admin", nil)
	for _, cookie := range rec.Result().Cookies() {
		req.AddCookie(cookie)
	}

	for _, secret := range []string{"the-second-secret-long-enough-too", ""} {
		t.Setenv("SESSION_SECRET", secret)
		if _, ok := GetSession[map[string]string](req); ok {
			t.Errorf("a session signed with the first secret still verified under %q", secret)
		}
	}
}

// The guard closing the forgery hole sits at the top of sessionPayload, which
// is a position, not a rule: a future caller reaching the signer another way
// would reopen it. So the signer refuses too, and this pins that - remove the
// check in sessionPayload and the forgery test above still has to fail.
func TestSignerRefusesWithoutASecret(t *testing.T) {
	t.Setenv("SESSION_SECRET", "")
	if sig := sessionSign("any-payload-at-all"); sig != "" {
		t.Errorf("sessionSign produced %q without a secret; anything non-empty is a mac anyone can recompute", sig)
	}
	t.Setenv("SESSION_SECRET", "a-real-secret-of-respectable-length")
	if sessionSign("any-payload-at-all") == "" {
		t.Error("sessionSign refused a real secret")
	}
}

// A short SESSION_SECRET is not a weaker secret, it is a searchable one: the
// whole security of the cookie is that nobody can produce its HMAC, and a
// handful of bytes falls offline from a single captured cookie. Warning about
// it - which is what borgo did - left a searchable key signing production
// sessions while printing a line nobody reads. Treated as absent everywhere,
// so every guard that already refuses without a secret covers this too.
func TestAShortSecretIsNoSecret(t *testing.T) {
	for _, secret := range []string{"x", "short", strings.Repeat("a", sessionSecretMinLen-1)} {
		t.Setenv("SESSION_SECRET", secret)

		if err := SetSession(httptest.NewRecorder(), map[string]string{"u": "a"}, time.Hour); !errors.Is(err, ErrNoSessionSecret) {
			t.Errorf("SetSession(%d bytes) = %v, want ErrNoSessionSecret", len(secret), err)
		}
		if sig := sessionSign("payload"); sig != "" {
			t.Errorf("sessionSign signed with a %d-byte key", len(secret))
		}
		// and it cannot be used to forge either, which is the direction that matters
		req := httptest.NewRequest(http.MethodGet, "/admin", nil)
		req.AddCookie(&http.Cookie{Name: sessionCookie, Value: forgeSession(t, map[string]string{"user": "root"}, secret)})
		if _, ok := GetSession[map[string]string](req); ok {
			t.Errorf("a session forged against the %d-byte key was accepted", len(secret))
		}
	}

	// exactly at the floor is usable: the boundary belongs to the good side
	t.Setenv("SESSION_SECRET", strings.Repeat("a", sessionSecretMinLen))
	if sessionSign("payload") == "" {
		t.Errorf("a %d-byte secret was refused; the minimum must be inclusive", sessionSecretMinLen)
	}
}
