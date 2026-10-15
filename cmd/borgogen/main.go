// Command borgogen statically analyzes an app's api/ package (go/ast +
// go/types, no runtime reflection) and generates two files:
//
//   - .borgo/api-types.d.ts - route pattern -> response and request types.
//     The response type of a route is the union of the T in every
//     borgo.JSON[T] and borgo.WriteJSON call reachable from its handler
//     (helper functions are followed, into other packages of the same module
//     too); the request type comes from borgo.Bind[T] and borgo.BindMax[T]
//     calls the same way. An inline json.NewEncoder(w).Encode(v) on the
//     handler's http.ResponseWriter counts as a response too. A "//borgo:type Go TS"
//     directive overrides the mapping for any named Go type. borgo.Push
//     calls additionally feed a "topic/event" -> payload map (WsEvents),
//     typing the browser's subscribe callback per topic.
//   - api/borgo.gen.go - mounting for handlers annotated with a
//     "//borgo:route METHOD /path" directive, so init() boilerplate is
//     optional. Manual borgo.Handle registration keeps working alongside.
package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/constant"
	"go/parser"
	"go/token"
	"go/types"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"

	"golang.org/x/tools/go/packages"
)

const (
	borgoPath = "github.com/LuigiDavideMicca/borgo"
	genGoFile = "api/borgo.gen.go"
)

var (
	directiveRe    = regexp.MustCompile(`^//borgo:route\s+(.+)$`)
	typeRe         = regexp.MustCompile(`^//borgo:type\s+(\S+)\s+(.+)$`)
	topicRe        = regexp.MustCompile(`^//borgo:topic\s+(\S+)\s*$`)
	looseTopic     = regexp.MustCompile(`^//\s*borgo:topic\b`)
	placeholderRe  = regexp.MustCompile(`\{([A-Za-z_][A-Za-z0-9_]*)\}`)
	patternRe      = regexp.MustCompile(`^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /\S*$`)
	looseDirective = regexp.MustCompile(`^//\s*borgo:route\b`)
)

type route struct {
	pattern string
	handler *types.Func
	// decl carries the body to read bridge types from when the handler is not a
	// declared function - an inline closure has no *types.Func to look up.
	decl *ast.FuncDecl
	// signup is the form type of a borgo.Signup handler: the one framework
	// handler whose request type is the app's, read from the instantiation
	// rather than from a body the generator cannot see
	signup types.Type
	pos    token.Position
}

type genError struct{ msg string }

func fail(format string, args ...any) {
	panic(genError{fmt.Sprintf(format, args...)})
}

// warn reports something the generator chose not to type but will not fail
// over: silence would leave the user wondering where their event went.
func warn(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "borgogen: warning: %s\n", fmt.Sprintf(format, args...))
}

func main() {
	if err := run("."); err != nil {
		fmt.Fprintln(os.Stderr, "borgogen: "+err.Error())
		os.Exit(1)
	}
}

func run(root string) (err error) {
	defer func() {
		if r := recover(); r != nil {
			ge, ok := r.(genError)
			if !ok {
				panic(r)
			}
			err = fmt.Errorf("%s", ge.msg)
		}
	}()

	if _, statErr := os.Stat(filepath.Join(root, "api")); statErr != nil {
		fail("no api/ directory here; run borgogen from the app root")
	}

	// no NeedDeps: dependency types come from export data instead of a full
	// source re-typecheck of the import graph, which dominates wall time
	cfg := &packages.Config{
		Dir: root,
		Mode: packages.NeedName | packages.NeedFiles | packages.NeedSyntax |
			packages.NeedTypes | packages.NeedTypesInfo | packages.NeedImports |
			packages.NeedModule,
	}
	pkg := loadAPI(cfg, root)
	if hasErrorIn(pkg, "borgo.gen.go") {
		// the previous generated mounting references deleted handlers; retry
		// against an empty stub of it. only then: -overlay defeats the go
		// list cache and roughly triples the load
		genGoAbs, _ := filepath.Abs(filepath.Join(root, genGoFile))
		cfg.Overlay = map[string][]byte{genGoAbs: []byte("package " + apiPackageName(root) + "\n")}
		pkg = loadAPI(cfg, root)
	}
	if len(pkg.Errors) > 0 {
		// the driver error (Pos "-") carries the compiler's whole block, and
		// the per-file errors repeat its lines one by one: joined naively,
		// every failure printed twice. lines are deduplicated in order, so
		// each failure is said once whichever shape delivered it
		seen := map[string]bool{}
		var lines []string
		for _, e := range pkg.Errors {
			for _, line := range strings.Split(e.Error(), "\n") {
				if line == "" || seen[line] {
					continue
				}
				seen[line] = true
				lines = append(lines, line)
			}
		}
		fail("%s", strings.Join(lines, "\n"))
	}
	dropGeneratedFile(pkg)

	routes := collectRoutes(pkg)
	decls := funcDecls(pkg)
	directives := collectDirectives(pkg, decls, routes)
	warnLooseRouteComments(pkg, decls)
	warnExcludedRouteFiles(root, pkg)
	mw := collectMiddleware(pkg)
	exportFns := collectExports(pkg, decls)
	routes = append(routes, directives...)

	sort.Slice(routes, func(i, j int) bool {
		am, ap := splitPattern(routes[i].pattern)
		bm, bp := splitPattern(routes[j].pattern)
		if ap != bp {
			return ap < bp
		}
		if am != bm {
			return am < bm
		}
		// sort.Slice is not stable, so duplicate patterns need a tiebreak of
		// their own or which one gets typed varies between runs
		if routes[i].pos.Filename != routes[j].pos.Filename {
			return routes[i].pos.Filename < routes[j].pos.Filename
		}
		return routes[i].pos.Offset < routes[j].pos.Offset
	})

	gen := &tsGen{
		names:     map[string]string{},
		taken:     reservedTSNames(),
		expanding: map[string]bool{},
		apiPkg:    pkg.Types,
		overrides: collectTypeOverrides(pkg),
	}
	loader := newHelperLoader(root, pkg)
	entries := make(map[string]string, len(routes))
	first := make(map[string]token.Position, len(routes))
	patterns := make([]string, 0, len(routes))
	for _, r := range routes {
		if prev, dup := first[r.pattern]; dup {
			// two borgo.Handle calls for one pattern: http.ServeMux panics at
			// startup, and emitting the key twice would put two conflicting
			// declarations of it in ApiRoutes
			fmt.Fprintf(os.Stderr, "borgogen: warning: %s: pattern %q is already registered at %s; only the first registration is typed, and http.ServeMux panics on the duplicate at startup\n", r.pos, r.pattern, prev)
			continue
		}
		first[r.pattern] = r.pos
		hpkg, hdecls, body := handlerBody(pkg, decls, r, loader)
		gen.multipart = false
		resp, req := gen.bridgeTypes(hpkg, hdecls, body, loader)
		if r.signup != nil {
			// decoded by Bind inside Signup: addressable, inbound
			refuseJSONFile(r.signup, r.pos, "borgo.Signup")
			var form union
			form.add(gen.tsType(r.signup, inbound()))
			req = form.String()
		}
		entry := "{ response: " + resp
		if req != "" {
			entry += "; request: " + req
		}
		if gen.multipart {
			// the client builds a FormData for this route instead of JSON
			entry += "; multipart: true"
		}
		entries[r.pattern] = entry + " }"
		patterns = append(patterns, r.pattern)
	}

	wsKeys, wsEntries, wsPatterns := collectPushes(pushSources(pkg, loader), gen)
	// before the defs are written out: the export stubs add the types they
	// name to the same api-types.d.ts that go.ts imports them from
	goTS := gen.exportsTS(exportFns)

	var out strings.Builder
	out.WriteString("// generated by borgogen - do not edit\n\n")
	for _, def := range gen.defs {
		out.WriteString(def)
		out.WriteString("\n")
	}
	shadowed := shadowedByModule(gen.defs)
	for _, name := range borgoModuleNames {
		if shadowed[name] {
			fmt.Fprintf(&out, "type %s%s = %s;\n", moduleAliasPrefix, name, name)
		}
	}
	if len(shadowed) > 0 {
		out.WriteString("\n")
	}
	out.WriteString("declare module \"borgo-framework\" {\n  interface ApiRoutes {\n")
	for _, p := range patterns {
		fmt.Fprintf(&out, "    %s: %s;\n", tsString(p), qualifyForModule(entries[p], shadowed))
	}
	out.WriteString("  }\n")
	if len(wsKeys) > 0 {
		out.WriteString("  interface WsEvents {\n")
		for _, k := range wsKeys {
			if wsPatterns[k] {
				// a template literal index signature: the key of every topic
				// the pattern admits, matched by EventsFor in index.ts
				fmt.Fprintf(&out, "    [k: `%s`]: %s;\n", eventKey(k), qualifyForModule(wsEntries[k], shadowed))
				continue
			}
			fmt.Fprintf(&out, "    %s: %s;\n", tsString(k), qualifyForModule(wsEntries[k], shadowed))
		}
		out.WriteString("  }\n")
	}
	out.WriteString("}\n\nexport {};\n")

	// the disk is untouched until here: any check above fails the run without
	// leaving one output regenerated, or deleted, and the other one stale
	writeMounting(root, pkg.Name, directives, pkg.Types.Scope(), mw, pkg.Types, exportFns)

	if mkErr := os.MkdirAll(filepath.Join(root, ".borgo"), 0o755); mkErr != nil {
		fail("%v", mkErr)
	}
	writeIfChanged(filepath.Join(root, ".borgo", "api-types.d.ts"), out.String())
	writeMiddlewareCover(root, mw)
	fmt.Printf("borgogen: %d routes -> .borgo/api-types.d.ts\n", len(patterns))
	goPath := filepath.Join(root, ".borgo", "go.ts")
	if goTS == "" {
		os.Remove(goPath)
	} else {
		writeIfChanged(goPath, goTS)
		fmt.Printf("borgogen: %d exports -> .borgo/go.ts\n", len(exportFns))
	}
	return nil
}

func loadAPI(cfg *packages.Config, root string) *packages.Package {
	pkgs, loadErr := packages.Load(cfg, "./api")
	if loadErr != nil {
		fail("loading api package: %v", loadErr)
	}
	if len(pkgs) != 1 {
		fail("expected one package in api/, got %d", len(pkgs))
	}
	return pkgs[0]
}

// dropGeneratedFile removes borgo.gen.go from the analyzed syntax: its
// borgo.Handle calls would otherwise re-register every directive route as a
// manual one and collide with the directives that produced them.
func dropGeneratedFile(pkg *packages.Package) {
	kept := pkg.Syntax[:0]
	for _, file := range pkg.Syntax {
		name := filepath.Base(pkg.Fset.Position(file.Pos()).Filename)
		if name != "borgo.gen.go" {
			kept = append(kept, file)
		}
	}
	pkg.Syntax = kept
}

func hasErrorIn(pkg *packages.Package, file string) bool {
	for _, e := range pkg.Errors {
		if strings.Contains(e.Pos, file) {
			return true
		}
	}
	return false
}

// apiPackageName reads the package clause of the first real api/*.go file so
// the overlay stub and the generated mounting use the right name.
func apiPackageName(root string) string {
	entries, err := os.ReadDir(filepath.Join(root, "api"))
	if err != nil {
		fail("%v", err)
	}
	fset := token.NewFileSet()
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".go") || e.Name() == "borgo.gen.go" ||
			// an api/foo_test.go declaring package api_test would name the
			// overlay stub after the external test package, and the retry
			// that exists to recover from a stale mounting would itself fail
			strings.HasSuffix(e.Name(), "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, filepath.Join(root, "api", e.Name()), nil, parser.PackageClauseOnly)
		if err == nil {
			return f.Name.Name
		}
	}
	return "api"
}

var handlerSig = "func(http.ResponseWriter, *http.Request)"

func isHandlerSig(fn *types.Func) bool {
	sig, ok := fn.Type().(*types.Signature)
	if !ok || sig.Recv() != nil || sig.TypeParams().Len() != 0 ||
		sig.Params().Len() != 2 || sig.Results().Len() != 0 {
		return false
	}
	return sig.Params().At(0).Type().String() == "net/http.ResponseWriter" &&
		sig.Params().At(1).Type().String() == "*net/http.Request"
}

// splitPattern splits "METHOD /path" tolerantly: manual borgo.Handle patterns
// may be method-less serve-mux patterns like "/path".
func splitPattern(p string) (method, path string) {
	if i := strings.IndexByte(p, ' '); i >= 0 {
		return p[:i], p[i+1:]
	}
	return "", p
}

// collectDirectives finds every //borgo:route directive and validates it
// against the manually registered patterns.
func collectDirectives(pkg *packages.Package, decls map[*types.Func]*ast.FuncDecl, manual []route) []route {
	taken := map[string]string{}
	for _, r := range manual {
		name := "?"
		if r.handler != nil {
			name = r.handler.Name()
		}
		taken[r.pattern] = name + " (borgo.Handle)"
	}

	var out []route
	// map iteration order is random, and on a duplicate directive it decided
	// which registration got named as "pos" and which as "prev" - the same
	// failure spelled two ways across two runs. source order is the one a
	// reader expects: the FIRST spelling in the tree wins the name
	ordered := make([]*types.Func, 0, len(decls))
	for fn := range decls {
		ordered = append(ordered, fn)
	}
	sort.Slice(ordered, func(i, j int) bool {
		a := pkg.Fset.Position(decls[ordered[i]].Pos())
		b := pkg.Fset.Position(decls[ordered[j]].Pos())
		if a.Filename != b.Filename {
			return a.Filename < b.Filename
		}
		return a.Offset < b.Offset
	})
	for _, fn := range ordered {
		decl := decls[fn]
		if decl.Doc == nil {
			continue
		}
		for _, comment := range decl.Doc.List {
			m := directiveRe.FindStringSubmatch(comment.Text)
			if m == nil {
				continue
			}
			pattern := strings.TrimSpace(m[1])
			pos := pkg.Fset.Position(comment.Pos())
			if !patternRe.MatchString(pattern) {
				fail("%s: //borgo:route %q: want \"METHOD /path\" with METHOD one of GET POST PUT PATCH DELETE HEAD OPTIONS", pos, pattern)
			}
			if sig, ok := fn.Type().(*types.Signature); ok {
				if sig.Recv() != nil {
					fail("%s: //borgo:route on method %s; handlers must be package-level functions", pos, fn.Name())
				}
				if sig.TypeParams().Len() != 0 {
					fail("%s: //borgo:route on generic function %s; handlers cannot have type parameters", pos, fn.Name())
				}
			}
			if !isHandlerSig(fn) {
				fail("%s: //borgo:route on %s, which is not a %s", pos, fn.Name(), handlerSig)
			}
			if prev, dup := taken[pattern]; dup {
				fail("%s: pattern %q already registered by %s", pos, pattern, prev)
			}
			taken[pattern] = fn.Name() + " (//borgo:route)"
			out = append(out, route{pattern: pattern, handler: fn, pos: pos})
		}
	}
	return out
}

// warnLooseRouteComments flags comments that look like a //borgo:route
// directive but are not the doc comment of any function (space after //,
// blank line before the func): they would otherwise be ignored silently.
func warnLooseRouteComments(pkg *packages.Package, decls map[*types.Func]*ast.FuncDecl) {
	attached := map[*ast.Comment]bool{}
	for _, decl := range decls {
		if decl.Doc == nil {
			continue
		}
		for _, comment := range decl.Doc.List {
			if directiveRe.MatchString(comment.Text) {
				attached[comment] = true
			}
		}
	}
	for _, file := range pkg.Syntax {
		for _, group := range file.Comments {
			for _, comment := range group.List {
				if attached[comment] || !looseDirective.MatchString(comment.Text) {
					continue
				}
				pos := pkg.Fset.Position(comment.Pos())
				fmt.Fprintf(os.Stderr, "borgogen: warning: %s: comment looks like //borgo:route but is not attached to a handler; it was ignored\n", pos)
			}
		}
	}
}

// warnExcludedRouteFiles flags //borgo:route directives sitting in api/*.go
// files this build does not compile - a //go:build constraint, a _linux suffix,
// a _test.go. The handler is invisible to the generator, so the route silently
// disappears from both outputs and the browser 404s with nothing to explain it.
func warnExcludedRouteFiles(root string, pkg *packages.Package) {
	compiled := map[string]bool{}
	for _, f := range pkg.GoFiles {
		compiled[filepath.Base(f)] = true
	}
	entries, err := os.ReadDir(filepath.Join(root, "api"))
	if err != nil {
		return
	}
	fset := token.NewFileSet()
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || compiled[name] ||
			strings.HasPrefix(name, "_") || strings.HasPrefix(name, ".") {
			continue
		}
		file, parseErr := parser.ParseFile(fset, filepath.Join(root, "api", name), nil, parser.ParseComments|parser.SkipObjectResolution)
		if parseErr != nil {
			continue
		}
	scan:
		for _, group := range file.Comments {
			for _, comment := range group.List {
				if looseTopic.MatchString(comment.Text) {
					fmt.Fprintf(os.Stderr, "borgogen: warning: %s: //borgo:topic in a file this build excludes; the push was not read and its events have no type\n", fset.Position(comment.Pos()))
					break scan
				}
				if !directiveRe.MatchString(comment.Text) {
					continue
				}
				fmt.Fprintf(os.Stderr, "borgogen: warning: %s: //borgo:route in a file this build excludes; the route was not mounted and has no type\n", fset.Position(comment.Pos()))
				break scan
			}
		}
	}
}

// writeMounting generates api/borgo.gen.go registering every directive
// handler, or removes it when no directives exist.
// middlewareDecl is what api/middleware.go declared: a Middleware function
// and, optionally, the Matcher naming the paths it covers.
type middlewareDecl struct {
	present bool
	matcher bool
	// the Matcher's paths when it is a literal list of constant strings
	// that nothing reassigns; known false when it cannot be read statically
	values []string
	known  bool
}

var middlewareSig = "func(http.Handler) http.Handler"

// collectMiddleware finds the app's middleware by its name. Every mistake is
// a failed run naming the file and line rather than a warning: a middleware
// that is silently not mounted is an authorization that silently does not
// happen, and the build that ships it is green.
func collectMiddleware(pkg *packages.Package) middlewareDecl {
	scope := pkg.Types.Scope()
	var decl middlewareDecl
	if obj := scope.Lookup("Middleware"); obj != nil {
		fn, ok := obj.(*types.Func)
		if !ok || !isMiddlewareSig(fn) {
			fail("%s: Middleware in package %s must be a function %s: borgo mounts the declaration with this name as the app's middleware, so a helper that is something else needs another name", pkg.Fset.Position(obj.Pos()), pkg.Name, middlewareSig)
		}
		decl.present = true
	}
	if obj := scope.Lookup("Matcher"); obj != nil {
		pos := pkg.Fset.Position(obj.Pos())
		v, ok := obj.(*types.Var)
		if !ok || v.Type().String() != "[]string" {
			fail("%s: Matcher in package %s must be a package-level var of type []string, the paths the middleware covers", pos, pkg.Name)
		}
		if !decl.present {
			fail("%s: Matcher is declared but package %s has no Middleware: a matcher with nothing to run protects nothing", pos, pkg.Name)
		}
		decl.matcher = true
		decl.values, decl.known = matcherLiteral(pkg, v)
	}
	return decl
}

// matcherLiteral reads the Matcher's paths without running the app: a
// composite literal of constant strings that nothing else in the package
// touches. Anything else - a computed list, an append or an index written in
// init - is unknown, and borgo export says so rather than guessing which
// pages it guards
func matcherLiteral(pkg *packages.Package, v *types.Var) ([]string, bool) {
	var values []string
	found, known := false, true
	for _, file := range pkg.Syntax {
		ast.Inspect(file, func(n ast.Node) bool {
			switch n := n.(type) {
			case *ast.ValueSpec:
				for i, name := range n.Names {
					if pkg.TypesInfo.Defs[name] != v {
						continue
					}
					found = true
					var lit ast.Expr
					if i < len(n.Values) {
						lit = n.Values[i]
					}
					cl, isLit := lit.(*ast.CompositeLit)
					if !isLit {
						known = false
						continue
					}
					for _, elt := range cl.Elts {
						tv := pkg.TypesInfo.Types[elt]
						if tv.Value == nil || tv.Value.Kind() != constant.String {
							known = false
							continue
						}
						values = append(values, constant.StringVal(tv.Value))
					}
				}
			case *ast.Ident:
				// any use of it but the call borgo.gen.go makes: an index
				// written in an init, a copy, an alias, a slice handed to a
				// function - each changes what Go guards at runtime while the
				// literal says otherwise, and export published a page Go
				// guards (found by the verifier of hunt 3's fixes)
				if pkg.TypesInfo.Uses[n] == v && filepath.Base(pkg.Fset.Position(n.Pos()).Filename) != "borgo.gen.go" {
					known = false
				}
			}
			return true
		})
	}
	// a file a build constraint keeps out of this load - linux only, a deploy
	// tag - is not type-checked here, and may still write the Matcher where
	// the app runs (found by the verifier of this fix)
	for _, name := range pkg.IgnoredFiles {
		if src, err := os.ReadFile(name); err != nil || matcherWord.Match(src) {
			known = false
		}
	}
	if !found || !known {
		return nil, false
	}
	return values, true
}

var matcherWord = regexp.MustCompile(`\bMatcher\b`)

func isMiddlewareSig(fn *types.Func) bool {
	sig, ok := fn.Type().(*types.Signature)
	if !ok || sig.Recv() != nil || sig.TypeParams().Len() != 0 ||
		sig.Params().Len() != 1 || sig.Results().Len() != 1 {
		return false
	}
	return sig.Params().At(0).Type().String() == "net/http.Handler" &&
		sig.Results().At(0).Type().String() == "net/http.Handler"
}

// --- //borgo:export ----------------------------------------------------------

var exportRe = regexp.MustCompile(`^//borgo:export\s*$`)

type exportFn struct {
	fn   *types.Func
	decl *ast.FuncDecl
	pos  token.Position
}

// collectExports finds every //borgo:export function and refuses, with file
// and line, any it could not make callable: the TypeScript side is generated
// from the signature, so a signature that does not cross the wire is a build
// error here and not a runtime error in a loader.
func collectExports(pkg *packages.Package, decls map[*types.Func]*ast.FuncDecl) []exportFn {
	ordered := make([]*types.Func, 0, len(decls))
	for fn := range decls {
		ordered = append(ordered, fn)
	}
	sort.Slice(ordered, func(i, j int) bool {
		a := pkg.Fset.Position(decls[ordered[i]].Pos())
		b := pkg.Fset.Position(decls[ordered[j]].Pos())
		if a.Filename != b.Filename {
			return a.Filename < b.Filename
		}
		return a.Offset < b.Offset
	})
	var out []exportFn
	for _, fn := range ordered {
		decl := decls[fn]
		if decl.Doc == nil {
			continue
		}
		for _, comment := range decl.Doc.List {
			text := strings.TrimSpace(comment.Text)
			if !strings.HasPrefix(text, "//borgo:export") {
				continue
			}
			pos := pkg.Fset.Position(comment.Pos())
			if !exportRe.MatchString(text) {
				fail("%s: malformed //borgo:export: it takes no arguments, the function's own name is the export's", pos)
			}
			sig := fn.Type().(*types.Signature)
			switch {
			case sig.Recv() != nil:
				fail("%s: //borgo:export on method %s; exports must be package-level functions", pos, fn.Name())
			case sig.TypeParams().Len() != 0:
				fail("%s: //borgo:export on generic function %s; exports cannot have type parameters", pos, fn.Name())
			case !fn.Exported():
				fail("%s: //borgo:export on %s, which is not exported: the TypeScript side calls it by name, so Go must export it too", pos, fn.Name())
			case sig.Variadic():
				fail("%s: //borgo:export %s is variadic; take a slice instead", pos, fn.Name())
			case sig.Params().Len() == 0 || sig.Params().At(0).Type().String() != "context.Context":
				fail("%s: //borgo:export %s must take a context.Context first: the call belongs to the render that made it", pos, fn.Name())
			}
			res := sig.Results()
			if !(res.Len() == 1 && res.At(0).Type().String() == "error") && !(res.Len() == 2 && res.At(1).Type().String() == "error") {
				fail("%s: //borgo:export %s must return (T, error) or error: the error is how a Go export says no", pos, fn.Name())
			}
			for i := 1; i < sig.Params().Len(); i++ {
				if why := wireRefusal(sig.Params().At(i).Type(), map[types.Type]bool{}); why != "" {
					fail("%s: //borgo:export %s: parameter %d is %s, which does not cross as json", pos, fn.Name(), i, why)
				}
			}
			if res.Len() == 2 {
				if why := wireRefusal(res.At(0).Type(), map[types.Type]bool{}); why != "" {
					fail("%s: //borgo:export %s returns %s, which does not cross as json", pos, fn.Name(), why)
				}
			}
			out = append(out, exportFn{fn: fn, decl: decl, pos: pos})
		}
	}
	return out
}

// isBorgoFile reports whether t is borgo.File itself.
func isBorgoFile(t types.Type) bool {
	named, ok := types.Unalias(t).(*types.Named)
	if !ok {
		return false
	}
	obj := named.Obj()
	return obj.Pkg() != nil && obj.Pkg().Path() == borgoPath && obj.Name() == "File"
}

// holdsFile reports whether a borgo.File reaches the wire from t: typed as a
// Blob, it is a body the client sends as a FormData, which only
// BindMultipart reads. A field encoding/json skips is not looked at.
func holdsFile(t types.Type, seen map[types.Type]bool) bool {
	if isBorgoFile(t) {
		return true
	}
	if seen[t] {
		return false
	}
	seen[t] = true
	switch u := t.Underlying().(type) {
	case *types.Pointer:
		return holdsFile(u.Elem(), seen)
	case *types.Slice:
		return holdsFile(u.Elem(), seen)
	case *types.Array:
		return holdsFile(u.Elem(), seen)
	case *types.Map:
		return holdsFile(u.Elem(), seen)
	case *types.Struct:
		for i := 0; i < u.NumFields(); i++ {
			if !planField(u, i).skip && holdsFile(u.Field(i).Type(), seen) {
				return true
			}
		}
	}
	return false
}

// refuseJSONFile fails the run when a request read as JSON holds a
// borgo.File: the client would send it as a FormData and the route answer
// 415 to every call that carries one (found by the verifier of phase 5)
func refuseJSONFile(t types.Type, pos token.Position, reader string) {
	if holdsFile(t, map[types.Type]bool{}) {
		fail("%s: %s decodes JSON, where a borgo.File carries no upload - only the fields the client wrote - and the typed client sends a body holding one as a FormData; read the form with borgo.BindMultipart", pos, reader)
	}
}

// wireRefusal names what encoding/json cannot carry, or "" when it can. A
// field json never sees - unexported, or tagged "-" - is not looked at.
func wireRefusal(t types.Type, seen map[types.Type]bool) string {
	if seen[t] {
		return ""
	}
	seen[t] = true
	switch u := t.Underlying().(type) {
	case *types.Chan:
		return "a channel"
	case *types.Signature:
		return "a function"
	case *types.Basic:
		if u.Info()&types.IsComplex != 0 {
			return "a complex number"
		}
		if u.Kind() == types.UnsafePointer {
			return "an unsafe.Pointer"
		}
	case *types.Pointer:
		return wireRefusal(u.Elem(), seen)
	case *types.Slice:
		return wireRefusal(u.Elem(), seen)
	case *types.Array:
		return wireRefusal(u.Elem(), seen)
	case *types.Map:
		return wireRefusal(u.Elem(), seen)
	case *types.Struct:
		for i := 0; i < u.NumFields(); i++ {
			f := u.Field(i)
			if !f.Exported() && !f.Embedded() {
				continue
			}
			if tag := reflect.StructTag(u.Tag(i)).Get("json"); tag == "-" {
				continue
			}
			if why := wireRefusal(f.Type(), seen); why != "" {
				return why
			}
		}
	}
	return ""
}

var tsKeywords = map[string]bool{
	"break": true, "case": true, "catch": true, "class": true, "const": true, "continue": true,
	"debugger": true, "default": true, "delete": true, "do": true, "else": true, "enum": true,
	"export": true, "extends": true, "false": true, "finally": true, "for": true, "function": true,
	"if": true, "import": true, "in": true, "instanceof": true, "new": true, "null": true,
	"return": true, "super": true, "switch": true, "this": true, "throw": true, "true": true,
	"try": true, "typeof": true, "var": true, "void": true, "while": true, "with": true,
	"yield": true, "let": true, "static": true, "implements": true, "interface": true,
	"package": true, "private": true, "protected": true, "public": true, "await": true, "arguments": true, "eval": true,
}

var tsIdentRe = regexp.MustCompile(`[A-Za-z_$][A-Za-z0-9_$]*`)

// exportsTS writes .borgo/go.ts: one typed stub per export, calling
// callExport with the Go function's name and the arguments in its order.
// Parameter names are the Go ones, so a rename in Go reads the same in the
// editor; types go through the same resolver as the routes, so changing a Go
// type breaks tsc on the caller.
func (g *tsGen) exportsTS(fns []exportFn) string {
	if len(fns) == 0 {
		return ""
	}
	var stubs []string
	for _, e := range fns {
		sig := e.fn.Type().(*types.Signature)
		names := paramNames(e.decl)
		var params, args []string
		for i := 1; i < sig.Params().Len(); i++ {
			name := ""
			if i < len(names) {
				name = names[i]
			}
			if name == "" || name == "_" {
				name = fmt.Sprintf("arg%d", i)
			}
			if tsKeywords[name] {
				name += "_"
			}
			params = append(params, name+": "+g.tsType(sig.Params().At(i).Type(), inbound()).String())
			args = append(args, name)
		}
		result := "null"
		if sig.Results().Len() == 2 {
			result = g.tsType(sig.Results().At(0).Type(), site{}).String()
		}
		stubs = append(stubs, fmt.Sprintf("  %s: (%s) => callExport<%s>(%q, [%s]),",
			lowerFirst(e.fn.Name()), strings.Join(params, ", "), result, e.fn.Name(), strings.Join(args, ", ")))
	}
	defined := map[string]bool{}
	for _, name := range g.names {
		defined[name] = true
	}
	used := map[string]bool{}
	for _, stub := range stubs {
		for _, ident := range tsIdentRe.FindAllString(stub, -1) {
			if defined[ident] {
				used[ident] = true
			}
		}
	}
	typeNames := make([]string, 0, len(used))
	for name := range used {
		typeNames = append(typeNames, name)
	}
	sort.Strings(typeNames)

	var b strings.Builder
	b.WriteString("// generated by borgogen - do not edit\n")
	b.WriteString("import { callExport } from \"borgo-framework/internal\";\n")
	if len(typeNames) > 0 {
		b.WriteString("import type { " + strings.Join(typeNames, ", ") + " } from \"./api-types\";\n")
	}
	b.WriteString("\nexport const go = {\n")
	b.WriteString(strings.Join(stubs, "\n"))
	b.WriteString("\n};\n")
	return b.String()
}

// paramNames flattens a declaration's parameter list, one name per parameter.
func paramNames(decl *ast.FuncDecl) []string {
	var names []string
	for _, field := range decl.Type.Params.List {
		if len(field.Names) == 0 {
			names = append(names, "")
			continue
		}
		for _, n := range field.Names {
			names = append(names, n.Name)
		}
	}
	return names
}

func lowerFirst(s string) string {
	if s == "" {
		return s
	}
	return strings.ToLower(s[:1]) + s[1:]
}

// freeName is base, or base with underscores until nothing in the package
// scope and nothing already chosen is called that.
func freeName(scope *types.Scope, used map[string]bool, base string) string {
	name := base
	for scope.Lookup(name) != nil || used[name] {
		name += "_"
	}
	used[name] = true
	return name
}

// exportAdapters writes the Export registrations: one typed adapter per
// function, decoding each positional argument into the parameter's own type.
// No reflection at runtime - the adapter is ordinary go, checked by the
// compiler like the rest of the package. It returns the extra imports the
// adapters need, by path.
func exportAdapters(qualifier string, apiPkg *types.Package, scope *types.Scope, fns []exportFn) (string, map[string]string) {
	used := map[string]bool{qualifier: true}
	imports := map[string]string{}
	ctxAlias := freeName(scope, used, "borgoctx")
	jsonAlias := freeName(scope, used, "borgojson")
	imports["context"] = ctxAlias
	imports["encoding/json"] = jsonAlias
	qual := func(p *types.Package) string {
		if p == nil || p == apiPkg {
			return ""
		}
		if alias, ok := imports[p.Path()]; ok {
			return alias
		}
		alias := freeName(scope, used, p.Name())
		imports[p.Path()] = alias
		return alias
	}
	var b strings.Builder
	for _, e := range fns {
		sig := e.fn.Type().(*types.Signature)
		name := e.fn.Name()
		n := sig.Params().Len() - 1
		fmt.Fprintf(&b, "\t%s.Export(%q, func(borgoCtx %s.Context, borgoArgs []%s.RawMessage) (any, error) {\n", qualifier, name, ctxAlias, jsonAlias)
		fmt.Fprintf(&b, "\t\tif len(borgoArgs) != %d {\n\t\t\treturn nil, %s.ExportArity(%q, %d, len(borgoArgs))\n\t\t}\n", n, qualifier, name, n)
		call := []string{"borgoCtx"}
		for i := 0; i < n; i++ {
			typ := types.TypeString(sig.Params().At(i+1).Type(), qual)
			fmt.Fprintf(&b, "\t\tvar borgoA%d %s\n", i, typ)
			fmt.Fprintf(&b, "\t\tif borgoErr := %s.Unmarshal(borgoArgs[%d], &borgoA%d); borgoErr != nil {\n\t\t\treturn nil, %s.ExportArgument(%q, %d, borgoErr)\n\t\t}\n", jsonAlias, i, i, qualifier, name, i)
			call = append(call, fmt.Sprintf("borgoA%d", i))
		}
		if sig.Results().Len() == 2 {
			fmt.Fprintf(&b, "\t\treturn %s(%s)\n", name, strings.Join(call, ", "))
		} else {
			fmt.Fprintf(&b, "\t\treturn nil, %s(%s)\n", name, strings.Join(call, ", "))
		}
		b.WriteString("\t})\n")
	}
	return b.String(), imports
}

func writeMounting(root, pkgName string, directives []route, scope *types.Scope, mw middlewareDecl, apiPkg *types.Package, exportFns []exportFn) {
	if len(directives) == 0 && !mw.present && len(exportFns) == 0 {
		os.Remove(filepath.Join(root, genGoFile))
		return
	}
	sorted := append([]route(nil), directives...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].pattern < sorted[j].pattern })

	qualifier, importDecl := "borgo", "import \""+borgoPath+"\""
	if alias := borgoAlias(scope); alias != "" {
		qualifier, importDecl = alias, "import "+alias+" \""+borgoPath+"\""
	}

	var adapters string
	if len(exportFns) > 0 {
		var imports map[string]string
		adapters, imports = exportAdapters(qualifier, apiPkg, scope, exportFns)
		// sorted by path, borgo's own included, which is the order gofmt
		// keeps: a generated file an app's gofmt would rewrite is a diff in
		// every app that has an export
		imports[borgoPath] = qualifier
		paths := make([]string, 0, len(imports))
		for path := range imports {
			paths = append(paths, path)
		}
		sort.Strings(paths)
		var lines []string
		for _, path := range paths {
			lines = append(lines, "\t"+imports[path]+" \""+path+"\"")
		}
		importDecl = "import (\n" + strings.Join(lines, "\n") + "\n)"
	}

	var out strings.Builder
	out.WriteString("// generated by borgogen - do not edit\npackage " + pkgName + "\n\n")
	out.WriteString(importDecl + "\n\nfunc init() {\n")
	for _, r := range sorted {
		fmt.Fprintf(&out, "\t%s.Handle(%q, %s)\n", qualifier, r.pattern, r.handler.Name())
	}
	if mw.present {
		matcher := "nil"
		if mw.matcher {
			matcher = "Matcher"
		}
		fmt.Fprintf(&out, "\t%s.UseMiddleware(Middleware, %s)\n", qualifier, matcher)
	}
	out.WriteString(adapters)
	out.WriteString("}\n")
	writeIfChanged(filepath.Join(root, genGoFile), out.String())
}

// borgoAlias returns the name the generated mounting must import borgo under,
// or "" for the plain one. An api package that declares its own borgo - a type,
// a var, anything package-level - collides with the import: Go rejects an
// identifier declared in both the file and the package block, and the whole
// package stops compiling with the error pointing at the user's file.
func borgoAlias(scope *types.Scope) string {
	if scope == nil || scope.Lookup("borgo") == nil {
		return ""
	}
	for name, i := "borgoPkg", 2; ; i++ {
		if scope.Lookup(name) == nil {
			return name
		}
		name = fmt.Sprintf("borgoPkg%d", i)
	}
}

func writeIfChanged(path, content string) {
	if current, err := os.ReadFile(path); err == nil && string(current) == content {
		// still mark the output as regenerated: mtime freshness (borgo doctor)
		// must clear after a run even when the content is already right
		now := time.Now()
		os.Chtimes(path, now, now)
		return
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		fail("%v", err)
	}
}

// borgoFunc resolves a call expression's callee to a function of the borgo
// package, returning its name, or "" when it is anything else.
func borgoFunc(info *types.Info, call *ast.CallExpr) (string, *ast.Ident) {
	fun := call.Fun
	switch idx := fun.(type) {
	case *ast.IndexExpr:
		// explicit type arguments, e.g. borgo.Bind[T](r)
		fun = idx.X
	case *ast.IndexListExpr:
		// two or more of them, e.g. borgo.Signup[User, Form](...)
		fun = idx.X
	}
	sel, ok := fun.(*ast.SelectorExpr)
	if !ok {
		return "", nil
	}
	fn, ok := info.Uses[sel.Sel].(*types.Func)
	if !ok || fn.Pkg() == nil || fn.Pkg().Path() != borgoPath {
		return "", nil
	}
	return fn.Name(), sel.Sel
}

func collectRoutes(pkg *packages.Package) []route {
	var routes []route
	for _, file := range pkg.Syntax {
		ast.Inspect(file, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			name, _ := borgoFunc(pkg.TypesInfo, call)
			if name != "Handle" || len(call.Args) != 2 {
				return true
			}
			tv := pkg.TypesInfo.Types[call.Args[0]]
			if tv.Value == nil || tv.Value.Kind() != constant.String {
				// the route is mounted and serves; only its key is unknown
				// here, so it cannot enter ApiRoutes. Left silent, the caller
				// of a live endpoint just finds it missing from the types
				warn("%s: borgo.Handle with a computed pattern; the route is registered at runtime but stays out of ApiRoutes, so its callers get no types",
					pkg.Fset.Position(call.Pos()))
				return true
			}
			pos := pkg.Fset.Position(call.Pos())
			fn, decl := handlerTarget(pkg.TypesInfo, call.Args[1])
			signup := signupForm(pkg.TypesInfo, call.Args[1])
			if fn == nil && decl == nil && signup == nil {
				// the route is mounted and serves; only the body behind it is
				// out of reach. Left silent it just came out "response: unknown"
				warn("%s: borgo.Handle with a handler expression that is not a function, a closure or a conversion of one; the route is registered but its request and response types stay unknown", pos)
			}
			routes = append(routes, route{
				pattern: constant.StringVal(tv.Value),
				handler: fn,
				decl:    decl,
				signup:  signup,
				pos:     pos,
			})
			return true
		})
	}
	return routes
}

func constString(pkg *packages.Package, expr ast.Expr) (string, bool) {
	tv := pkg.TypesInfo.Types[expr]
	if tv.Value == nil || tv.Value.Kind() != constant.String {
		return "", false
	}
	return constant.StringVal(tv.Value), true
}

// collectPushes gathers every borgo.Push call into a "topic/event" -> payload
// type map; payloads pushed under the same key union like response types do.
// Only calls with constant topic and event strings can be recorded: a computed
// name is not a mistake, it is how you publish something decided at runtime, so
// those calls generate nothing and their subscribers keep the untyped callback.
//
// Every same-module package the api package reaches is scanned, not just api
// itself: publishing from a service or domain package instead of from the http
// handler is ordinary layering, and a push the generator never sees takes the
// whole WsEvents block down with it.
func collectPushes(pkgs []*packages.Package, gen *tsGen) ([]string, map[string]string, map[string]bool) {
	unions := map[string]*union{}
	patterns := map[string]bool{}
	rawPatterns := map[string]string{}
	firstPos := map[string]token.Position{}
	var keys []string
	for _, pkg := range pkgs {
		for _, file := range pkg.Syntax {
			directives := topicDirectives(pkg, file)
			ast.Inspect(file, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				name, sel := borgoFunc(pkg.TypesInfo, call)
				if name != "Push" || len(call.Args) != 3 {
					return true
				}
				pos := pkg.Fset.Position(call.Pos())
				topic, topicOK := constString(pkg, call.Args[0])
				event, eventOK := constString(pkg, call.Args[1])
				// a //borgo:topic directive names the shape of a computed
				// topic, so the generator can key the map by it and keep
				// owning the payload type - the alternative, a key written
				// by hand in the app's .d.ts, drifts from the Go struct
				// with nothing to say so (piazza's F7)
				// the call's own line first: a directive at the end of a
				// line names that line's call, and the call on the next
				// line must not inherit it (found by the verifier of this
				// step: it was typed under the wrong pattern, in silence)
				if d := directives[pos.Line]; d != nil || directives[pos.Line-1] != nil {
					if d == nil {
						d = directives[pos.Line-1]
					}
					if d.claimed.IsValid() {
						fail("%s: //borgo:topic %q already names the borgo.Push at %s; a directive names one call, so give this one its own", d.pos, d.pattern, d.claimed)
					}
					d.claimed = pos
					if topicOK {
						fail("%s: //borgo:topic %q on a borgo.Push whose topic is the literal %q: the literal is the shape, drop the directive", d.pos, d.pattern, topic)
					}
					if !eventOK {
						fail("%s: //borgo:topic %q on a borgo.Push whose event name is computed: the event must be a literal for the payload to be typed", d.pos, d.pattern)
					}
					topic, topicOK = d.pattern, true
					if d.template {
						topic = d.key
						patterns[topic+"/"+event] = true
						rawPatterns[topic+"/"+event] = d.pattern
					}
				}
				// a computed topic or event is the documented way to publish
				// something that cannot be typed: the push still happens, the
				// event stays out of the map, and the browser keeps the untyped
				// callback. Nothing to report - it is a choice, not a mistake
				if !topicOK || !eventOK {
					return true
				}
				if strings.Contains(topic, "/") {
					// it compiles and it delivers, but "topic/event" keys make the
					// split ambiguous, so the browser would subscribe to the part
					// before the slash. Say so rather than drop it silently
					warn(`%s: borgo.Push topic %q contains "/", so its events stay untyped - WsEvents keys are "topic/event"`, pos, topic)
					return true
				}
				inst, ok := pkg.TypesInfo.Instances[sel]
				if !ok || inst.TypeArgs.Len() != 1 {
					return true
				}
				key := topic + "/" + event
				if unions[key] == nil {
					unions[key] = &union{}
					keys = append(keys, key)
					firstPos[key] = pos
				}
				// borgo.Push marshals the payload as a map value of type any:
				// unaddressable twice over, so a pointer-receiver marshaler
				// on the payload itself never runs
				unions[key].add(gen.tsType(inst.TypeArgs.At(0), site{}))
				return true
			})
			for _, d := range directives {
				if !d.claimed.IsValid() {
					// a directive that names nothing is a typing that silently
					// does not happen: said, like a route directive off a handler
					fail("%s: //borgo:topic %q is not on a borgo.Push call with a computed topic: put it on the line above the call, or at the end of the line the call starts on", d.pos, d.pattern)
				}
			}
		}
	}
	sort.Strings(keys)
	entries := make(map[string]string, len(keys))
	for _, k := range keys {
		entries[k] = unions[k].String()
	}
	refuseTopicCollisions(keys, unions, patterns, rawPatterns, firstPos)
	return keys, entries, patterns
}

// refuseTopicCollisions fails the run when a pattern key admits a literal key
// or another pattern for the same event with a payload it does not carry: the
// generated file would then fail tsc on an index signature, naming no Go line
// (found by the verifier of the step). A literal whose payload the pattern's
// union already holds is fine - it is what the pattern would have said.
func refuseTopicCollisions(keys []string, unions map[string]*union, patterns map[string]bool, rawPatterns map[string]string, firstPos map[string]token.Position) {
	for _, p := range keys {
		if !patterns[p] {
			continue
		}
		pattern, event := rawPatterns[p], p[strings.LastIndex(p, "/")+1:]
		admits := topicPatternRegexp(pattern)
		for _, k := range keys {
			if k == p || k[strings.LastIndex(k, "/")+1:] != event {
				continue
			}
			other := k[:strings.LastIndex(k, "/")]
			if patterns[k] {
				// two patterns: p admits an instance of k when their literal
				// text nests; then the payloads must agree exactly, since either
				// may be the wider one for a given topic. The other direction is
				// the same check with p and k swapped, which the outer loop makes
				if !admits.MatchString(placeholderRe.ReplaceAllString(rawPatterns[k], "a")) {
					continue
				}
				if unions[k].String() != unions[p].String() {
					fail("%s: //borgo:topic %q and %s: //borgo:topic %q overlap on event %q with different payloads (%s and %s): the generated WsEvents would type the event two ways at once, which tsc resolves in silence to never, a type no handler can read - give them one payload, or topics that do not nest", firstPos[p], pattern, firstPos[k], rawPatterns[k], event, unions[p].String(), unions[k].String())
				}
				continue
			}
			if !admits.MatchString(other) {
				continue
			}
			if !unions[p].holds(unions[k]) {
				fail("%s: borgo.Push on the literal topic %q carries %s for event %q, and %s: //borgo:topic %q admits that topic with %s: the generated WsEvents would type the event two ways at once, and tsc lets the literal win in silence, so the pattern's payload is a lie on that topic - push the same payload, or a topic the pattern does not admit", firstPos[k], other, unions[k].String(), event, firstPos[p], pattern, unions[p].String())
			}
		}
	}
}

// topicPatternRegexp is what topics a pattern admits: its literal text
// exactly, a placeholder anything
func topicPatternRegexp(pattern string) *regexp.Regexp {
	var b strings.Builder
	b.WriteString("^")
	last := 0
	for _, m := range placeholderRe.FindAllStringIndex(pattern, -1) {
		b.WriteString(regexp.QuoteMeta(pattern[last:m[0]]))
		b.WriteString(".*")
		last = m[1]
	}
	b.WriteString(regexp.QuoteMeta(pattern[last:]))
	b.WriteString("$")
	return regexp.MustCompile(b.String())
}

// topicDirective is one //borgo:topic comment: the pattern as written, the
// TypeScript key it becomes when it holds a placeholder ({name} as ${string},
// the rest escaped for a template literal), and the call that claimed it
type topicDirective struct {
	pattern  string
	key      string
	template bool
	pos      token.Position
	claimed  token.Position
}

// topicDirectives finds every //borgo:topic comment of a file, keyed by the
// line it ends on: a Push on that line, or on the next, claims it. The
// pattern is validated here, once, whatever claims it: literal text and
// {name} placeholders, no "/" (the key's separator) and no "," (the wire's),
// no whitespace of any alphabet, braces that open and close, and the relay's
// length cap on the literal text. A comment that looks like the directive
// but is not one stops the run too: a typing that silently did not happen is
// what this exists to end.
func topicDirectives(pkg *packages.Package, file *ast.File) map[int]*topicDirective {
	out := map[int]*topicDirective{}
	for _, group := range file.Comments {
		for _, c := range group.List {
			pos := pkg.Fset.Position(c.Pos())
			m := topicRe.FindStringSubmatch(c.Text)
			if m == nil {
				if looseTopic.MatchString(c.Text) {
					fail("%s: malformed //borgo:topic: want \"//borgo:topic <pattern>\", no space after //, one pattern with no whitespace", pos)
				}
				continue
			}
			pattern := m[1]
			if why := topicPatternRefusal(pattern); why != "" {
				fail("%s: //borgo:topic %q %s", pos, pattern, why)
			}
			d := &topicDirective{pattern: pattern, pos: pos, template: placeholderRe.MatchString(pattern)}
			if d.template {
				key := templateText(pattern)
				d.key = placeholderRe.ReplaceAllString(key, "$${string}")
			}
			out[pkg.Fset.Position(c.End()).Line] = d
		}
	}
	return out
}

// the relay's cap on a topic name, copied from websocket.go and counted as
// the relay and the browser count, in utf-16 units: a pattern whose literal
// text alone is over it names topics the handshake refuses
const topicMaxLength = 128

func topicPatternRefusal(pattern string) string {
	switch {
	case strings.Contains(pattern, "/"):
		return `contains "/", which separates the topic from the event in a WsEvents key`
	case strings.Contains(pattern, ","):
		return `contains ",", which separates topics on the wire (/ws?topics=a,b)`
	}
	for _, r := range pattern {
		if unicode.IsSpace(r) || r == 0xFEFF {
			return fmt.Sprintf("contains whitespace (U+%04X), which the relay strips from a topic and the client refuses", r)
		}
	}
	literal := placeholderRe.ReplaceAllString(pattern, "")
	if strings.ContainsAny(literal, "{}") {
		return "has a brace that is not a {name} placeholder: placeholders are {name}, with a Go identifier inside"
	}
	if n := len(utf16.Encode([]rune(literal))); n > topicMaxLength {
		return fmt.Sprintf("has %d characters of literal text, over the %d a topic may have", n, topicMaxLength)
	}
	return ""
}

// pushSources returns the api package followed by every same-module package it
// imports, transitively, capped at the same number of hops helper following
// uses. Import paths are walked in sorted order so a payload pushed under one
// key from two packages always unions in the same order.
func pushSources(pkg *packages.Package, loader *helperLoader) []*packages.Package {
	out := []*packages.Package{pkg}
	seen := map[string]bool{pkg.PkgPath: true}
	frontier := []*packages.Package{pkg}
	for hop := 0; hop < maxCrossPkgDepth && len(frontier) > 0; hop++ {
		var next []*packages.Package
		for _, path := range nextPushHop(frontier, seen, loader) {
			if hp := loader.load(path, ""); hp != nil {
				out = append(out, hp.pkg)
				next = append(next, hp.pkg)
			}
		}
		frontier = next
	}
	// a dropped push is worse than an omission: TopicEvents<T> closes a topic's
	// union as soon as one event is declared, so a subscriber for the missing
	// one fails tsc with nothing pointing back at here
	if dropped := nextPushHop(frontier, seen, loader); len(dropped) > 0 {
		warn("%s is more than %d package hops from api/, so it was not scanned; a borgo.Push there stays out of WsEvents and its subscriber will not typecheck",
			strings.Join(dropped, ", "), maxCrossPkgDepth)
	}
	return out
}

// nextPushHop returns the same-module packages one hop past frontier, in sorted
// order so a payload pushed under one key from two packages always unions the
// same way, and marks them seen.
func nextPushHop(frontier []*packages.Package, seen map[string]bool, loader *helperLoader) []string {
	var paths []string
	for _, p := range frontier {
		for path := range p.Imports {
			// borgo declares Push, so a qualified borgo.Push cannot occur
			// inside it; loading the framework would be pure cost for the
			// one app that shares a module with it - this one's examples
			if seen[path] || path == borgoPath || !loader.sameModule(path) {
				continue
			}
			seen[path] = true
			paths = append(paths, path)
		}
	}
	sort.Strings(paths)
	return paths
}

// handlerTarget resolves the handler argument of a borgo.Handle call to the
// body its bridge types come from: a declared function, or the closure itself
// when the handler is written inline. Both are nil when neither applies, which
// is the caller's cue to say so rather than emit "response: unknown" in silence.
func handlerTarget(info *types.Info, expr ast.Expr) (*types.Func, *ast.FuncDecl) {
	switch e := expr.(type) {
	case *ast.Ident:
		if fn, ok := info.Uses[e].(*types.Func); ok {
			return fn, nil
		}
	case *ast.SelectorExpr:
		if fn, ok := info.Uses[e.Sel].(*types.Func); ok {
			return fn, nil
		}
	case *ast.ParenExpr:
		return handlerTarget(info, e.X)
	case *ast.FuncLit:
		// borgo.Handle("GET /x", func(w, r) {...}): there is no *types.Func to
		// look a declaration up by, but the body is right here
		return nil, &ast.FuncDecl{Name: ast.NewIdent("handler"), Type: e.Type, Body: e.Body}
	case *ast.CallExpr:
		// borgo.Authed(h) is transparent: the route keeps h's types
		if name, _ := borgoFunc(info, e); name == "Authed" && len(e.Args) == 1 {
			return handlerTarget(info, e.Args[0])
		}
		// and so is a conversion - http.HandlerFunc(Named) above all
		if len(e.Args) == 1 && info.Types[e.Fun].IsType() {
			return handlerTarget(info, e.Args[0])
		}
	}
	return nil, nil
}

// signupForm returns the form type S of a borgo.Signup[U, S](...) handler
// expression, through borgo.Authed and conversions as handlerTarget looks,
// or nil for anything else. The body of Signup is the framework's and never
// read; its request type is the instantiation's second argument.
func signupForm(info *types.Info, expr ast.Expr) types.Type {
	switch e := expr.(type) {
	case *ast.ParenExpr:
		return signupForm(info, e.X)
	case *ast.CallExpr:
		if name, sel := borgoFunc(info, e); name == "Signup" {
			if inst, ok := info.Instances[sel]; ok && inst.TypeArgs.Len() == 2 {
				return inst.TypeArgs.At(1)
			}
			return nil
		}
		if name, _ := borgoFunc(info, e); name == "Authed" && len(e.Args) == 1 {
			return signupForm(info, e.Args[0])
		}
		if len(e.Args) == 1 && info.Types[e.Fun].IsType() {
			return signupForm(info, e.Args[0])
		}
	}
	return nil
}

// handlerBody resolves the package, declarations and body a route's bridge
// types are read from. A handler from another package (users.List) is loaded
// like any other helper; what cannot be loaded is said out loud rather than
// typed as unknown in silence.
func handlerBody(pkg *packages.Package, decls map[*types.Func]*ast.FuncDecl, r route, loader *helperLoader) (*packages.Package, map[*types.Func]*ast.FuncDecl, *ast.FuncDecl) {
	switch {
	case r.decl != nil:
		return pkg, decls, r.decl
	case r.handler == nil:
		return pkg, decls, nil // collectRoutes already warned
	case decls[r.handler] != nil:
		return pkg, decls, decls[r.handler]
	}
	hpkg := r.handler.Pkg()
	if hpkg != nil && hpkg.Path() == borgoPath {
		// borgo's own handlers (the built-in auth ones) are untyped by the
		// framework's choice: a warning here would fire on every run of every
		// app that uses them, and nobody could act on it
		return pkg, decls, nil
	}
	if hpkg == nil || hpkg == pkg.Types || !loader.sameModule(hpkg.Path()) {
		where := "outside this module"
		if hpkg != nil {
			where = hpkg.Path()
		}
		warn("%s: handler %s is declared in %s, which this generator does not read; the route is registered but its request and response types stay unknown", r.pos, r.handler.Name(), where)
		return pkg, decls, nil
	}
	hp := loader.load(hpkg.Path(), r.pos.String()+": ")
	if hp == nil {
		return pkg, decls, nil // load warned
	}
	decl := hp.byName[r.handler.Name()]
	if decl == nil {
		// a method value, or a function this build does not compile
		warn("%s: handler %s is not a package-level function of %s, so its request and response types stay unknown", r.pos, r.handler.Name(), hpkg.Path())
		return pkg, decls, nil
	}
	return hp.pkg, hp.decls, decl
}

func funcDecls(pkg *packages.Package) map[*types.Func]*ast.FuncDecl {
	decls := map[*types.Func]*ast.FuncDecl{}
	for _, file := range pkg.Syntax {
		for _, d := range file.Decls {
			if fd, ok := d.(*ast.FuncDecl); ok {
				if fn, ok := pkg.TypesInfo.Defs[fd.Name].(*types.Func); ok {
					decls[fn] = fd
				}
			}
		}
	}
	return decls
}

type tsGen struct {
	// keyed on the instantiated type string, so Page[A] and Page[B] emit
	// distinct interfaces instead of collapsing on the generic origin
	names map[string]string
	taken map[string]bool
	// named non-struct types being expanded. A struct is anchored by its name
	// before its fields are walked; `type Tree map[string]Tree` has no such
	// anchor and would expand forever - a stack overflow is fatal, not a
	// panic, so run()'s recover never sees it
	expanding map[string]bool
	defs      []string
	apiPkg    *types.Package
	overrides *overrideSet
	// set by bridgeTypes when the route's request was read with
	// borgo.BindMultipart: the client sends a FormData for it
	multipart bool
}

// overrideSet holds the "//borgo:type Go TS" directives of a run, resolved to
// what each one names. A directive for an api type is bound to the single
// declaration it picked out; one for an imported or predeclared type keeps its
// spelling, which already names at most one type.
type overrideSet struct {
	byObj  map[*types.TypeName]string
	byName map[string]string
}

// collectTypeOverrides gathers every "//borgo:type Go TS" directive and
// resolves it to exactly one type. The Go type is "pkgpath.Name" for an
// imported type, a bare name for an api or predeclared one, or - where a bare
// name is ambiguous - "Name@file.go:line" for the declaration at that position.
// A bare name means the package-level type if there is one, the sole
// function-local one if not, and several candidates are a question the run
// asks. A directive that can never apply fails the run: silence would read as
// "applied".
func collectTypeOverrides(pkg *packages.Package) *overrideSet {
	out := &overrideSet{byObj: map[*types.TypeName]string{}, byName: map[string]string{}}
	type claim struct {
		ts  string
		pos token.Position
	}
	claimed := map[any]claim{}
	for _, file := range pkg.Syntax {
		for _, group := range file.Comments {
			for _, comment := range group.List {
				m := typeRe.FindStringSubmatch(comment.Text)
				pos := pkg.Fset.Position(comment.Pos())
				if m == nil {
					// prose like "//borgo:types are ..." is not a directive
					rest, isDirective := strings.CutPrefix(comment.Text, "//borgo:type")
					if isDirective && (rest == "" || rest[0] == ' ' || rest[0] == '\t') {
						fail("%s: malformed directive, want //borgo:type <go type> <ts type>", pos)
					}
					continue
				}
				goType, ts := m[1], strings.TrimSpace(m[2])
				if _, reason := scanOverrideTS(ts); reason != "" {
					fail("%s: //borgo:type %s %s: %s", pos, goType, ts, reason)
				}
				// two directives conflict when they land on one type, however
				// each of them spelled it
				var target any = goType
				if obj := resolveOverride(pkg, goType, pos); obj != nil {
					target = obj
				}
				if prev, dup := claimed[target]; dup && prev.ts != ts {
					fail("%s: //borgo:type %s %s conflicts with %q at %s; a Go type maps to one TypeScript type", pos, goType, ts, prev.ts, prev.pos)
				}
				claimed[target] = claim{ts, pos}
				if obj, ok := target.(*types.TypeName); ok {
					out.byObj[obj] = ts
				} else {
					out.byName[goType] = ts
				}
			}
		}
	}
	return out
}

// scanOverrideTS answers the two questions asked of a //borgo:type
// replacement: can it parse at all, and does it bind loosely enough to need
// parentheses when composed. The text is spliced into the .d.ts whole, so an
// unclosed bracket or a stray ";" costs every route in the project its types.
// This is not a typechecker and cannot be one: the replacement usually names a
// type declared in the app, unknowable from here, so only what cannot parse
// is refused.
//
// loose is a "|", "&", "?" or "=>" outside every bracket - the operators that
// bind looser than the union a nullable position wraps the text in. Decided
// by the scan, never by looking at the finished string (see tsRef).
func scanOverrideTS(ts string) (loose bool, reason string) {
	if ts == "" {
		return false, "the TypeScript type is empty"
	}
	pairs := map[rune]rune{')': '(', ']': '[', '}': '{', '>': '<'}
	var open []rune
	r := []rune(ts)
	for i := 0; i < len(r); i++ {
		switch c := r[i]; c {
		case '"', '\'', '`':
			j := i + 1
			for j < len(r) && r[j] != c {
				if r[j] == '\\' {
					j++
				}
				j++
			}
			if j >= len(r) {
				return loose, fmt.Sprintf("the %s string literal in it is never closed", string(c))
			}
			i = j
		case '/':
			if i+1 < len(r) && (r[i+1] == '/' || r[i+1] == '*') {
				return loose, "it contains a comment, which would comment out the rest of the line it is written into"
			}
		case '=':
			// the ">" of a "=>" closes nothing, and a lone "=" is an assignment
			// and not part of any type
			if i+1 >= len(r) || r[i+1] != '>' {
				return loose, `it contains "=", which is not part of a type`
			}
			i++
			loose = loose || len(open) == 0
		case '|', '&', '?':
			loose = loose || len(open) == 0
		case '(', '[', '{', '<':
			open = append(open, c)
		case ')', ']', '}', '>':
			if len(open) == 0 || open[len(open)-1] != pairs[c] {
				return loose, fmt.Sprintf("the %s in it closes nothing", string(c))
			}
			open = open[:len(open)-1]
		case ';':
			if len(open) == 0 {
				return loose, `it contains a top-level ";", which would end the declaration it is written into and leave the rest of the text loose in the file`
			}
		}
	}
	if len(open) > 0 {
		return loose, fmt.Sprintf("the %s in it is never closed", string(open[len(open)-1]))
	}
	return loose, ""
}

// resolveOverride binds a directive's Go type to the one declaration it names,
// or returns nil for the spellings that already name at most one type and are
// matched by string: an imported "pkgpath.Name", a predeclared name. It fails
// the run for a name that resolves to nothing, and for a bare name that several
// declarations answer to.
func resolveOverride(pkg *packages.Package, goType string, pos token.Position) *types.TypeName {
	bare, locator, located := strings.Cut(goType, "@")
	if i := strings.LastIndex(bare, "."); i >= 0 {
		if located {
			fail("%s: //borgo:type %s: a @file:line locator picks out a function-local type of this api package, and %s names an imported one", pos, goType, bare)
		}
		// an imported package-level name already names at most one type
		checkImportedOverride(pkg, bare[:i], bare[i+1:], goType, pos)
		return nil
	}
	candidates := declaredTypes(pkg, bare)
	if len(candidates) == 0 {
		if _, ok := types.Universe.Lookup(bare).(*types.TypeName); ok && !located {
			return nil // predeclared, and matched by name like an imported one
		}
		fail("%s: //borgo:type names %s, which is not a type this api package can refer to; the directive would never apply", pos, goType)
	}
	if located {
		for _, obj := range candidates {
			if shortPos(pkg, obj) == locator {
				return obj
			}
		}
		fail("%s: //borgo:type %s names no type declared there; this api package declares %s at %s",
			pos, goType, bare, strings.Join(overridePositions(pkg, candidates), ", "))
	}
	if len(candidates) == 1 {
		return candidates[0]
	}
	// the package-level one wins outright: it is what a bare name means, and
	// the function-local ones are not what the author was pointing at
	for _, obj := range candidates {
		if obj.Parent() == pkg.Types.Scope() {
			return obj
		}
	}
	fail("%s: //borgo:type %s is ambiguous: this api package declares %d types named %s, at %s. Name the one you mean as %s@%s",
		pos, goType, len(candidates), bare, strings.Join(overridePositions(pkg, candidates), ", "),
		bare, shortPos(pkg, candidates[0]))
	return nil
}

// checkImportedOverride checks a "pkgpath.Name" against the package imported
// under that path. A path the api package does not import is left alone - it
// may still be reached through a helper package, and guessing there would fail
// runs that are perfectly correct.
func checkImportedOverride(pkg *packages.Package, path, name, goType string, pos token.Position) {
	if pkg.Types == nil {
		return
	}
	for _, imp := range pkg.Types.Imports() {
		if imp.Path() != path {
			continue
		}
		if _, ok := imp.Scope().Lookup(name).(*types.TypeName); !ok {
			fail("%s: //borgo:type names %s, which is not a type this api package can refer to; the directive would never apply", pos, goType)
		}
	}
}

// declaredTypes returns every type of that name the api package declares, at
// package level and in any function body, in source order so the run's errors
// and its choices do not move between builds.
func declaredTypes(pkg *packages.Package, name string) []*types.TypeName {
	if pkg.Types == nil {
		return nil
	}
	var found []*types.TypeName
	var walk func(s *types.Scope)
	walk = func(s *types.Scope) {
		if obj, ok := s.Lookup(name).(*types.TypeName); ok {
			// a type parameter is a name inside one signature, never a type a
			// response can be built from
			if _, isParam := obj.Type().(*types.TypeParam); !isParam {
				found = append(found, obj)
			}
		}
		for i := 0; i < s.NumChildren(); i++ {
			walk(s.Child(i))
		}
	}
	walk(pkg.Types.Scope())
	sort.Slice(found, func(i, j int) bool {
		a, b := pkg.Fset.Position(found[i].Pos()), pkg.Fset.Position(found[j].Pos())
		if a.Filename != b.Filename {
			return a.Filename < b.Filename
		}
		return a.Offset < b.Offset
	})
	return found
}

func overridePositions(pkg *packages.Package, objs []*types.TypeName) []string {
	out := make([]string, 0, len(objs))
	for _, obj := range objs {
		out = append(out, shortPos(pkg, obj))
	}
	return out
}

func shortPos(pkg *packages.Package, obj *types.TypeName) string {
	p := pkg.Fset.Position(obj.Pos())
	return fmt.Sprintf("%s:%d", filepath.Base(p.Filename), p.Line)
}

// tsRef is one rendered TypeScript type with the null it admits carried beside
// the text, joined once by String. Nothing takes a joined type apart again: a
// rendered string is not a parse tree, " | " occurs inside type-argument lists
// too ("Record<string, Array<Item | null> | null>"), and counting brackets is
// the same mistake spelled longer.
//
// Failure direction: a site that renders ts and forgets null emits a type that
// parses and silently promises non-null for a field that arrives null. Tests
// assert the exact rendering of each level, not only that the file parses.
type tsRef struct {
	ts   string // one whole alternative; "" when the type is null and nothing else
	null bool
	// override text that binds looser than a union does (scanOverrideTS). Every
	// rendering of our own is already an atom where a union puts it - a name, an
	// Array<...>, a Record<...>, an object literal - but "(v: string) => void"
	// is not: widening it to admit null yields "(v: string) => void | null", a
	// function returning void|null, which is a different type and typechecks
	// happily as one.
	opaque bool
}

func (r tsRef) orNull() tsRef {
	r.null = true
	return r
}

// member renders the type as one alternative of a union, parenthesizing the
// text that needs it. Only override text ever does: see opaque.
func (r tsRef) member() string {
	if r.opaque {
		return "(" + r.ts + ")"
	}
	return r.ts
}

func (r tsRef) String() string {
	switch {
	case r.ts == "" && r.null:
		return "null"
	case r.ts == "":
		return "unknown"
	case r.null:
		return r.member() + " | null"
	}
	return r.ts
}

// union collects the alternatives of a TypeScript union as whole members and
// joins them in the order added, at the end. Repeats are dropped whole -
// "string" added twice is "string", never "string | string" - and null is
// composed as a flag so that two nullable answers under one route read
// "A | B | null" and not "A | null | B | null".
type union struct {
	seen  map[string]bool
	parts []string
	null  bool
}

func (u *union) add(r tsRef) {
	u.null = u.null || r.null
	if r.ts == "" {
		return
	}
	if u.seen == nil {
		u.seen = map[string]bool{}
	}
	if part := r.member(); !u.seen[part] {
		u.seen[part] = true
		u.parts = append(u.parts, part)
	}
}

func (u *union) empty() bool { return len(u.parts) == 0 && !u.null }

// holds reports whether every alternative of o is one of u's: what o says a
// value may be, u says too
func (u *union) holds(o *union) bool {
	if o.null && !u.null {
		return false
	}
	for _, p := range o.parts {
		if !u.seen[p] {
			return false
		}
	}
	return true
}

func (u *union) String() string {
	if u.null {
		return strings.Join(append(append([]string(nil), u.parts...), "null"), " | ")
	}
	return strings.Join(u.parts, " | ")
}

// maxCrossPkgDepth caps how many package boundaries helper following crosses
// from one handler. Cycles are already impossible (visited set); the cap
// bounds how much of the module a single route can pull into analysis.
const maxCrossPkgDepth = 3

type helperPkg struct {
	pkg    *packages.Package
	decls  map[*types.Func]*ast.FuncDecl
	byName map[string]*ast.FuncDecl // package-level functions only
}

// helperLoader lazily loads packages of the app's own module that handlers
// call into, so bridge types coming from helpers outside api/ are still seen.
// Each package is loaded at most once per run (syntax + type info, deps from
// export data like the main load) and only when a handler actually calls one
// of its functions.
type helperLoader struct {
	root   string
	module string // module path of the app; "" disables cross-package following
	cache  map[string]*helperPkg
}

func newHelperLoader(root string, apiPkg *packages.Package) *helperLoader {
	l := &helperLoader{root: root, cache: map[string]*helperPkg{}}
	if apiPkg.Module != nil {
		l.module = apiPkg.Module.Path
	}
	return l
}

func (l *helperLoader) sameModule(path string) bool {
	return l.module != "" && (path == l.module || strings.HasPrefix(path, l.module+"/"))
}

// load returns the analyzed helper package, or nil when it cannot be loaded.
// A failed package warns once, prefixed by from - "file:line: " when a
// particular call needed it, empty when the whole package is being scanned.
func (l *helperLoader) load(path, from string) *helperPkg {
	if hp, ok := l.cache[path]; ok {
		return hp
	}
	l.cache[path] = nil
	cfg := &packages.Config{
		Dir: l.root,
		Mode: packages.NeedName | packages.NeedFiles | packages.NeedSyntax |
			packages.NeedTypes | packages.NeedTypesInfo | packages.NeedImports,
	}
	pkgs, err := packages.Load(cfg, path)
	if err != nil || len(pkgs) != 1 || len(pkgs[0].Errors) > 0 {
		warn("%shelper package %s could not be analyzed; the response types and pushes behind it are not followed", from, path)
		return nil
	}
	hp := &helperPkg{pkg: pkgs[0], decls: funcDecls(pkgs[0]), byName: map[string]*ast.FuncDecl{}}
	for _, file := range hp.pkg.Syntax {
		for _, d := range file.Decls {
			if fd, ok := d.(*ast.FuncDecl); ok && fd.Recv == nil {
				hp.byName[fd.Name.Name] = fd
			}
		}
	}
	l.cache[path] = hp
	return hp
}

// encodedType returns the type written by a json.NewEncoder(w).Encode(v)
// chain aimed at an http.ResponseWriter, or nil. Only the inline chain is
// recognized: once the encoder lives in a variable or targets another writer,
// calling it a response would be guessing.
func encodedType(info *types.Info, call *ast.CallExpr) types.Type {
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok || len(call.Args) != 1 {
		return nil
	}
	enc, ok := info.Uses[sel.Sel].(*types.Func)
	if !ok || enc.Name() != "Encode" || enc.Pkg() == nil || enc.Pkg().Path() != "encoding/json" {
		return nil
	}
	newEnc, ok := sel.X.(*ast.CallExpr)
	if !ok || len(newEnc.Args) != 1 {
		return nil
	}
	ctor := callee(info, newEnc)
	if ctor == nil || ctor.Name() != "NewEncoder" || ctor.Pkg() == nil || ctor.Pkg().Path() != "encoding/json" {
		return nil
	}
	if w := info.Types[newEnc.Args[0]]; w.Type == nil || w.Type.String() != "net/http.ResponseWriter" {
		return nil
	}
	tv := info.Types[call.Args[0]]
	if tv.Type == nil {
		return nil
	}
	return types.Default(tv.Type)
}

// callee resolves a call to the declared function or method it invokes, or
// nil for builtins, function values, and interface methods.
func callee(info *types.Info, call *ast.CallExpr) *types.Func {
	switch e := call.Fun.(type) {
	case *ast.Ident:
		fn, _ := info.Uses[e].(*types.Func)
		return fn
	case *ast.SelectorExpr:
		fn, _ := info.Uses[e.Sel].(*types.Func)
		return fn
	}
	return nil
}

// takesHTTP reports whether a function's parameters include an
// http.ResponseWriter or *http.Request. borgo.JSON needs the writer and
// borgo.Bind the request, so a helper without either cannot contribute bridge
// types and loading its package would be wasted work (db.Find, log helpers).
func takesHTTP(fn *types.Func) bool {
	sig, ok := fn.Type().(*types.Signature)
	if !ok {
		return false
	}
	for i := 0; i < sig.Params().Len(); i++ {
		switch sig.Params().At(i).Type().String() {
		case "net/http.ResponseWriter", "*net/http.Request":
			return true
		}
	}
	return false
}

// bridgeTypes unions the response type (borgo.JSON[T] and borgo.WriteJSON
// calls) and the request type (borgo.Bind[T] calls) reachable from the
// handler. Helper calls are followed: freely within the same package, and
// into other packages of the same module when the helper is a package-level
// function taking a writer or request, capped at maxCrossPkgDepth hops.
func (g *tsGen) bridgeTypes(pkg *packages.Package, decls map[*types.Func]*ast.FuncDecl, decl *ast.FuncDecl, loader *helperLoader) (response, request string) {
	var resp, req union
	visited := map[*ast.FuncDecl]bool{}
	capped := map[*types.Func]bool{} // warned about once per route, not per call site

	var walk func(pkg *packages.Package, decls map[*types.Func]*ast.FuncDecl, d *ast.FuncDecl, depth int)
	walk = func(pkg *packages.Package, decls map[*types.Func]*ast.FuncDecl, d *ast.FuncDecl, depth int) {
		if d == nil || d.Body == nil || visited[d] {
			return
		}
		visited[d] = true
		ast.Inspect(d.Body, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			switch name, sel := borgoFunc(pkg.TypesInfo, call); name {
			case "JSON", "Bind", "BindMax", "BindMultipart", "BindMultipartMax":
				if inst, ok := pkg.TypesInfo.Instances[sel]; ok && inst.TypeArgs.Len() == 1 {
					if strings.HasPrefix(name, "BindMultipart") {
						g.multipart = true
					} else if name != "JSON" {
						refuseJSONFile(inst.TypeArgs.At(0), pkg.Fset.Position(call.Pos()), "borgo."+name)
					}
					if name != "JSON" {
						// Bind declares its own value and decodes into &v, so
						// the decoder holds the address of everything in it
						req.add(g.tsType(inst.TypeArgs.At(0), inbound()))
					} else if len(call.Args) != 3 || !isErrorStatus(pkg.TypesInfo, call.Args[1]) {
						// JSON hands the value to encoding/json through an any,
						// so what reaches the wire is the unaddressable shape
						resp.add(g.tsType(inst.TypeArgs.At(0), site{}))
					}
				}
			case "WriteJSON":
				if len(call.Args) == 3 && !isErrorStatus(pkg.TypesInfo, call.Args[1]) {
					if tv := pkg.TypesInfo.Types[call.Args[2]]; tv.Type != nil {
						resp.add(g.tsType(types.Default(tv.Type), site{}))
					}
				}
			case "":
				if t := encodedType(pkg.TypesInfo, call); t != nil {
					resp.add(g.tsType(t, site{}))
					return true
				}
				fn := callee(pkg.TypesInfo, call)
				if fn == nil {
					return true
				}
				if fn.Pkg() == pkg.Types {
					walk(pkg, decls, decls[fn], depth)
					return true
				}
				if fn.Pkg() == nil || !loader.sameModule(fn.Pkg().Path()) || !takesHTTP(fn) {
					return true
				}
				if sig, ok := fn.Type().(*types.Signature); !ok || sig.Recv() != nil {
					// methods cannot be matched by name across loads
					return true
				}
				if depth >= maxCrossPkgDepth {
					// dropped in silence the cap takes an alternative out of the
					// union and reads like a handler that answers nothing
					if !capped[fn] {
						capped[fn] = true
						warn("%s: %s.%s is more than %d package hops from the handler, so it was not followed; a borgo.JSON or borgo.Bind inside it is missing from this route's types",
							pkg.Fset.Position(call.Pos()), fn.Pkg().Name(), fn.Name(), maxCrossPkgDepth)
					}
					return true
				}
				if hp := loader.load(fn.Pkg().Path(), pkg.Fset.Position(call.Pos()).String()+": "); hp != nil {
					walk(hp.pkg, hp.decls, hp.byName[fn.Name()], depth+1)
				}
			}
			return true
		})
	}
	walk(pkg, decls, decl, 0)

	// a route nothing answered from has no response type to promise; an empty
	// request union renders "" and drops the request key altogether
	if resp.empty() {
		return "unknown", req.String()
	}
	return resp.String(), req.String()
}

// isErrorStatus reports whether the status argument is a constant >= 300.
// The ts api client throws for any non-2xx response instead of resolving with
// its body, so an error envelope written under a constant error status never
// reaches the typed caller and must stay out of the response union. A
// non-constant status (helpers taking status as a parameter) stays in.
func isErrorStatus(info *types.Info, expr ast.Expr) bool {
	tv := info.Types[expr]
	if tv.Value == nil || tv.Value.Kind() != constant.Int {
		return false
	}
	v, ok := constant.Int64Val(tv.Value)
	return ok && v >= 300
}

// wire is which crossing a type is being rendered for. The two are not mirror
// images: encoding/json consults MarshalJSON/MarshalText going out and
// UnmarshalJSON/UnmarshalText coming in, and a type routinely carries one side
// without the other - an enum with MarshalText and no UnmarshalText is a
// string in a response and an object in a request body.
type wire int

const (
	out wire = iota
	// in is the decoder's side, measured against encoding/json for every kind
	// this file emits (TestInboundFieldsMatchEncodingJSON runs the table):
	//
	//   - an absent field is not an error: the zero value stays, so every
	//     property is "?".
	//   - a field present as null is not an error either: nil on a *T, the
	//     zero on a plain T (literalStore never reaches an UnmarshalText for
	//     null; time.Time and json.Number check for it themselves), so every
	//     property admits "| null".
	//   - a field present with the wrong type IS an error, for every kind
	//     except the two already rendered "unknown" (an interface, a type with
	//     its own UnmarshalJSON). So "x?: string | null" is exact, not wider.
	//
	// omitempty and omitzero are marshal directives and change nothing here.
	in
)

// site is where a value sits and which way it is crossing - the two things that
// decide which of a type's methods encoding/json actually calls.
//
// addr is what json.Marshal can take the address of, and it matters only going
// out: the decoder always holds a pointer to what it is filling. borgo.Bind
// decodes into &v, a map value is decoded into a fresh addressable value and
// stored back, a slice grows into addressable elements - so a pointer-receiver
// Unmarshaler runs in every position and nothing on the way in depends on where
// the value sits.
type site struct {
	w    wire
	addr bool
}

func inbound() site { return site{w: in, addr: true} }

// at moves to a position of the given addressability, which is a move only on
// the way out.
func (s site) at(addr bool) site {
	if s.w == out {
		s.addr = addr
	}
	return s
}

// wireTS reports the shape t reaches the wire as when it converts itself, and
// whether it does at all.
func wireTS(t types.Type, s site) (string, bool) {
	if s.w == in {
		switch {
		case hasUnmarshalMethod(t, "UnmarshalJSON"):
			return "unknown", true
		case hasUnmarshalMethod(t, "UnmarshalText"):
			return "string", true
		}
		return "", false
	}
	return marshalTS(t, s.addr)
}

// keyTS reports whether a map key type names itself on the wire. Only the text
// side counts, in either direction: encoding/json's resolveKeyName consults
// TextMarshaler and never MarshalJSON, and its decoder consults
// TextUnmarshaler and never UnmarshalJSON.
func keyTS(t types.Type, s site) (string, bool) {
	if s.w == in {
		if hasUnmarshalMethod(t, "UnmarshalText") {
			return "string", true
		}
		return "", false
	}
	if hasMarshalMethod(t, "MarshalText", false) {
		return "string", true
	}
	return "", false
}

// hasUnmarshalMethod looks for a method with the exact func([]byte) error shape
// of json.Unmarshaler and encoding.TextUnmarshaler. The lookup always includes
// the method set of *t: see site.addr for why coming in there is no other case.
func hasUnmarshalMethod(t types.Type, name string) bool {
	obj, _, _ := types.LookupFieldOrMethod(t, true, nil, name)
	fn, ok := obj.(*types.Func)
	if !ok {
		return false
	}
	sig, ok := fn.Type().(*types.Signature)
	if !ok || sig.Params().Len() != 1 || sig.Results().Len() != 1 {
		return false
	}
	return types.Identical(sig.Params().At(0).Type(), types.NewSlice(types.Typ[types.Byte])) &&
		sig.Results().At(0).Type().String() == "error"
}

// marshalTS reports the shape t reaches the wire as when it marshals itself,
// for a value in an addressable position or not. It follows the order
// encoding/json's newTypeEncoder does - MarshalJSON before MarshalText, and a
// method declared on the pointer receiver only where the value can be
// addressed - so a type carrying a pointer-receiver MarshalJSON and a
// value-receiver MarshalText really does reach the wire both ways in one
// response: "js" as a slice element, "txt" as the root.
//
// MarshalJSON output is unknown here (any JSON at all); MarshalText output is
// always a quoted string, which is how uuid.UUID, netip.Addr and hand written
// enums stay strings whatever their Go shape is.
func marshalTS(t types.Type, addressable bool) (string, bool) {
	switch {
	case hasMarshalMethod(t, "MarshalJSON", false),
		addressable && hasMarshalMethod(t, "MarshalJSON", true):
		return "unknown", true
	case hasMarshalMethod(t, "MarshalText", false),
		addressable && hasMarshalMethod(t, "MarshalText", true):
		return "string", true
	}
	return "", false
}

// hasMarshalMethod looks for a method with the exact func() ([]byte, error)
// shape, so a struct field that merely happens to be named MarshalJSON does
// not read as a marshaler. addressable widens the lookup to the method set of
// *t, which is the one encoding/json uses for an addressable value.
func hasMarshalMethod(t types.Type, name string, addressable bool) bool {
	obj, _, _ := types.LookupFieldOrMethod(t, addressable, nil, name)
	fn, ok := obj.(*types.Func)
	if !ok {
		return false
	}
	sig, ok := fn.Type().(*types.Signature)
	if !ok || sig.Params().Len() != 0 || sig.Results().Len() != 2 {
		return false
	}
	// []byte and []uint8 are one type but not one string: go/types spells the
	// predeclared alias "[]byte" and the plain kind "[]uint8", so comparing the
	// rendering missed a MarshalJSON() ([]uint8, error) that json.Marshal calls
	return types.Identical(sig.Results().At(0).Type(), types.NewSlice(types.Typ[types.Byte])) &&
		sig.Results().At(1).Type().String() == "error"
}

// tsType renders t as TypeScript at the site the value sits at: which way it
// crosses the wire, and - going out - whether encoding/json can take its
// address, which is the whole of what decides whether a MarshalJSON or
// MarshalText declared on the pointer receiver runs. json.Marshal's own
// argument is not addressable, and neither is a map value or anything behind an
// interface; a slice element and everything behind a pointer always are; a
// struct field, an array element and a value-embedded struct inherit from what
// holds them, while a group promoted through an embedded pointer is reached
// with a dereference and so is addressable wherever the outer value sits. Every
// one of these is pinned to a json.Marshal of the shape it describes in
// TestAddressableVariantsMatchEncodingJSON.
func (g *tsGen) tsType(t types.Type, s site) tsRef {
	switch t := t.(type) {
	case *types.Named:
		obj := t.Obj()
		if ts, ok := g.override(obj); ok {
			return overrideRef(t, ts)
		}
		// a file part of a multipart form: a Blob to the client, which a
		// File is one of, and appended to the FormData as a file. Inbound
		// only: a File written into a response is the plain struct
		// encoding/json makes of it (found by the verifier of the step)
		if s.w == in && isBorgoFile(t) {
			// the global one by name: an app type called Blob would otherwise
			// take its place for every file field (found by hunt 3)
			return tsRef{ts: "globalThis.Blob"}
		}
		// time.Time and json.Number cross the same way in both directions, so
		// neither of these two needs to know which one it is on
		if obj.Pkg() != nil && obj.Pkg().Path() == "time" && obj.Name() == "Time" {
			return tsRef{ts: "string"}
		}
		// json.Number is typed string and carries a bare number on the wire.
		// Only this exact type: `type Amount json.Number` is a copy, not it, and
		// encoding/json quotes a copy like any other string-kinded type
		if obj.Pkg() != nil && obj.Pkg().Path() == "encoding/json" && obj.Name() == "Number" {
			return tsRef{ts: "number"}
		}
		if ts, ok := wireTS(t, s); ok {
			// a marshaler reached through an interface can be nil, and
			// encoding/json writes "null" for it without calling the method:
			// "string" would be a narrowing in the dangerous direction
			if _, iface := t.Underlying().(*types.Interface); iface {
				return tsRef{ts: ts}.orNull()
			}
			return tsRef{ts: ts}
		}
		if u, ok := t.Underlying().(*types.Struct); ok {
			return g.interfaceFor(t, u, s)
		}
		return g.namedFor(t, s)
	case *types.Alias:
		// an alias is a name of its own, so a //borgo:type may target it
		// instead of the type it stands for
		if ts, ok := g.override(t.Obj()); ok {
			return overrideRef(t, ts)
		}
		return g.tsType(types.Unalias(t), s)
	case *types.Basic:
		switch {
		case t.Info()&types.IsBoolean != 0:
			return tsRef{ts: "boolean"}
		// IsNumeric includes complex64/128, which encoding/json refuses at
		// runtime: "number" was a confidently wrong type for a value that
		// can never arrive - unknown is the honest answer, wrong never is
		case t.Info()&types.IsComplex != 0:
			return tsRef{ts: "unknown"}
		case t.Info()&types.IsNumeric != 0:
			return tsRef{ts: "number"}
		case t.Info()&types.IsString != 0:
			return tsRef{ts: "string"}
		}
		return tsRef{ts: "unknown"}
	case *types.Pointer:
		return g.tsType(t.Elem(), s.at(true)).orNull()
	case *types.Slice:
		// encoding/json base64s a slice of any byte-kinded element, named or
		// aliased, not just of the predeclared byte - unless that element
		// converts itself, by MarshalJSON or by MarshalText going out and by
		// their Unmarshal counterparts coming in, in which case the slice is
		// written element by element like any other. Slice elements are
		// addressable, so a method on the pointer receiver counts.
		if b, ok := types.Unalias(t.Elem()).Underlying().(*types.Basic); ok && b.Kind() == types.Uint8 {
			if _, self := wireTS(t.Elem(), s.at(true)); !self {
				return tsRef{ts: "string"}.orNull()
			}
		}
		// a nil slice is "null", never "[]": only an array is always there
		return tsRef{ts: "Array<" + g.tsType(t.Elem(), s.at(true)).String() + ">"}.orNull()
	case *types.Array:
		return tsRef{ts: "Array<" + g.tsType(t.Elem(), s).String() + ">"}
	case *types.Map:
		// encoding/json keys an object by a string or an integer key, and
		// rejects the whole value for anything else it cannot name - floats
		// and complexes included, which IsNumeric would have let through
		if b, ok := t.Key().Underlying().(*types.Basic); ok && b.Info()&(types.IsString|types.IsInteger) != 0 {
			return tsRef{ts: "Record<string, " + g.tsType(t.Elem(), s.at(false)).String() + ">"}.orNull()
		}
		if _, self := keyTS(t.Key(), s); self {
			// encoding/json keys the object by MarshalText output, and only by
			// it: resolveKeyName never consults MarshalJSON, so a key type
			// carrying both is still a string key and not "unknown". Coming in
			// it is TextUnmarshaler and only it, the same way. A key is never
			// addressable going out either, so a MarshalText on the pointer
			// receiver does not apply - encoding/json refuses the map outright
			return tsRef{ts: "Record<string, " + g.tsType(t.Elem(), s.at(false)).String() + ">"}.orNull()
		}
		return tsRef{ts: "unknown"}
	case *types.Struct:
		// an anonymous struct promotes its embedded methods too, so one
		// embedding a time.Time reaches the wire as a JSON string and never as
		// the object its fields describe
		if ts, ok := wireTS(t, s); ok {
			return tsRef{ts: ts}
		}
		return tsRef{ts: "{ " + strings.Join(g.fields(t, s), "; ") + " }"}
	}
	return tsRef{ts: "unknown"}
}

// addrSensitive reports whether t's shape depends on where the value sits -
// whether a marshaler declared on the pointer receiver only is reachable from t
// along a path that carries addressability. Such a type needs two declarations
// in the generated file, one per position; every other type needs one.
//
// Only by-value containment carries addressability (struct fields, array
// elements, value-embedded structs) and by-value containment cannot be cyclic
// in Go, so this walk terminates on the shape of the type alone; seen guards
// against the malformed types a half-broken build can still hand us.
func (g *tsGen) addrSensitive(t types.Type) bool {
	return g.sensitive(t, map[types.Type]bool{})
}

func (g *tsGen) sensitive(t types.Type, seen map[types.Type]bool) bool {
	if seen[t] {
		return false
	}
	seen[t] = true
	switch t := t.(type) {
	case *types.Named:
		obj := t.Obj()
		if _, ok := g.override(obj); ok {
			return false
		}
		if obj.Pkg() != nil && obj.Pkg().Path() == "time" && obj.Name() == "Time" {
			return false
		}
		if obj.Pkg() != nil && obj.Pkg().Path() == "encoding/json" && obj.Name() == "Number" {
			return false
		}
		if answered, differs := marshalsDiffer(t); answered {
			return differs
		}
		return g.sensitive(t.Underlying(), seen)
	case *types.Alias:
		if _, ok := g.override(t.Obj()); ok {
			return false
		}
		return g.sensitive(types.Unalias(t), seen)
	case *types.Array:
		return g.sensitive(t.Elem(), seen)
	case *types.Struct:
		if answered, differs := marshalsDiffer(t); answered {
			return differs
		}
		return g.sensitiveFields(t, map[*types.Struct]bool{t: true}, seen)
	}
	// a pointer and a slice element are addressable wherever they sit; a map
	// value and anything behind an interface never are. None of the four passes
	// the caller's position on, so none of them can differ by it
	return false
}

// marshalsDiffer reports whether t marshals itself at all, and if so whether it
// does it differently in the two positions.
func marshalsDiffer(t types.Type) (answered, differs bool) {
	plain, okPlain := marshalTS(t, false)
	addr, okAddr := marshalTS(t, true)
	if !okPlain && !okAddr {
		return false, false
	}
	return true, okPlain != okAddr || plain != addr
}

// dirDiffers reports whether t is rendered differently coming in than going
// out, and so needs a $Request declaration of its own. Any struct with a field
// on the wire differs: coming in every property is optional and nullable (see
// in), going out only where omitempty/omitzero or a nil-able kind make it so.
// `type Money int` renders "number" both ways, and so does a slice or map of
// one.
//
// Over-approximates where the two renderings coincide (an
// all-`json:",omitempty"`-pointer struct), on purpose: "differs" where nothing
// does costs one duplicate declaration, "does not" where something does hands
// a request body the response's shape. Deciding it exactly would take a second
// walk able to disagree with the one that renders.
func (g *tsGen) dirDiffers(t types.Type) bool {
	return g.differs(t, map[types.Type]bool{})
}

func (g *tsGen) differs(t types.Type, seen map[types.Type]bool) bool {
	if seen[t] {
		return false
	}
	seen[t] = true
	switch t := t.(type) {
	case *types.Named:
		obj := t.Obj()
		if _, ok := g.override(obj); ok {
			return false
		}
		if obj.Pkg() != nil && obj.Pkg().Path() == "time" && obj.Name() == "Time" {
			return false
		}
		if obj.Pkg() != nil && obj.Pkg().Path() == "encoding/json" && obj.Name() == "Number" {
			return false
		}
		if answered, d := wiresDiffer(t); answered {
			return d
		}
		return g.differs(t.Underlying(), seen)
	case *types.Alias:
		if _, ok := g.override(t.Obj()); ok {
			return false
		}
		return g.differs(types.Unalias(t), seen)
	case *types.Pointer:
		return g.differs(t.Elem(), seen)
	case *types.Slice:
		return g.differs(t.Elem(), seen)
	case *types.Array:
		return g.differs(t.Elem(), seen)
	case *types.Map:
		return g.differs(t.Key(), seen) || g.differs(t.Elem(), seen)
	case *types.Struct:
		if answered, d := wiresDiffer(t); answered {
			return d
		}
		// a struct that converts nothing itself is rendered field by field, and
		// the fields are what differ. One with nothing on the wire renders
		// "{ [key: string]: unknown }" both ways and does not
		return hasWireField(t, map[*types.Struct]bool{t: true})
	}
	return false
}

// hasWireField reports whether any field of s reaches the wire, counting the
// ones flattened in from an embedded struct. expanded is collectFields' guard
// against a struct that embeds itself.
func hasWireField(s *types.Struct, expanded map[*types.Struct]bool) bool {
	for i := 0; i < s.NumFields(); i++ {
		plan := planField(s, i)
		switch {
		case plan.skip:
		case plan.embedded != nil:
			if expanded[plan.embedded] {
				continue
			}
			expanded[plan.embedded] = true
			found := hasWireField(plan.embedded, expanded)
			delete(expanded, plan.embedded)
			if found {
				return true
			}
		default:
			return true
		}
	}
	return false
}

// wiresDiffer reports whether t converts itself at all, in either direction or
// either position, and if so whether all of those answers agree. A type with a
// MarshalText and no UnmarshalText disagrees; so does one whose marshaler is on
// the pointer receiver, because the position it does not run in renders the Go
// shape while the decoder - which always has the address - does not.
func wiresDiffer(t types.Type) (answered, differs bool) {
	plain, okPlain := marshalTS(t, false)
	addr, okAddr := marshalTS(t, true)
	back, okBack := wireTS(t, inbound())
	if !okPlain && !okAddr && !okBack {
		return false, false
	}
	return true, okPlain != okAddr || okPlain != okBack || plain != addr || plain != back
}

func (g *tsGen) sensitiveFields(s *types.Struct, expanded map[*types.Struct]bool, seen map[types.Type]bool) bool {
	for i := 0; i < s.NumFields(); i++ {
		plan := planField(s, i)
		switch {
		case plan.skip:
		case plan.embedded != nil:
			// a group promoted through an embedded pointer is reached with a
			// dereference, so it is addressable whatever holds the outer value
			// and cannot differ by position
			if plan.viaPtr || expanded[plan.embedded] {
				continue
			}
			expanded[plan.embedded] = true
			differs := g.sensitiveFields(plan.embedded, expanded, seen)
			delete(expanded, plan.embedded)
			if differs {
				return true
			}
		case g.sensitive(s.Field(i).Type(), seen):
			return true
		}
	}
	return false
}

// override returns the TypeScript a //borgo:type directive puts in place of a
// Go type. A directive for an api type was bound to one declaration when it was
// collected, so a type sharing its name in another function body is not it.
func (g *tsGen) override(obj *types.TypeName) (string, bool) {
	if ts, ok := g.overrides.byObj[obj]; ok {
		return ts, true
	}
	if obj.Pkg() != nil {
		if ts, ok := g.overrides.byName[obj.Pkg().Path()+"."+obj.Name()]; ok {
			return ts, true
		}
		return "", false
	}
	ts, ok := g.overrides.byName[obj.Name()] // predeclared
	return ts, ok
}

// overrideRef renders a //borgo:type replacement. The text replaces the shape,
// not the nil: a nil slice, map, pointer or interface is "null" on the wire
// whatever the replacement says. So a text that already ends in "| null" is
// widened again rather than merged with
// (TestOverrideTextIsCarriedWholeIntoEveryNullablePosition).
func overrideRef(t types.Type, ts string) tsRef {
	loose, _ := scanOverrideTS(ts) // the reason was answered when it was collected
	r := tsRef{ts: ts, opaque: loose}
	switch types.Unalias(t).Underlying().(type) {
	case *types.Slice, *types.Map, *types.Pointer, *types.Interface:
		return r.orNull()
	}
	return r
}

// typeArgSuffix mangles instantiated type arguments into a readable,
// deterministic name part: Page[Widget] -> "Widget", Page[[]post.Item] ->
// "PostItem".
func (g *tsGen) typeArgSuffix(args *types.TypeList) string {
	if args == nil || args.Len() == 0 {
		return ""
	}
	var b strings.Builder
	for i := 0; i < args.Len(); i++ {
		s := types.TypeString(args.At(i), func(p *types.Package) string {
			if p == g.apiPkg {
				return ""
			}
			return p.Name()
		})
		up := true
		for _, r := range s {
			if r == '_' || unicode.IsLetter(r) || unicode.IsDigit(r) {
				if up {
					r = unicode.ToUpper(r)
					up = false
				}
				b.WriteRune(r)
			} else {
				up = true
			}
		}
	}
	return b.String()
}

// addrSuffix marks the declaration of a type as encoding/json writes it where
// the value is addressable. "$" cannot occur in a Go identifier, so the variant
// name can never be one a user type would claim.
const addrSuffix = "$Addressable"

// reqSuffix marks the declaration of a type as encoding/json reads it. It is
// unconditional where it applies, not a fallback for a name already claimed:
// which direction reaches a type first is an accident of route order, and a
// name that moves with it is a diff nobody can read.
const reqSuffix = "$Request"

// reserveName picks the TypeScript identifier for a Go type and claims it, so
// two Go types that share a short name cannot collide in the generated file.
func (g *tsGen) reserveName(t *types.Named, addressable, req bool) string {
	obj := t.Obj()
	name := obj.Name() + g.typeArgSuffix(t.TypeArgs())
	if addressable {
		name += addrSuffix
	}
	if req {
		name += reqSuffix
	}
	if g.taken[name] && obj.Pkg() != nil {
		// title-cased, so the one-off `type resp struct{...}` a second handler
		// declares reads ApiResp and not Apiresp
		name = title(obj.Pkg().Name()) + title(name)
	}
	base := name
	for i := 2; g.taken[name]; i++ {
		name = fmt.Sprintf("%s%d", base, i)
	}
	g.taken[name] = true
	return name
}

func title(s string) string {
	for i, r := range s {
		return string(unicode.ToUpper(r)) + s[i+len(string(r)):]
	}
	return s
}

// variantKey identifies one of the up to three declarations a named type gets:
// its plain shape, the shape it takes where encoding/json can address it, and
// the shape encoding/json reads back. Each of the last two exists only for the
// types that really do take a different one there - the plain shape answers for
// everything else, and a request body of an ordinary struct goes on sharing the
// declaration its response has.
func (g *tsGen) variantKey(t *types.Named, s site) (key string, addr, req bool) {
	switch {
	case s.w == in && g.dirDiffers(t):
		return typeKey(t) + "#in", false, true
	case s.w == out && s.addr && g.addrSensitive(t):
		return typeKey(t) + "#addr", true, false
	}
	return typeKey(t), false, false
}

// typeKey identifies a named type across the names, expanding and taken maps.
// types.TypeString is not unique: a function-local `type resp struct{...}` has
// the same string in every handler, so the declaration position separates
// those; a package-level type keeps the plain string, so two instantiations
// of a generic still key on their type arguments.
func typeKey(t *types.Named) string {
	key := types.TypeString(t, nil)
	obj := t.Obj()
	if scope := obj.Parent(); scope != nil && obj.Pkg() != nil && scope != obj.Pkg().Scope() {
		key = fmt.Sprintf("%s#%d", key, obj.Pos())
	}
	return key
}

// pointerCycle reports whether expanding t re-enters t through pointers alone -
// `type Loop *Loop`, or a pair of types pointing at each other. Every value of
// such a type is a chain that has to end at a nil pointer, and encoding/json
// writes a pointer as whatever it points at, so null is the only thing that can
// reach the wire. Inlining the expansion instead emitted `export type Loop =
// Loop | null;`, a type alias that refers to itself: TS2456.
func pointerCycle(t types.Type) bool {
	seen := map[*types.TypeName]bool{}
	for {
		named, ok := types.Unalias(t).(*types.Named)
		if !ok {
			return false
		}
		if seen[named.Obj()] {
			return true
		}
		seen[named.Obj()] = true
		ptr, ok := named.Underlying().(*types.Pointer)
		if !ok {
			return false
		}
		t = ptr.Elem()
	}
}

// namedFor expands a named type whose underlying is not a struct. It inlines
// the underlying, as it always did - `type Money int` is still just `number` -
// unless the expansion re-enters this same type, which means the type is
// recursive and has to be able to refer to itself. Then it gets a declaration
// of its own and the inner reference resolves to that name.
func (g *tsGen) namedFor(t *types.Named, s site) tsRef {
	if pointerCycle(t) {
		return tsRef{null: true}
	}
	key, addr, req := g.variantKey(t, s)
	if name, ok := g.names[key]; ok {
		return tsRef{ts: name}
	}
	if g.expanding[key] {
		name := g.reserveName(t, addr, req)
		g.names[key] = name
		return tsRef{ts: name}
	}
	g.expanding[key] = true
	body := g.tsType(t.Underlying(), s.at(addr))
	delete(g.expanding, key)
	// a name appeared while we were inside: an inner frame hit the cycle and
	// reserved one, and this frame owns the declaration that gives it meaning
	if name, ok := g.names[key]; ok {
		g.defs = append(g.defs, variantNote(t, addr, req)+"export type "+name+" = "+body.String()+";\n")
		return tsRef{ts: name}
	}
	return body
}

func (g *tsGen) interfaceFor(t *types.Named, u *types.Struct, s site) tsRef {
	key, addr, req := g.variantKey(t, s)
	if name, ok := g.names[key]; ok {
		return tsRef{ts: name}
	}
	name := g.reserveName(t, addr, req)
	g.names[key] = name

	fields := g.fields(u, s.at(addr))
	g.defs = append(g.defs, variantNote(t, addr, req)+"export interface "+name+" {\n  "+strings.Join(fields, ";\n  ")+";\n}\n")
	return tsRef{ts: name}
}

// variantNote heads the second or third declaration of one Go type with the
// reason it exists: more than one declaration for one type is otherwise a
// puzzle, and the reference sites alone do not say which produced which.
func variantNote(t *types.Named, addressable, req bool) string {
	switch {
	case addressable:
		return "// " + t.Obj().Name() + " as encoding/json writes it where the value is\n" +
			"// addressable - a slice element, or anything behind a pointer - so the\n" +
			"// pointer-receiver marshalers inside it do run.\n"
	case req:
		return "// " + t.Obj().Name() + " as encoding/json reads it, which is not\n" +
			"// the response it writes: a field the decoder never receives is not an\n" +
			"// error, and neither is one that arrives null, so every property below\n" +
			"// is optional and admits null whatever its Go type is.\n"
	}
	return ""
}

// fields returns the interface members of a struct as encoding/json would
// write it: json tags for naming, omitempty for optionality, embedded structs
// flattened, and the name conflicts that flattening creates resolved.
func (g *tsGen) fields(u *types.Struct, s site) []string {
	var found []jsonField
	g.collectFields(u, 0, false, s, map[*types.Struct]bool{u: true}, &found)

	// encoding/json's promotion rule: of the fields that would marshal under
	// the same name, the shallowest wins; at equal depth exactly one tagged
	// field wins, and any other tie drops the name from the wire entirely.
	winner := map[string]int{}
	tied := map[string]bool{}
	for i, f := range found {
		j, seen := winner[f.name]
		switch {
		case !seen, f.depth < found[j].depth, f.depth == found[j].depth && f.tagged && !found[j].tagged:
			winner[f.name], tied[f.name] = i, false
		case f.depth > found[j].depth, f.tagged != found[j].tagged:
			// shadowed by the field already held
		default:
			tied[f.name] = true
		}
	}

	var out []string
	for i, f := range found {
		if tied[f.name] || winner[f.name] != i {
			continue
		}
		out = append(out, fmt.Sprintf("%s%s: %s", tsPropName(f.name), f.optional, f.ts))
	}
	if len(out) == 0 {
		return []string{"[key: string]: unknown"}
	}
	return out
}

type jsonField struct {
	name     string
	optional string
	ts       string
	depth    int  // embedding hops from the outermost struct
	tagged   bool // named by a json tag rather than by the field name
}

// fieldPlan is what encoding/json's typeFields decides about one struct field
// before any of it is typed: dropped, flattened into the parent, or written
// under a name. It is split out so the shape walk and the addressability walk
// cannot disagree about which fields reach the wire.
type fieldPlan struct {
	skip     bool
	embedded *types.Struct // non-nil when the field is flattened into the parent
	viaPtr   bool          // and reached through a pointer
	name     string
	tagged   bool // named by a json tag rather than by the field name
	opts     string
}

func planField(s *types.Struct, i int) fieldPlan {
	f := s.Field(i)
	name, opts, skip := parseJSONTag(s.Tag(i))
	if !validTagName(name) {
		// not a name encoding/json will use; the field keeps its Go one
		name = ""
	}
	et := f.Type()
	p, ptr := types.Unalias(et).(*types.Pointer)
	if ptr {
		et = p.Elem()
	}
	var embedded *types.Struct
	if named, ok := types.Unalias(et).(*types.Named); ok {
		embedded, _ = named.Underlying().(*types.Struct)
	}
	if skip || (!f.Exported() && !(f.Embedded() && embedded != nil)) {
		return fieldPlan{skip: true}
	}
	// no Marshaler check here, and none in encoding/json's typeFields either:
	// an embedded struct is flattened whatever methods it carries, and the
	// marshaler only decides anything once it is promoted to the outer type -
	// in which case tsType answered before this ran
	if f.Embedded() && name == "" && embedded != nil {
		return fieldPlan{embedded: embedded, viaPtr: ptr}
	}
	tagged := name != ""
	if !tagged {
		name = f.Name()
	}
	return fieldPlan{name: name, tagged: tagged, opts: opts}
}

// collectFields walks a struct the way encoding/json's typeFields does,
// flattening embedded structs - including embedded unexported struct types,
// whose exported fields do reach the wire. expanded holds the struct types
// already flattened on this path: a type that embeds itself (type Node struct{
// *Node }) would otherwise recurse forever, and encoding/json stops at the same
// point since the promoted copy is shadowed by the shallower one anyway.
//
// viaPtr marks the fields promoted through an embedded pointer. encoding/json
// skips the whole promoted group when that pointer is nil - json.Marshal of a
// zero Outer in `type Outer struct{ *Inner; B int }` is {"b":1}, with no sign
// of Inner's fields - so none of them can be promised. The same dereference
// makes that group addressable whatever holds the outer value.
func (g *tsGen) collectFields(u *types.Struct, depth int, viaPtr bool, s site, expanded map[*types.Struct]bool, out *[]jsonField) {
	for i := 0; i < u.NumFields(); i++ {
		plan := planField(u, i)
		if plan.skip {
			continue
		}
		if plan.embedded != nil {
			if expanded[plan.embedded] {
				continue
			}
			expanded[plan.embedded] = true
			g.collectFields(plan.embedded, depth+1, viaPtr || plan.viaPtr, s.at(s.addr || plan.viaPtr), expanded, out)
			delete(expanded, plan.embedded)
			continue
		}
		f := u.Field(i)
		optional := ""
		if viaPtr || hasOpt(plan.opts, "omitzero") || (hasOpt(plan.opts, "omitempty") && canBeEmpty(f.Type())) {
			// omitzero drops the field whenever the value is the zero of its
			// type - or its IsZero() says so - which omitempty never does for
			// a struct: a `json:"t,omitzero"` time.Time is routinely absent
			optional = "?"
		}
		ts := g.tsType(f.Type(), s)
		if quotesAsString(f.Type(), plan.opts, s) {
			// the null a pointer added is untouched by the quoting and rides
			// along on its own. Whatever text was here is gone, and with it any
			// reason to treat it as somebody else's
			ts.ts, ts.opaque = "string", false
		}
		if s.w == in {
			optional = "?" // see the doc on the in constant for both of these
			ts = ts.orNull()
		}
		*out = append(*out, jsonField{name: plan.name, optional: optional, ts: ts.String(), depth: depth, tagged: plan.tagged})
	}
}

// quotesAsString reports whether a `,string` option really puts this field on
// the wire quoted. encoding/json decides it on the Go kind, in typeFields: a
// bool, an integer, a float or a string is quoted, and an unnamed pointer to
// one is quoted through - `type P *int` is named and is not. Everything else
// ignores the option. Decided on the kind, not on the rendered text: a
// //borgo:type can stand between the two. A converter outranks the option:
// marshalerEncoder and textMarshalerEncoder never look at opts.quoted, and
// the same holds coming back.
func quotesAsString(t types.Type, opts string, s site) bool {
	if !hasOpt(opts, "string") {
		return false
	}
	if p, ok := types.Unalias(t).(*types.Pointer); ok {
		t, s = p.Elem(), s.at(true)
	}
	if _, self := wireTS(t, s); self {
		return false
	}
	b, ok := types.Unalias(t).Underlying().(*types.Basic)
	return ok && b.Info()&(types.IsBoolean|types.IsInteger|types.IsFloat|types.IsString) != 0
}

// tsPropName quotes a JSON name that is not a bare TypeScript identifier.
// encoding/json accepts tags like `json:"user-name"` or `json:"a.b"`; written
// unquoted they are a syntax error, and one such field breaks the parse of the
// whole .d.ts - so every route in the project loses its types at once.
func tsPropName(name string) string {
	if isTSIdent(name) {
		return name
	}
	return fmt.Sprintf("%q", name)
}

// tsReserved holds every name a generated declaration cannot carry: what this
// repo's own tsc rejects as an interface or type alias name, in its two error
// categories, TS1xxx at the parse and TS2427/TS2457 at the check. Array and
// Record are the two generics this file writes: an interface under either
// name shadows them in the module and every use becomes "type is not
// generic", quietly, since apps typecheck with skipLibCheck. A file field is written globalThis.Blob, and the names borgo-framework
// declares are reached through aliases (qualifyForModule): neither renames
// an app's type.
var tsReserved = []string{
	"Array", "Record",
	"as", "await", "break", "case", "catch", "class", "const", "continue",
	"debugger", "default", "delete", "do", "else", "enum", "export", "extends",
	"false", "finally", "for", "function", "if", "implements", "import", "in",
	"instanceof", "interface", "let", "new", "null", "package", "private",
	"protected", "public", "return", "static", "super", "switch", "this",
	"throw", "true", "try", "typeof", "var", "void", "while", "with", "yield",
	"any", "bigint", "boolean", "never", "number", "object", "string",
	"symbol", "undefined", "unknown",
}

func reservedTSNames() map[string]bool {
	taken := make(map[string]bool, len(tsReserved))
	for _, name := range tsReserved {
		taken[name] = true
	}
	return taken
}

func isTSIdent(s string) bool {
	if s == "" {
		return false
	}
	for i, r := range s {
		switch {
		case r == '_' || r == '$' || unicode.IsLetter(r):
		case i > 0 && unicode.IsDigit(r):
		default:
			return false
		}
	}
	return true
}

// canBeEmpty reports whether omitempty can ever drop a field of type t, which
// is encoding/json's isEmptyValue: false, 0, "", a nil pointer or interface,
// and a slice, map or array of length zero. A struct is never empty to it - a
// `json:"meta,omitempty"` struct, a time.Time above all, is on the wire every
// time - and neither is an array with elements in it. The Go kind decides,
// not the marshaled shape: a MarshalJSON that writes "" does not make the
// field disappear.
func canBeEmpty(t types.Type) bool {
	switch u := types.Unalias(t).Underlying().(type) {
	case *types.Basic:
		return u.Info()&(types.IsBoolean|types.IsNumeric|types.IsString) != 0
	case *types.Slice, *types.Map, *types.Pointer, *types.Interface:
		return true
	case *types.Array:
		return u.Len() == 0
	}
	return false
}

// validTagName mirrors encoding/json's isValidTag. A name holding anything
// else - a quote, a backslash, an apostrophe, a rune that is neither letter,
// digit nor one of these punctuation marks - is not a name to it at all: it
// drops the tag and marshals the field under its Go name, so a
// `json:"who's"` field arrives as "Owner".
func validTagName(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if !strings.ContainsRune("!#$%&()*+-./:;<=>?@[]^_{|}~ ", c) &&
			!unicode.IsLetter(c) && !unicode.IsDigit(c) {
			return false
		}
	}
	return true
}

// hasOpt reports whether a json tag's option list contains opt. Options are
// compared whole, the way encoding/json splits them: ",omitemptyish" is an
// unknown option to it, not omitempty.
func hasOpt(opts, opt string) bool {
	for opts != "" {
		var o string
		o, opts, _ = strings.Cut(opts, ",")
		if o == opt {
			return true
		}
	}
	return false
}

// parseJSONTag splits a json struct tag into its name and its options. skip
// carries encoding/json's whole-tag rule: `json:"-"` drops the field, while
// `json:"-,"` is the documented way to put a field on the wire under the name
// "-" - only the first of the two is an exclusion.
func parseJSONTag(tag string) (name, opts string, skip bool) {
	value, ok := lookupTag(tag, "json")
	if !ok {
		return "", "", false
	}
	if value == "-" {
		return "", "", true
	}
	if i := strings.Index(value, ","); i >= 0 {
		return value[:i], value[i+1:], false
	}
	return value, "", false
}

func lookupTag(tag, key string) (string, bool) {
	// minimal reflect.StructTag.Lookup
	for tag != "" {
		i := 0
		for i < len(tag) && tag[i] == ' ' {
			i++
		}
		tag = tag[i:]
		if tag == "" {
			break
		}
		i = 0
		for i < len(tag) && tag[i] > ' ' && tag[i] != ':' && tag[i] != '"' {
			i++
		}
		if i == 0 || i+1 >= len(tag) || tag[i] != ':' || tag[i+1] != '"' {
			break
		}
		k := tag[:i]
		tag = tag[i+1:]
		i = 1
		for i < len(tag) && tag[i] != '"' {
			if tag[i] == '\\' {
				i++
			}
			i++
		}
		if i >= len(tag) {
			break
		}
		// unquoted as reflect.StructTag.Lookup unquotes it: the raw text kept
		// its escapes, and the wire name json writes did not match the type's
		// (found by hunt 3)
		value, err := strconv.Unquote(tag[:i+1])
		if err != nil {
			break
		}
		tag = tag[i+1:]
		if k == key {
			return value, true
		}
	}
	return "", false
}

// writeMiddlewareCover tells borgo export which paths api/middleware.go
// guards: a page it covers must not become a file a static host serves to
// everyone (found by hunt 3). Without a Matcher the middleware covers every
// path, as it does in Go; no middleware, no file
func writeMiddlewareCover(root string, mw middlewareDecl) {
	path := filepath.Join(root, ".borgo", "middleware.json")
	if !mw.present {
		os.Remove(path)
		return
	}
	var covers any = "all"
	switch {
	case mw.matcher && mw.known:
		covers = append([]string{}, mw.values...)
	case mw.matcher:
		covers = "unknown"
	}
	data, _ := json.Marshal(map[string]any{"covers": covers})
	writeIfChanged(path, string(data)+string(rune(10)))
}
