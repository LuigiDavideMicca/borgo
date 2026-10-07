package borgo

import (
	"net/http/httptest"
	"testing"
	"time"
)

// the cost of one session read on its own: what every Authed route and every
// page render behind the front pays per request
func BenchmarkGetSession(b *testing.B) {
	b.Setenv("SESSION_SECRET", "bench-session-secret-0123456789abcdefghij")
	w := httptest.NewRecorder()
	type user struct {
		ID    uint     `json:"id"`
		Name  string   `json:"name"`
		Roles []string `json:"roles"`
	}
	if err := SetSession(w, user{ID: 7, Name: "ann", Roles: []string{"admin", "editor"}}, time.Hour); err != nil {
		b.Fatal(err)
	}
	r := httptest.NewRequest("GET", "/", nil)
	for _, c := range w.Result().Cookies() {
		r.AddCookie(c)
	}
	b.ReportAllocs()
	for b.Loop() {
		if _, ok := GetSession[user](r); !ok {
			b.Fatal("no session")
		}
	}
}
