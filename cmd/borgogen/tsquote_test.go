package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var bs = string(rune(92))

// an event name holding a backtick or "${" made the whole generated file a
// parse error under a templated //borgo:topic (found by hunt 3)
func TestATemplateKeyEscapesTheEventName(t *testing.T) {
	cases := map[string]string{
		"room:${string}/a`b":          "room:${string}/a" + bs + "`b",
		"chat:${string}/x${y}":        "chat:${string}/x" + bs + "${y}",
		"chat:${string}/a" + bs + "b": "chat:${string}/a" + bs + bs + "b",
		// an event may hold a slash, a topic never: the first one ends the topic
		"room:${string}/x`y/z": "room:${string}/x" + bs + "`y/z",
		"chat:${string}/plain": "chat:${string}/plain",
	}
	for in, want := range cases {
		if got := eventKey(in); got != want {
			t.Errorf("eventKey(%q) = %q, want %q", in, got, want)
		}
	}
	if got := templateText("a`b${c}" + bs); got != "a"+bs+"`b"+bs+"${c}"+bs+bs {
		t.Errorf("templateText: %q", got)
	}
}

// %q wrote escapes TypeScript reads otherwise: \a is "a" there, \U0001F600
// is "U0001F600" (found by hunt 3)
func TestKeysAreTypeScriptStrings(t *testing.T) {
	for in, want := range map[string]string{
		"GET /api/x":              `"GET /api/x"`,
		"room/" + string(rune(7)): `"room/` + bs + `u0007"`,
		"room/😀":                  `"room/😀"`,
		"a<b>&c":                  `"a<b>&c"`,
		`say "hi"`:                `"say ` + bs + `"hi` + bs + `""`,
	} {
		if got := tsString(in); got != want {
			t.Errorf("tsString(%q) = %s, want %s", in, got, want)
		}
	}
}

// the raw tag text kept its escapes, so the field was named for the escape
// and not for what encoding/json writes (found by hunt 3)
func TestATagIsUnquotedAsReflectUnquotesIt(t *testing.T) {
	tag := `json:"` + bs + `u00e9t` + bs + `u00e9" xml:"n` + bs + `x2c"`
	if got, ok := lookupTag(tag, "json"); !ok || got != "été" {
		t.Errorf("json: %q %v", got, ok)
	}
	if got, ok := lookupTag(tag, "xml"); !ok || got != "n," {
		t.Errorf("xml: %q %v", got, ok)
	}
	if got, ok := lookupTag(`json:"`+bs+`q"`, "json"); ok {
		t.Errorf("an invalid escape was read as %q", got)
	}
	if !strings.Contains(tag, bs) {
		t.Fatal("the fixture lost its backslashes")
	}
}

// the same, end to end: the generated file holds the keys as TypeScript
// reads them
func TestEventNamesAreWrittenAsTypeScriptReadsThem(t *testing.T) {
	wants(t, generateFresh(t, "topicescape"),
		"[k: `room:${string}/a"+bs+"`b`]: number;",
		"[k: `chat:${string}/x"+bs+"${y}`]: number;",
		"[k: `room:${string}/x"+bs+"`y/z`]: number;",
		`"bell/ring`+bs+`u0007": number;`,
	)
}

func middlewareCover(t *testing.T, dir string) string {
	t.Helper()
	generateFresh(t, dir)
	return strings.TrimSpace(read(t, filepath.Join("testdata", dir, ".borgo", "middleware.json")))
}

// borgo export cannot run the app to ask which paths api/middleware.go
// guards, and published the pages it guarded (found by hunt 3): the
// generator reads the Matcher when it can, and says when it cannot
func TestTheMiddlewaresCoverIsWrittenForExport(t *testing.T) {
	cases := map[string]string{
		"middleware":     `{"covers":["/api/admin/*"]}`,
		"middlewareonly": `{"covers":"all"}`,
		"mwcomputed":     `{"covers":"unknown"}`,
		"mwreassigned":   `{"covers":"unknown"}`,
		"mwindexed":      `{"covers":"unknown"}`,
		"mwbuildtag":     `{"covers":"unknown"}`,
	}
	for dir, want := range cases {
		if got := middlewareCover(t, dir); got != want {
			t.Errorf("%s: %s, want %s", dir, got, want)
		}
	}
	generateFresh(t, "topicescape")
	if _, err := os.Stat(filepath.Join("testdata", "topicescape", ".borgo", "middleware.json")); !os.IsNotExist(err) {
		t.Errorf("an app without middleware has a cover file: %v", err)
	}
}

// borgo-framework's own declarations resolve first inside its declare module
// block: an app type Channel became borgo's (found by the verifier of hunt
// 3), and renaming it broke every import of it (found rebuilding piazza).
// The app's type keeps its name; the block reaches it through an alias
func TestAnAppTypeNamedLikeBorgosKeepsItsName(t *testing.T) {
	wants(t, generateFresh(t, "shadowed"),
		"export interface Channel {",
		"export interface WsEvents {",
		"type __app_Channel = Channel;",
		"type __app_WsEvents = WsEvents;",
		`"GET /api/channel": { response: __app_Channel };`,
		`"GET /api/events": { response: __app_WsEvents };`,
		`"live/channel": __app_Channel;`,
	)
	// a string literal type and a property key are not type references
	shadowed := map[string]bool{"Channel": true}
	if got := qualifyForModule(`{ Channel: Channel; kind: "Channel" | Array<Channel> }`, shadowed); got != `{ Channel: __app_Channel; kind: "Channel" | Array<__app_Channel> }` {
		t.Errorf("qualifyForModule: %s", got)
	}
	if got := qualifyForModule(`{ Channel?: Channel | null }`, shadowed); got != `{ Channel?: __app_Channel | null }` {
		t.Errorf("qualifyForModule, an optional key: %s", got)
	}
}
