package borgo

import (
	"net/http/httptest"
	"testing"
)

// the go half must give the same verdicts as apiCsrfRejects in util.ts: the
// bun suite's csrf.test.ts is the table this mirrors
func TestApiCsrfRejectsMirrorsTheFrontServer(t *testing.T) {
	cases := []struct {
		method, cookie, header string
		want                   bool
	}{
		{"GET", "borgo_csrf=t", "", false},
		{"HEAD", "borgo_csrf=t", "", false},
		{"OPTIONS", "borgo_csrf=t", "", false},
		{"POST", "", "", false},                // no cookie: not a browser this page armed
		{"POST", "borgo_session=s", "", false}, // the /api half arms on the csrf cookie alone
		{"POST", "borgo_csrf=t", "", true},     // armed, no echo
		{"POST", "borgo_csrf=t", "x", true},    // wrong echo
		{"POST", "borgo_csrf=t", "t", false},   // the echo
		{"PUT", "borgo_csrf=t", "t", false},
		{"DELETE", "borgo_csrf=t", "", true},
		{"POST", "borgo_csrf=t; borgo_csrf=u", "t", true}, // a tossed duplicate is no token
		{"POST", "borgo_csrf=t; borgo_csrf=u", "u", true}, // whichever of the two is echoed
		{"POST", "borgo_csrf=t; borgo_csrf=t", "t", false},
		{"POST", "borgo_csrf=t; borgo_csrf=a b", "t", true}, // a duplicate net/http would drop still disagrees, as it does in bun
		{"POST", "borgo_csrf=", "", true},                   // present and empty: armed, unreadable
	}
	for _, c := range cases {
		r := httptest.NewRequest(c.method, "/api/x", nil)
		if c.cookie != "" {
			r.Header.Set("Cookie", c.cookie)
		}
		if c.header != "" {
			r.Header.Set(csrfHeader, c.header)
		}
		if got := apiCsrfRejects(r); got != c.want {
			t.Errorf("%s cookie=%q header=%q: rejects=%v, want %v", c.method, c.cookie, c.header, got, c.want)
		}
	}
}

func TestCsrfEnforcedFollowsTheFrontServersRule(t *testing.T) {
	for _, c := range []struct {
		csrf, dev string
		want      bool
	}{
		{"", "", true},   // production by default
		{"", "1", false}, // off in dev
		{"", "0", true},  // explicitly not dev
		{"1", "1", true}, // BORGO_CSRF decides either way
		{"0", "", false},
		{"true", "1", true},
	} {
		t.Setenv("BORGO_CSRF", c.csrf)
		t.Setenv("BORGO_DEV", c.dev)
		got, err := csrfEnforced()
		if err != nil || got != c.want {
			t.Errorf("BORGO_CSRF=%q BORGO_DEV=%q: %v %v, want %v", c.csrf, c.dev, got, err, c.want)
		}
	}
	t.Setenv("BORGO_CSRF", "yes")
	if _, err := csrfEnforced(); err == nil {
		t.Error("BORGO_CSRF=yes was read as something")
	}
}
