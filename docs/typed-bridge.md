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

Decode with `borgo.Bind[T](r)` and the route's request is typed too, so the client *requires* a body of that type:

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

The generated entry now carries both directions, and a body of the wrong shape fails `tsc`:

```ts no-check
"POST /api/tasks": { response: TaskItem; request: TaskCreate$Request };
```

The request side is not `TaskCreate`. It is a second declaration, `TaskCreate$Request`, because a struct is read by `encoding/json` more leniently than it is written — see [the request side](#the-request-side-what-the-decoder-accepts). In short: every property is optional and admits `null`, so `body: {}` compiles, and it compiles because the server accepts it.

`Bind` reads at most 1 MB, so a route expecting a small payload cannot be fed gigabytes; `borgo.BindMax[T](r, 8<<20)` raises the cap where a route legitimately needs it (`limit <= 0` disables it), and borgogen types it identically. `borgo.BindError(w, err)` answers with the right status as JSON — `413` past the limit, `415` for a missing or non-JSON `Content-Type`, `400` for malformed JSON — and the proxy relays those verbatim, so the browser sees the API's answer rather than a wrapped error page.

## How Go types become TypeScript

Fields follow `encoding/json` semantics, because that is what will actually be on the wire. This table is the **response** side — what `json.Marshal` writes. A request body is read by a different, more lenient set of rules, and gets its own declaration; that is the [next section](#the-request-side-what-the-decoder-accepts).

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

`$` cannot appear in a Go identifier, so the variant name can never collide with a type of yours — the same is true of the `$Request` suffix below. A type whose two renderings are identical — the overwhelming majority — gets one interface as before.

This also means the two positions can run *different methods*. A type with `MarshalJSON` on the pointer receiver and `MarshalText` on the value one is `unknown` where it is addressable and `string` where it is not, because that is the order `encoding/json` resolves them in. Give a marshaler a value receiver and all of this collapses: one shape, one interface, everywhere.

## The request side: what the decoder accepts

A struct handed to `borgo.Bind[T]` is rendered a second time, under `<Name>$Request`, as `encoding/json` *reads* it rather than as it writes it. The two are not mirror images, and the difference was measured one field per kind against the decoder rather than read off its documentation:

- a field the decoder **never receives** is not an error — it keeps its zero value;
- a field that arrives as **`null`** is not an error either, for any kind: pointer or not, container, converter, `,string` field, `omitempty` field alike — the value is left untouched, which on a fresh `Bind` is again the zero;
- a field of the **wrong type** *is* an error (`UnmarshalTypeError`), for every kind except `any` and a custom `UnmarshalJSON`.

So on the inbound side every property becomes optional and admits `null`, and the third rule is what keeps that exact rather than a shrug: `title?: string | null` is precisely the set of values the server takes for a `string` field, not a wider one.

```go
type TaskPatch struct {
	Title string   `json:"title"`
	Tags  []string `json:"tags,omitempty"`
	Due   *string  `json:"due"`
}
```

```ts no-check
// TaskPatch as encoding/json writes it
export interface TaskPatch {
  title: string;
  tags?: Array<string> | null;
  due: string | null;
}

// TaskPatch as encoding/json reads it, which is not
// the response it writes: a field the decoder never receives is not an
// error, and neither is one that arrives null, so every property below
// is optional and admits null whatever its Go type is.
export interface TaskPatch$Request {
  title?: string | null;
  tags?: Array<string> | null;
  due?: string | null;
}
```

A few consequences worth knowing:

- **`omitempty` and `omitzero` change nothing here.** They are write directives. Reading them as "this is the optional one" reads the wrong direction — the fields without them are no less optional to the decoder.
- **A nested struct is lenient too**, because the same decoder reads it: a field of type `Inner` is `Inner$Request | null` in a request.
- **A fixed-size array is `Array<T> | null`** coming in, not a tuple: `encoding/json` takes what it is given and pads or drops the rest, so `[2]string` accepts `["only"]` and `["a","b","c"]`.
- **`,string` is enforced coming in**: the field wants the quoted form and refuses the bare number, which is why it is typed `string` both ways.
- **A type is rendered once where the two readings coincide** — a named scalar (`type Money int`), a slice or a map of one. Only a struct with a field on the wire gets the second declaration, and it gets it whether or not some route also answers with it, so the name is not an accident of route order. (A struct whose every field is already optional and nullable going out gets a `$Request` twin of identical text; answering "differs" where nothing does costs one duplicate declaration, and answering "does not" where something does would hand a request body the response's shape, which is the bug this direction exists to fix.)
- **A `json:"-"` field and an unexported one are not in the request type**, because the decoder never fills them.

### Where the request type cannot be exact

Some things about a body cannot be said in TypeScript, and a type that pretended otherwise would be worse than one that says where it stops. Each divergence below is pinned by a test (`TestWhereTheRequestTypeCannotBeExact` in `cmd/borgogen`) that fails the day it stops diverging, so the list is measured, not remembered. The type is **wider** than the server in these cases — the body compiles, and the server answers `400`:

- **One numeric type.** TypeScript cannot say integer or width, so `{"count": 1.5}` and `{"count": 1e300}` typecheck against an `int` field and the decoder refuses them.
- **A string is a string.** RFC 3339 for `time.Time`, base64 for `[]byte`, and the quoted number of a `,string` field are sub-languages a type cannot spell: `"nope"`, `"!!!"` and `"x"` all compile and all fail to bind.

And **narrower** than the server in these, deliberately — nothing the server would do anything with is lost:

- **A top-level `null` body.** The decoder accepts it and leaves the zero value; the type does not. `null` and `{}` produce the identical value, so no server state is unreachable through the type.
- **A key the Go type does not declare.** The decoder ignores it; `tsc` refuses it, twice over — as an excess property on a fresh literal, and, since every property is optional, as a weak-type mismatch. That includes a `json:"-"` field addressed by its Go name.
- **`json.Number` also accepts a numeric string.** `{"amount": "7"}` binds, and the type says `number`. Widening to `number | string` would admit every string the server refuses; the template literal `` `${number}` `` looks exact and is not, because TypeScript's numeric-string grammar is its own, not JSON's — `" 7"`, `"7 "`, `"+7"`, `".5"`, `"7."`, `"0x10"`, `"0b11"`, `"0o7"` and `"07"` all typecheck as `` `${number}` `` and `encoding/json` refuses every one (`TestNumericStringIsNotJSONNumber`). So it stays `number`, and a caller that really wants to send `"7"` knows it is stepping outside the type.

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
