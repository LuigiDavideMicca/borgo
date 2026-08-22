package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	addrapi "github.com/LuigiDavideMicca/borgo/cmd/borgogen/testdata/addressable/api"
	bytesapi "github.com/LuigiDavideMicca/borgo/cmd/borgogen/testdata/bytes/api"
	closureapi "github.com/LuigiDavideMicca/borgo/cmd/borgogen/testdata/closurehandle/api"
	deeph3 "github.com/LuigiDavideMicca/borgo/cmd/borgogen/testdata/deeppush/h3"
	deeph4 "github.com/LuigiDavideMicca/borgo/cmd/borgogen/testdata/deeppush/h4"
	embedapi "github.com/LuigiDavideMicca/borgo/cmd/borgogen/testdata/embed/api"
	ifaceapi "github.com/LuigiDavideMicca/borgo/cmd/borgogen/testdata/ifacetext/api"
	inboundapi "github.com/LuigiDavideMicca/borgo/cmd/borgogen/testdata/inbound/api"
	nestedapi "github.com/LuigiDavideMicca/borgo/cmd/borgogen/testdata/nested/api"
	overrideapi "github.com/LuigiDavideMicca/borgo/cmd/borgogen/testdata/overrideunion/api"
	recursiveapi "github.com/LuigiDavideMicca/borgo/cmd/borgogen/testdata/recursive/api"
	requestapi "github.com/LuigiDavideMicca/borgo/cmd/borgogen/testdata/request/api"
	stringoptapi "github.com/LuigiDavideMicca/borgo/cmd/borgogen/testdata/stringopt/api"
	textapi "github.com/LuigiDavideMicca/borgo/cmd/borgogen/testdata/textmarshal/api"
	wireapi "github.com/LuigiDavideMicca/borgo/cmd/borgogen/testdata/wire/api"
)

// wants asserts every want is present in the generated file, whole - each of
// these spells out a complete declaration or ApiRoutes entry, braces included,
// so a substring match cannot be satisfied by a different body.
func wants(t *testing.T, types string, want ...string) {
	t.Helper()
	for _, w := range want {
		if !strings.Contains(types, w) {
			t.Errorf("api-types.d.ts missing:\n%s\ngot:\n%s", w, types)
		}
	}
}

// generated holds the output of one run per fixture. A run is a packages.Load
// and this suite asks for the same handful of fixtures from thirty tests -
// testdata/wire alone answers eight of them - while the output is a pure
// function of the fixture. Under -race that repetition is minutes, and the
// package has a ten minute timeout like every other.
var generated sync.Map

func generate(t *testing.T, dir string) string {
	t.Helper()
	if out, ok := generated.Load(dir); ok {
		return out.(string)
	}
	out := generateFresh(t, dir)
	generated.Store(dir, out)
	return out
}

// generateFresh runs the generator whatever the cache holds, for the tests that
// are about the run itself - what it says on stderr, what it leaves on disk -
// rather than about what it rendered.
func generateFresh(t *testing.T, dir string) string {
	t.Helper()
	root := filepath.Join("testdata", dir)
	if err := run(root); err != nil {
		t.Fatal(err)
	}
	return read(t, filepath.Join(root, ".borgo", "api-types.d.ts"))
}

// marshals asserts what encoding/json really writes for a fixture value, so
// the generated TypeScript below is checked against the wire and not against
// somebody's reading of the encoding/json documentation.
func marshals(t *testing.T, v any, want string) {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("json.Marshal(%T): %v", v, err)
	}
	if string(b) != want {
		t.Fatalf("json.Marshal(%T) = %s, want %s", v, b, want)
	}
}

// accepts and rejects assert what encoding/json really does with a body for a
// fixture type, so the request types are checked against the decoder the way
// the response types are checked against the encoder.
func accepts(t *testing.T, body string, v any) {
	t.Helper()
	if err := json.Unmarshal([]byte(body), v); err != nil {
		t.Fatalf("json.Unmarshal(%s, %T): %v", body, v, err)
	}
}

func rejects(t *testing.T, body string, v any) {
	t.Helper()
	if err := json.Unmarshal([]byte(body), v); err == nil {
		t.Fatalf("json.Unmarshal(%s, %T) was accepted, and the point of this fixture is that it is not", body, v)
	}
}

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

// tscBin resolves the compiler this repo pins and a runtime to run it with. A
// go test runs with cwd at its package directory, so the path below is the
// workspace's own typescript and never a download: bunx outside the workspace
// fetches typescript@latest, and a gate that fails must fail for the generated
// code, not for whatever npm published this morning.
func tscBin(t *testing.T) (bin, script string) {
	t.Helper()
	script, err := filepath.Abs(filepath.Join("..", "..", "node_modules", "typescript", "bin", "tsc"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(script); err != nil {
		t.Skipf("the workspace typescript is not installed at %s (bun install), so the emitted declarations cannot be compiled here", script)
	}
	for _, name := range []string{"bun", "node"} {
		if bin, err = exec.LookPath(name); err == nil {
			return bin, script
		}
	}
	t.Skip("neither bun nor node is on PATH, so the emitted declarations cannot be compiled here")
	return "", ""
}

// typecheck compiles declarations with that compiler and reports what it said.
func typecheck(t *testing.T, types string) ([]byte, error) {
	t.Helper()
	bin, script, dir := tscProject(t, types, "")
	cmd := exec.Command(bin, script, "--noEmit", "-p", "tsconfig.json")
	cmd.Dir = dir
	return cmd.CombinedOutput()
}

// tscProject lays out a compilable project around the generated declarations,
// with probe.ts beside them when there is one to compile.
func tscProject(t *testing.T, types, probe string) (bin, script, dir string) {
	t.Helper()
	bin, script = tscBin(t)
	dir = t.TempDir()
	writeTemp(t, dir, "api-types.d.ts", types)
	// the emitted file augments "borgo-framework", and augmenting a module that
	// does not resolve is TS2664 before a single member of it is looked at
	writeTemp(t, dir, "borgo-framework.d.ts",
		"declare module \"borgo-framework\" {\n  export interface ApiRoutes {}\n  export interface WsEvents {}\n}\n")
	// skipLibCheck is what apps compile with, and it hides everything in a .d.ts
	// but the syntax; off here, so a declaration that parses and still means
	// nothing is caught too
	include := `["*.d.ts"]`
	if probe != "" {
		writeTemp(t, dir, "probe.ts", probe)
		include = `["*.d.ts","probe.ts"]`
	}
	writeTemp(t, dir, "tsconfig.json",
		`{"compilerOptions":{"strict":true,"noEmit":true,"skipLibCheck":false,"types":[]},"include":`+include+`}`)
	return bin, script, dir
}

var tscErrorLine = regexp.MustCompile(`probe\.ts\((\d+),`)

// typecheckBodies assigns each body to a generated type, one per line, and
// reports which ones the compiler accepted. One tsc run answers for the whole
// table, and the line a diagnostic carries is what maps it back to its body -
// so the bodies must be written on one line each, and are.
//
// This is the half of the property that no assertion about the emitted text can
// stand in for: what a type declares valid is what tsc says about a body, not
// what the declaration looks like to a reader.
func typecheckBodies(t *testing.T, types, typeName string, bodies []string) []bool {
	t.Helper()
	var probe strings.Builder
	fmt.Fprintf(&probe, "import type { %s } from \"./api-types\";\n", typeName)
	for i, body := range bodies {
		if strings.ContainsAny(body, "\n\r") {
			t.Fatalf("body %d spans lines, and the line is what identifies it: %q", i, body)
		}
		fmt.Fprintf(&probe, "const b%d: %s = %s;\nvoid b%d;\n", i, typeName, body, i)
	}
	bin, script, dir := tscProject(t, types, probe.String())
	cmd := exec.Command(bin, script, "--noEmit", "-p", "tsconfig.json")
	cmd.Dir = dir
	out, _ := cmd.CombinedOutput()

	bad := map[int]bool{}
	for _, m := range tscErrorLine.FindAllStringSubmatch(string(out), -1) {
		line, err := strconv.Atoi(m[1])
		if err != nil {
			t.Fatalf("unreadable tsc diagnostic %q in:\n%s", m[0], out)
		}
		bad[line] = true
	}
	// a diagnostic outside probe.ts means the project itself did not compile,
	// and every "accepted" below would be an accident of that
	if strings.Contains(string(out), "api-types.d.ts(") {
		t.Fatalf("tsc rejected the generated declarations themselves:\n%s", out)
	}
	accepted := make([]bool, len(bodies))
	for i := range bodies {
		accepted[i] = !bad[2+2*i] // line 1 is the import; two lines per body
	}
	return accepted
}

// typechecks compiles the emitted declarations with tsc. Every other assertion
// in this file is a substring, and a substring is still found when the "<" that
// opened around it never closed - the whole point of a generated .d.ts is that
// it parses, because one bad declaration in it costs every route in the project
// its types at once, not just the field that produced it.
func typechecks(t *testing.T, types string) {
	t.Helper()
	if out, err := typecheck(t, types); err != nil {
		t.Errorf("tsc rejected the generated declarations: %v\n%s\n%s", err, out, types)
	}
}

// A gate resolved to a local compiler is worth exactly what it still rejects,
// so both properties typechecks is here for are asserted directly: that the
// file parses, and - skipLibCheck being off - that it means something.
func TestTypecheckRejectsBrokenDeclarations(t *testing.T) {
	for _, c := range []struct{ name, types string }{
		{"unclosed generic", "export interface Broken {\n  m: Record<string, number;\n}\n"},
		{"undefined type", "export interface Broken {\n  m: NoSuchType;\n}\n"},
	} {
		t.Run(c.name, func(t *testing.T) {
			if out, err := typecheck(t, c.types); err == nil {
				t.Errorf("tsc accepted a declaration it has to reject:\n%s", out)
			}
		})
	}
}

func writeTemp(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
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
		// a request body is read, not written, and nothing about reading is
		// required: see TestInboundFieldsMatchEncodingJSON
		`"POST /api/widgets": { response: Widget; request: WidgetCreate$Request };`,
		"export interface WidgetCreate$Request {\n  name?: string | null;\n}",
		`"DELETE /api/widgets/{id}": { response: Deleted };`,
		`"GET /api/widgets/{id}": { response: Widget };`,
		`"PUT /api/widgets/{id}": { response: Widget; request: WidgetCreate$Request };`,
		`"GET /api/manual": { response: string };`,
		`"GET /api/secret": { response: Deleted };`,
		"created: string;",
		// a nil slice or map is "null" on the wire, whatever the key spells
		"tags?: Array<string> | null;",
		"price: string;",
		"notes: string | null;",
		"attrs: Record<string, number> | null;",
		"raw: unknown;",
		"counts: Record<string, string> | null;",
		"flags: unknown;",
		`"GET /api/categories": { response: Array<Category> | null };`,
		"children?: Array<Category> | null;",
		"parent: Category | null;",
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
		// a directive that can never apply is a mistake, and used to be silent
		{"type directive naming nothing", "badtypename", "not a type this api package can refer to"},
		{"type directive with a typo in an imported name", "badtypepath", "not a type this api package can refer to"},
		{"two type directives for one go type", "duptype", "maps to one TypeScript type"},
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
	types := generate(t, "generics")
	for _, want := range []string{
		"export interface PageWidget {",
		"export interface PagePost {",
		"items: Array<Widget> | null;",
		"items: Array<Post> | null;",
		`"GET /api/widgets": { response: PageWidget };`,
		`"GET /api/posts": { response: PagePost };`,
	} {
		if !strings.Contains(types, want) {
			t.Errorf("api-types.d.ts missing %q\n%s", want, types)
		}
	}
}

func TestSameNameStructsInDifferentPackagesStayDistinct(t *testing.T) {
	types := generate(t, "collide")
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
	types := generate(t, "tsnames")
	for _, want := range []string{
		"export interface ApiRecord {\n  m: Record<string, number> | null;\n}",
		"export interface ApiArray {\n  l: Array<number> | null;\n}",
	} {
		if !strings.Contains(types, want) {
			t.Errorf("api-types.d.ts missing:\n%s\ngot:\n%s", want, types)
		}
	}
}

// A Go type may be named anything Go allows, and TypeScript reserves names Go
// does not. `type null struct{...}` came out "export interface null {...}",
// which does not parse at all, so the file it sat in stopped being a file - and
// with it every route in the project, not only the one that declared the type.
func TestTypesNamedAfterTSReservedWordsAreRenamed(t *testing.T) {
	types := generate(t, "tsnames")
	wants(t, types,
		"export interface ApiNull {\n  x: number;\n}",
		"export interface ApiFunction {\n  y: number;\n}",
		"export interface ApiString {\n  z: number;\n}",
		`"GET /api/null": { response: ApiNull };`,
		`"GET /api/function": { response: ApiFunction };`,
		`"GET /api/string": { response: ApiString };`,
	)
	typechecks(t, types)
}

func TestTextMarshalersAreStrings(t *testing.T) {
	types := generate(t, "textmarshal")
	want := "export interface Resp {\n  id: string;\n  lvl: string;\n  addr: string;\n" +
		"  keyed: Record<string, number> | null;\n  plain: number;\n}"
	if !strings.Contains(types, want) {
		t.Errorf("api-types.d.ts missing:\n%s\ngot:\n%s", want, types)
	}
}

// An interface that embeds encoding.TextMarshaler marshals as a string only
// when it holds something. A nil one is "null", and encoding/json never calls
// the method to find out - so typing the interface "string" narrowed the type
// in the dangerous direction: the browser reads .length off a null that the
// declaration promised was a string.
func TestMarshalerInterfacesAreNullable(t *testing.T) {
	marshals(t, ifaceapi.Box{}, `{"code":null,"free":null,"many":null}`)
	marshals(t, ifaceapi.Box{Code: ifaceapi.Warn{}, Many: []ifaceapi.Coded{nil, ifaceapi.Warn{}}},
		`{"code":"warn","free":null,"many":[null,"warn"]}`)

	types := generate(t, "ifacetext")
	wants(t, types, "export interface Box {\n  code: string | null;\n"+
		// an interface carrying no marshaler at all was never the narrow case
		"  free: unknown;\n  many: Array<string | null> | null;\n}")
	typechecks(t, types)
}

// A MarshalText on the pointer receiver runs only where encoding/json holds an
// addressable value, so one named type is a string in a slice and its
// underlying shape in a plain field - each position typed as what the wire
// really carries, not as the union of both.
func TestPointerReceiverTextMarshalerFollowsThePosition(t *testing.T) {
	marshals(t, textapi.PtrText{Many: []textapi.Tier{0}, Keyed: map[textapi.Tier]int{0: 0}},
		`{"one":0,"many":["tier"],"keyed":{"0":0},"deep":{"one":0}}`)

	wants(t, generate(t, "textmarshal"),
		"export interface PtrText {\n  one: number;\n  many: Array<string> | null;\n"+
			"  keyed: Record<string, number> | null;\n  deep: TierBox;\n}",
		"export interface TierBox {\n  one: number;\n}",
	)
}

func TestByteSlicesAreBase64Strings(t *testing.T) {
	marshals(t, bytesapi.Blob{Raw: []byte{1, 2, 3}, Alias: []byte{1, 2, 3}, Defined: []bytesapi.ByteDef{1, 2, 3}},
		`{"raw":"AQID","alias":"AQID","defined":"AQID","arr":[0,0,0,0]}`)
	// a slice element is addressable, so the pointer-receiver MarshalText runs
	marshals(t, bytesapi.SelfBytes{Text: []bytesapi.TextByte{0}, PText: []bytesapi.PtrTextByte{0}, JS: []bytesapi.JSONByte{0}},
		`{"text":["tb"],"ptext":["pb"],"js":["jb"]}`)

	wants(t, generate(t, "bytes"),
		// a nil []byte is "null", not "" - only the array is always there
		"export interface Blob {\n  raw: string | null;\n  alias: string | null;\n  defined: string | null;\n  arr: Array<number>;\n}",
		// a byte-kinded element that marshals itself leaves the base64 path
		"export interface SelfBytes {\n  text: Array<string> | null;\n  ptext: Array<string> | null;\n  js: Array<unknown> | null;\n}",
	)
}

// Promoted fields follow encoding/json's rules, so the interfaces below match
// what json.Marshal of a zero value actually writes (each case is spelled out
// in testdata/embed/api/embed.go).
func TestEmbeddedFieldPromotion(t *testing.T) {
	types := generate(t, "embed")
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
	types := generate(t, "tagnames")
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

// encoding/json decides `,string` on the Go kind, in typeFields, before it
// knows anything about how the value will be written. Deciding it on the
// rendered TypeScript agreed by coincidence - "number" and "boolean" are what
// the quotable kinds render as - and stopped agreeing the moment a //borgo:type
// stood between the kind and the text, in both directions at once.
func TestStringOptionFollowsTheGoKindNotTheRenderedText(t *testing.T) {
	marshals(t, stringoptapi.Kinds{Amount: 7, Plain: 7},
		`{"amount":"7","plain":7,"ratio":3,"coin":9,"flag":"false","p":null}`)

	types := generate(t, "stringopt")
	wants(t, types, "export interface Kinds {\n"+
		// an int kind is quoted however it is rendered
		"  amount: string;\n"+
		"  plain: `${number}`;\n"+
		// and a struct kind is not, however it is rendered
		"  ratio: number;\n"+
		// a marshaler outranks the option: opts.quoted never reaches it
		"  coin: unknown;\n"+
		"  flag: string;\n"+
		// the null a pointer carries is untouched by the quoting
		"  p: string | null;\n}")
	typechecks(t, types)
}

// omitzero (go 1.24) drops a field whose value is the zero of its type, which
// is exactly the case omitempty does not cover for structs and time.Time. A
// required property for a field the wire routinely omits is the dangerous
// direction: the browser reads undefined off a type that promised a value.
func TestOptionalFieldsMatchEncodingJSON(t *testing.T) {
	types := generate(t, "optional")
	for _, want := range []string{
		"zerost?: Inner;",
		"zeronum?: number;",
		"zerotime?: string;",
		// an option encoding/json does not recognize is not omitempty either
		"typo: number;",
		// omitempty on a kind isEmptyValue never calls empty: the field is on
		// the wire every time, so promising it may be missing is a lie too
		"a2: Array<number>;",
		"st: Inner;",
		"t: string;",
		"m: Inner;",
		// and the kinds it does drop stay optional
		"bool?: boolean;",
		"num?: number;",
		"str?: string;",
		"slice?: Array<number> | null;",
		"map?: Record<string, number> | null;",
		"ptr?: number | null;",
		"iface?: unknown;",
		"a0?: Array<number>;",
	} {
		if !strings.Contains(types, want) {
			t.Errorf("api-types.d.ts missing %q\n%s", want, types)
		}
	}
}

// Every nil encoding/json can reach writes "null", never an empty container: a
// handler that found nothing answers {"items":null,...} while the type promised
// an array, and data.items.map() is a TypeError on the very first empty result.
func TestNilSlicesMapsAndBytesAreNullable(t *testing.T) {
	marshals(t, wireapi.Empty{},
		`{"items":null,"m":null,"raw":null,"nest":null,"named":null,"arr":[0,0]}`)

	types := generate(t, "wire")
	want := "export interface Empty {\n  items: Array<number> | null;\n  m: Record<string, number> | null;\n" +
		"  raw: string | null;\n  nest: Array<Array<string> | null> | null;\n  named: Array<string> | null;\n" +
		// an array is not a slice: it is on the wire every time, elements and all
		"  arr: Array<number>;\n}"
	if !strings.Contains(types, want) {
		t.Errorf("api-types.d.ts missing:\n%s\ngot:\n%s", want, types)
	}
	if !strings.Contains(types, `"GET /api/empty": { response: Empty };`) {
		t.Errorf("route missing:\n%s", types)
	}
}

// An anonymous struct promotes the methods of what it embeds just like a named
// one does, so a struct{ time.Time; ... } is a JSON string on the wire and
// nothing at all like the object its fields describe.
func TestAnonymousStructWithPromotedMarshalerIsNotAnObject(t *testing.T) {
	marshals(t, wireapi.Stamped{}, `{"at":"0001-01-01T00:00:00Z","plain":{"n":0}}`)

	types := generate(t, "wire")
	// and one without a marshaler still expands to its fields
	want := "export interface Stamped {\n  at: unknown;\n  plain: { n: number };\n}"
	if !strings.Contains(types, want) {
		t.Errorf("api-types.d.ts missing:\n%s\ngot:\n%s", want, types)
	}
}

// A promoted MarshalText reaches an anonymous struct the same way, and a
// pointer receiver still only runs where encoding/json holds an addressable
// value - so the same anonymous struct is a string in a slice and an object in
// a plain field. Expanding it needs care: a struct is its own underlying type.
func TestAnonymousStructWithPromotedTextMarshaler(t *testing.T) {
	one := wireapi.Tagged{}
	one.Many = append(one.Many, struct {
		wireapi.PtrLabel
		Extra int `json:"extra"`
	}{})
	marshals(t, one, `{"l":"label","p":{"N":0,"extra":0},"many":["ptr"]}`)

	types := generate(t, "wire")
	want := "export interface Tagged {\n  l: string;\n  p: { N: number; extra: number };\n" +
		"  many: Array<string> | null;\n}"
	if !strings.Contains(types, want) {
		t.Errorf("api-types.d.ts missing:\n%s\ngot:\n%s", want, types)
	}
}

// encoding/json names an object key from a string or an integer and refuses the
// whole value for anything else - a float key included, which is numeric but not
// a key. Typing it Record<string, number> promised a response that never comes.
func TestFloatMapKeysAreUnknown(t *testing.T) {
	if _, err := json.Marshal(wireapi.Keys{}); err == nil ||
		!strings.Contains(err.Error(), "unsupported type: map[float64]int") {
		t.Fatalf("want encoding/json to refuse a float map key, got %v", err)
	}

	types := generate(t, "wire")
	want := "export interface Keys {\n  fees: unknown;\n  sizes: Record<string, number> | null;\n}"
	if !strings.Contains(types, want) {
		t.Errorf("api-types.d.ts missing:\n%s\ngot:\n%s", want, types)
	}
}

// encoding/json drops a whole promoted group when the pointer it hangs off is
// nil, without a word about it, so none of those fields can be promised.
func TestFieldsPromotedThroughANilPointerAreOptional(t *testing.T) {
	marshals(t, embedapi.PtrOuter{B: 1}, `{"b":1}`)
	marshals(t, embedapi.PtrOuter{PtrInner: &embedapi.PtrInner{A: 7}, B: 1}, `{"a":7,"b":1}`)
	marshals(t, embedapi.Deep{D: 2}, `{"d":2}`)

	types := generate(t, "embed")
	for _, want := range []string{
		"export interface PtrOuter {\n  a?: number;\n  b: number;\n}",
		// two hops down, still behind the same nil pointer
		"export interface Deep {\n  a?: number;\n  c?: number;\n  d: number;\n}",
	} {
		if !strings.Contains(types, want) {
			t.Errorf("api-types.d.ts missing:\n%s\ngot:\n%s", want, types)
		}
	}
}

// A named type whose underlying is not a struct is inlined, so a recursive one
// had no anchor and expanded until the stack blew up - a fatal error run()'s
// recover never sees, so the dev loop died on save with no message at all.
func TestRecursiveNamedNonStructTypesTerminate(t *testing.T) {
	types := generate(t, "recursive")
	for _, want := range []string{
		"export type Tree = Record<string, Tree> | null;",
		"export type Ring = Array<Hop> | null;",
		"export interface Hop {\n  next: Ring;\n}",
		`"GET /api/tree": { response: Tree };`,
		`"GET /api/ring": { response: Ring };`,
		// a named type that is not recursive is still inlined
		"export interface Wallet {\n  balance: number;\n}",
	} {
		if !strings.Contains(types, want) {
			t.Errorf("api-types.d.ts missing %q\n%s", want, types)
		}
	}
	if strings.Contains(types, "export type Money") {
		t.Errorf("a non-recursive named type needs no declaration of its own:\n%s", types)
	}
}

// Publishing from a service package instead of from the http handler is
// ordinary layering. Scanning only api/ dropped those events, and with them the
// whole WsEvents block, so every subscriber in the app lost its types at once.
func TestPushesInOtherPackagesAreCollected(t *testing.T) {
	types := generate(t, "pushpkg")
	for _, want := range []string{
		"interface WsEvents {",
		// one hop out, through a function taking no writer and no request
		`"room/note": Note;`,
		// and two hops out
		`"room/audit": Audit;`,
		"export interface Note {\n  text: string;\n}",
		"export interface Audit {\n  at: string;\n}",
	} {
		if !strings.Contains(types, want) {
			t.Errorf("api-types.d.ts missing %q\n%s", want, types)
		}
	}
}

// //borgo:type is consulted for named types, and an alias is a name of its own -
// silently ignoring one left the directive looking applied and the wrong type in
// every caller.
func TestTypeOverrideAppliesToAnAlias(t *testing.T) {
	types := generate(t, "aliastype")
	want := "export interface Price {\n  amount: string;\n  ship: string;\n  raw: number;\n}"
	if !strings.Contains(types, want) {
		t.Errorf("api-types.d.ts missing:\n%s\ngot:\n%s", want, types)
	}
}

// A borgo.Handle whose pattern is computed still mounts and still serves; only
// its key is unknown here. Dropped in silence, its callers just found the route
// missing from ApiRoutes with nothing to explain it.
func TestComputedHandlePatternWarns(t *testing.T) {
	root := filepath.Join("testdata", "dynamichandle")
	out := captureStderr(t, func() {
		if err := run(root); err != nil {
			t.Error(err)
		}
	})
	if !strings.Contains(out, "dyn.go:26") || !strings.Contains(out, "computed pattern") {
		t.Errorf("want a warning pointing at the call, got:\n%s", out)
	}
	types := read(t, filepath.Join(root, ".borgo", "api-types.d.ts"))
	if !strings.Contains(types, `"GET /api/fixed"`) {
		t.Errorf("the constant route must still be typed:\n%s", types)
	}
}

// A struct that embeds a pointer to itself used to recurse until the stack
// blew up - a fatal error, not a recoverable one, on every save in dev.
func TestSelfEmbeddingStructTerminates(t *testing.T) {
	types := generate(t, "selfembed")
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

// A one-off `type resp struct{...}` declared inside the handler that answers
// with it is mainstream Go. types.TypeString spells every one of them
// "pkgpath.resp", so two handlers collapsed onto a single interface built from
// whichever route sorted first: the other route promised properties it never
// sends and hid the ones it does.
func TestFunctionLocalNamedTypesDoNotCollide(t *testing.T) {
	// the three shapes testdata/localtypes/api answers with, on the wire
	func() {
		type resp struct {
			A int `json:"a"`
		}
		marshals(t, resp{A: 1}, `{"a":1}`)
	}()
	func() {
		type resp struct {
			B string `json:"b"`
			C bool   `json:"c"`
		}
		marshals(t, resp{B: "x", C: true}, `{"b":"x","c":true}`)
	}()
	func() {
		type node []int
		marshals(t, node{1, 2}, `[1,2]`)
	}()

	types := generate(t, "localtypes")
	wants(t, types,
		"export interface resp {\n  a: number;\n}",
		"export interface ApiResp {\n  b: string;\n  c: boolean;\n}",
		`"GET /api/alpha": { response: resp };`,
		`"GET /api/beta": { response: ApiResp };`,
		// a non-struct local collides the same way: the recursive one needs a
		// declaration and claims the name, and the plain slice next to it used
		// to resolve to that declaration instead of to its own shape
		"export type node = Record<string, node> | null;",
		`"GET /api/cyc": { response: node };`,
		`"GET /api/list": { response: Array<number> | null };`,
	)
}

// encoding/json.Number is typed string in Go and carries a bare number on the
// wire. A named copy of it is not it, and is quoted like any other string.
func TestJSONNumberIsANumberOnTheWire(t *testing.T) {
	n := json.Number("12.5")
	marshals(t, wireapi.Nums{N: "1", NP: &n, NS: []json.Number{"2", "3"}, Amt: "3"},
		`{"n":1,"np":12.5,"ns":[2,3],"amt":"3"}`)

	wants(t, generate(t, "wire"),
		"export interface Nums {\n  n: number;\n  np: number | null;\n"+
			"  ns: Array<number> | null;\n  amt: string;\n}")
}

// encoding/json's typeFields flattens an embedded struct whatever methods it
// carries; the marshaler only decides anything once it is promoted to the outer
// type, and then tsType has already answered. Refusing to flatten invented two
// properties and hid the real ones.
func TestEmbeddedMarshalersAreStillFlattened(t *testing.T) {
	// MA and MB are both marshalers at the same depth, so neither promotes and
	// Amb is a plain struct to encoding/json
	marshals(t, embedapi.Amb{}, `{"x":0,"y":0,"z":0}`)
	// PtrM's marshaler promotes to *PtrEmbed only, so an unaddressable
	// PtrEmbed is flattened and an addressable one goes through the marshaler
	marshals(t, embedapi.PtrEmbed{}, `{"x":0,"z":0}`)
	marshals(t, []embedapi.PtrEmbed{{}}, `["pm"]`)

	wants(t, generate(t, "embed"),
		"export interface Amb {\n  x: number;\n  y: number;\n  z: number;\n}",
		`"GET /api/amb": { response: Amb };`,
		// the root of a response is not addressable, so PtrM's marshaler cannot
		// run there and the flattened shape is the only one it can be
		"export interface PtrEmbed {\n  x: number;\n  z: number;\n}",
		`"GET /api/ptrembed": { response: PtrEmbed };`,
	)
}

// A MarshalJSON on the pointer receiver runs only where encoding/json holds an
// addressable value, and each of these four positions has one answer: a plain
// field of an unaddressable struct and a map value get the Go shape, a slice
// element and a pointed-to value get the marshaler's output.
func TestPointerReceiverJSONMarshalerFollowsThePosition(t *testing.T) {
	marshals(t, wireapi.PMHolder{Many: []wireapi.PM{{}}, Ptr: &wireapi.PM{}, Keyed: map[string]wireapi.PM{"k": {}}},
		`{"one":{"x":0},"many":["pm"],"ptr":"pm","keyed":{"k":{"x":0}}}`)

	wants(t, generate(t, "wire"),
		"export interface PM {\n  x: number;\n}",
		"export interface PMHolder {\n  one: PM;\n  many: Array<unknown> | null;\n"+
			"  ptr: unknown | null;\n  keyed: Record<string, PM> | null;\n}",
	)
}

// PM alone is a leaf: where it is addressable it is just the marshaler's
// output, and there is no second shape to declare. Outer merely holds a PM by
// value, and that is enough to give Outer itself two shapes on one wire - the
// case a single generated interface cannot describe, and the one a cheap fix
// gets backwards. Every expectation below is pinned to the json.Marshal above
// it, field by field.
func TestAddressableVariantsMatchEncodingJSON(t *testing.T) {
	marshals(t, addrapi.Holder{
		Many:   []addrapi.Outer{{}},
		Keyed:  map[string]addrapi.Outer{"k": {}},
		Ptr:    &addrapi.Outer{},
		ArrIn:  [][1]addrapi.Outer{{}},
		Boxes:  []addrapi.ArrBox{{}},
		Deref:  addrapi.Deref{Inner: &addrapi.Inner{}},
		Derefs: []addrapi.Deref{{Inner: &addrapi.Inner{}}},
		BothIn: []addrapi.Both{{}},
	}, `{"plain":{"p":{"x":0}},"many":[{"p":"pm"}],"keyed":{"k":{"p":{"x":0}}},"ptr":{"p":"pm"},`+
		`"arr":[{"p":{"x":0}}],"arrin":[[{"p":"pm"}]],"box":{"a":[{"p":{"x":0}}]},"boxes":[{"a":[{"p":"pm"}]}],`+
		`"deref":{"p":"pm","b":0},"derefs":[{"p":"pm","b":0}],"both":"txt","bothin":["js"]}`)
	// the three responses on their own, which is where the trap is: the slice
	// of Outer is the marshaled shape and the map of Outer is not
	marshals(t, addrapi.Outer{}, `{"p":{"x":0}}`)
	marshals(t, []addrapi.Outer{{}}, `[{"p":"pm"}]`)
	marshals(t, map[string]addrapi.Outer{"k": {}}, `{"k":{"p":{"x":0}}}`)
	// recursive and sensitive at once: every hop past the first is behind a
	// pointer, so the addressable variant has to refer to itself
	marshals(t, addrapi.Node{}, `{"p":{"x":0},"next":null}`)
	marshals(t, addrapi.Node{Next: &addrapi.Node{}}, `{"p":{"x":0},"next":{"p":"pm","next":null}}`)

	wants(t, generate(t, "addressable"),
		"export interface Node {\n  p: PM;\n  next: Node$Addressable | null;\n}",
		"export interface Node$Addressable {\n  p: unknown;\n  next: Node$Addressable | null;\n}",
		"export interface PM {\n  x: number;\n}",
		"export interface Outer {\n  p: PM;\n}",
		"export interface Outer$Addressable {\n  p: unknown;\n}",
		// an array element inherits, so ArrBox splits in two as well
		"export interface ArrBox {\n  a: Array<Outer>;\n}",
		"export interface ArrBox$Addressable {\n  a: Array<Outer$Addressable>;\n}",
		// a group promoted through an embedded pointer is reached with a
		// dereference, so it is addressable wherever the outer value sits and
		// Deref has one shape - a second declaration of it would be noise
		"export interface Deref {\n  p?: unknown;\n  b: number;\n}",
		"export interface Holder {\n  plain: Outer;\n  many: Array<Outer$Addressable> | null;\n"+
			"  keyed: Record<string, Outer> | null;\n  ptr: Outer$Addressable | null;\n"+
			"  arr: Array<Outer>;\n  arrin: Array<Array<Outer$Addressable>> | null;\n"+
			"  box: ArrBox;\n  boxes: Array<ArrBox$Addressable> | null;\n"+
			"  deref: Deref;\n  derefs: Array<Deref> | null;\n"+
			"  both: string;\n  bothin: Array<unknown> | null;\n}",
		`"GET /api/outer": { response: Outer };`,
		`"GET /api/outers": { response: Array<Outer$Addressable> | null };`,
		`"GET /api/outermap": { response: Record<string, Outer> | null };`,
	)
}

// encoding/json's resolveKeyName never consults MarshalJSON for a map key, only
// the kind and then TextMarshaler, so a key type carrying both is still a
// string key and the map is an ordinary object.
func TestMapKeyWithBothMarshalersIsStillAnObject(t *testing.T) {
	marshals(t, wireapi.MapBoth{M: map[wireapi.KeyBoth]int{{N: 5}: 5}}, `{"m":{"kt":5}}`)

	wants(t, generate(t, "wire"), "export interface MapBoth {\n  m: Record<string, number> | null;\n}")
}

// go/types spells the predeclared alias "[]byte" and the plain kind "[]uint8",
// so matching the result type by its rendering missed a MarshalJSON that
// json.Marshal calls all the same.
func TestUint8MarshalJSONIsRecognized(t *testing.T) {
	marshals(t, wireapi.Uint8Marshal{}, `{"u":"u8"}`)

	wants(t, generate(t, "wire"), "export interface Uint8Marshal {\n  u: unknown;\n}")
}

// union.add dedups whole strings while tsUnion flattens alternatives, so two
// nullable answers under one route used to carry a "| null" each.
func TestNullableResponsesShareOneNull(t *testing.T) {
	marshals(t, wireapi.Tags(nil), `null`)
	marshals(t, []int(nil), `null`)

	types := generate(t, "wire")
	wants(t, types, `"GET /api/either": { response: Array<string> | Array<number> | null };`)
	entry := types[strings.Index(types, `"GET /api/either"`):]
	entry = entry[:strings.IndexByte(entry, '\n')]
	if n := strings.Count(entry, "null"); n != 1 {
		t.Errorf("want one null alternative, got %d in %s", n, entry)
	}
}

// Three nullable levels - map[string][]*T, [][]*T, [][][]byte,
// map[string]map[string][]T, map[string][]map[string]T - used to be rendered
// and then taken apart again by splitting the rendering on " | ". " | " occurs
// inside a type-argument list too, so the pieces were fragments and not
// alternatives: "Record<string, Array<Item | null> | null>" split to
// ["Record<string, Array<Item", "null>", "null>"], the repeated "null>" was
// dropped as a duplicate, and the ">" it carried went with it. Two levels
// survived by luck, which is why this went unseen.
//
// Each field below is asserted whole, not merely for balanced brackets: the
// null now travels beside the text instead of inside it, so the way this fails
// from here on is the opposite of the old one - a null quietly left off, in a
// type that parses and typechecks and promises non-null for a field that
// arrives null.
func TestNestedNullableTypesAreClosedAndKeepEveryNull(t *testing.T) {
	full := nestedapi.Nested{
		Grouped: map[string][]*nestedapi.Item{"g": {{ID: "a"}}},
		Rows:    [][]*nestedapi.Item{{{ID: "b"}}},
		Chunks:  [][][]byte{{[]byte("c")}},
		Deep:    map[string]map[string][]string{"d": {"e": {"f"}}},
		Mixed:   map[string][]map[string]int{"m": {{"k": 1}}},
	}
	marshals(t, full, `{"grouped":{"g":[{"id":"a"}]},"rows":[[{"id":"b"}]],"chunks":[["Yw=="]],"deep":{"d":{"e":["f"]}},"mixed":{"m":[{"k":1}]}}`)
	// and every one of those levels really can be null on the wire, which is
	// what each "| null" below is promising
	marshals(t, nestedapi.Nested{}, `{"grouped":null,"rows":null,"chunks":null,"deep":null,"mixed":null}`)
	marshals(t, [][]*nestedapi.Item(nil), `null`)
	marshals(t, []map[string]*nestedapi.Item(nil), `null`)

	types := generate(t, "nested")
	wants(t, types, "export interface Nested {\n"+
		"  grouped: Record<string, Array<Item | null> | null> | null;\n"+
		"  rows: Array<Array<Item | null> | null> | null;\n"+
		"  chunks: Array<Array<string | null> | null> | null;\n"+
		"  deep: Record<string, Record<string, Array<string> | null> | null> | null;\n"+
		"  mixed: Record<string, Array<Record<string, number> | null> | null> | null;\n}")
	// the same composition reached from a response union and from the push map,
	// where the members have to stay whole to be deduped and the pair carries
	// one null between them
	wants(t, types,
		`"GET /api/nested/either": { response: Array<Array<Item | null> | null> | Array<Record<string, Item | null> | null> | null };`,
		`"room/mixed": Array<Array<Item | null> | null> | Array<Record<string, Array<string> | null> | null> | null;`,
	)
	typechecks(t, types)
}

// The direction the fix above fails in, stated as a test rather than as a
// hope. Nothing splits a rendered type any more, so a union member is opaque -
// including the one case where a member arrives already carrying a top-level
// null, a //borgo:type whose replacement text is itself a union. Widening that
// leaf stacks a second null on it: examples/tasks maps gorm.DeletedAt to
// "string | null", and a *gorm.DeletedAt would read "string | null | null".
//
// That is redundant, not wrong - TypeScript flattens a union and null is
// idempotent in it - and it is the price of never taking somebody else's text
// apart. It is pinned here so it stays a choice: if this ever has to go, it
// goes by carrying the override as structure from the directive, never by
// splitting the rendering again.
func TestOverrideTextIsCarriedWholeIntoEveryNullablePosition(t *testing.T) {
	// the wire the two nilable cases below are typed against
	marshals(t, overrideapi.Tags(nil), `null`)
	marshals(t, overrideapi.Tags{"a"}, `["a"]`)

	types := generate(t, "overrideunion")
	wants(t, types, "export interface Holder {\n"+
		"  one: string | null;\n"+
		"  ptr: (string | null) | null;\n"+
		"  many: Array<string | null> | null;\n"+
		"  keyed: Record<string, string | null> | null;\n"+
		// a replacement that binds looser than "|" is parenthesised before
		// anything is composed around it, or the null lands inside the
		// function's return type instead of beside the function
		"  fn: ((v: string) => void) | null;\n"+
		// and a nilable Go type keeps its null: the text replaces the shape,
		// not the nil. No parentheses here - the scan found nothing loose in it
		"  tags: Array<string> | null;\n}")
	typechecks(t, types)
}

// A replacement nobody validated went into the file exactly as written, and a
// generated file is not a place where a mistake stays local: one unbalanced
// bracket in one directive costs every route in the project its types. A
// generator that cannot render a type says so instead.
func TestUnparsableTypeOverridesFailTheRun(t *testing.T) {
	for _, c := range []struct{ name, dir, want string }{
		{"unclosed generic", "badtypets", "the < in it is never closed"},
		{"trailing comment", "badtypecomment", "it contains a comment"},
		{"statement after the type", "badtypestmt", `it contains a top-level ";"`},
	} {
		t.Run(c.name, func(t *testing.T) {
			// what is asserted below is that this run writes nothing, and that
			// is a claim about a known starting state: a copy left by an
			// earlier run - a mutation experiment above all, which is where
			// this was found - would otherwise read as one this run wrote
			out := filepath.Join("testdata", c.dir, ".borgo", "api-types.d.ts")
			if err := os.Remove(out); err != nil && !os.IsNotExist(err) {
				t.Fatal(err)
			}
			err := run(filepath.Join("testdata", c.dir))
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("want an error containing %q, got %v", c.want, err)
			}
			if _, statErr := os.Stat(out); !os.IsNotExist(statErr) {
				t.Errorf("a refused directive must leave no generated file behind: %v", statErr)
			}
		})
	}
}

// `type Loop *Loop` is a cycle that runs through pointers alone: every value is
// a chain that has to end at a nil pointer, and encoding/json writes a pointer
// as whatever it points at. Inlining it emitted "export type Loop = Loop |
// null;", a type alias referring to itself - TS2456, which skipLibCheck hides.
func TestPointerCycleTypeIsNull(t *testing.T) {
	marshals(t, recursiveapi.LoopHolder{}, `{"l":null}`)
	var end recursiveapi.Loop
	marshals(t, recursiveapi.LoopHolder{L: &end}, `{"l":null}`)

	types := generate(t, "recursive")
	wants(t, types, "export interface LoopHolder {\n  l: null;\n}")
	if strings.Contains(types, "export type Loop") {
		t.Errorf("a pointer cycle has no declaration to make, and a self-referential alias is TS2456:\n%s", types)
	}
}

// An inline closure and an http.HandlerFunc(Named) conversion are both ordinary
// ways to register a handler, and both used to yield "response: unknown" with
// nothing said. Anything still unresolvable has to warn, the way a computed
// borgo.Handle pattern already does.
func TestClosureAndConvertedHandlersAreTyped(t *testing.T) {
	marshals(t, closureapi.Inline{A: 1}, `{"a":1}`)
	marshals(t, closureapi.Wrapped{B: "b"}, `{"b":"b"}`)

	var types string
	out := captureStderr(t, func() { types = generateFresh(t, "closurehandle") })
	wants(t, types,
		"export interface Inline {\n  a: number;\n}",
		"export interface Wrapped {\n  b: string;\n}",
		`"GET /api/inline": { response: Inline };`,
		`"GET /api/wrapped": { response: Wrapped };`,
		`"GET /api/authedinline": { response: Wrapped };`,
		// a handler decided at runtime has no body to read, which is the one
		// case that stays unknown - and says so
		`"GET /api/opaque": { response: unknown };`,
	)
	if !strings.Contains(out, "handle.go:35") || !strings.Contains(out, "stay unknown") {
		t.Errorf("want a warning pointing at the unresolvable registration, got:\n%s", out)
	}
}

// A push further from api than the walk goes is worse than a plain omission:
// TopicEvents<T> closes a topic's union as soon as one of its events is
// declared, so the subscriber for the dropped one fails tsc with nothing
// pointing back at the generator.
func TestPushBeyondTheHopCapWarns(t *testing.T) {
	marshals(t, deeph3.PThree{}, `{"n":0}`)
	marshals(t, deeph4.PFour{}, `{"n":0}`)

	var types string
	out := captureStderr(t, func() { types = generateFresh(t, "deeppush") })
	wants(t, types,
		`"chain/one": POne;`,
		`"chain/two": PTwo;`,
		`"chain/three": PThree;`,
	)
	if strings.Contains(types, "chain/four") {
		t.Errorf("h4 is past the cap, so its event cannot be typed:\n%s", types)
	}
	if !strings.Contains(out, "deeppush/h4") || !strings.Contains(out, "package hops from api/") {
		t.Errorf("want a warning naming the package that was not scanned, got:\n%s", out)
	}
}

// A request body is what encoding/json reads, and reading is not writing run
// backwards: the decoder consults UnmarshalJSON and UnmarshalText, and it always
// holds the address of what it is filling, because borgo.Bind declares its own
// value and decodes into &v. Rendering request types with the marshal rules was
// inverted in both directions at once, and the assertions below are both of
// them: the shape the old generator told callers to send is the one shape the
// server refuses, and the shape it refused to admit is the one it accepts.
func TestRequestTypesFollowTheUnmarshalRules(t *testing.T) {
	// out: Slug is a string, because MarshalText says so
	marshals(t, requestapi.Create{Slug: requestapi.Slug{Raw: "x"}}, `{"slug":"x","stamp":{"unix":0},"note":""}`)
	// in: that very body is rejected, and the object shape is what binds
	rejects(t, `{"slug":"x"}`, &requestapi.Create{})
	accepts(t, `{"slug":{"raw":"x"},"stamp":17,"note":"n"}`, &requestapi.Create{})

	types := generate(t, "request")
	wants(t, types,
		"export interface Create {\n  slug: string;\n  stamp: Stamp;\n  note: string;\n}",
		"export interface Create$Request {\n  slug?: Slug$Request | null;\n  stamp?: unknown | null;\n  note?: string | null;\n}",
		"export interface Slug$Request {\n  raw?: string | null;\n}",
		`"POST /api/things": { response: Create; request: Create$Request };`,
		// and a type that converts nothing itself still reads differently from
		// how it is written, because reading is lenient about every field
		"export interface Plain {\n  name: string;\n}",
		"export interface Plain$Request {\n  name?: string | null;\n}",
		`"POST /api/plain": { response: Plain; request: Plain$Request };`,
	)
	typechecks(t, types)
}

// Registering a handler that lives in another package of the app is ordinary
// layering: api/ knows the *types.Func and holds no declaration for it, so the
// walk began at nothing and the route came out "response: unknown" - the same
// answer a handler that writes nothing gets, with nothing to tell them apart.
func TestHandlersInOtherPackagesAreTyped(t *testing.T) {
	var types string
	out := captureStderr(t, func() { types = generateFresh(t, "pkghandler") })
	wants(t, types,
		"export interface User {\n  name: string;\n}",
		"export interface Filter$Request {\n  q?: string | null;\n}",
		`"GET /api/users": { response: User; request: Filter$Request };`,
		// and one whose package this generator really does not read stays
		// unknown - out loud, which is the whole difference
		`"GET /api/notfound": { response: unknown };`,
	)
	if !strings.Contains(out, "net/http") || !strings.Contains(out, "stay unknown") {
		t.Errorf("want a warning naming the package that was not read, got:\n%s", out)
	}
	if strings.Contains(out, "users.List") || strings.Contains(out, "handler List") {
		t.Errorf("the handler that was read must not warn:\n%s", out)
	}
	// borgo's own handlers are untyped by the framework's choice and on every
	// run of every app that registers them: a warning nobody can act on is how
	// the ones that matter stop being read
	if strings.Contains(out, "LoginHandler") {
		t.Errorf("the framework's own handlers must not warn:\n%s", out)
	}
	if !strings.Contains(types, `"POST /api/login": { response: unknown };`) {
		t.Errorf("the framework handler is still a route, and still untyped:\n%s", types)
	}
	typechecks(t, types)
}

// The hop cap bounds how much of the module one route can pull into analysis.
// What sits past it used to be dropped without a word, and a missing
// alternative does not read as missing: the route just answers less than it
// does, or nothing at all, and the caller's code fails to compile against a
// response the server really sends. The push walk already says where it
// stopped; this is the same debt on the response side.
func TestResponsesBeyondTheHopCapWarn(t *testing.T) {
	var types string
	out := captureStderr(t, func() { types = generateFresh(t, "deepresp") })
	wants(t, types, `"GET /api/chain": { response: ROne | RTwo | RThree };`)
	if strings.Contains(types, "RFour") {
		t.Errorf("h4 is past the cap, so nothing in it can be typed:\n%s", types)
	}
	if !strings.Contains(out, "h4.Four") || !strings.Contains(out, "package hops from the handler") {
		t.Errorf("want a warning naming the function that was not followed, got:\n%s", out)
	}
	typechecks(t, types)
}

// A //borgo:type naming a function-local type does apply, as long as the name
// picks out exactly one. Rejecting it failed a run whose directive was
// perfectly good.
func TestTypeOverrideOnAFunctionLocalType(t *testing.T) {
	wants(t, generate(t, "localoverride"), "export interface resp {\n  at: string;\n}")
}

// reserveName's collision path prefixes the package name, and used to paste it
// onto the type's own name unchanged: a second function-local `type resp
// struct{...}` came out Apiresp. ApiRecord and ApiArray were already right only
// because those names start capitalised.
func TestPrefixedCollisionNamesAreTitleCased(t *testing.T) {
	types := generate(t, "localtypes")
	wants(t, types, "export interface ApiResp {", `"GET /api/beta": { response: ApiResp };`)
	if strings.Contains(types, "Apiresp") {
		t.Errorf("the package prefix must title-case the name it prefixes:\n%s", types)
	}
}

// The override key was the bare name alone, so a directive written for a
// package-level type also rewrote every function-local type that happened to
// share its name - silently, in handlers the author never touched.
func TestBareTypeOverrideDoesNotReachOtherScopes(t *testing.T) {
	types := generate(t, "overridescope")
	wants(t, types,
		// the package-level Stamp the directive names
		"export interface PkgResp {\n  at: string;\n}",
		// and the unrelated one declared inside another handler, untouched
		"export interface Stamp {\n  nano: number;\n}",
		"export interface resp {\n  at: Stamp;\n}",
	)
}

// A bare name that several declarations answer to is a question, not a default:
// the run stops and says which ones it found and how to pick one.
func TestAmbiguousBareTypeOverrideFails(t *testing.T) {
	err := run(filepath.Join("testdata", "ambigtype"))
	if err == nil {
		t.Fatal("want an error")
	}
	for _, want := range []string{
		"is ambiguous",
		"2 types named stamp",
		"ambig.go:17",
		"ambig.go:25",
		"stamp@ambig.go:17",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error missing %q: %v", want, err)
		}
	}
}

// And the spelling that error hands the author does resolve to the one
// declaration, leaving the other alone.
func TestTypeOverrideCanNameOneDeclarationByPosition(t *testing.T) {
	types := generate(t, "postype")
	wants(t, types,
		"export interface resp {\n  at: string;\n}",
		"export interface stamp {\n  nano: number;\n}",
		"export interface ApiResp {\n  at: stamp;\n}",
	)
}

// What a request type must describe is what encoding/json's decoder does, and
// that was measured rather than reasoned about: the table on the in constant is
// the output of running every kind borgogen renders through the four bodies
// that can reach a field. Two of its rows decide the whole rendering - an
// absent field is not an error and a null field is not an error, for every kind
// without exception - and the third keeps it from being a shrug: a field of the
// wrong type IS an error, so "string | null" is exact and not merely safe.
//
// The assertion below is the property itself and not a reading of the emitted
// text: each body is handed to tsc against the generated type and to
// encoding/json against the Go type it was generated from, and the two answers
// must be the same answer. A body the type calls valid is decoded; a body the
// server refuses does not compile.
func TestInboundFieldsMatchEncodingJSON(t *testing.T) {
	types := generate(t, "inbound")
	wants(t, types,
		// going out, a field is optional only where omitempty can drop it and
		// nullable only where the Go kind can be nil. Nothing here moved
		"export interface Every {\n"+
			"  flag: boolean;\n  count: number;\n  ratio: number;\n  name: string;\n"+
			"  ptr: string | null;\n  list: Array<string> | null;\n  fixed: Array<string>;\n"+
			"  dict: Record<string, string> | null;\n  nested: Inner;\n  blob: string | null;\n"+
			"  at: string;\n  amount: number;\n  free: unknown;\n  code: string;\n"+
			"  opt?: string;\n  quoted: string;\n}",
		// coming in, every one of them is both
		"export interface Every$Request {\n"+
			"  flag?: boolean | null;\n  count?: number | null;\n  ratio?: number | null;\n  name?: string | null;\n"+
			"  ptr?: string | null;\n  list?: Array<string> | null;\n  fixed?: Array<string> | null;\n"+
			"  dict?: Record<string, string> | null;\n  nested?: Inner$Request | null;\n  blob?: string | null;\n"+
			"  at?: string | null;\n  amount?: number | null;\n  free?: unknown | null;\n  code?: string | null;\n"+
			"  opt?: string | null;\n  quoted?: string | null;\n}",
		// a nested struct is read by the same decoder, so it is lenient too
		"export interface Inner {\n  a: number;\n}",
		"export interface Inner$Request {\n  a?: number | null;\n}",
		// and a type with no fields for that leniency to apply to is one shape
		// both ways, so it keeps one declaration
		`"POST /api/tags": { response: Array<string> | null; request: Array<string> | null };`,
		// the case dirDiffers over-approximates: already optional, already
		// nullable, and it still gets a second declaration of the same text
		"export interface Loose {\n  ptr?: string | null;\n}",
		"export interface Loose$Request {\n  ptr?: string | null;\n}",
	)
	// a json:"-" field and an unexported one are not read at all, so neither can
	// appear in a body the type admits
	if strings.Contains(types, "Skipped") || strings.Contains(types, "hidden") {
		t.Errorf("a field the decoder never fills must not be in the request type:\n%s", types)
	}

	rows := []struct {
		body string
		ok   bool // encoding/json decodes it
	}{
		// absent: never an error, for any kind
		{`{}`, true},
		{`{"nested":{}}`, true},
		// null: never an error either, for any kind - pointer and non-pointer,
		// converter and container, `,string` and omitempty alike
		{`{"flag":null,"count":null,"ratio":null,"name":null,"ptr":null,"list":null,"fixed":null,"dict":null,"nested":null,"blob":null,"at":null,"amount":null,"free":null,"code":null,"opt":null,"quoted":null}`, true},
		{`{"nested":{"a":null}}`, true},
		// the right type
		{`{"flag":true,"count":7,"ratio":1.5,"name":"n","ptr":"p","list":["a"],"fixed":["a","b"],"dict":{"k":"v"},"nested":{"a":1},"blob":"aGk=","at":"2020-01-01T00:00:00Z","amount":7,"free":{"anything":true},"code":"c","opt":"o","quoted":"7"}`, true},
		{`{"list":[]}`, true},
		{`{"dict":{}}`, true},
		// an array is not a tuple to encoding/json: it takes what it is given
		// and pads or drops the rest, so Array<T> is exact and [T,T] would not be
		{`{"fixed":["only"]}`, true},
		{`{"fixed":["a","b","c"]}`, true},
		// an interface field takes any JSON at all, which is what unknown says
		{`{"free":7}`, true},
		{`{"free":"s"}`, true},
		// the wrong type: an error for every kind but the one above
		{`{"flag":"x"}`, false},
		{`{"count":"x"}`, false},
		{`{"ratio":"x"}`, false},
		{`{"name":7}`, false},
		{`{"ptr":7}`, false},
		{`{"list":7}`, false},
		{`{"list":[7]}`, false},
		{`{"fixed":7}`, false},
		{`{"dict":7}`, false},
		{`{"dict":{"k":7}}`, false},
		{`{"nested":7}`, false},
		{`{"nested":{"a":"x"}}`, false},
		{`{"blob":7}`, false},
		{`{"at":7}`, false},
		{`{"amount":"s"}`, false},
		{`{"code":7}`, false},
		// `,string` is enforced coming in: the field wants the quoted form and
		// refuses the bare one, which is why it is typed string and not number
		{`{"quoted":7}`, false},
		// omitempty is a marshal directive and buys the decoder nothing: this
		// field is exactly as strict about its type as one without it
		{`{"opt":7}`, false},
	}

	for _, r := range rows {
		v := &inboundapi.Every{}
		if got := json.Unmarshal([]byte(r.body), v) == nil; got != r.ok {
			t.Fatalf("encoding/json accepted %s = %v, and this table claims %v", r.body, got, r.ok)
		}
	}

	bodies := make([]string, len(rows))
	for i, r := range rows {
		bodies[i] = r.body
	}
	for i, accepted := range typecheckBodies(t, types, "Every$Request", bodies) {
		if accepted != rows[i].ok {
			t.Errorf("%s: the generated type accepts it = %v, the server accepts it = %v", rows[i].body, accepted, rows[i].ok)
		}
	}
}

// Some things about a request body cannot be said in TypeScript at all, and a
// type that pretended otherwise would be worse than one that says where it
// stops. Each row below is a body the two sides really do disagree about,
// pinned so that a disagreement which ever stops being one is noticed here
// rather than believed.
func TestWhereTheRequestTypeCannotBeExact(t *testing.T) {
	types := generate(t, "inbound")
	rows := []struct {
		body    string
		decodes bool
		why     string
	}{
		// TypeScript has one number type, so the width and the integer-ness of a
		// Go numeric field are unsayable. The type is wider than the server here
		{`{"count":1.5}`, false, "a fraction into an int"},
		{`{"count":1e300}`, false, "a value past the width of an int"},
		// and a string is a string: RFC3339, base64 and the `,string` payload
		// are sub-languages of it that a type cannot spell
		{`{"at":"nope"}`, false, "a string that is not a timestamp"},
		{`{"blob":"!!!"}`, false, "a string that is not base64"},
		{`{"quoted":"x"}`, false, "a quoted value that is not a number"},
		// the other direction, and the only one: json.Number also accepts a
		// numeric string. `number | string` would admit every string; the
		// template literal `${number}` admits only what TypeScript parses as a
		// number - which is not what Go does: see TestNumericStringIsNotJSONNumber
		// for the nine forms tsc takes and encoding/json refuses. It stays number
		{`{"amount":"7"}`, true, "a numeric string into a json.Number"},
		// an unknown key is ignored by the decoder and refused by tsc, which
		// refuses it twice over: as an excess property on a fresh literal, and -
		// since every property here is optional - as a weak-type mismatch. It
		// costs the caller nothing the server would have done anything with
		{`{"nope":1}`, true, "a key the Go type does not declare"},
		{`{"Skipped":"x"}`, true, `a json:"-" field addressed by its Go name`},
	}
	for _, r := range rows {
		v := &inboundapi.Every{}
		if got := json.Unmarshal([]byte(r.body), v) == nil; got != r.decodes {
			t.Fatalf("%s (%s): encoding/json accepted it = %v, want %v", r.body, r.why, got, r.decodes)
		}
	}
	bodies := make([]string, len(rows))
	for i, r := range rows {
		bodies[i] = r.body
	}
	for i, accepted := range typecheckBodies(t, types, "Every$Request", bodies) {
		if accepted == rows[i].decodes {
			t.Errorf("%s (%s): tsc and encoding/json agree now, so this is no longer an inexactness to document", rows[i].body, rows[i].why)
		}
	}
}

// `${number}` looks like the exact type for a json.Number string: it takes "7"
// and refuses "abc". It is not. TypeScript's idea of a numeric string is its own
// literal grammar; encoding/json's is the JSON number grammar. Each string below
// is a body one side takes and the other refuses, measured here so the choice
// to emit plain number rests on the difference, not on the memory of one.
func TestNumericStringIsNotJSONNumber(t *testing.T) {
	types := generate(t, "inbound") + "export type Numeric = { amount?: number | `${number}` };\n"
	rows := []struct {
		value string
		go_   bool
		tsc   bool
	}{
		{`"7"`, true, true},
		{`"-7"`, true, true},
		{`"7.5"`, true, true},
		{`"1e3"`, true, true},
		{`"abc"`, false, false},
		{`""`, false, false},
		{`"NaN"`, false, false},
		{`"Infinity"`, false, false},
		// JSON has no whitespace, sign prefix, bare dot, radix or leading zero
		{`" 7"`, false, true},
		{`"7 "`, false, true},
		{`"+7"`, false, true},
		{`".5"`, false, true},
		{`"7."`, false, true},
		{`"0x10"`, false, true},
		{`"0b11"`, false, true},
		{`"0o7"`, false, true},
		{`"07"`, false, true},
	}
	bodies := make([]string, len(rows))
	for i, r := range rows {
		bodies[i] = `{"amount":` + r.value + `}`
		var v struct{ Amount json.Number }
		if got := json.Unmarshal([]byte(bodies[i]), &v) == nil; got != r.go_ {
			t.Errorf("%s: encoding/json accepted it = %v, want %v", r.value, got, r.go_)
		}
	}
	wider := 0
	for i, accepted := range typecheckBodies(t, types, "Numeric", bodies) {
		if accepted != rows[i].tsc {
			t.Errorf("%s: tsc accepted `${number}` = %v, want %v", rows[i].value, accepted, rows[i].tsc)
		}
		if accepted && !rows[i].go_ {
			wider++
		}
	}
	if wider == 0 {
		t.Error("`${number}` is now exactly json.Number: emit it, and retire the pin in TestWhereTheRequestTypeCannotBeExact")
	}
}
