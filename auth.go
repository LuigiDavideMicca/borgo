package borgo

import (
	"context"
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// PasswordHasher hashes and verifies passwords. The default is PBKDF2-SHA256
// from the standard library (OWASP parameters), chosen so the runtime keeps
// zero dependencies; swap in argon2id via this interface if your threat model
// asks for it.
type PasswordHasher interface {
	Hash(password string) (string, error)
	Verify(password, hash string) bool
}

const (
	pbkdf2Iterations = 600_000
	pbkdf2SaltLen    = 16
	pbkdf2KeyLen     = 32
	// Verify derives with the parameters the stored hash asks for, so a row
	// carrying a 32 KB key costs 106 s of cpu per attempt here (x1140 a real
	// verify) while holding one of the few hash slots, and an iteration count
	// with enough digits never returns at all. Nothing borgo writes comes
	// near these bounds; past them the stored hash is junk, not a credential.
	pbkdf2MaxIterations = 10_000_000
	pbkdf2MinKeyLen     = 16
	pbkdf2MaxKeyLen     = 64
)

type pbkdf2Hasher struct{}

// DefaultHasher returns the PBKDF2-SHA256 hasher used when Auth.Hasher is nil.
// Hashes embed their parameters ("pbkdf2$<iterations>$<salt>$<key>"), so
// stored passwords keep verifying if the defaults change.
//
// It is a function and not a package variable on purpose: a variable of
// interface type can be reassigned by any code in the process, silently
// changing password hashing for every Auth that did not set its own Hasher.
// The value is stateless, so each call returns an equivalent hasher. To use a
// different algorithm, set Auth.Hasher on the Auth you own.
func DefaultHasher() PasswordHasher { return pbkdf2Hasher{} }

func (pbkdf2Hasher) Hash(password string) (string, error) {
	salt := make([]byte, pbkdf2SaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key, err := pbkdf2.Key(sha256.New, password, salt, pbkdf2Iterations, pbkdf2KeyLen)
	if err != nil {
		return "", err
	}
	enc := base64.RawURLEncoding
	return fmt.Sprintf("pbkdf2$%d$%s$%s", pbkdf2Iterations, enc.EncodeToString(salt), enc.EncodeToString(key)), nil
}

func (pbkdf2Hasher) Verify(password, hash string) bool {
	parts := strings.Split(hash, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2" {
		return false
	}
	iterations, err := strconv.Atoi(parts[1])
	if err != nil || iterations < 1 || iterations > pbkdf2MaxIterations {
		return false
	}
	enc := base64.RawURLEncoding
	salt, err := enc.DecodeString(parts[2])
	if err != nil {
		return false
	}
	want, err := enc.DecodeString(parts[3])
	// the key length drives the cost, and a truncated key is not a credential
	if err != nil || len(want) < pbkdf2MinKeyLen || len(want) > pbkdf2MaxKeyLen {
		return false
	}
	got, err := pbkdf2.Key(sha256.New, password, salt, iterations, len(want))
	if err != nil {
		return false
	}
	return hmac.Equal(got, want)
}

// ErrUserExists signals from Auth.Register that the username is taken; the
// RegisterHandler answers it with 409 instead of 500.
var ErrUserExists = errors.New("user already exists")

// Credentials is the JSON body the login and register handlers decode.
type Credentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// Auth wires an app-supplied user provider to ready-made login, logout and
// register handlers over the signed-cookie session. Mechanics, not policy:
// borgo imposes no database and no user schema - Lookup and Register are
// yours, the session stores whatever principal you choose.
type Auth[U any] struct {
	// Lookup returns the user and its stored password hash for a username.
	// Any error is answered as invalid credentials, so a missing user is
	// indistinguishable from a wrong password.
	Lookup func(ctx context.Context, username string) (U, string, error)
	// Register creates a user from a username and an already-hashed password.
	// Optional: without it RegisterHandler answers 404. Return ErrUserExists
	// for a taken username.
	Register func(ctx context.Context, username, hash string) (U, error)
	// Principal maps the user to what the session stores. Optional: the
	// default stores the user itself. Keep it minimal - it rides in a cookie.
	Principal func(u U) any
	// MaxAge is the session lifetime, default 7 days.
	MaxAge time.Duration
	// Hasher verifies (and, on register, creates) password hashes.
	// Default: DefaultHasher().
	Hasher PasswordHasher

	dummyOnce sync.Once
	dummy     string
}

func (a *Auth[U]) hasher() PasswordHasher {
	if a.Hasher != nil {
		return a.Hasher
	}
	return DefaultHasher()
}

func (a *Auth[U]) principal(u U) any {
	if a.Principal != nil {
		return a.Principal(u)
	}
	return u
}

func (a *Auth[U]) maxAge() time.Duration {
	if a.MaxAge > 0 {
		return a.MaxAge
	}
	return 7 * 24 * time.Hour
}

// dummyHash is verified on failed lookups, so a missing user costs the same
// time as a wrong password and usernames cannot be enumerated by timing. It
// comes from the configured hasher: a hash in another format would fail its
// format check instantly, reopening the timing side channel.
func (a *Auth[U]) dummyHash() string {
	a.dummyOnce.Do(func() {
		a.dummy, _ = a.hasher().Hash("borgo-timing-equalizer")
	})
	return a.dummy
}

// One password hash costs ~140 ms of cpu at OWASP iteration counts, so
// unauthenticated login traffic is a cpu exhaustion vector: a handful of
// parallel attempts is enough to starve every other route. Half the cores
// keeps the rest of the api answering while logins queue.
var hashSlots = newHashSlots()

// newHashSlots sizes the semaphore at package init, where a malformed
// BORGO_HASH_SLOTS cannot be refused to anybody: init runs before main, so a
// panic here kills a binary whose only tie to borgo is an import. It falls back
// to the default cap instead - too lax on its own, since a typo would silently
// reinstate the exhaustion vector the cap exists to close, which is why the
// refusal is logged from here and re-read by CheckEnv.
func newHashSlots() chan struct{} {
	n, err := hashSlotCount()
	if err != nil {
		log.Print(err)
	}
	return make(chan struct{}, n)
}

// defaultHashSlots is the cap when BORGO_HASH_SLOTS is unset.
func defaultHashSlots() int { return max(1, runtime.GOMAXPROCS(0)/2) }

// hashSlotCount reads BORGO_HASH_SLOTS, the number of password hashes that may
// run at once. It is read once, when the package is initialised, because the
// semaphore it sizes is created there. A box tuned for login throughput raises
// it; a box that must keep every other route responsive under a login flood
// lowers it. A value that is not a positive integer is returned as a refusal
// alongside the default cap.
func hashSlotCount() (int, error) {
	v := os.Getenv("BORGO_HASH_SLOTS")
	if v == "" {
		return defaultHashSlots(), nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 1 {
		return defaultHashSlots(), fmt.Errorf(
			"borgo: BORGO_HASH_SLOTS: invalid value %q (want a positive integer; unset uses max(1, GOMAXPROCS/2) = %d)",
			v, defaultHashSlots(),
		)
	}
	return n, nil
}

// hashWait is how long a request queues for a slot before being shed; a var
// so tests need not wait it out.
var hashWait = 5 * time.Second

// withHashSlot runs hash while holding a slot. It reports false - having
// already answered the request - when the queue is too long, and when the
// client hung up before its turn came.
func withHashSlot(w http.ResponseWriter, r *http.Request, hash func()) bool {
	timer := time.NewTimer(hashWait)
	defer timer.Stop()
	select {
	case hashSlots <- struct{}{}:
		defer func() { <-hashSlots }()
		hash()
		return true
	case <-r.Context().Done():
		return false
	case <-timer.C:
		w.Header().Set("Retry-After", "1")
		WriteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "too many sign-in attempts in flight, retry"})
		return false
	}
}

func readCredentials(w http.ResponseWriter, r *http.Request) (Credentials, bool) {
	creds, err := Bind[Credentials](r)
	if err != nil {
		BindError(w, err)
		return Credentials{}, false
	}
	if creds.Username == "" || creds.Password == "" {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "username and password required"})
		return Credentials{}, false
	}
	return creds, true
}

// LoginHandler verifies the posted {username, password} against Lookup and
// starts a session with the principal, responding with it as JSON. Under more
// parallel attempts than the box can hash it answers 503 with Retry-After.
func (a *Auth[U]) LoginHandler(w http.ResponseWriter, r *http.Request) {
	creds, ok := readCredentials(w, r)
	if !ok {
		return
	}
	user, hash, err := a.Lookup(r.Context(), creds.Username)
	if err != nil {
		// verify a hash that cannot match rather than returning early, so a
		// missing user costs the same as a wrong password
		hash = a.dummyHash()
	}
	var verified bool
	if !withHashSlot(w, r, func() { verified = a.hasher().Verify(creds.Password, hash) }) {
		return
	}
	if err != nil || !verified {
		WriteJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid credentials"})
		return
	}
	principal := a.principal(user)
	if err := SetSession(w, principal, a.maxAge()); err != nil {
		log.Printf("borgo: session write failed: %v", err)
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": "session write failed"})
		return
	}
	WriteJSON(w, http.StatusOK, principal)
}

// LogoutHandler clears the session cookie.
func (a *Auth[U]) LogoutHandler(w http.ResponseWriter, r *http.Request) {
	ClearSession(w)
	w.WriteHeader(http.StatusNoContent)
}

// RegisterHandler hashes the posted password, creates the user through
// Register and starts a session, responding 201 with the principal. A taken
// username is a 409, which tells the caller the name exists: pair it with a
// generic message in the ui if that matters to you.
func (a *Auth[U]) RegisterHandler(w http.ResponseWriter, r *http.Request) {
	if a.Register == nil {
		http.NotFound(w, r)
		return
	}
	creds, ok := readCredentials(w, r)
	if !ok {
		return
	}
	var hash string
	var err error
	if !withHashSlot(w, r, func() { hash, err = a.hasher().Hash(creds.Password) }) {
		return
	}
	if err != nil {
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": "hashing failed"})
		return
	}
	// refuse before writing to the user store: creating an account we then
	// cannot issue a session for leaves the caller with a 500 and a username
	// that answers "taken" on the retry
	if sessionSecret() == "" {
		log.Print("borgo: register refused: " + ErrNoSessionSecret.Error())
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": "session write failed"})
		return
	}
	user, err := a.Register(r.Context(), creds.Username, hash)
	if errors.Is(err, ErrUserExists) {
		WriteJSON(w, http.StatusConflict, map[string]string{"error": "username taken"})
		return
	}
	if err != nil {
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": "registration failed"})
		return
	}
	principal := a.principal(user)
	if err := SetSession(w, principal, a.maxAge()); err != nil {
		log.Printf("borgo: session write failed: %v", err)
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": "session write failed"})
		return
	}
	WriteJSON(w, http.StatusCreated, principal)
}

// Authed guards an api route: without a valid session the request is answered
// 401 as JSON and the handler never runs. borgogen sees through the wrapper,
// so the route keeps its generated types. Pages guard themselves in their
// loader instead - see docs/auth-and-sessions.md.
func Authed(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !hasValidSession(r) {
			WriteJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthenticated"})
			return
		}
		next(w, r)
	}
}

func hasValidSession(r *http.Request) bool {
	_, ok := GetSession[json.RawMessage](r)
	return ok
}
