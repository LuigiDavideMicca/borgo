package borgo

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// testdata/env_parity.json is what env.ts's own parser answers for each
// string (written by env-parity.test.ts in the bun suite, which holds the
// file to it): the go side must give the same value or the same words
func TestReadEnvAgreesWithEnvTs(t *testing.T) {
	b, err := os.ReadFile("testdata/env_parity.json")
	if err != nil {
		t.Fatal(err)
	}
	var rows []struct {
		Type  string `json:"type"`
		Raw   string `json:"raw"`
		OK    bool   `json:"ok"`
		Value any    `json:"value"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(b, &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) < 50 {
		t.Fatalf("only %d rows", len(rows))
	}
	for _, row := range rows {
		t.Setenv("V", row.Raw)
		got, err := ReadEnv([]EnvVar{{Name: "V", Type: row.Type}})
		if !row.OK {
			if err == nil || !strings.HasSuffix(err.Error(), "\n  - "+row.Error) {
				t.Errorf("%s %q: want refused with %q, got %v %v", row.Type, row.Raw, row.Error, got, err)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s %q: want %v, refused: %v", row.Type, row.Raw, row.Value, err)
			continue
		}
		v := got["V"]
		switch want := row.Value.(type) {
		case float64:
			switch g := v.(type) {
			case float64:
				if g != want {
					t.Errorf("%s %q: %v, want %v", row.Type, row.Raw, g, want)
				}
			case int:
				if row.Type != "port" || float64(g) != want {
					t.Errorf("%s %q: %v, want %v", row.Type, row.Raw, g, want)
				}
			default:
				t.Errorf("%s %q: %T %v, want %v", row.Type, row.Raw, v, v, want)
			}
		default:
			if v != want {
				t.Errorf("%s %q: %#v, want %#v", row.Type, row.Raw, v, want)
			}
		}
	}
}

// missing, defaulted, optional and validated, and every refusal counted
func TestReadEnvFillsAndRefusesLikeEnvTs(t *testing.T) {
	t.Setenv("SET", "7")
	t.Setenv("EMPTY", "")
	t.Setenv("RAW", " kept as written ")
	t.Setenv("BAD", "x")
	got, err := ReadEnv([]EnvVar{
		{Name: "SET", Type: "number"},
		{Name: "EMPTY", Type: "port", Default: 3000},
		{Name: "UNSET_OPT", Type: "boolean", Optional: true},
		{Name: "RAW", Validated: true},
		{Name: "UNSET_DEF", Type: "string", Default: "app.db"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got["SET"] != 7.0 || got["EMPTY"] != 3000 || got["UNSET_OPT"] != nil || got["RAW"] != " kept as written " || got["UNSET_DEF"] != "app.db" {
		t.Errorf("%#v", got)
	}
	if _, ok := got["UNSET_OPT"]; !ok {
		t.Error("an optional variable left unset is absent from the map, not nil in it")
	}
	_, err = ReadEnv([]EnvVar{
		{Name: "UNSET_REQ", Type: "url"},
		{Name: "BAD", Type: "port"},
		{Name: "UNSET_VAL", Validated: true},
		{Name: "UNSET_STR"},
	})
	want := "borgo env: 4 variables refused:\n" +
		"  - UNSET_REQ: missing (expected a url)\n" +
		"  - BAD: expected a port (an integer 0-65535), got \"x\"\n" +
		"  - UNSET_VAL: missing (expected a value its validator accepts)\n" +
		"  - UNSET_STR: missing (expected a string)"
	if err == nil || err.Error() != want {
		t.Errorf("got:\n%v\nwant:\n%s", err, want)
	}
	_, err = ReadEnv([]EnvVar{{Name: "BAD", Type: "boolean"}})
	if err == nil || !strings.HasPrefix(err.Error(), "borgo env: 1 variable refused:") {
		t.Errorf("one refusal: %v", err)
	}
	_, err = ReadEnv([]EnvVar{{Name: "SET", Type: "date"}})
	if err == nil || !strings.Contains(err.Error(), "SET: env.ts declares a type the go side does not know (date)") {
		t.Errorf("unknown type: %v", err)
	}
}

// a validate spec overrides the type in env.ts: the go side passes the raw
// string whatever type sits beside it, and an absent type is a string
func TestReadEnvPassesAValidatedValueRaw(t *testing.T) {
	t.Setenv("CUSTOM", "not a number")
	t.Setenv("PLAIN", " x ")
	got, err := ReadEnv([]EnvVar{{Name: "CUSTOM", Type: "number", Validated: true}, {Name: "PLAIN"}})
	if err != nil || got["CUSTOM"] != "not a number" || got["PLAIN"] != " x " {
		t.Errorf("%#v %v", got, err)
	}
}

// where the go side cannot follow the javascript parser it refuses: a host
// outside ascii, which the browser's parser maps through idna, is refused
// here and taken there - never the other way round
func TestReadEnvRefusesAHostOutsideASCII(t *testing.T) {
	for _, raw := range []string{"http://例え.jp", "https://café.example/", "ftp://é"} {
		t.Setenv("V", raw)
		if _, err := ReadEnv([]EnvVar{{Name: "V", Type: "url"}}); err == nil {
			t.Errorf("%q accepted", raw)
		}
	}
	// a path or a query outside ascii is no host: taken by both
	t.Setenv("V", "https://example.com/café?q=é")
	if _, err := ReadEnv([]EnvVar{{Name: "V", Type: "url"}}); err != nil {
		t.Errorf("non-ascii path: %v", err)
	}
}
