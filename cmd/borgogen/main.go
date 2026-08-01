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
	"fmt"
	"go/ast"
	"go/constant"
	"go/parser"
	"go/token"
	"go/types"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"

	"golang.org/x/tools/go/packages"
)

const (
	borgoPath = "github.com/LuigiDavideMicca/borgo"
	genGoFile = "api/borgo.gen.go"
)

var (
	directiveRe    = regexp.MustCompile(`^//borgo:route\s+(.+)$`)
	typeRe         = regexp.MustCompile(`^//borgo:type\s+(\S+)\s+(.+)$`)
	patternRe      = regexp.MustCompile(`^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /\S*$`)
	looseDirective = regexp.MustCompile(`^//\s*borgo:route\b`)
)

type route struct {
	pattern string
	handler *types.Func
	pos     token.Position
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
		msgs := make([]string, 0, len(pkg.Errors))
		for _, e := range pkg.Errors {
			msgs = append(msgs, e.Error())
		}
		fail("%s", strings.Join(msgs, "\n"))
	}
	dropGeneratedFile(pkg)

	routes := collectRoutes(pkg)
	decls := funcDecls(pkg)
	directives := collectDirectives(pkg, decls, routes)
	warnLooseRouteComments(pkg, decls)
	warnExcludedRouteFiles(root, pkg)
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
		names: map[string]string{},
		// Array and Record are the two generics this file writes: an interface
		// declared under either name shadows them inside the module and every
		// use turns into "type is not generic", quietly, since apps typecheck
		// with skipLibCheck
		taken:     map[string]bool{"Array": true, "Record": true},
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
		resp, req := gen.bridgeTypes(pkg, decls, decls[r.handler], loader)
		entry := "{ response: " + resp
		if req != "" {
			entry += "; request: " + req
		}
		entries[r.pattern] = entry + " }"
		patterns = append(patterns, r.pattern)
	}

	wsKeys, wsEntries := collectPushes(pushSources(pkg, loader), gen)

	var out strings.Builder
	out.WriteString("// generated by borgogen - do not edit\n\n")
	for _, def := range gen.defs {
		out.WriteString(def)
		out.WriteString("\n")
	}
	out.WriteString("declare module \"borgo-framework\" {\n  interface ApiRoutes {\n")
	for _, p := range patterns {
		fmt.Fprintf(&out, "    %q: %s;\n", p, entries[p])
	}
	out.WriteString("  }\n")
	if len(wsKeys) > 0 {
		out.WriteString("  interface WsEvents {\n")
		for _, k := range wsKeys {
			fmt.Fprintf(&out, "    %q: %s;\n", k, wsEntries[k])
		}
		out.WriteString("  }\n")
	}
	out.WriteString("}\n\nexport {};\n")

	// the disk is untouched until here: any check above fails the run without
	// leaving one output regenerated, or deleted, and the other one stale
	writeMounting(root, pkg.Name, directives, pkg.Types.Scope())

	if mkErr := os.MkdirAll(filepath.Join(root, ".borgo"), 0o755); mkErr != nil {
		fail("%v", mkErr)
	}
	writeIfChanged(filepath.Join(root, ".borgo", "api-types.d.ts"), out.String())
	fmt.Printf("borgogen: %d routes -> .borgo/api-types.d.ts\n", len(patterns))
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
	for fn, decl := range decls {
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
func writeMounting(root, pkgName string, directives []route, scope *types.Scope) {
	if len(directives) == 0 {
		os.Remove(filepath.Join(root, genGoFile))
		return
	}
	sorted := append([]route(nil), directives...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].pattern < sorted[j].pattern })

	qualifier, importDecl := "borgo", "import \""+borgoPath+"\""
	if alias := borgoAlias(scope); alias != "" {
		qualifier, importDecl = alias, "import "+alias+" \""+borgoPath+"\""
	}

	var out strings.Builder
	out.WriteString("// generated by borgogen - do not edit\npackage " + pkgName + "\n\n")
	out.WriteString(importDecl + "\n\nfunc init() {\n")
	for _, r := range sorted {
		fmt.Fprintf(&out, "\t%s.Handle(%q, %s)\n", qualifier, r.pattern, r.handler.Name())
	}
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
	if idx, ok := fun.(*ast.IndexExpr); ok {
		// explicit type arguments, e.g. borgo.Bind[T](r)
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
			routes = append(routes, route{
				pattern: constant.StringVal(tv.Value),
				handler: handlerFunc(pkg.TypesInfo, call.Args[1]),
				pos:     pkg.Fset.Position(call.Pos()),
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
func collectPushes(pkgs []*packages.Package, gen *tsGen) ([]string, map[string]string) {
	unions := map[string]*union{}
	var keys []string
	for _, pkg := range pkgs {
		for _, file := range pkg.Syntax {
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
				}
				unions[key].add(gen.tsType(inst.TypeArgs.At(0)))
				return true
			})
		}
	}
	sort.Strings(keys)
	entries := make(map[string]string, len(keys))
	for _, k := range keys {
		entries[k] = unions[k].String()
	}
	return keys, entries
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
		var next []*packages.Package
		for _, path := range paths {
			if hp := loader.load(path, ""); hp != nil {
				out = append(out, hp.pkg)
				next = append(next, hp.pkg)
			}
		}
		frontier = next
	}
	return out
}

func handlerFunc(info *types.Info, expr ast.Expr) *types.Func {
	switch e := expr.(type) {
	case *ast.Ident:
		if fn, ok := info.Uses[e].(*types.Func); ok {
			return fn
		}
	case *ast.SelectorExpr:
		if fn, ok := info.Uses[e.Sel].(*types.Func); ok {
			return fn
		}
	case *ast.CallExpr:
		// borgo.Authed(h) is transparent: the route keeps h's types
		if name, _ := borgoFunc(info, e); name == "Authed" && len(e.Args) == 1 {
			return handlerFunc(info, e.Args[0])
		}
	}
	return nil
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
	// named non-struct types currently being expanded. A struct is safe from
	// recursion because interfaceFor names it before it walks its fields; a
	// named map, slice or pointer had no such anchor, so `type Tree
	// map[string]Tree` expanded forever. That is a stack overflow, which is
	// fatal rather than a panic - run()'s recover never sees it, so the dev
	// loop died on every save with no message at all.
	expanding map[string]bool
	defs      []string
	apiPkg    *types.Package
	overrides map[string]string
}

// collectTypeOverrides gathers every "//borgo:type Go TS" directive. The Go
// type is "pkgpath.Name" for imported types or a bare name for api types.
//
// A directive that can never apply - one naming a Go type that does not exist,
// or a second one for a type already claimed - fails the run. A malformed
// directive already does; staying silent about a directive that is well formed
// and still does nothing would read as "applied" and leave the user staring at
// the type it was meant to replace.
func collectTypeOverrides(pkg *packages.Package) map[string]string {
	out := map[string]string{}
	at := map[string]token.Position{}
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
				if prev, dup := out[goType]; dup && prev != ts {
					fail("%s: //borgo:type %s %s conflicts with %q at %s; a Go type maps to one TypeScript type", pos, goType, ts, prev, at[goType])
				}
				if !overrideTargetExists(pkg, goType) {
					fail("%s: //borgo:type names %s, which is not a type this api package can refer to; the directive would never apply", pos, goType)
				}
				out[goType], at[goType] = ts, pos
			}
		}
	}
	return out
}

// overrideTargetExists reports whether a //borgo:type could ever match a Go
// type. Only the two lookups tsGen.override actually performs are checked: a
// bare name against the api package and the predeclared types, a "path.Name"
// against the package imported under that path. A path the api package does
// not import is left alone - it may still be reached through a helper package,
// and guessing there would fail runs that are perfectly correct.
func overrideTargetExists(pkg *packages.Package, goType string) bool {
	i := strings.LastIndex(goType, ".")
	if i < 0 {
		if pkg.Types != nil {
			if _, ok := pkg.Types.Scope().Lookup(goType).(*types.TypeName); ok {
				return true
			}
		}
		_, ok := types.Universe.Lookup(goType).(*types.TypeName)
		return ok
	}
	path, name := goType[:i], goType[i+1:]
	if pkg.Types == nil {
		return true
	}
	for _, imp := range pkg.Types.Imports() {
		if imp.Path() != path {
			continue
		}
		_, ok := imp.Scope().Lookup(name).(*types.TypeName)
		return ok
	}
	return true
}

type union struct {
	seen  map[string]bool
	parts []string
}

func (u *union) add(ts string) {
	if u.seen == nil {
		u.seen = map[string]bool{}
	}
	if !u.seen[ts] {
		u.seen[ts] = true
		u.parts = append(u.parts, ts)
	}
}

func (u *union) String() string {
	return strings.Join(u.parts, " | ")
}

// tsUnion joins TypeScript alternatives in the order given, flattening the
// unions among them and dropping the repeats: "string" and "string | null"
// compose to "string | null", not "string | string | null".
func tsUnion(parts ...string) string {
	var u union
	for _, p := range parts {
		for _, alt := range strings.Split(p, " | ") {
			u.add(alt)
		}
	}
	return u.String()
}

// nullable widens a TypeScript type to admit null, which is what encoding/json
// writes for every nil it can reach: a nil slice, map or pointer is "null" on
// the wire, not "[]", "{}" or a missing key. A type that promises an array for
// a response that can be empty turns data.items.map() into a TypeError.
func nullable(ts string) string { return tsUnion(ts, "null") }

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
			case "JSON", "Bind", "BindMax":
				if inst, ok := pkg.TypesInfo.Instances[sel]; ok && inst.TypeArgs.Len() == 1 {
					if name != "JSON" {
						req.add(g.tsType(inst.TypeArgs.At(0)))
					} else if len(call.Args) != 3 || !isErrorStatus(pkg.TypesInfo, call.Args[1]) {
						resp.add(g.tsType(inst.TypeArgs.At(0)))
					}
				}
			case "WriteJSON":
				if len(call.Args) == 3 && !isErrorStatus(pkg.TypesInfo, call.Args[1]) {
					if tv := pkg.TypesInfo.Types[call.Args[2]]; tv.Type != nil {
						resp.add(g.tsType(types.Default(tv.Type)))
					}
				}
			case "":
				if t := encodedType(pkg.TypesInfo, call); t != nil {
					resp.add(g.tsType(t))
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
				if fn.Pkg() == nil || !loader.sameModule(fn.Pkg().Path()) ||
					!takesHTTP(fn) || depth >= maxCrossPkgDepth {
					return true
				}
				if sig, ok := fn.Type().(*types.Signature); !ok || sig.Recv() != nil {
					// methods cannot be matched by name across loads
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

	if len(resp.parts) == 0 {
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

// hasCustomMarshal reports whether t marshals through json.Marshaler in any
// position. A marshaler declared on the pointer receiver only reaches some of
// them (see textMarshalTS), but both answers are "unknown" here, so the
// distinction does not change the emitted type.
func hasCustomMarshal(t types.Type) bool { return hasMarshalMethod(t, "MarshalJSON", true) }

// textMarshalTS types a value that reaches the wire through
// encoding.TextMarshaler - how uuid.UUID, netip.Addr and hand written enums
// become quoted strings whatever their Go shape is.
//
// encoding/json only calls a MarshalText declared on the pointer receiver when
// the value it holds is addressable, and inside a json.Marshal(v any) most are
// not: not v itself, not a struct field of it, not a map value - but a slice
// element is, and so is anything behind a pointer. One named type can reach
// the wire both ways in a single response, so a pointer-only marshaler has no
// single shape to report and the type is the union of the two. raw yields the
// shape of the non-marshaling half and is called only when it is needed: an
// anonymous struct is its own underlying type, so reaching for it through
// tsType would not terminate.
func (g *tsGen) textMarshalTS(t types.Type, raw func() string) (string, bool) {
	if hasCustomMarshal(t) || !hasMarshalMethod(t, "MarshalText", true) {
		return "", false
	}
	if hasMarshalMethod(t, "MarshalText", false) {
		return "string", true
	}
	return tsUnion("string", raw()), true
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
	return sig.Results().At(0).Type().String() == "[]byte" &&
		sig.Results().At(1).Type().String() == "error"
}

func (g *tsGen) tsType(t types.Type) string {
	switch t := t.(type) {
	case *types.Named:
		obj := t.Obj()
		if ts, ok := g.override(obj); ok {
			return ts
		}
		if obj.Pkg() != nil && obj.Pkg().Path() == "time" && obj.Name() == "Time" {
			return "string"
		}
		if hasCustomMarshal(t) {
			return "unknown"
		}
		if ts, ok := g.textMarshalTS(t, func() string { return g.tsType(t.Underlying()) }); ok {
			return ts
		}
		if s, ok := t.Underlying().(*types.Struct); ok {
			return g.interfaceFor(t, s)
		}
		return g.namedFor(t)
	case *types.Alias:
		// an alias is a name of its own, so a //borgo:type may target it
		// instead of the type it stands for
		if ts, ok := g.override(t.Obj()); ok {
			return ts
		}
		return g.tsType(types.Unalias(t))
	case *types.Basic:
		switch {
		case t.Info()&types.IsBoolean != 0:
			return "boolean"
		case t.Info()&types.IsNumeric != 0:
			return "number"
		case t.Info()&types.IsString != 0:
			return "string"
		}
		return "unknown"
	case *types.Pointer:
		return nullable(g.tsType(t.Elem()))
	case *types.Slice:
		// encoding/json base64s a slice of any byte-kinded element, named or
		// aliased, not just of the predeclared byte - unless that element
		// marshals itself, by MarshalJSON or by MarshalText, in which case the
		// slice is written element by element like any other. Slice elements
		// are addressable, so a marshaler on the pointer receiver counts.
		if b, ok := types.Unalias(t.Elem()).Underlying().(*types.Basic); ok &&
			b.Kind() == types.Uint8 && !hasCustomMarshal(t.Elem()) &&
			!hasMarshalMethod(t.Elem(), "MarshalText", true) {
			return nullable("string")
		}
		// a nil slice is "null", never "[]": only an array is always there
		return nullable("Array<" + g.tsType(t.Elem()) + ">")
	case *types.Array:
		return "Array<" + g.tsType(t.Elem()) + ">"
	case *types.Map:
		// encoding/json keys an object by a string or an integer key, and
		// rejects the whole value for anything else it cannot name - floats
		// and complexes included, which IsNumeric would have let through
		if b, ok := t.Key().Underlying().(*types.Basic); ok && b.Info()&(types.IsString|types.IsInteger) != 0 {
			return nullable("Record<string, " + g.tsType(t.Elem()) + ">")
		}
		if !hasCustomMarshal(t.Key()) && hasMarshalMethod(t.Key(), "MarshalText", false) {
			// encoding/json keys the object by MarshalText output. A key is
			// never addressable, so a MarshalText on the pointer receiver does
			// not apply - encoding/json refuses to marshal the map at all
			return nullable("Record<string, " + g.tsType(t.Elem()) + ">")
		}
		return "unknown"
	case *types.Struct:
		// an anonymous struct promotes its embedded methods too, so one
		// embedding a time.Time reaches the wire as a JSON string and never as
		// the object its fields describe
		if hasCustomMarshal(t) {
			return "unknown"
		}
		object := func() string { return "{ " + strings.Join(g.fields(t), "; ") + " }" }
		if ts, ok := g.textMarshalTS(t, object); ok {
			return ts
		}
		return object()
	}
	return "unknown"
}

func (g *tsGen) override(obj *types.TypeName) (string, bool) {
	if obj.Pkg() != nil {
		if ts, ok := g.overrides[obj.Pkg().Path()+"."+obj.Name()]; ok {
			return ts, true
		}
	}
	if obj.Pkg() == nil || obj.Pkg() == g.apiPkg {
		if ts, ok := g.overrides[obj.Name()]; ok {
			return ts, true
		}
	}
	return "", false
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

// reserveName picks the TypeScript identifier for a Go type and claims it, so
// two Go types that share a short name cannot collide in the generated file.
func (g *tsGen) reserveName(t *types.Named) string {
	obj := t.Obj()
	name := obj.Name() + g.typeArgSuffix(t.TypeArgs())
	if g.taken[name] && obj.Pkg() != nil {
		pkgName := obj.Pkg().Name()
		name = strings.ToUpper(pkgName[:1]) + pkgName[1:] + name
	}
	base := name
	for i := 2; g.taken[name]; i++ {
		name = fmt.Sprintf("%s%d", base, i)
	}
	g.taken[name] = true
	return name
}

// namedFor expands a named type whose underlying is not a struct. It inlines
// the underlying, as it always did - `type Money int` is still just `number` -
// unless the expansion re-enters this same type, which means the type is
// recursive and has to be able to refer to itself. Then it gets a declaration
// of its own and the inner reference resolves to that name.
func (g *tsGen) namedFor(t *types.Named) string {
	key := types.TypeString(t, nil)
	if name, ok := g.names[key]; ok {
		return name
	}
	if g.expanding[key] {
		name := g.reserveName(t)
		g.names[key] = name
		return name
	}
	g.expanding[key] = true
	body := g.tsType(t.Underlying())
	delete(g.expanding, key)
	// a name appeared while we were inside: an inner frame hit the cycle and
	// reserved one, and this frame owns the declaration that gives it meaning
	if name, ok := g.names[key]; ok {
		g.defs = append(g.defs, "export type "+name+" = "+body+";\n")
		return name
	}
	return body
}

func (g *tsGen) interfaceFor(t *types.Named, s *types.Struct) string {
	key := types.TypeString(t, nil)
	if name, ok := g.names[key]; ok {
		return name
	}
	name := g.reserveName(t)
	g.names[key] = name

	fields := g.fields(s)
	g.defs = append(g.defs, "export interface "+name+" {\n  "+strings.Join(fields, ";\n  ")+";\n}\n")
	return name
}

// fields returns the interface members of a struct as encoding/json would
// write it: json tags for naming, omitempty for optionality, embedded structs
// flattened, and the name conflicts that flattening creates resolved.
func (g *tsGen) fields(s *types.Struct) []string {
	var found []jsonField
	g.collectFields(s, 0, false, map[*types.Struct]bool{s: true}, &found)

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
// of Inner's fields - so none of them can be promised.
func (g *tsGen) collectFields(s *types.Struct, depth int, viaPtr bool, expanded map[*types.Struct]bool, out *[]jsonField) {
	for i := 0; i < s.NumFields(); i++ {
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
		named, _ := types.Unalias(et).(*types.Named)
		var embeddedStruct *types.Struct
		if named != nil {
			embeddedStruct, _ = named.Underlying().(*types.Struct)
		}

		if !f.Exported() && !(f.Embedded() && embeddedStruct != nil) {
			continue
		}
		if skip {
			continue
		}
		if f.Embedded() && name == "" && embeddedStruct != nil && !hasCustomMarshal(named) {
			if expanded[embeddedStruct] {
				continue
			}
			expanded[embeddedStruct] = true
			g.collectFields(embeddedStruct, depth+1, viaPtr || ptr, expanded, out)
			delete(expanded, embeddedStruct)
			continue
		}
		tagged := name != ""
		if !tagged {
			name = f.Name()
		}
		optional := ""
		if viaPtr || hasOpt(opts, "omitzero") || (hasOpt(opts, "omitempty") && canBeEmpty(f.Type())) {
			// omitzero drops the field whenever the value is the zero of its
			// type - or its IsZero() says so - which omitempty never does for
			// a struct: a `json:"t,omitzero"` time.Time is routinely absent
			optional = "?"
		}
		ts := g.tsType(f.Type())
		if hasOpt(opts, "string") {
			// ,string quotes booleans and pointed-to numbers too, not just
			// plain ones: {"b":"true","p":"5"}
			switch ts {
			case "number", "boolean":
				ts = "string"
			case "number | null", "boolean | null":
				ts = "string | null"
			}
		}
		*out = append(*out, jsonField{name: name, optional: optional, ts: ts, depth: depth, tagged: tagged})
	}
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
		value := tag[1:i]
		tag = tag[i+1:]
		if k == key {
			return value, true
		}
	}
	return "", false
}
