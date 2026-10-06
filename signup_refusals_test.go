package borgo

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// What the verifier of the step found unpinned: the forms the constraint
// admits but Signup must refuse, and every answer of the handler that no
// test held - the decoder's refusals through it, a failing hasher, a
// wrapped ErrUserExists, an app error, the session's principal and age, a
// saturated hash queue, and RegisterHandler honouring the Auth's fields.

type deepForm struct {
	signupBody
	Invite string `json:"invite"`
}

type ptrForm struct {
	*Credentials
	Email string `json:"email"`
}

type aliasForm = Credentials

type avatarForm struct {
	Credentials
	Avatar File `json:"avatar"`
}

type galleryForm struct {
	Credentials
	Albums map[string][]*File `json:"albums"`
}

type avatarPart struct {
	Avatar File `json:"avatar"`
}

// an unexported embedded pointer to a struct: encoding/json reads the
// exported fields it promotes, the File among them
type promotedFileForm struct {
	Credentials
	*avatarPart
}

type skippedFileForm struct {
	Credentials
	Avatar File `json:"-"`
	avatar File
	files
}

// an unexported embedded non-struct: encoding/json never reads it
type files []File

// a File in a signup form is one JSON never fills, while the typed client
// sends the form as multipart and gets 415 (found by the verifier of phase 5)
func TestSignupRefusesAFormHoldingAFile(t *testing.T) {
	auth := &Auth[signedUp]{}
	refused := func(name string, build func()) {
		t.Helper()
		defer func() {
			r := recover()
			if r == nil || !strings.Contains(fmt.Sprint(r), "holds a borgo.File") {
				t.Errorf("%s: want a refusal naming the file, got %v", name, r)
			}
		}()
		build()
	}
	refused("a File field", func() {
		Signup(auth, func(context.Context, avatarForm, string) (signedUp, error) { return signedUp{}, nil })
	})
	refused("a File promoted through an unexported embedded pointer", func() {
		Signup(auth, func(context.Context, promotedFileForm, string) (signedUp, error) { return signedUp{}, nil })
	})
	refused("files in a map of slices of pointers", func() {
		Signup(auth, func(context.Context, galleryForm, string) (signedUp, error) { return signedUp{}, nil })
	})
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("a File json never reads was refused: %v", r)
		}
	}()
	h := Signup(auth, func(context.Context, skippedFileForm, string) (signedUp, error) { return signedUp{}, nil })
	_ = skippedFileForm{}.avatar
	_ = h
}

// the compiler admits a form whose promoted method runs through a pointer a
// body of null leaves nil - and the first request would panic. Signup says
// no where it is built, by name; embedding by value at any depth is fine
func TestSignupRefusesAFormItCouldNotDecodeSafely(t *testing.T) {
	auth := &Auth[signedUp]{}
	accepted := func(name string, build func()) {
		t.Helper()
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("%s: refused: %v", name, r)
			}
		}()
		build()
	}
	refused := func(name string, build func()) {
		t.Helper()
		defer func() {
			r := recover()
			if r == nil || !strings.Contains(fmt.Sprint(r), "by value") {
				t.Errorf("%s: want a refusal naming the embedding by value, got %v", name, r)
			}
		}()
		build()
	}
	accepted("a struct embedding Credentials", func() {
		Signup(auth, func(context.Context, signupBody, string) (signedUp, error) { return signedUp{}, nil })
	})
	accepted("embedded two deep", func() {
		Signup(auth, func(context.Context, deepForm, string) (signedUp, error) { return signedUp{}, nil })
	})
	accepted("Credentials itself, by alias", func() {
		Signup(auth, func(context.Context, aliasForm, string) (signedUp, error) { return signedUp{}, nil })
	})
	refused("a struct embedding *Credentials", func() {
		Signup(auth, func(context.Context, ptrForm, string) (signedUp, error) { return signedUp{}, nil })
	})
	refused("a pointer to a form", func() {
		Signup(auth, func(context.Context, *signupBody, string) (signedUp, error) { return signedUp{}, nil })
	})
	refused("the interface itself", func() {
		Signup(auth, func(context.Context, SignupForm, string) (signedUp, error) { return signedUp{}, nil })
	})
	defer func() {
		if r := recover(); r == nil || !strings.Contains(fmt.Sprint(r), "auth is nil") {
			t.Errorf("Signup with a nil auth: %v", r)
		}
	}()
	Signup[signedUp, signupBody](nil, func(context.Context, signupBody, string) (signedUp, error) { return signedUp{}, nil })
}

type failingHasher struct{}

func (failingHasher) Hash(string) (string, error) { return "", errors.New("no entropy") }
func (failingHasher) Verify(string, string) bool  { return false }

// every answer between the decoder and the session, with the store watched
func TestSignupAnswersEveryFailureAndTouchesTheStoreOnlyOnSuccess(t *testing.T) {
	t.Setenv("SESSION_SECRET", "a-test-secret-of-at-least-32-bytes-long")
	var calls int
	var fail error
	auth := &Auth[signedUp]{MaxAge: time.Hour, Principal: func(u signedUp) any { return map[string]string{"username": u.Username} }}
	h := Signup(auth, func(ctx context.Context, form signupBody, hash string) (signedUp, error) {
		calls++
		if fail != nil {
			return signedUp{}, fail
		}
		return signedUp{Username: form.Username, Hash: hash}, nil
	})
	post := func(contentType, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
		r.Header.Set("Content-Type", contentType)
		w := httptest.NewRecorder()
		h(w, r)
		return w
	}
	good := `{"username":"ada","password":"pw123456","email":"a@x"}`

	// the decoder's own refusals reach the caller as BindError answers them
	if w := post("text/plain", good); w.Code != http.StatusUnsupportedMediaType {
		t.Errorf("text/plain: want 415, got %d", w.Code)
	}
	if w := post("application/json", `{"username":"ada","password":"pw","email":"`+strings.Repeat("x", 1<<20)+`"}`); w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("over the cap: want 413, got %d", w.Code)
	}
	if calls != 0 {
		t.Fatalf("a refused body reached register %d times", calls)
	}
	// a hasher that fails: 500, and no store
	auth.Hasher = failingHasher{}
	if w := post("application/json", good); w.Code != http.StatusInternalServerError || !strings.Contains(w.Body.String(), "hashing failed") || calls != 0 {
		t.Errorf("failing hasher: %d %s, register called %d times", w.Code, w.Body, calls)
	}
	auth.Hasher = nil
	// ErrUserExists wrapped is still the 409
	fail = fmt.Errorf("users: %w", ErrUserExists)
	if w := post("application/json", good); w.Code != http.StatusConflict {
		t.Errorf("wrapped ErrUserExists: want 409, got %d", w.Code)
	}
	// any other error of the app: 500 and no session
	fail = errors.New("disk on fire")
	if w := post("application/json", good); w.Code != http.StatusInternalServerError || !strings.Contains(w.Body.String(), "registration failed") || len(w.Result().Cookies()) != 0 {
		t.Errorf("an app error: %d %s, %d cookies", w.Code, w.Body, len(w.Result().Cookies()))
	}
	fail = nil
	// success: the cookie is the principal, for the Auth's MaxAge
	w := post("application/json", good)
	if w.Code != http.StatusCreated {
		t.Fatalf("want 201, got %d: %s", w.Code, w.Body)
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || cookies[0].MaxAge != 3600 {
		t.Fatalf("the session cookie: %+v", cookies)
	}
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.AddCookie(cookies[0])
	if s, ok := GetSession[map[string]string](r); !ok || s["username"] != "ada" || len(s) != 1 {
		t.Errorf("the session holds %v, want the principal", s)
	}
	// a principal the session cannot encode: 500 and no cookie (the store
	// was written, as documented: only SESSION_SECRET is checked before it)
	auth.Principal = func(signedUp) any { return map[string]any{"c": make(chan int)} }
	if w := post("application/json", good); w.Code != http.StatusInternalServerError || !strings.Contains(w.Body.String(), "session write failed") || len(w.Result().Cookies()) != 0 {
		t.Errorf("an unencodable principal: %d %s, %d cookies", w.Code, w.Body, len(w.Result().Cookies()))
	}
}

// with every hashing slot busy the answer is 503, and the store is never
// asked: a handler that went on after the shed would register with an
// empty hash
func TestSignupShedsBeforeTheStore(t *testing.T) {
	t.Setenv("SESSION_SECRET", "a-test-secret-of-at-least-32-bytes-long")
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
	var calls int
	h := Signup(&Auth[signedUp]{}, func(ctx context.Context, form signupBody, hash string) (signedUp, error) {
		calls++
		return signedUp{}, nil
	})
	w := postJSON(h, `{"username":"ada","password":"pw123456","email":"a@x"}`)
	if w.Code != http.StatusServiceUnavailable || w.Header().Get("Retry-After") == "" {
		t.Fatalf("want 503 with Retry-After, got %d", w.Code)
	}
	if calls != 0 {
		t.Fatalf("register was called %d times after the shed", calls)
	}
}

type recordingHasher struct{ hashed []string }

func (r *recordingHasher) Hash(p string) (string, error) {
	r.hashed = append(r.hashed, p)
	return "h:" + p, nil
}
func (r *recordingHasher) Verify(p, h string) bool { return h == "h:"+p }

// RegisterHandler is Signup over the same Auth: its Principal, Hasher and
// MaxAge are the ones in force
func TestRegisterHandlerHonoursTheAuthsFields(t *testing.T) {
	auth, users := testAuth(t)
	hasher := &recordingHasher{}
	auth.Hasher = hasher
	auth.MaxAge = 2 * time.Hour
	auth.Principal = func(u testUser) any { return map[string]string{"who": u.Name} }
	w := postJSON(auth.RegisterHandler, `{"username":"newby","password":"pw123456"}`)
	if w.Code != http.StatusCreated || !strings.Contains(w.Body.String(), `"who":"newby"`) {
		t.Fatalf("want 201 with the principal, got %d: %s", w.Code, w.Body)
	}
	if users["newby"] != "h:pw123456" || len(hasher.hashed) != 1 {
		t.Errorf("the Auth's hasher was not the one used: stored %q, hashed %v", users["newby"], hasher.hashed)
	}
	if c := w.Result().Cookies(); len(c) != 1 || c[0].MaxAge != 7200 {
		t.Errorf("the Auth's MaxAge was not the cookie's: %+v", c)
	}
}
