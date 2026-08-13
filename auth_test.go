package borgo

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

type testUser struct {
	Name string `json:"name"`
}

func testAuth(t *testing.T) (*Auth[testUser], map[string]string) {
	t.Helper()
	t.Setenv("SESSION_SECRET", "test-secret-long-enough-to-be-a-key")
	hash, err := DefaultHasher().Hash("hunter22")
	if err != nil {
		t.Fatal(err)
	}
	users := map[string]string{"luigi": hash}
	auth := &Auth[testUser]{
		Lookup: func(ctx context.Context, username string) (testUser, string, error) {
			h, ok := users[username]
			if !ok {
				return testUser{}, "", errors.New("no such user")
			}
			return testUser{Name: username}, h, nil
		},
		Register: func(ctx context.Context, username, hash string) (testUser, error) {
			if _, taken := users[username]; taken {
				return testUser{}, ErrUserExists
			}
			users[username] = hash
			return testUser{Name: username}, nil
		},
	}
	return auth, users
}

func postJSON(handler http.HandlerFunc, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler(w, r)
	return w
}

func TestHasherRoundTrip(t *testing.T) {
	hash, err := DefaultHasher().Hash("s3cret")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(hash, "pbkdf2$600000$") {
		t.Errorf("hash format wrong: %s", hash)
	}
	if !DefaultHasher().Verify("s3cret", hash) {
		t.Error("correct password rejected")
	}
	if DefaultHasher().Verify("wrong", hash) {
		t.Error("wrong password accepted")
	}
	again, _ := DefaultHasher().Hash("s3cret")
	if again == hash {
		t.Error("two hashes of the same password must differ (random salt)")
	}
}

type swappedHasher struct{}

func (swappedHasher) Hash(string) (string, error) { return "swapped$anything", nil }
func (swappedHasher) Verify(string, string) bool  { return true }

// DefaultHasher used to be a package-level var of interface type, so any code
// in the process - a dependency, a test helper, an init() three modules away -
// could reassign it and silently change password hashing for every Auth that
// had not set its own Hasher. A caller can now only rebind its own copy.
func TestDefaultHasherCannotBeSwappedAtADistance(t *testing.T) {
	stolen := DefaultHasher()
	// the whole of what a caller can do to the value it is handed
	stolen = swappedHasher{}
	if _, ok := stolen.(swappedHasher); !ok {
		t.Fatal("the local really should have been rebound")
	}

	if _, ok := DefaultHasher().(pbkdf2Hasher); !ok {
		t.Fatalf("DefaultHasher() = %T after a caller rebound its copy, want pbkdf2Hasher", DefaultHasher())
	}
	var auth Auth[testUser]
	if _, ok := auth.hasher().(pbkdf2Hasher); !ok {
		t.Fatalf("an Auth with no Hasher fell back to %T, want pbkdf2Hasher", auth.hasher())
	}
	// and the fallback still produces real pbkdf2 hashes, not swappedHasher's
	hash, err := auth.hasher().Hash("hunter22")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(hash, "pbkdf2$") {
		t.Fatalf("fallback hasher produced %q", hash)
	}
	if auth.hasher().Verify("wrong", hash) {
		t.Fatal("the fallback hasher accepts any password: it was swapped")
	}
}

// the property above is a compile-time one, so it is worth checking at the
// source: nothing exported may hold a PasswordHasher in a package-level var,
// and DefaultHasher must be a func.
func TestNoExportedPasswordHasherVariable(t *testing.T) {
	fset := token.NewFileSet()
	pkg, err := parser.ParseDir(fset, ".", func(fi os.FileInfo) bool {
		return !strings.HasSuffix(fi.Name(), "_test.go")
	}, 0)
	if err != nil {
		t.Fatal(err)
	}
	files := pkg["borgo"]
	if files == nil {
		t.Fatal("package borgo not found in the working directory")
	}

	var defaultHasherIsFunc bool
	for name, file := range files.Files {
		for _, decl := range file.Decls {
			switch d := decl.(type) {
			case *ast.FuncDecl:
				if d.Recv == nil && d.Name.Name == "DefaultHasher" {
					defaultHasherIsFunc = true
				}
			case *ast.GenDecl:
				if d.Tok != token.VAR {
					continue
				}
				for _, spec := range d.Specs {
					value, ok := spec.(*ast.ValueSpec)
					if !ok {
						continue
					}
					ident, isIdent := value.Type.(*ast.Ident)
					if !isIdent || ident.Name != "PasswordHasher" {
						continue
					}
					for _, n := range value.Names {
						if n.IsExported() {
							t.Errorf("%s: exported var %s PasswordHasher: any code in the process could reassign it and change hashing for every Auth; make it a func", name, n.Name)
						}
					}
				}
			}
		}
	}
	if !defaultHasherIsFunc {
		t.Error("DefaultHasher must be declared as a func, not a var")
	}
}

func TestHashSlotsDefault(t *testing.T) {
	t.Setenv("BORGO_HASH_SLOTS", "")
	got, err := hashSlotCount()
	if err != nil {
		t.Fatal(err)
	}
	if want := defaultHashSlots(); got != want {
		t.Fatalf("unset BORGO_HASH_SLOTS gives %d slots, want the previous default %d", got, want)
	}
	if want := max(1, runtime.GOMAXPROCS(0)/2); defaultHashSlots() != want {
		t.Fatalf("default = %d, want max(1, GOMAXPROCS/2) = %d", defaultHashSlots(), want)
	}
}

func TestHashSlotsOverride(t *testing.T) {
	for _, v := range []string{"1", "3", "64"} {
		t.Setenv("BORGO_HASH_SLOTS", v)
		want, _ := strconv.Atoi(v)
		got, err := hashSlotCount()
		if err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Errorf("BORGO_HASH_SLOTS=%s gives %d slots, want %d", v, got, want)
		}
	}
}

// a typo that silently fell back to the default would quietly reinstate the
// cpu exhaustion vector the cap exists to close, exactly like a malformed
// BORGO_*_TIMEOUT. It is refused as a value, not as a panic: this is read
// during package init, where a panic kills the importing binary outright
func TestHashSlotsRejectsGarbage(t *testing.T) {
	for _, v := range []string{"lots", "0", "-4", "2.5", "8 ", "1e3", "99999999999999999999"} {
		t.Run(v, func(t *testing.T) {
			t.Setenv("BORGO_HASH_SLOTS", v)
			n, err := hashSlotCount()
			if err == nil {
				t.Fatalf("BORGO_HASH_SLOTS=%q was accepted as %d slots", v, n)
			}
			if !strings.Contains(err.Error(), "BORGO_HASH_SLOTS") {
				t.Fatalf("error does not name the variable: %v", err)
			}
			if n != defaultHashSlots() {
				t.Fatalf("refused value left the cap at %d, want the default %d", n, defaultHashSlots())
			}
		})
	}
}

// the refused value falls back to a cap the operator did not choose, so it has
// to reach somebody who can act on it: CheckEnv is where a program that has
// started can still be told. It re-reads rather than replaying what init found,
// or the refusal outlives the correction and every later boot is dead for a
// variable that is no longer wrong.
func TestCheckEnvRefusesAndThenForgivesTheHashSlotCount(t *testing.T) {
	log.SetOutput(io.Discard)
	defer log.SetOutput(os.Stderr)

	t.Setenv("BORGO_HASH_SLOTS", "lots")
	err := CheckEnv()
	if err == nil || !strings.Contains(err.Error(), "BORGO_HASH_SLOTS") {
		t.Fatalf("CheckEnv returned %v, want the BORGO_HASH_SLOTS refusal", err)
	}

	t.Setenv("BORGO_HASH_SLOTS", strconv.Itoa(cap(hashSlots)))
	if err := CheckEnv(); err != nil {
		t.Fatalf("CheckEnv still refuses a corrected value: %v", err)
	}
}

// and a corrected value that arrives too late to size the semaphore is said out
// loud: silently serving a cap the operator did not ask for is the same shape
// as silently serving a default
func TestCheckEnvSaysACorrectedSlotCountArrivedTooLate(t *testing.T) {
	var logs strings.Builder
	log.SetOutput(&logs)
	defer log.SetOutput(os.Stderr)

	t.Setenv("BORGO_HASH_SLOTS", strconv.Itoa(cap(hashSlots)+7))
	if err := CheckEnv(); err != nil {
		t.Fatalf("a valid value was refused: %v", err)
	}
	if !strings.Contains(logs.String(), "BORGO_HASH_SLOTS") {
		t.Fatalf("nothing said the cap is not the one asked for: %q", logs.String())
	}
}

// the semaphore the package actually uses must be the configured size
func TestHashSlotsSizeTheSemaphore(t *testing.T) {
	want, err := hashSlotCount()
	if err != nil {
		t.Fatal(err)
	}
	if got := cap(hashSlots); got != want {
		t.Fatalf("hashSlots has %d slots, want %d", got, want)
	}
}

// go test cannot see this one: the panic it replaces happened while the package
// under test was initialising, which is before any test binary reaches a test.
// So the assertion is a binary of its own - it imports borgo, never serves, and
// is run with a value borgo refuses. It must start, reach main, and report;
// dying at init with exit 2 is a library killing the process that hosts it,
// and every tool that only imports borgo dies with it.
func TestARefusedHashSlotCountDoesNotKillAnImporter(t *testing.T) {
	if testing.Short() {
		t.Skip("builds a second binary")
	}
	exe := buildImporter(t)
	cmd := exec.Command(exe)
	cmd.Env = append(os.Environ(), "BORGO_HASH_SLOTS=lots")
	var stdout, stderr strings.Builder
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	out := stdout.String() + stderr.String()
	if err != nil {
		t.Fatalf("a binary that only imports borgo died on BORGO_HASH_SLOTS=lots: %v\n%s", err, out)
	}
	if !strings.Contains(stdout.String(), "reached main") {
		t.Fatalf("the importer never reached main: %s", out)
	}
	// it survived - now it must not be left guessing why its cap is not the one
	// it asked for. The log is all a binary that only imports borgo ever sees
	if !strings.Contains(stderr.String(), "BORGO_HASH_SLOTS") {
		t.Fatalf("package init did not report the refused value: %s", out)
	}
	if !strings.Contains(stdout.String(), "CheckEnv: ") || !strings.Contains(stdout.String(), "BORGO_HASH_SLOTS") {
		t.Fatalf("CheckEnv did not return the refusal: %s", out)
	}
}

// buildImporter builds the binary under testdata that imports borgo and never
// serves, and returns its path.
func buildImporter(t *testing.T) string {
	t.Helper()
	exe := filepath.Join(t.TempDir(), "importer.exe")
	build := exec.Command("go", "build", "-o", exe, "./testdata/importer")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("building the importer: %v\n%s", err, out)
	}
	return exe
}

// the cap is taken at init and cannot be resized, so every later disagreement
// with the environment has to be said out loud - including the one an in-process
// unset creates, which a notice guarded on the variable being set cannot see:
// the environment then asks for the default while the process runs at whatever
// init gave it. Needs a cap that is not the default, so it needs its own process.
func TestCheckEnvSaysTheCapNoLongerMatchesAnUnsetVariable(t *testing.T) {
	if testing.Short() {
		t.Skip("builds a second binary")
	}
	slots := defaultHashSlots() + 7
	cmd := exec.Command(buildImporter(t))
	cmd.Env = append(os.Environ(),
		"BORGO_HASH_SLOTS="+strconv.Itoa(slots),
		"IMPORTER_UNSETS_HASH_SLOTS=1",
	)
	var stdout, stderr strings.Builder
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("the importer died: %v\n%s%s", err, stdout.String(), stderr.String())
	}
	want := fmt.Sprintf("fixed at %d", slots)
	if !strings.Contains(stderr.String(), want) {
		t.Fatalf("unsetting BORGO_HASH_SLOTS under a cap of %d said nothing: %q", slots, stderr.String())
	}
}

func TestHasherRejectsMalformed(t *testing.T) {
	for _, hash := range []string{"", "plain", "pbkdf2$abc$x$y", "pbkdf2$1000$!!$!!", "argon2$1$a$b"} {
		if DefaultHasher().Verify("anything", hash) {
			t.Errorf("malformed hash %q verified", hash)
		}
	}
}

// a stored hash chooses the work Verify does, so a planted row must not be
// able to turn one login attempt into minutes of cpu on a hash slot
func TestHasherRejectsAbsurdParameters(t *testing.T) {
	enc := base64.RawURLEncoding
	salt := make([]byte, pbkdf2SaltLen)
	key := make([]byte, 32*1024)
	crafted := map[string]string{
		"32 KB key":           fmt.Sprintf("pbkdf2$%d$%s$%s", pbkdf2Iterations, enc.EncodeToString(salt), enc.EncodeToString(key)),
		"a billion rounds":    fmt.Sprintf("pbkdf2$%d$%s$%s", 1_000_000_000, enc.EncodeToString(salt), enc.EncodeToString(key[:pbkdf2KeyLen])),
		"one-byte key":        fmt.Sprintf("pbkdf2$%d$%s$%s", pbkdf2Iterations, enc.EncodeToString(salt), enc.EncodeToString(key[:1])),
		"more digits than go": fmt.Sprintf("pbkdf2$%s$%s$%s", strings.Repeat("9", 30), enc.EncodeToString(salt), enc.EncodeToString(key[:pbkdf2KeyLen])),
	}
	for name, hash := range crafted {
		start := time.Now()
		if DefaultHasher().Verify("anything", hash) {
			t.Errorf("%s: crafted hash verified", name)
		}
		// a real verify is ~100 ms; anything in this ballpark means the
		// crafted parameters were honoured
		if elapsed := time.Since(start); elapsed > 20*time.Millisecond {
			t.Errorf("%s: rejected only after %v of work", name, elapsed)
		}
	}
	// the parameters borgo itself writes keep verifying
	hash, err := DefaultHasher().Hash("hunter22")
	if err != nil {
		t.Fatal(err)
	}
	if !DefaultHasher().Verify("hunter22", hash) {
		t.Error("a hash from the default hasher must still verify")
	}
}

func TestLoginHandler(t *testing.T) {
	auth, _ := testAuth(t)

	w := postJSON(auth.LoginHandler, `{"username":"luigi","password":"hunter22"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", w.Code, w.Body)
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != "borgo_session" {
		t.Fatalf("want session cookie, got %+v", cookies)
	}
	r := sessionRequest(cookies[0])
	principal, ok := GetSession[testUser](r)
	if !ok || principal.Name != "luigi" {
		t.Fatalf("session principal wrong: %+v ok=%v", principal, ok)
	}

	for name, body := range map[string]string{
		"wrong password": `{"username":"luigi","password":"nope"}`,
		"unknown user":   `{"username":"ghost","password":"hunter22"}`,
	} {
		if w := postJSON(auth.LoginHandler, body); w.Code != http.StatusUnauthorized {
			t.Errorf("%s: want 401, got %d", name, w.Code)
		}
	}
	for name, body := range map[string]string{
		"empty fields": `{"username":"","password":""}`,
		"not json":     `not json`,
	} {
		if w := postJSON(auth.LoginHandler, body); w.Code != http.StatusBadRequest {
			t.Errorf("%s: want 400, got %d", name, w.Code)
		}
	}
}

func TestLoginCustomPrincipal(t *testing.T) {
	auth, _ := testAuth(t)
	auth.Principal = func(u testUser) any { return map[string]string{"user": u.Name} }

	w := postJSON(auth.LoginHandler, `{"username":"luigi","password":"hunter22"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", w.Code)
	}
	principal, ok := GetSession[map[string]string](sessionRequest(w.Result().Cookies()[0]))
	if !ok || principal["user"] != "luigi" {
		t.Fatalf("custom principal wrong: %+v", principal)
	}
}

func TestRegisterHandler(t *testing.T) {
	auth, users := testAuth(t)

	w := postJSON(auth.RegisterHandler, `{"username":"newby","password":"pw123456"}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("want 201, got %d: %s", w.Code, w.Body)
	}
	if len(w.Result().Cookies()) != 1 {
		t.Fatal("register must start a session")
	}
	if !DefaultHasher().Verify("pw123456", users["newby"]) {
		t.Error("stored hash does not verify")
	}

	if w := postJSON(auth.RegisterHandler, `{"username":"luigi","password":"pw"}`); w.Code != http.StatusConflict {
		t.Errorf("taken username: want 409, got %d", w.Code)
	}

	auth.Register = nil
	if w := postJSON(auth.RegisterHandler, `{"username":"x","password":"y"}`); w.Code != http.StatusNotFound {
		t.Errorf("no register provider: want 404, got %d", w.Code)
	}
}

func TestLogoutHandler(t *testing.T) {
	auth, _ := testAuth(t)
	w := postJSON(auth.LogoutHandler, "")
	if w.Code != http.StatusNoContent {
		t.Fatalf("want 204, got %d", w.Code)
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || cookies[0].MaxAge != -1 {
		t.Fatalf("logout must clear the cookie: %+v", cookies)
	}
}

func TestLoginShedsLoadWhenSaturated(t *testing.T) {
	auth, _ := testAuth(t)
	prev := hashWait
	hashWait = 20 * time.Millisecond
	defer func() { hashWait = prev }()

	for range cap(hashSlots) {
		hashSlots <- struct{}{}
	}
	defer func() {
		for range cap(hashSlots) {
			<-hashSlots
		}
	}()

	w := postJSON(auth.LoginHandler, `{"username":"luigi","password":"hunter22"}`)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("want 503 when every hashing slot is busy, got %d", w.Code)
	}
	if w.Header().Get("Retry-After") == "" {
		t.Error("a 503 must carry Retry-After")
	}
}

func TestLoginUnderConcurrency(t *testing.T) {
	auth, _ := testAuth(t)
	// hashing is an order of magnitude slower under the race detector: this
	// asserts that queued logins all get served, not how fast
	prev := hashWait
	hashWait = time.Minute
	defer func() { hashWait = prev }()

	var wg sync.WaitGroup
	codes := make([]int, 12)
	for i := range codes {
		wg.Add(1)
		go func() {
			defer wg.Done()
			body := `{"username":"luigi","password":"hunter22"}`
			if i%3 == 0 {
				body = `{"username":"ghost","password":"hunter22"}`
			}
			codes[i] = postJSON(auth.LoginHandler, body).Code
		}()
	}
	wg.Wait()

	for i, code := range codes {
		want := http.StatusOK
		if i%3 == 0 {
			want = http.StatusUnauthorized
		}
		if code != want {
			t.Errorf("login %d: got %d, want %d", i, code, want)
		}
	}
	if len(hashSlots) != 0 {
		t.Fatalf("%d hashing slots leaked", len(hashSlots))
	}
}

// a rotated cookie on login is what keeps a planted session from surviving
// the privilege change
func TestLoginReplacesAnExistingSession(t *testing.T) {
	auth, _ := testAuth(t)

	planted := setAndExtract(t, testUser{Name: "attacker"}, time.Hour)
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"username":"luigi","password":"hunter22"}`))
	r.Header.Set("Content-Type", "application/json")
	r.AddCookie(planted)
	w := httptest.NewRecorder()
	auth.LoginHandler(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", w.Code)
	}
	fresh := w.Result().Cookies()
	if len(fresh) != 1 || fresh[0].Value == planted.Value {
		t.Fatalf("login must issue a new session cookie, got %+v", fresh)
	}
	principal, ok := GetSession[testUser](sessionRequest(fresh[0]))
	if !ok || principal.Name != "luigi" {
		t.Fatalf("session still holds %+v", principal)
	}
}

func TestAuthed(t *testing.T) {
	t.Setenv("SESSION_SECRET", "test-secret-long-enough-to-be-a-key")
	handler := Authed(func(w http.ResponseWriter, r *http.Request) {
		WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})

	w := httptest.NewRecorder()
	handler(w, sessionRequest(nil))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("no session: want 401, got %d", w.Code)
	}
	var body map[string]string
	if json.Unmarshal(w.Body.Bytes(), &body) != nil || body["error"] == "" {
		t.Fatalf("401 must be json with an error: %s", w.Body)
	}

	cookie := setAndExtract(t, testUser{Name: "luigi"}, time.Hour)
	w = httptest.NewRecorder()
	handler(w, sessionRequest(cookie))
	if w.Code != http.StatusOK {
		t.Fatalf("valid session: want 200, got %d", w.Code)
	}

	w = httptest.NewRecorder()
	handler(w, sessionRequest(&http.Cookie{Name: "borgo_session", Value: "forged.sig"}))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("forged session: want 401, got %d", w.Code)
	}
}

func TestRegisterRefusesBeforeTouchingTheStore(t *testing.T) {
	t.Setenv("SESSION_SECRET", "")
	created := false
	auth := Auth[testUser]{
		Lookup: func(context.Context, string) (testUser, string, error) { return testUser{}, "", errors.New("no user") },
		Register: func(_ context.Context, username, hash string) (testUser, error) {
			created = true
			return testUser{Name: username}, nil
		},
	}
	req := httptest.NewRequest("POST", "/api/register", strings.NewReader(`{"username":"ada","password":"hunter22"}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	auth.RegisterHandler(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("want 500, got %d", w.Code)
	}
	// the account must not exist: it could never be logged into, and the
	// retry would answer "username taken"
	if created {
		t.Fatal("register wrote to the store despite having no session secret")
	}
}
