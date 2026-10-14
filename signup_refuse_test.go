package borgo

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

// a form that validates itself, in the app's words
type validatedSignup struct {
	Credentials
	Email string `json:"email"`
}

func (f validatedSignup) Validate() error {
	switch {
	case f.Email == "plain":
		return errors.New("an email is needed")
	case !strings.Contains(f.Email, "@"):
		return Refuse(http.StatusBadRequest, map[string]string{"error": "not an email address", "field": "email"})
	}
	return nil
}

type countingHasher struct{ hashes atomic.Int32 }

func (h *countingHasher) Hash(password string) (string, error) {
	h.hashes.Add(1)
	return "hashed:" + password, nil
}

func (h *countingHasher) Verify(password, hash string) bool { return hash == "hashed:"+password }

// every refusal of the app's was a 500 "registration failed", an email
// already registered said "username taken", and a malformed form was hashed
// before it was refused (found rebuilding piazza on 0.30)
func TestSignupAnswersTheAppsOwnRefusals(t *testing.T) {
	t.Setenv("SESSION_SECRET", "a-test-secret-of-at-least-32-bytes-long")
	hasher := &countingHasher{}
	auth := &Auth[validatedSignup]{Hasher: hasher, Principal: func(u validatedSignup) any { return u.Username }}
	h := Signup(auth, func(ctx context.Context, form validatedSignup, hash string) (validatedSignup, error) {
		if form.Email == "taken@example.test" {
			return validatedSignup{}, Refuse(http.StatusConflict, map[string]string{"error": "that email is already registered", "field": "email"})
		}
		if form.Email == "teapot@example.test" {
			return validatedSignup{}, Refuse(200, "an ok status is not a refusal")
		}
		return form, nil
	})

	w := postJSON(h, `{"username":"ada","password":"pw123456","email":"nope"}`)
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), `"field":"email"`) {
		t.Errorf("a refusal from Validate: %d %s", w.Code, w.Body)
	}
	w = postJSON(h, `{"username":"ada","password":"pw123456","email":"plain"}`)
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "an email is needed") {
		t.Errorf("a plain error from Validate: %d %s", w.Code, w.Body)
	}
	if n := hasher.hashes.Load(); n != 0 {
		t.Errorf("a refused form was hashed %d times", n)
	}
	w = postJSON(h, `{"username":"ada","password":"pw123456","email":"taken@example.test"}`)
	if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "already registered") {
		t.Errorf("a refusal from register: %d %s", w.Code, w.Body)
	}
	w = postJSON(h, `{"username":"ada","password":"pw123456","email":"teapot@example.test"}`)
	if w.Code != http.StatusBadRequest {
		t.Errorf("a refusal with a status that is not one: %d %s", w.Code, w.Body)
	}
	w = postJSON(h, `{"username":"ada","password":"pw123456","email":"ada@example.test"}`)
	if w.Code != http.StatusCreated {
		t.Errorf("a good form: %d %s", w.Code, w.Body)
	}
}
