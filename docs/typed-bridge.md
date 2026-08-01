# The typed bridge

Your Go handlers, read by static analysis, become the TypeScript types your React pages are checked against. No OpenAPI spec to maintain, no generation step you invoke by hand, no runtime reflection. This page covers writing API routes, what `borgogen` can see, how Go types map to TypeScript, the generated client, and where the analysis honestly stops.

This is one of the five reasons borgo exists: types that are generated cannot drift from the code they describe, because nobody maintains them.

## API routes

API routes are Go files in `api/`. Annotate a handler with a route directive and it is mounted for you:

```go
//borgo:route GET /api/tasks
func ListTasks(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, TaskList{Tasks: tasks})
}
```

Prefer explicitness? `borgo.Handle("GET /api/tasks", ListTasks)` in an `init()` works identically and feeds the same types. `main.go` stays five lines: import your `api` package, call `borgo.Serve()`.

## It is a normal Go module

This is worth stating plainly, because the framework's own zero-dependency rule sometimes reads as a restriction on *your* code. It is not. Your `api/` package is ordinary Go: `go get` whatever you want and use it.

```bash
go get gorm.io/gorm
go get github.com/jackc/pgx/v5
go get modernc.org/sqlite
```

```go
//borgo:route GET /api/tasks/recent
func RecentTasks(w http.ResponseWriter, r *http.Request) {
	tasks := []Task{}
	if err := db.Order("created_at desc").Find(&tasks).Error; err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	borgo.JSON(w, http.StatusOK, TaskList{Tasks: tasks})
}
```

The bridge does not care where your data came from — it reads the type you hand to `borgo.JSON`, so a route backed by GORM, `database/sql`, an HTTP call to another service or a hard-coded slice all type identically. `examples/tasks` in this repository uses GORM with SQLite; the `full` template uses in-memory maps so it has no dependencies to install.

What has zero dependencies is the **framework**: `github.com/LuigiDavideMicca/borgo` pulls in nothing but the standard library, so the only third-party code in your binary is the code you chose. Types from a dependency reach TypeScript like any other — `time.Time` becomes a string, a type with `MarshalText` becomes a string, and one whose custom `MarshalJSON` runs where it is used maps to `unknown` until you point a [`//borgo:type` override](#type-overrides) at it, which is exactly what the GORM example does for `gorm.DeletedAt`. Whether a marshaler runs at all can depend on the value's position — see [addressability](#addressability-one-type-two-shapes).

A malformed directive fails the generator *before* it writes anything, so a typo can never leave behind a half-generated `borgo.gen.go` that keeps breaking the build after you fix it. Registering the same pattern twice, or registering after `borgo.Serve()` has snapshotted the table, panics naming the offending pattern. (Only the *malformed* pattern panic also names the registering file and line.)

## What borgogen reads

`borgogen` runs automatically on every `api/*.go` change in dev, and as part of `borgo build` and `borgo export`. It analyzes your `api` package with `go/ast` and `go/types`, and writes two files:

- `.borgo/api-types.d.ts` — a TypeScript interface per Go struct, plus a route map from pattern to request and response types
- `api/borgo.gen.go` — the mounting code for `//borgo:route` handlers

It finds a route's **response type** from `borgo.JSON[T]`, `borgo.WriteJSON`, and inline `json.NewEncoder(w).Encode(v)` calls reachable from the handler — including through helper functions, both inside the `api` package and — within the bounds listed under [honest limits](#honest-limits) — across other packages of your module:

```go
func respondTask(w http.ResponseWriter, status int, task Task) {
	borgo.JSON(w, status, TaskItem{Task: task})
}

//borgo:route GET /api/tasks/{id}
func GetTask(w http.ResponseWriter, r *http.Request) {
	respondTask(w, http.StatusOK, Task{ID: 1, Title: "Buy oranges"})
}
```

The route still types as `TaskItem`. Extracting a helper is a refactoring, not a hole in your types.

A handler with more than one success shape produces a **union**, and error envelopes written with a constant status of 300 or more are deliberately excluded — the client throws an `ApiError` on any non-2xx, so those bodies never reach the caller as data:

```ts no-check
"GET /api/search": { response: Suggestions | Results };
```

## Typed request bodies

Decode with `borgo.Bind[T](r)` and the route's request is typed too, so the client *requires* a matching body:

```go
type TaskCreate struct {
	Title string `json:"title"`
	Body  string `json:"body"`
}

//borgo:route POST /api/tasks
func CreateTask(w http.ResponseWriter, r *http.Request) {
	body, err := borgo.Bind[TaskCreate](r)
	if err != nil {
		borgo.BindError(w, err)
		return
	}
	borgo.JSON(w, http.StatusCreated, TaskItem{Task: Task{Title: body.Title}})
}
```

The generated entry now carries both directions, and a wrong body fails `tsc`:

```ts no-check
"POST /api/tasks": { response: TaskItem; request: TaskCreate };
```

`Bind` reads at most 1 MB, so a route expecting a small payload cannot be fed gigabytes; `borgo.BindMax[T](r, 8<<20)` raises the cap where a route legitimately needs it (`limit <= 0` disables it), and borgogen types it identically. `borgo.BindError(w, err)` answers with the right status as JSON — `413` past the limit, `415` for a missing or non-JSON `Content-Type`, `400` for malformed JSON — and the proxy relays those verbatim, so the browser sees the API's answer rather than a wrapped error page.

## How Go types become TypeScript

Fields follow `encoding/json` semantics, because that is what will actually be on the wire:

| Go | TypeScript | Note |
| --- | --- | --- |
| `string`, `int`, `float64`, `bool` | `string`, `number`, `boolean` | |
| `*T` | `T \| null` | |
| `[]T` | `Array<T> \| null` | a **nil** slice marshals to `null`, never `[]` — see below |
| `[N]T` | `Array<T>` | a fixed-size array is always there, so it is never null |
| `[]byte` | `string \| null` | Go marshals it as base64; nil is `null` |
| `map[string]T` | `Record<string, T> \| null` | numeric keys too — Go writes them as strings; a nil map is `null` |
| `time.Time` | `string` | RFC 3339 |
| `json.RawMessage` | `unknown` | |
| a type with a value-receiver `MarshalText` | `string` | |
| a type with a value-receiver `MarshalJSON` | `unknown` | override it with `//borgo:type` |
| a type whose marshaler has a **pointer receiver** | depends on where the value sits | see [addressability](#addressability-one-type-two-shapes) below |
| `json:"name,omitempty"` | `name?: T` | strings, numbers, bools, slices, maps, pointers — not structs, which Go always writes |
| `json:"name,omitzero"` | `name?: T` | Go 1.24+ |
| `json:"-"` | omitted | but `json:"-,"` means a field literally named `-` |
| `json:",string"` | `string` | numbers and bools quoted on the wire |

Embedded structs are flattened using the standard library's own depth rules: a field on the outer struct shadows a promoted one at greater depth, and two promoted fields tied at the same depth cancel out, exactly as `encoding/json` drops them. Fields promoted from an *unexported* embedded type are included, because they are marshalled. Two same-named structs in different packages get distinct interfaces, prefixed by package. Recursive types terminate. A JSON tag that is not a valid TypeScript identifier is emitted quoted, so `json:"user-name"` cannot break your typecheck.

### Addressability: one type, two shapes

`encoding/json` calls a marshaler declared on a **pointer receiver** only where it can take the value's address. So a type carrying one does not have *a* JSON shape — it has two, and which one you get depends on the position the value sits in, not on the type. borgogen models this exactly rather than picking a winner.

The rules it follows, which are `reflect.Value.CanAddr`'s:

| Position | Addressable? |
| --- | --- |
| `json.Marshal`'s own argument — the root of a response | no |
| a slice element, anything behind a pointer | **yes**, always |
| a struct field, an array element, a value-embedded struct | inherits from whatever holds it |
| a map value, a map key, anything behind an interface | no, ever |
| a field promoted through an **embedded pointer** | **yes** — reaching it dereferences, so it is addressable even inside a map value |

The case worth seeing, because it is the one that surprises:

```go
type PM struct {
	X int `json:"x"`
}

func (p *PM) MarshalJSON() ([]byte, error) { return []byte(`"pm"`), nil }

type Outer struct {
	P PM `json:"p"`
}
```

`Outer` never mentions a pointer, and yet:

```
Outer{}                    ->  {"p":{"x":0}}
[]Outer{{}}                ->  [{"p":"pm"}]
map[string]Outer{"k": {}}  ->  {"k":{"p":{"x":0}}}
```

Same type, three positions, two different JSON shapes — the slice element is addressable, so `PM`'s marshaler runs there and nowhere else. A map value behaves like the root, not like the slice.

Where the shape genuinely depends on position, borgogen emits a second interface beside the first and each reference site picks the right one:

```ts no-check
export interface Outer {
  p: PM;
}

// Outer as encoding/json writes it where the value is addressable
export interface Outer$Addressable {
  p: unknown;
}
```

`$` cannot appear in a Go identifier, so the variant name can never collide with a type of yours. A type whose two renderings are identical — the overwhelming majority — gets one interface as before.

This also means the two positions can run *different methods*. A type with `MarshalJSON` on the pointer receiver and `MarshalText` on the value one is `unknown` where it is addressable and `string` where it is not, because that is the order `encoding/json` resolves them in. Give a marshaler a value receiver and all of this collapses: one shape, one interface, everywhere.

## Type overrides

A type borgogen cannot see through — one whose custom `MarshalJSON` runs in the position it is used — maps to `unknown`. Override the mapping for any named type with a directive anywhere in the `api` package:

```go
//borgo:type gorm.io/gorm.DeletedAt string | null
```

## The nil slice trap

One place where Go's own JSON semantics can surprise you, and where the generated types now say so out loud:

```go no-check
var tasks []Task            // nil, not empty
db.Find(&tasks)             // still nil if there are no rows
borgo.JSON(w, 200, TaskList{Tasks: tasks})
```

A **nil** slice, map or `[]byte` marshals to `null`, not `[]` — and there is no tag, no receiver and no analysis that tells the generator which of your handlers has arranged for it not to be nil. So the bridge types the wire: `Array<Task> | null`. The alternative is a type that is right about intent and wrong about bytes, which fails at `tasks.map(...)` in the browser, at runtime, in production — the one place TypeScript was supposed to help. A fixed-size array (`[N]T`) is exempt: it is always there.

You have two ways to deal with the null, and they are both fine.

**Handle it on the client**, which is what the type is asking for:

```tsx no-check
const tasks = data.tasks ?? [];
```

**Or make it impossible in Go**, which is one line and worth the habit in any handler returning a collection:

```go no-check
tasks := []Task{}           // empty, marshals to []
```

Note that the second one does not change the generated type — borgogen reads the struct, not the handler — so the `?? []` stays. What it buys you is that the null never reaches a client you did not write.

## The generated client

Loaders and actions receive `api`, a client typed by the map above. The route pattern is the key, path params come from the pattern itself, and the response type follows:

```tsx
import type { LoaderContext } from "borgo-framework";

export async function loader({ params, api }: LoaderContext) {
  const { task } = await api("GET /api/tasks/{id}", { params: { id: params.id } });
  return { task };
}
```

Options are `params`, `query`, `body`, `headers` and `timeout` (milliseconds; off by default, because a hard default would break streaming and long-polling callers). Non-2xx responses throw `ApiError`, which carries `.status` and a size-capped `.body`:

```tsx
import { ApiError, redirect, type LoaderContext } from "borgo-framework";

export async function loader({ api }: LoaderContext) {
  try {
    return { me: await api("GET /api/me") };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return redirect("/login");
    throw error;
  }
}
```

The client forwards the browser's cookies on every call, so Go sees the session during server rendering, and forwards `Set-Cookie` back — which is what makes a login action actually log the browser in. `apiUrl` is the escape hatch: the raw base URL, for anything the typed client does not model.

Loader and action code is stripped from client bundles at build time, so server-only imports and secrets used there never reach the browser. CI greps the built assets for a sentinel string to keep that honest.

The same analysis types [WebSocket events](realtime.md#typed-events) from `borgo.Push` calls.

## Generated files and CI

Both generated files are committed to your repository, so a fresh clone typechecks before anyone runs `dev`. Keep them in sync the way this repo does: run the generator in CI and fail if the output differs from what is checked in.

One trap worth knowing: TypeScript skips dot-directories, so `.borgo/api-types.d.ts` must be named explicitly in `tsconfig.json`:

```json
{ "include": ["**/*", ".borgo/api-types.d.ts"] }
```

Every template ships this. If your editor suddenly cannot find the route types, that line is the first thing to check.

## Honest limits

The bridge is static analysis, and it says `unknown` rather than guessing. What it cannot see:

- helper functions **outside your module** — a response written by a vendored or third-party package;
- helper functions in another package of your module that are more than **three package hops** away, or that are methods, or that do not take an `http.ResponseWriter`/`*http.Request`. In-package helpers have none of these restrictions; the hop limit is warned about, the other two are not;
- an encoder stored in a variable before use (`enc := json.NewEncoder(w)`) rather than the inline chain;
- dynamically chosen types: `borgo.JSON(w, s, any(x))` types as the static type of the expression, which is `any`;
- anything reached through reflection.

The escape hatch is visible, not silent: you get `unknown`, and a compile error at the point of use, rather than a plausible-looking type that is wrong.

One decoding subtlety, on the Go side rather than the TypeScript one: `encoding/json` matches field names case-insensitively and lets the last duplicate key win, so `{"Username":"a","username":"b"}` binds `b`, and `{"USERNAME":…}` still matches. `borgo.Bind` inherits this, because changing it would break the standard library's contract. The practical rule: never validate a JSON body in one layer and act on it in another — bind once, in the Go handler, and validate what *that* decode produced.
