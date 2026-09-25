package borgo

import (
	"strings"
	"testing"
)

func TestWSAllowNoOriginReadsEveryBorgoBoolean(t *testing.T) {
	for _, tc := range []struct {
		value string
		want  bool
		err   string
	}{
		{"", false, ""},
		{"1", true, ""},
		{"true", true, ""},
		{"0", false, ""},
		{"false", false, ""},
		// the value a client was once told to set: refused at boot, as every
		// other boolean refuses it, and the refusal text says "=1" now
		{"yes", false, "invalid value"},
		{"on", false, "invalid value"},
		{"1\r", false, "control character at position 1"},
	} {
		t.Setenv("BORGO_WS_ALLOW_NO_ORIGIN", tc.value)
		got, err := wsAllowNoOriginFromEnv()
		if tc.err != "" {
			if err == nil || !strings.Contains(err.Error(), tc.err) {
				t.Errorf("%q: want an error saying %q, got %v", tc.value, tc.err, err)
			}
			continue
		}
		if err != nil || got != tc.want {
			t.Errorf("%q: got %v, %v; want %v", tc.value, got, err, tc.want)
		}
	}
}
