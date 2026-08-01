package main

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func captureStderr(t *testing.T, fn func()) string {
	t.Helper()
	old := os.Stderr
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stderr = w
	fn()
	w.Close()
	os.Stderr = old
	out, _ := io.ReadAll(r)
	return string(out)
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestGenerateFixture(t *testing.T) {
	root := filepath.Join("testdata", "app")
	typesPath := filepath.Join(root, ".borgo", "api-types.d.ts")
	genPath := filepath.Join(root, "api", "borgo.gen.go")
	committedTypes := read(t, typesPath)
	committedGen := read(t, genPath)

	if err := run(root); err != nil {
		t.Fatal(err)
	}

	types := read(t, typesPath)
	gen := read(t, genPath)
	if types != committedTypes {
		t.Errorf("api-types.d.ts changed; the committed fixture snapshot is stale")
	}
	if gen != committedGen {
		t.Errorf("borgo.gen.go changed; the committed fixture snapshot is stale")
	}

	wantTypes := []string{
		`"GET /api/health": { response: Health };`,
		"status: string",
		"detail?: string",
		`"GET /api/export": { response: Export };`,
		`"GET /api/mixed": { response: Widget | Deleted };`,
		`"GET /api/widgets": { response: WidgetList };`,
		`"POST /api/widgets": { response: Widget; request: WidgetCreate };`,
		`"DELETE /api/widgets/{id}": { response: Deleted };`,
		`"GET /api/widgets/{id}": { response: Widget };`,
		`"PUT /api/widgets/{id}": { response: Widget; request: WidgetCreate };`,
		`"GET /api/manual": { response: string };`,
		`"GET /api/secret": { response: Deleted };`,
		"created: string",
		"tags?: Array<string>",
		"price: string",
		"notes: string | null",
		"attrs: Record<string, number>",
		"raw: unknown",
		"counts: Record<string, string>",
		"flags: unknown",
		`"GET /api/categories": { response: Array<Category> };`,
		"children?: Array<Category>",
		"parent: Category | null",
		`"GET /api/health/full": { response: FullHealth };`,
		"uptime: number",
		"interface WsEvents {",
		`"widgets/created": Widget;`,
		`"widgets/deleted": number | string;`,
	}
	for _, want := range wantTypes {
		if !strings.Contains(types, want) {
			t.Errorf("api-types.d.ts missing %q\n%s", want, types)
		}
	}
	if strings.Contains(types, "Secret") || strings.Contains(types, "hidden") {
		t.Errorf("unexported or json:\"-\" fields leaked:\n%s", types)
	}
	if strings.Contains(types, "ErrResp") {
		t.Errorf("error-status payloads must stay out of the response union; the ts client throws on non-2xx:\n%s", types)
	}
	if strings.Contains(types, "Draft") || strings.Contains(types, "Scratch") {
		t.Errorf("an encoder aimed at a non-ResponseWriter must not become a response type:\n%s", types)
	}

	wantGen := []string{
		`borgo.Handle("GET /api/health", HealthCheck)`,
		`borgo.Handle("DELETE /api/widgets/{id}", DeleteWidget)`,
		`borgo.Handle("GET /api/widgets", ListWidgets)`,
		`borgo.Handle("POST /api/widgets", CreateWidget)`,
	}
	for _, want := range wantGen {
		if !strings.Contains(gen, want) {
			t.Errorf("borgo.gen.go missing %q\n%s", want, gen)
		}
	}
	if strings.Contains(gen, "manual") {
		t.Errorf("manually registered route must not be re-mounted:\n%s", gen)
	}
}

func TestWriteIfChangedBumpsMtimeWhenIdentical(t *testing.T) {
	path := filepath.Join(t.TempDir(), "out.ts")
	if err := os.WriteFile(path, []byte("same"), 0o644); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}

	writeIfChanged(path, "same")

	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !fi.ModTime().After(old.Add(30 * time.Minute)) {
		t.Errorf("mtime not bumped: still %v", fi.ModTime())
	}
	if read(t, path) != "same" {
		t.Errorf("content must be untouched")
	}
}

func TestGenerateErrors(t *testing.T) {
	cases := []struct{ name, dir, want string }{
		{"duplicate pattern", "dup", "already registered"},
		{"malformed type directive", "badtype", "malformed directive"},
		{"directive on non-handler", "badsig", "not a func(http.ResponseWriter"},
		{"pattern without method", "nospace", `want "METHOD /path"`},
		{"directive on method", "method", "package-level"},
		{"directive on generic function", "genericfn", "type parameters"},
		{"missing api dir", "none", "no api/ directory"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := run(filepath.Join("testdata", c.dir))
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("want error containing %q, got %v", c.want, err)
			}
		})
	}
}

func TestInvalidDirectiveWritesNoMounting(t *testing.T) {
	root := filepath.Join("testdata", "nospace")
	if err := run(root); err == nil {
		t.Fatal("want an error")
	}
	if _, err := os.Stat(filepath.Join(root, "api", "borgo.gen.go")); !os.IsNotExist(err) {
		t.Errorf("borgo.gen.go must not be written for an invalid directive")
	}
}

// A run that fails after the routes are collected and typed - here on two
// handlers claiming one pattern - must leave both outputs exactly as they were,
// not a fresh mounting next to a missing or stale .d.ts.
func TestFailedRunLeavesNoOutput(t *testing.T) {
	root := filepath.Join("testdata", "partialfail")
	genPath := filepath.Join(root, "api", "borgo.gen.go")
	if err := run(root); err == nil {
		t.Fatal("want an error")
	}
	if _, err := os.Stat(genPath); !os.IsNotExist(err) {
		t.Errorf("borgo.gen.go must not be written by a failing run: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, ".borgo", "api-types.d.ts")); !os.IsNotExist(err) {
		t.Errorf("api-types.d.ts must not be written by a failing run: %v", err)
	}
}

func TestStaleGeneratedMountingRecovers(t *testing.T) {
	root := filepath.Join("testdata", "stalegen")
	genPath := filepath.Join(root, "api", "borgo.gen.go")
	good := read(t, genPath)
	stale := strings.Replace(good, "borgo.Handle(\"GET /api/ping\", Ping)", "borgo.Handle(\"GET /api/gone\", DeletedHandler)", 1)
	if stale == good {
		t.Fatal("fixture does not contain the expected mounting line")
	}
	if err := os.WriteFile(genPath, []byte(stale), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.WriteFile(genPath, []byte(good), 0o644) })

	if err := run(root); err != nil {
		t.Fatalf("stale borgo.gen.go must not fail the run: %v", err)
	}
	if read(t, genPath) != good {
		t.Errorf("borgo.gen.go not regenerated:\n%s", read(t, genPath))
	}
}

// The stale-mounting retry names its overlay stub after the api package. An
// api/aaa_test.go declaring package api_test used to win that lookup, so the
// recovery path failed with "found packages api and api_test" and the user was
// left deleting borgo.gen.go by hand.
func TestStaleMountingRecoversAlongsideAnExternalTestPackage(t *testing.T) {
	root := filepath.Join("testdata", "testpkg")
	genPath := filepath.Join(root, "api", "borgo.gen.go")
	good := read(t, genPath)
	stale := strings.Replace(good, `borgo.Handle("GET /api/ping", Ping)`, `borgo.Handle("GET /api/gone", DeletedHandler)`, 1)
	if stale == good {
		t.Fatal("fixture does not contain the expected mounting line")
	}
	if err := os.WriteFile(genPath, []byte(stale), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.WriteFile(genPath, []byte(good), 0o644) })

	if err := run(root); err != nil {
		t.Fatalf("stale borgo.gen.go must not fail the run: %v", err)
	}
	if read(t, genPath) != good {
		t.Errorf("borgo.gen.go not regenerated:\n%s", read(t, genPath))
	}
}

func TestGenericInstantiationsStayDistinct(t *testing.T) {
	root := filepath.Join("testdata", "generics")
	if err := run(root); err != nil {
		t.Fatal(err)
	}
	types := read(t, filepath.Join(root, ".borgo", "api-types.d.ts"))
	for _, want := range []string{
		"export interface PageWidget {",
		"export interface PagePost {",
		"items: Array<Widget>",
		"items: Array<Post>",
		`"GET /api/widgets": { response: PageWidget };`,
		`"GET /api/posts": { response: PagePost };`,
	} {
		if !strings.Contains(types, want) {
			t.Errorf("api-types.d.ts missing %q\n%s", want, types)
		}
	}
}

func TestSameNameStructsInDifferentPackagesStayDistinct(t *testing.T) {
	root := filepath.Join("testdata", "collide")
	if err := run(root); err != nil {
		t.Fatal(err)
	}
	types := read(t, filepath.Join(root, ".borgo", "api-types.d.ts"))
	for _, want := range []string{
		"export interface Status {",
		"export interface LibStatus {",
		"ok: boolean",
		"ready: boolean",
		`"GET /api/local": { response: Status };`,
		`"GET /api/remote": { response: LibStatus };`,
	} {
		if !strings.Contains(types, want) {
			t.Errorf("api-types.d.ts missing %q\n%s", want, types)
		}
	}
}

// An api package declaring its own borgo used to produce a mounting that made
// the whole package stop compiling: "borgo already declared through import".
func TestMountingAvoidsAPackageLevelBorgo(t *testing.T) {
	root := filepath.Join("testdata", "borgoname")
	if err := run(root); err != nil {
		t.Fatal(err)
	}
	gen := read(t, filepath.Join(root, "api", "borgo.gen.go"))
	for _, want := range []string{
		`import borgoPkg "github.com/LuigiDavideMicca/borgo"`,
		`borgoPkg.Handle("GET /api/ping", Ping)`,
	} {
		if !strings.Contains(gen, want) {
			t.Errorf("borgo.gen.go missing %q\n%s", want, gen)
		}
	}
}

// export interface Record used to shadow the Record<K, V> this generator
// writes, so every Record<...> in the file became "type is not generic" - and
// apps typecheck with skipLibCheck, so nobody saw it.
func TestTypesNamedAfterTSGenericsAreRenamed(t *testing.T) {
	root := filepath.Join("testdata", "tsnames")
	if err := run(root); err != nil {
		t.Fatal(err)
	}
	types := read(t, filepath.Join(root, ".borgo", "api-types.d.ts"))
	for _, want := range []string{
		"export interface ApiRecord {\n  m: Record<string, number>;\n}",
		"export interface ApiArray {\n  l: Array<number>;\n}",
	} {
		if !strings.Contains(types, want) {
			t.Errorf("api-types.d.ts missing:\n%s\ngot:\n%s", want, types)
		}
	}
}

func TestTextMarshalersAreStrings(t *testing.T) {
	root := filepath.Join("testdata", "textmarshal")
	if err := run(root); err != nil {
		t.Fatal(err)
	}
	types := read(t, filepath.Join(root, ".borgo", "api-types.d.ts"))
	want := "export interface Resp {\n  id: string;\n  lvl: string;\n  addr: string;\n" +
		"  keyed: Record<string, number>;\n  plain: number;\n}"
	if !strings.Contains(types, want) {
		t.Errorf("api-types.d.ts missing:\n%s\ngot:\n%s", want, types)
	}
}

// A MarshalText on the pointer receiver runs only where encoding/json holds an
// addressable value, so one named type reaches the wire as a string in a slice
// and as its underlying shape in a plain field - see the json.Marshal output
// spelled out in testdata/textmarshal/api/text.go.
func TestPointerReceiverTextMarshalerCoversBothShapes(t *testing.T) {
	root := filepath.Join("testdata", "textmarshal")
	if err := run(root); err != nil {
		t.Fatal(err)
	}
	types := read(t, filepath.Join(root, ".borgo", "api-types.d.ts"))
	for _, want := range []string{
		"export interface PtrText {\n  one: string | number;\n  many: Array<string | number>;\n" +
			"  keyed: Record<string, number>;\n  deep: TierBox;\n}",
		"export interface TierBox {\n  one: string | number;\n}",
	} {
		if !strings.Contains(types, want) {
			t.Errorf("api-types.d.ts missing:\n%s\ngot:\n%s", want, types)
		}
	}
}

func TestByteSlicesAreBase64Strings(t *testing.T) {
	root := filepath.Join("testdata", "bytes")
	if err := run(root); err != nil {
		t.Fatal(err)
	}
	types := read(t, filepath.Join(root, ".borgo", "api-types.d.ts"))
	for _, want := range []string{
		"export interface Blob {\n  raw: string;\n  alias: string;\n  defined: string;\n  arr: Array<number>;\n}",
		// a byte-kinded element that marshals itself leaves the base64 path
		"export interface SelfBytes {\n  text: Array<string>;\n  ptext: Array<string | number>;\n  js: Array<unknown>;\n}",
	} {
		if !strings.Contains(types, want) {
			t.Errorf("api-types.d.ts missing:\n%s\ngot:\n%s", want, types)
		}
	}
}

// Promoted fields follow encoding/json's rules, so the interfaces below match
// what json.Marshal of a zero value actually writes (each case is spelled out
// in testdata/embed/api/embed.go).
func TestEmbeddedFieldPromotion(t *testing.T) {
	root := filepath.Join("testdata", "embed")
	if err := run(root); err != nil {
		t.Fatal(err)
	}
	types := read(t, filepath.Join(root, ".borgo", "api-types.d.ts"))
	for _, want := range []string{
		// exported fields of an embedded unexported struct type do reach the wire
		"export interface Doc {\n  id: number;\n  name: string;\n  title: string;\n}",
		// the outer id shadows the promoted one instead of duplicating it
		"export interface Child {\n  name: string;\n  id: number;\n}",
		// two tagged fields at the same depth cancel out
		"export interface Tie {\n  y: number;\n}",
		// and so do two reached through different embedded branches
		"export interface Diamond {\n  a1: number;\n  b1: number;\n}",
	} {
		if !strings.Contains(types, want) {
			t.Errorf("api-types.d.ts missing:\n%s\ngot:\n%s", want, types)
		}
	}
}

// One `json:"user-name"` used to be written unquoted, which is a syntax error
// that costs the whole project its types, not just that route's.
func TestNonIdentifierJSONNamesAreQuoted(t *testing.T) {
	root := filepath.Join("testdata", "tagnames")
	if err := run(root); err != nil {
		t.Fatal(err)
	}
	types := read(t, filepath.Join(root, ".borgo", "api-types.d.ts"))
	for _, want := range []string{
		`"user-name": string`,
		`"a.b": string`,
		`"1st": string`,
		// json.Marshal(Dashes{}) is {"-":0,"keep":0}
		"export interface Dashes {\n  \"-\": number;\n  keep: number;\n}",
		// json.Marshal(Invalid{}) is {"Apos":"","Emoji":"","a b":"","inner":0}
		"export interface Invalid {\n  Apos: string;\n  Emoji: string;\n  \"a b\": string;\n  inner: number;\n}",
		"città: string",    // unicode letters are identifiers in ts
		"plain_$1: string", // $ and a non-leading digit are too
		// ,string quotes booleans and pointed-to numbers, not only plain ones
		"export interface Quoted {\n  b: string;\n  i: string;\n  f: string;\n  st: string;\n  p: string | null;\n}",
	} {
		if !strings.Contains(types, want) {
			t.Errorf("api-types.d.ts missing %q\n%s", want, types)
		}
	}
}

// omitzero (go 1.24) drops a field whose value is the zero of its type, which
// is exactly the case omitempty does not cover for structs and time.Time. A
// required property for a field the wire routinely omits is the dangerous
// direction: the browser reads undefined off a type that promised a value.
func TestOptionalFieldsMatchEncodingJSON(t *testing.T) {
	root := filepath.Join("testdata", "optional")
	if err := run(root); err != nil {
		t.Fatal(err)
	}
	types := read(t, filepath.Join(root, ".borgo", "api-types.d.ts"))
	for _, want := range []string{
		"zerost?: Inner",
		"zeronum?: number",
		"zerotime?: string",
		// an option encoding/json does not recognize is not omitempty either
		"typo: number",
		// omitempty on a kind isEmptyValue never calls empty: the field is on
		// the wire every time, so promising it may be missing is a lie too
		"a2: Array<number>",
		"st: Inner",
		"t: string",
		"m: Inner",
		// and the kinds it does drop stay optional
		"bool?: boolean",
		"num?: number",
		"str?: string",
		"slice?: Array<number>",
		"map?: Record<string, number>",
		"ptr?: number | null",
		"iface?: unknown",
		"a0?: Array<number>",
	} {
		if !strings.Contains(types, want) {
			t.Errorf("api-types.d.ts missing %q\n%s", want, types)
		}
	}
}

// A struct that embeds a pointer to itself used to recurse until the stack
// blew up - a fatal error, not a recoverable one, on every save in dev.
func TestSelfEmbeddingStructTerminates(t *testing.T) {
	root := filepath.Join("testdata", "selfembed")
	if err := run(root); err != nil {
		t.Fatal(err)
	}
	types := read(t, filepath.Join(root, ".borgo", "api-types.d.ts"))
	// json.Marshal(Node{nil, 5}) is {"x":5}: the promoted copy never shows up
	if want := "export interface Node {\n  x: number;\n}"; !strings.Contains(types, want) {
		t.Errorf("want %q\n%s", want, types)
	}
}

// Two borgo.Handle calls for one pattern used to declare the key twice in
// ApiRoutes, with whichever type sorted last.
func TestDuplicateManualPatternIsDeclaredOnceAndWarns(t *testing.T) {
	root := filepath.Join("testdata", "dupmanual")
	out := captureStderr(t, func() {
		if err := run(root); err != nil {
			t.Fatal(err)
		}
	})
	types := read(t, filepath.Join(root, ".borgo", "api-types.d.ts"))
	if n := strings.Count(types, `"GET /api/x":`); n != 1 {
		t.Errorf("want the pattern declared once, got %d\n%s", n, types)
	}
	if !strings.Contains(types, `"GET /api/x": { response: A };`) {
		t.Errorf("want the first registration typed\n%s", types)
	}
	if !strings.Contains(out, "already registered at") || !strings.Contains(out, "dup.go:21") {
		t.Errorf("want a warning naming both call sites, got:\n%s", out)
	}
}

// A handler in a file the current build excludes is invisible to the loader,
// so its route disappears from both outputs with nothing to explain the 404.
func TestExcludedRouteFileWarns(t *testing.T) {
	root := filepath.Join("testdata", "excluded")
	out := captureStderr(t, func() {
		if err := run(root); err != nil {
			t.Error(err)
		}
	})
	if !strings.Contains(out, "plan9.go:11") || !strings.Contains(out, "this build excludes") {
		t.Errorf("want a warning pointing at the excluded directive, got:\n%s", out)
	}
	types := read(t, filepath.Join(root, ".borgo", "api-types.d.ts"))
	if strings.Contains(types, "plan9") {
		t.Errorf("the excluded route must not be typed:\n%s", types)
	}
}

func TestLooseRouteCommentWarns(t *testing.T) {
	out := captureStderr(t, func() {
		if err := run(filepath.Join("testdata", "loose")); err != nil {
			t.Error(err)
		}
	})
	if !strings.Contains(out, "not attached to a handler") {
		t.Errorf("want a loose-directive warning on stderr, got:\n%s", out)
	}
	if !strings.Contains(out, "loose.go:9") {
		t.Errorf("want file:line in the warning, got:\n%s", out)
	}
}

// A slashed topic still publishes and still reaches its subscribers, so
// refusing to generate would break a working app over a typing detail. It
// cannot be typed, though - "topic/event" keys make the split ambiguous - so
// the event is dropped from the map and the reason is said out loud.
func TestSlashPushWarnsAndStaysUntyped(t *testing.T) {
	root := filepath.Join("testdata", "slashpush")
	out := captureStderr(t, func() {
		if err := run(root); err != nil {
			t.Error(err)
		}
	})
	if !strings.Contains(out, "bad.go:6") {
		t.Errorf("want file:line in the warning, got:\n%s", out)
	}
	if !strings.Contains(out, "stay untyped") {
		t.Errorf("want the warning to say the events stay untyped, got:\n%s", out)
	}
	if types := read(t, filepath.Join(root, ".borgo", "api-types.d.ts")); strings.Contains(types, "live/chat") {
		t.Errorf("a slashed topic must not enter WsEvents:\n%s", types)
	}
}

// Push with a computed topic or event is the documented escape hatch: there is
// nothing to record statically, so generation succeeds in silence and the
// browser keeps the untyped callback. Failing here would leave no way at all to
// publish a name decided at runtime.
func TestDynamicPushGeneratesWithoutComplaint(t *testing.T) {
	root := filepath.Join("testdata", "dynamicpush")
	out := captureStderr(t, func() {
		if err := run(root); err != nil {
			t.Fatalf("a computed topic must not fail generation: %v", err)
		}
	})
	if out != "" {
		t.Errorf("a computed topic is a choice, not a mistake; got:\n%s", out)
	}
	if types := read(t, filepath.Join(root, ".borgo", "api-types.d.ts")); strings.Contains(types, "WsEvents") {
		t.Errorf("nothing was statically typed, so WsEvents must be absent:\n%s", types)
	}
}
