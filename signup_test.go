package borgo

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// the form piazza wanted and RegisterHandler could not take
type signupBody struct {
	Credentials
	Email string `json:"email"`
	Name  string `json:"name"`
}

type signedUp struct {
	Username, Email, Name, Hash string
}

func testSignup(t *testing.T) (http.HandlerFunc, map[string]signedUp) {
	t.Helper()
	t.Setenv("SESSION_SECRET", "a-test-secret-of-at-least-32-bytes-long")
	users := map[string]signedUp{"luigi": {Username: "luigi"}}
	auth := &Auth[signedUp]{
		Lookup: func(ctx context.Context, username string) (signedUp, string, error) {
			u, ok := users[username]
			if !ok {
				return signedUp{}, "", ErrUserExists
			}
			return u, u.Hash, nil
		},
		Principal: func(u signedUp) any { return map[string]string{"username": u.Username, "email": u.Email} },
	}
	h := Signup(auth, func(ctx context.Context, form signupBody, hash string) (signedUp, error) {
		if _, taken := users[form.Username]; taken {
			return signedUp{}, ErrUserExists
		}
		u := signedUp{Username: form.Username, Email: form.Email, Name: form.Name, Hash: hash}
		users[form.Username] = u
		return u, nil
	})
	return h, users
}

// a body of the app's shape reaches register whole, the password reaches it
// hashed, and the session and the 201 are RegisterHandler's
func TestSignupTakesTheAppsOwnForm(t *testing.T) {
	h, users := testSignup(t)
	w := postJSON(h, `{"username":"ada","password":"pw123456","email":"ada@example.test","name":"Ada"}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("want 201, got %d: %s", w.Code, w.Body)
	}
	if len(w.Result().Cookies()) != 1 {
		t.Fatal("signup must start a session")
	}
	u := users["ada"]
	if u.Email != "ada@example.test" || u.Name != "Ada" {
		t.Errorf("the form did not reach register whole: %+v", u)
	}
	if u.Hash == "pw123456" || !DefaultHasher().Verify("pw123456", u.Hash) {
		t.Errorf("the password reached register as %q", u.Hash)
	}
	var principal map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &principal); err != nil || principal["email"] != "ada@example.test" {
		t.Errorf("the response is not the principal: %s", w.Body)
	}
}

// the refusals of RegisterHandler, on the wider form
func TestSignupRefusesWhatRegisterHandlerRefuses(t *testing.T) {
	h, users := testSignup(t)
	for body, want := range map[string]int{
		`{"email":"x@y","password":"pw"}`:                    http.StatusBadRequest, // no username
		`{"username":"x","email":"x@y"}`:                     http.StatusBadRequest, // no password
		`{"username":"luigi","password":"pw","email":"l@x"}`: http.StatusConflict,   // taken
		`not json`: http.StatusBadRequest,
	} {
		if w := postJSON(h, body); w.Code != want {
			t.Errorf("%s: want %d, got %d: %s", body, want, w.Code, w.Body)
		}
	}
	if _, created := users["x"]; created {
		t.Error("a refused form reached the store")
	}
	// the store is never written when no session could follow
	t.Setenv("SESSION_SECRET", "")
	if w := postJSON(h, `{"username":"nobody","password":"pw123456","email":"n@x"}`); w.Code != http.StatusInternalServerError {
		t.Errorf("without a session secret: want 500, got %d", w.Code)
	}
	if _, created := users["nobody"]; created {
		t.Error("a user was created that no session could be issued for")
	}
}

// RegisterHandler is Signup over Credentials alone: the same handler, the
// same answers, so an app that never needed more sees nothing change
func TestRegisterHandlerIsSignupOverCredentials(t *testing.T) {
	auth, users := testAuth(t)
	w := postJSON(auth.RegisterHandler, `{"username":"newby","password":"pw123456","email":"ignored@x"}`)
	if w.Code != http.StatusCreated || !DefaultHasher().Verify("pw123456", users["newby"]) {
		t.Fatalf("want 201 with the hash stored, got %d: %s", w.Code, w.Body)
	}
	defer func() {
		if r := recover(); r == nil || !strings.Contains(r.(string), "register is nil") {
			t.Errorf("Signup with a nil register: %v", r)
		}
	}()
	Signup[signedUp, Credentials](&Auth[signedUp]{}, nil)
}
