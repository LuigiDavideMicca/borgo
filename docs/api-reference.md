# API reference and stability audit

Every public surface borgo has, catalogued from the source, with a stability marker on each entry. This page exists for two reasons: so you can tell at a glance whether something you are about to depend on is a promise or an experiment, and so the project can see how much unfinished surface stands between here and 1.0.

The rules those markers will mean once 1.0 ships are in [api stability](api-stability.md). What borgo will and will not grow into is in [VISION.md](../VISION.md).

## How to read this

| Marker | Meaning |
| --- | --- |
| **stable** | We intend to keep it, with this name and this shape, through all of 1.x. |
| **provisional** | Shipped and usable, but the name or the signature may change before 1.0. Use it; expect a migration note. |
| **internal** | Exported for mechanical reasons — the generated code imports it, or a sibling module needs it. Not for application use, not covered by the stability promise, may change in any release. |

Anything not listed here is not public, whatever its capitalization.

Counted at 0.21: **42** Go exports (counting struct fields and interface methods), **47** TypeScript exports across five entry points, **26** environment variables, **7** `borgo` subcommands plus `create-borgo` and `borgogen`, and the file conventions below. Twelve of those exports are provisional and twenty-three are internal but reachable from a published entry point — the [findings](#findings) at the end say what to do about each.

## Go: `github.com/LuigiDavideMicca/borgo`

The module is the repository root. It has zero runtime dependencies; `golang.org/x/tools` is required only by `cmd/borgogen`.

### Routing and server

| Symbol | What it is for | Stability |
| --- | --- | --- |
| `Handle(pattern string, h http.HandlerFunc)` | Registers a handler under a `"METHOD /path"` pattern. Panics on a malformed pattern, a nil handler, a duplicate, or a call after `Serve`. | stable |
| `Serve()` | Mounts every registered route, adds `GET /healthz` unless an app route claims it, listens on `API_PORT`, handles signals and graceful shutdown. Blocks, and calls `log.Fatal` if the listener fails. | stable |
| `ServeContext(ctx) error` | The same server, ended by cancelling `ctx` and returning the error instead of exiting. For embedding in a larger program, and for tests. | stable |
| `Version` | The released version this binary was built from, kept honest by a test that reads the release manifest. | stable |

`Serve` was provisional in 0.20 only in its *shape*: returning nothing and calling `log.Fatal` made it impossible to embed or to exercise from a test. 0.21 added `ServeContext` beside it rather than changing it, so both are stable and `Serve` stays the one you want when the process exists to be the server.

### Responses

| Symbol | What it is for | Stability |
| --- | --- | --- |
| `JSON[T any](w, status int, v T)` | Writes `v` as a JSON response. The type parameter is what `borgogen` reads to type the route's response for TypeScript. | stable |
| `WriteJSON(w, status int, v any)` | Same behaviour, untyped parameter. Also the framework's own internal JSON writer. | provisional |
| `Bind[T any](r) (T, error)` | Decodes the request body as JSON into `T`, capped at 1 MB. Types the route's request body for TypeScript. | stable |
| `BindMax[T any](r, limit int64) (T, error)` | `Bind` with an explicit byte cap; `limit <= 0` disables it. | stable |
| `BindError(w, err error)` | Answers a `Bind` error with the right status: 413 oversized, 415 wrong content type, 400 otherwise. | stable |
| `Cache(w, maxAge time.Duration, staleWhileRevalidate ...time.Duration)` | Marks the response publicly cacheable; downgrades to `private` if the response already carries `Set-Cookie`. | provisional |
| `NoCache(w)` | Marks the response `no-store`. | stable |

`Cache` is provisional because of the variadic third parameter, which is Go's idiom for "I did not want to define an options type" and cannot grow a second option without another one.

### Sessions

| Symbol | What it is for | Stability |
| --- | --- | --- |
| `SetSession(w, v any, maxAge time.Duration) error` | Stores `v` JSON-encoded and HMAC-signed in the `borgo_session` cookie. The expiry is signed too. Errors if the cookie would exceed 4 KB. | stable |
| `GetSession[T any](r) (T, bool)` | Verifies signature and expiry and decodes into `T`. False for missing, tampered, expired — or ambiguous (two valid cookies). | stable |
| `ClearSession(w)` | Deletes the session cookie. | stable |
| `ErrNoSessionSecret` | Returned by `SetSession` when `SESSION_SECRET` is unset. | stable |

### Auth

| Symbol | What it is for | Stability |
| --- | --- | --- |
| `Auth[U any]` | Struct wiring an app's user store to ready-made login/logout/register handlers over the session. | stable |
| `Auth.Lookup func(ctx, username) (U, string, error)` | Required. Returns the user and its stored password hash. Any error reads as invalid credentials. | stable |
| `Auth.Register func(ctx, username, hash string) (U, error)` | Optional. Without it, `RegisterHandler` answers 404. Return `ErrUserExists` for a taken name. | stable |
| `Auth.Principal func(u U) any` | Optional. Maps the user to what the session stores. | provisional |
| `Auth.MaxAge time.Duration` | Session lifetime; default 7 days. | stable |
| `Auth.Hasher PasswordHasher` | Password hasher; default `DefaultHasher()`. | stable |
| `(*Auth[U]).LoginHandler` | Verifies credentials, starts a session, responds with the principal. 503 + `Retry-After` when the hash queue is saturated. | stable |
| `(*Auth[U]).LogoutHandler` | Clears the session cookie, 204. | stable |
| `(*Auth[U]).RegisterHandler` | Hashes, creates, starts a session, 201. 409 for a taken username. | stable |
| `Authed(next http.HandlerFunc) http.HandlerFunc` | Guards an API route: 401 JSON without a valid session. `borgogen` sees through the wrapper, so the route keeps its types. | stable |
| `Credentials` | The `{username, password}` JSON body the login and register handlers decode. | stable |
| `ErrUserExists` | Sentinel for `Auth.Register`, answered as 409. | stable |
| `PasswordHasher` | Interface: `Hash(password) (string, error)`, `Verify(password, hash) bool`. | stable |
| `DefaultHasher() PasswordHasher` | Returns the PBKDF2-SHA256 hasher used when `Auth.Hasher` is nil. | stable |

`Auth.Principal` is provisional because it returns `any` in a struct that is otherwise generic over `U` — the one place in the Go API where a type is thrown away. `DefaultHasher` was a package-level *variable* of interface type until 0.21, which meant any code in the process could reassign it and silently change hashing for every `Auth` that did not set `Hasher`; it is a function now, and to use another algorithm you set `Hasher` on the `Auth` you own.

### Server-sent events

| Symbol | What it is for | Stability |
| --- | --- | --- |
| `SSE(w, r) (*SSEStream, error)` | Prepares the response for SSE (headers, flush, deadlines cleared) and returns the stream. | stable |
| `SSEStream` | One open SSE response. | stable |
| `(*SSEStream).Send(event string, data any) error` | Writes one named event with a JSON payload. Rejects newlines in the event name. | stable |
| `(*SSEStream).Ping() error` | Writes a comment line so proxies do not close an idle stream. | stable |
| `(*SSEStream).Done() <-chan struct{}` | Closes on client disconnect or server shutdown. A stream handler must return when it fires. | stable |
| `SSEHub` | Broadcasts events to every connected client. | stable |
| `NewSSEHub() *SSEHub` | Constructor. | stable |
| `(*SSEHub).Publish(event string, data any)` | Sends to every subscriber; slow clients skip rather than block the publisher. | stable |
| `(*SSEHub).ServeHTTP(w, r)` | Streams hub events to one client. Register it as a route handler. | stable |
| `(*SSEHub).Subscribers() int` | How many clients are connected right now. | stable |
| `(*SSEHub).Close()` | Ends every stream on the hub and drops its subscribers. Idempotent. | stable |

### WebSocket push

| Symbol | What it is for | Stability |
| --- | --- | --- |
| `Push[T any](topic, event string, data T) error` | Publishes to a WebSocket topic on the front server. `borgogen` records `T` in the generated event map, typing the browser's `subscribe` callback. | stable |
| `Push(topic, event string, data any) error` | The same call without a visible type parameter. | provisional |

### Not exported, but worth knowing

`bindLimit` (1 MB), `sessionCookie` (`"borgo_session"`), `sessionCookieMaxLen` (4096), `gzipMinBytes` (1024), `sseWriteTimeout` (10 s), the PBKDF2 parameters, `hashSlots` (`max(1, GOMAXPROCS/2)`) and `hashWait` (5 s) are all unexported constants and variables. They are *behaviour* users can observe, so they are covered by [api stability](api-stability.md) as behaviour, but there is no symbol to import.

## TypeScript: `borgo-framework`

`packages/borgo/package.json` declares five importable entry points — the root, `/internal`, `/router`, `/runtime` and `/refresh-runtime` — plus `./package.json`. Only the root is intended for application code; the others exist because generated code has to import from somewhere, and their names say so.

### `borgo-framework` — values

| Export | What it is for | Stability |
| --- | --- | --- |
| `redirect(to: string, status = 303)` | Builds a redirect `Response` for a loader or action. | stable |
| `subscribe(topic, onEvent)` | Opens a WebSocket channel on a topic, with reconnect and backoff. Returns a `Channel`. | stable |
| `Island({ name, props, client })` | Renders a hydration marker for a component in `islands/`. `client` is `"load"` or `"visible"`. | stable |
| `CsrfField()` | Renders the hidden CSRF input a `<form method="post">` needs. | stable |
| `registerServiceWorker(path = "/sw.js")` | Registers a service worker in production only; no-ops in dev, on the server and where unsupported. | stable |
| `ApiError` | Thrown by the api client for a non-2xx response. Carries `status`, `body` (first 2 KB) and a route-naming message. | stable |
| `CSRF_COOKIE` (`"borgo_csrf"`) | The double-submit cookie name. | provisional |
| `CSRF_FIELD` (`"__borgo_csrf"`) | The hidden form field name. | provisional |
| `csrfCookieValue(header)` | Reads the CSRF token from a cookie header, treating conflicting duplicates as absent. | provisional |

### `borgo-framework` — types

| Export | What it is for | Stability |
| --- | --- | --- |
| `ApiRoutes` | Empty interface the generated `.borgo/api-types.d.ts` augments with one entry per Go route. The seam of the typed bridge. | stable |
| `WsEvents` | Empty interface mapping `"topic/event"` to a payload type. Filled by `borgo.Push` calls, or declared by hand for browser-published events. | stable |
| `LoaderContext` | `{ request, params, api, apiUrl }` handed to a page's `loader`. | stable |
| `ActionContext` | The same shape, handed to a page's `action`. | stable |
| `PrerenderContext` | `{ api, apiUrl }` handed to `prerenderPaths` during `borgo export`. | stable |
| `Head` | `{ title?, meta? }`. Will grow optional fields (`link`, `script`); growth is additive. | stable |
| `HydrateMode` | `boolean \| "visible"`. | stable |
| `Channel<T>` | `{ publish(...), close() }` returned by `subscribe`. | stable |
| `IslandProps` | Props of `<Island>`. | stable |
| `ApiClient` | The typed `api(...)` function's type. | stable |
| `ApiOptions<K>` | `{ query?, headers?, timeout?, body, params }` — `body` and `params` become required when the route declares them. | stable |
| `ApiResponse<K>` / `ApiRequest<K>` | Response and request types for a route key. | stable |
| `ApiRouteKey` | The union of registered route patterns, or `string` when none are. | internal |
| `PageModule` | The shape of a `pages/*.tsx` module. | provisional |
| `LayoutModule` | The shape of a `_layout.tsx` module. | provisional |
| `Route` | A manifest entry: pattern, file, module, layouts, islands flag. | internal |
| `TopicEvents<T>` / `TopicEventName<T>` / `PublishArgs<T>` | Conditional-type machinery behind `subscribe`'s and `publish`'s typing. | internal |

`PageModule` and `LayoutModule` are provisional rather than internal because they *describe* the page contract users write against — but nothing forces a page to import them, and their field set will grow as the page model does.

### `borgo-framework/router`

Imported by the generated `.borgo/routes.gen.tsx` for `type Route`. Everything it exports is also reachable from the root entry except `safeDecode`.

| Export | What it is for | Stability |
| --- | --- | --- |
| `safeDecode(s)` | `decodeURIComponent` that returns the input unchanged on a malformed escape. | internal |
| `filePathToPattern`, `matchRoute`, `resolveHead` | As above. | internal |
| `Route`, `PageModule`, `LayoutModule`, `LoaderContext`, `ActionContext`, `PrerenderContext`, `Head`, `HydrateMode` | Type re-exports. | see root entry |

**The subpath itself is internal.** It exists because generated code needs a stable specifier.

### `borgo-framework/runtime`

The browser runtime. Imported by the generated client entries (`.borgo/client.tsx`, `.borgo/islands-client.tsx`, `.borgo/client-routes.gen.ts`), never by application code.

| Export | What it is for | Stability |
| --- | --- | --- |
| `mount({ createElement, hydrateRoot, routes, notFound })` | Hydrates the page and installs client navigation, form enhancement, prefetching, scroll restoration and (in dev) the fast-refresh channel. | internal |
| `mountIslands({ createElement, hydrateRoot, islands })` | Hydrates `<Island>` markers on a page that ships no page bundle. | internal |
| `redirectUrl(raw)` | Parses a redirect target, rejecting anything that is not `http:`/`https:`. | internal |
| `asProps(value)` | Coerces an untrusted loader payload to a props object. | internal |
| `ClientPageModule`, `ClientRoute`, `MountOptions`, `MountIslandsOptions` | Types of the above. `ClientRoute` appears in generated code. | internal |

### `borgo-framework/internal`

Everything the generated client entries need and nothing an application should write by hand. The name is the contract: this subpath carries no stability promise and may change in any release.

| Export | What it is for | Stability |
| --- | --- | --- |
| `registerCsrf(token)` | Hands the client runtime the CSRF token the server rendered with. | internal |
| `registerIslands(map)` | Registers the island components a `hydrate=false` page mounts. | internal |
| `withCsrf(element, token)` | Wraps a tree in the CSRF context `CsrfField` reads. | internal |
| `csrfRuntime()`, `islandRegistry()` | The registries themselves, read by the server and the runtime across module boundaries. | internal |

### `borgo-framework/refresh-runtime`

| Export | What it is for | Stability |
| --- | --- | --- |
| `default` | Re-export of `react-refresh/runtime`, so the generated dev entry resolves it through borgo wherever the package manager put it. | internal |

### `borgo-framework/package.json`

Exported so `borgo doctor` can read the installed framework version. **internal**.

### Not exported at all

`makeApiClient` (`src/api.ts`) and everything in `build.ts`, `dev.ts`, `server.ts`'s internals, `util.ts`, `compress.ts`, `doctor.ts`, `deploy.ts`, `pwa.ts`, `export.ts`, `metrics.ts`, `overlay.ts` and `colors.ts` are private: those modules are not in `exports`, so they are unreachable from an app. This is correct and should stay that way.

## `create-borgo`

Published as a package with a single `bin`. It exposes no importable API — `src/cli.ts` is an executable, and `packages/create-borgo/package.json` declares no `exports`. **stable** as a command, no API surface.

## Environment variables

Read at runtime unless noted. Defaults in parentheses.

### Both halves

| Variable | Read by | What it does | Stability |
| --- | --- | --- | --- |
| `PORT` (`3000`) | front server; Go, to find the front server for `Push` | Front server port. | stable |
| `API_PORT` (`3501`) | Go server; front server, to build the proxy target | Go API port. | stable |
| `SESSION_SECRET` | Go | HMAC key for signed-cookie sessions. Required for sessions; warned about at startup when missing or under 32 bytes. | stable |
| `SESSION_SECURE` | Go and front server | `1` adds `Secure` to the session and CSRF cookies. | stable |
| `BORGO_PUSH_KEY` | Go and front server | Shared secret for `Push` across hosts. Once set it *replaces* the loopback check. | stable |
| `NO_COLOR` | Go and front server | Any value disables ANSI colour. | stable |

### Front server only

| Variable | What it does | Stability |
| --- | --- | --- |
| `API_URL` (`http://localhost:$API_PORT`) | Where the front server reaches the api, for split deployments. | stable |
| `BORGO_API_TIMEOUT` (`30000`) | Milliseconds to wait for api response headers before answering 504; `0` disables. | stable |
| `BORGO_MAX_BODY` (`33554432`) | Largest request body the front server accepts and buffers, in bytes. | stable |
| `BORGO_CSRF` | `0` disables CSRF checks on form actions, `1` forces them in dev. | stable |
| `BORGO_SECURITY_HEADERS` | `0` drops the security headers and the CSP. | stable |
| `BORGO_CSP` | `0` drops the CSP alone; any other value replaces the policy, with `{nonce}` substituted per request. | stable |
| `BORGO_METRICS` | `1` exposes `/metrics` in Prometheus text format. | stable |
| `BUN_CONFIG_MAX_HTTP_REQUESTS` (`256`, bun's default) | How many proxied requests may be in flight at once. Each event stream holds one for its whole life, so the default ceilings concurrent SSE subscribers at ~255. Read by bun at process start. | stable |

`BORGO_METRICS` was `METRICS` before 0.21. The old name is not honoured, and not honouring it is the point: a bare `METRICS` is the most collidable variable borgo ever read, and an alias kept for compatibility would keep the collision alive.

`BUN_CONFIG_MAX_HTTP_REQUESTS` is bun's, not borgo's, but borgo is why you would set it — see [realtime](realtime.md#honest-limits). borgo raises it to `16384` in `borgo dev` and in every deploy config it writes; anywhere else it is yours to set, and only in the environment the process starts with.

### Go server only

| Variable | What it does | Stability |
| --- | --- | --- |
| `FRONT_URL` (`http://localhost:$PORT`) | Where `Push` reaches the front server. | stable |
| `BORGO_READ_HEADER_TIMEOUT` (`5s`) | Cap on reading request headers. | stable |
| `BORGO_IDLE_TIMEOUT` (`2m`) | Idle keep-alive reclaim. | stable |
| `BORGO_READ_TIMEOUT` (`0`, off) | Whole-request read deadline. | stable |
| `BORGO_WRITE_TIMEOUT` (`0`, off) | Whole-response write deadline; `SSE` exempts its own connection. | stable |
| `BORGO_SHUTDOWN_TIMEOUT` (`10s`) | Grace period for in-flight requests; `0` waits indefinitely. | stable |
| `BORGO_HASH_SLOTS` (`max(1, GOMAXPROCS/2)`) | Password hashes that may run at once. A value that is not a positive integer is refused at startup. | stable |

All six are Go duration strings. A malformed value panics at boot, before the startup banner.

### Build, dev loop and internal

| Variable | What it does | Stability |
| --- | --- | --- |
| `BORGO_TAILWIND` | Set to `1` by `--tailwind` for child processes. Use the flag, not the variable. | internal |
| `BORGO_PARENT_PID` | How the CLI tells a child process whose death to exit with. | internal |
| `BORGO_RELOAD` | Marks a restart so the banner prints the short form. | internal |
| `BORGO_CHANGED` | Carries the changed file into the dev fallback server. | internal |
| `BORGO_DEV` | Set by the dev loop for `serve-entry.ts`. | internal |
| `BORGO_FORCE_PROMPT` | Test hook: forces `create-borgo`'s interactive path. | internal |
| `NODE_ENV` | Not read at runtime — it is a build-time `define` substituted into client bundles. | internal |

`DB_PATH`, which appears in the deploy samples and the example app, is the *application's* variable, not borgo's.

## CLI

### `borgo`

Run from an app root — the directory holding `pages/`.

| Command | What it does | Stability |
| --- | --- | --- |
| `borgo dev` | Starts both servers, watches, fast-refreshes. | stable |
| `borgo build` | Runs `borgogen`, builds client assets into `public/assets/`, compiles the Go binary into `dist/`. | stable |
| `borgo start` | Runs from build output, supervising both processes. Rebuilds automatically if `public/assets` holds a dev build. | stable |
| `borgo export` | Static site into `dist/site/`. | stable |
| `borgo deploy init <caddy\|nginx\|systemd\|compose>` | Writes a deploy config. | stable |
| `borgo pwa init` | Writes `public/manifest.webmanifest` and a service worker. | stable |
| `borgo doctor` | Diagnoses the environment: Bun and Go versions, ports, api binary, generated types, dependencies. | stable |
| `borgo` / `borgo --help` / `-h` / `--version` / `-v` | Banner and usage; exits 0. An unknown command exits 1. | stable |

| Flag | Applies to | What it does | Stability |
| --- | --- | --- | --- |
| `--tailwind` | any command (parsed globally) | Hands the CSS pipeline to Tailwind (the `@tailwindcss/postcss` plugin); sets `BORGO_TAILWIND=1` for children. | stable |
| `--front-only` | `start` | Skips the Go binary, for split deployments. | stable |
| `--force` | `pwa init`, `deploy init` | Overwrites existing files. | stable |

The exit codes are part of the contract: `build` exits 1 if `borgogen` or `go build` fails, `start` exits with the api's own code if the api dies, `doctor` and `export` exit with their own status.

### `create-borgo`

| Form | What it does | Stability |
| --- | --- | --- |
| `bunx create-borgo@latest <name>` | Scaffolds a new app. Prompts for template and Tailwind in an interactive terminal. | stable |
| `--template <base\|minimal\|full>`, `-t`, `--template=<x>` | Picks a template; default `base`. | stable |
| `--tailwind` / `--no-tailwind` | Wires Tailwind, or declines without prompting. | stable |
| `--help` / `-h` | Usage. | stable |

An unknown argument is an error, not a silently ignored token.

### `borgogen`

Invoked as `go tool borgogen`, wired through the app's `go.mod` `tool` directive. It takes no flags and reads the working directory. **stable** as a command; its *output* is a contract covered in [api stability](api-stability.md).

## File conventions

These are as much a public API as any function: an app depends on them, and changing one breaks builds.

### Directory layout

| Path | Meaning | Stability |
| --- | --- | --- |
| `pages/**/*.tsx` | Routes. `index.tsx` → `/`, `[id].tsx` → `:id`. Static segments beat dynamic ones. | stable |
| `pages/**/_layout.tsx` | Layout for its directory and below; nests outermost-first. Must default-export a component taking `{ children }`. | stable |
| `pages/_404.tsx`, `pages/_500.tsx` | Not-found and error pages. | stable |
| `pages/**/_*.tsx` | Any file whose basename starts with `_` is special and is not routed. | stable |
| `islands/*.tsx` | Island components, default-exported, referenced by `<Island name="Counter" />`. | stable |
| `api/*.go` | The Go API package. `api/borgo.gen.go` is generated; `*_test.go` is ignored by `borgogen`. | stable |
| `public/` | Served as-is. `public/assets/` is build output. | stable |
| `index.html` | The SSR shell. | stable |
| `style.scss` | Compiled to `public/assets/style.css` when present. | stable |
| `style.css` | Tailwind entry, used only with `--tailwind`. | stable |
| `.borgo/` | Generated: `api-types.d.ts`, `routes.gen.tsx`, `client-routes.gen.ts`, `client.tsx`, `islands-client.tsx`, `refresh.ts`. | internal |
| `dist/` | `borgo build` output (the Go binary) and `borgo export` output (`dist/site/`). | stable |

### Page module exports

| Export | Meaning | Stability |
| --- | --- | --- |
| `default` | The React component. Required — a page without one fails the build with a named error. | stable |
| `loader(ctx)` | Runs on the server; returns props or a `Response`. Stripped from client bundles. | stable |
| `action(ctx)` | Runs on a POST; returns props, `actionData` or a `Response`. Stripped from client bundles. | stable |
| `head` | `Head` object or `(props) => Head`. | stable |
| `hydrate` | `true`, `false` or `"visible"`. **Must be a literal** — it is read from the source text without executing the module. | stable |
| `prerender` | `true` opts a loader page into static export. | stable |
| `prerenderPaths(ctx)` | Lists param sets for a dynamic route during export. | stable |

### Go directives

| Directive | Meaning | Stability |
| --- | --- | --- |
| `//borgo:route METHOD /path` | Mounts the following package-level handler. Must be the function's doc comment, no space after `//`, and the handler must be `func(http.ResponseWriter, *http.Request)` with no type parameters. | stable |
| `//borgo:type <GoType> <TSType>` | Overrides the TypeScript type generated for a named Go type. | stable |

A comment that *looks* like a route directive but is not attached to a handler produces a warning rather than silence — as does a directive in a file the build excludes.

### Markers, params and headers the runtime owns

| Name | Where | Meaning | Stability |
| --- | --- | --- | --- |
| `data-borgo-island`, `data-borgo-props`, `data-borgo-client` | DOM | Island hydration markers. | internal |
| `data-borgo-visible` | DOM | Hydration trigger element for `hydrate = "visible"`. | provisional |
| `data-borgo-head` | DOM | Meta tags the client runtime owns and replaces. | internal |
| `data-borgo-native` | `<form>` | Opts a form out of enhanced submission. | stable |
| `?__borgo=props` | URL | Asks a page for its loader props as JSON. | internal |
| `X-Borgo-Action`, `X-Borgo` | HTTP | Action request marker, and the response discriminator (`action` / `raw`). | internal |
| `X-Borgo-Key` | HTTP | `BORGO_PUSH_KEY` on a cross-host push. | internal |
| `borgo_session`, `borgo_csrf` | Cookies | The two cookies borgo owns. | stable |
| `/healthz`, `/metrics`, `/ws`, `/api/*`, `/assets/*`, `/__borgo/*` | URL | Reserved paths. An app route must not claim them (except `/healthz`, which an app may override on the Go side). | stable |

## Findings

The rest of this page is the audit, not the reference: what the surface got wrong, what it costs to fix, and what was decided. Entries marked **landed in 0.21** are done and the reference above already reflects them; the others are still recommendations awaiting a decision before 1.0.

### Duplicated APIs

**1. `JSON[T]` and `WriteJSON` — two ways to write a JSON response.**
`JSON` is a one-line delegation to `WriteJSON`. `borgogen` reads the response type from both. `WriteJSON` is also the framework's own writer (used by `BindError`, `Authed`, every `Auth` handler), so it cannot simply vanish.
*Disposition:* **deprecate `WriteJSON` as public, keep it internal.** `JSON(w, status, v)` with `v` of interface type infers exactly what `WriteJSON` did, so the public replacement is a mechanical rename. Documentation should stop mentioning `WriteJSON` first.
*Migration cost:* low. A `sed` in application code; `borgogen` keeps recognising both through the deprecation window. Affects every app that followed an older tutorial, which is most of them — so this needs a full minor's warning.

**2. `Push` and `PushT` — same call, one with a visible type parameter. — landed in 0.21**
`PushT[T]` was `Push` with `T` exposed to static analysis, delegating straight to it: the same split as `JSON`/`WriteJSON`, with the opposite naming convention (see naming, below).
*Disposition taken:* **`Push` became generic and `PushT` was removed** — no deprecation window, since the alias existed only to carry the type parameter that `Push` now has. `Push[T any](topic, event string, data T) error` compiles unchanged at almost every existing call site, because Go infers `T` from the argument; a site passing an `any`-typed value still types as `T = any`.
*Migration:* rename `PushT` to `Push`. The one shape Go cannot infer is an untyped `nil` — write `Push[any](topic, event, nil)`. Calls that used to type as `any` may now type precisely, which *adds* information to the browser: an improvement, and a visible diff in generated files.

**3. `Cache` and `NoCache` — not actually duplicates. Keep both.**
It is tempting to collapse them into `Cache(w, 0)`, and it would be wrong: `Cache(w, 0)` emits `public, max-age=0`, which is cacheable-with-revalidation, while `NoCache` emits `no-store`, which forbids storage entirely. On a personalized page the difference is a data leak.
*Disposition:* **keep both, document the difference explicitly.** The asymmetry worth fixing is `Cache`'s variadic tail, not its existence.
*Migration cost:* zero (documentation only). Replacing the variadic with an options struct would be a breaking change; defer to 2.0 or add `CacheStale(w, maxAge, swr)` additively.

**4. `cookieValue` and `csrfCookieValue` — plus a third parser in `util.ts`. — landed in 0.21**
`cookieValue(header, name)` is a generic cookie reader exported from the package root and **referenced by nothing** — not by application code, not by the framework, not by tests. `csrfCookieValue(header)` is the one that is actually used, and it is deliberately different: conflicting duplicate cookies read as absent, matching the Go side's treatment of ambiguous session cookies. `hasCookie(header, name)` in `util.ts` parses the same string a third way (internal, not exported).
*Disposition taken:* **`cookieValue` was removed; `csrfCookieValue` is documented and promoted to stable.** `cookieValue`'s duplicate-tolerant behaviour is a footgun next to its neighbour. `csrfCookieValue` should be promoted from provisional to stable and documented, because an app doing hand-rolled `fetch` POSTs genuinely needs the token and `<CsrfField />` only covers `<form>`s.
*Migration cost:* effectively zero for removal — the symbol is undocumented and unused. Promoting `csrfCookieValue` is documentation.

**5. `Bind` and `BindMax` — justified duplication, keep.**
`Bind` is `BindMax` with the safe constant baked in. Keeping the default at the shorter name is the whole point.
*Disposition:* **keep.** *Cost:* zero.

**6. `isConnRefused` implemented twice.**
`packages/borgo/src/api.ts:6` defines a private copy; `packages/borgo/src/util.ts:770` exports another. Same predicate, two chances to drift.
*Disposition:* **have `api.ts` import the one from `util.ts`.** Both are internal, so this is a pure refactor.
*Migration cost:* zero (no public surface involved).

**7. `filePathToPattern`, `matchRoute`, `resolveHead` are public on two paths. — landed in 0.21**
Re-exported from the root entry *and* reachable via `borgo-framework/router`. No application imports them from either.
*Disposition taken:* **dropped from the root entry**, and still exported from `/router`, where the generated routes file already reaches them. No deprecation note: the symbols were undocumented and no known caller existed.

**8. `SSEHub.Publish`, `Push`, and `Channel.publish` — three names for "send an event".**
Not redundant (SSE hub, Go→front WebSocket relay, browser→relay respectively) but confusing enough that users conflate them.
*Disposition:* **keep the names; fix the docs.** [realtime](realtime.md) should open with a three-line table saying which is which. *Cost:* documentation.

### Exports nobody outside the framework needs

The Go surface is clean: every exported Go symbol has an application-facing reason to exist. The TypeScript surface is not.

| Export | Entry point | Why it is exported | Disposition | Migration cost |
| --- | --- | --- | --- | --- |
| `cookieValue` | root | Nothing. Dead. | **removed in 0.21** | zero — unused, undocumented |
| `registerCsrf` | root | The generated client entry emitted `import { registerCsrf, registerIslands } from "borgo-framework"` | **moved to `borgo-framework/internal` in 0.21** | low — the generated string in `build.ts` changed; `.borgo/` is regenerated on every build |
| `registerIslands` | root | Same | **moved in 0.21** | same |
| `withCsrf` | root | Used by `runtime.ts` and `util.ts` across module boundaries | **moved in 0.21** | zero — cross-module only |
| `CSRF_COOKIE` | root | Internal constant | **hide** | zero |
| `CSRF_FIELD` | root | Internal constant, but arguably useful to an app building a form by hand | **keep, document** | zero |
| `filePathToPattern`, `matchRoute`, `resolveHead` | root + `/router` | Shared between build, server and runtime | **dropped from root in 0.21** | low |
| `safeDecode` | `/router` | Shared between router and server | **leave; mark the subpath internal** | zero |
| `mount`, `mountIslands`, `redirectUrl`, `asProps` | `/runtime` | Generated entries and unit tests | **leave; mark the subpath internal** | zero |
| `ApiRouteKey`, `TopicEvents`, `TopicEventName`, `PublishArgs` | root | Inference machinery for `api()` and `subscribe()` | **leave; mark internal in docs** | zero — removing them would break the public types that reference them |
| `Route` | root + `/router` | Manifest shape | **mark internal** | zero |
| `serve` | `/server` | Nothing imported the subpath | **subpath dropped in 0.21** | it was a breaking change to `exports`, taken before 1.0 rather than never |
| `default` | `/refresh-runtime` | Generated dev entry | **leave; mark internal** | zero |

The pattern is clear enough to state as a rule: **the root entry point should contain only what an application writes by hand.** Everything the generated code needs belongs on a subpath whose name says "not for you".

### Naming inconsistencies

**1. The typed-variant convention contradicted itself. — half landed in 0.21**
On the response side the *plain* name is the typed one (`JSON[T]`) and the untyped one is prefixed (`WriteJSON`). On the push side it used to be the reverse: `PushT` was the typed one and plain `Push` the untyped one, so a user who learned one learned the wrong lesson about the other.
*Rule chosen:* **the plain name is the typed one.** The push half landed with finding 2 — `Push` is now the generic one and there is no second name. The response half is finding 1 and still open.
*Cost:* the remaining half is finding 1's cost.

**2. `Push` (Go, WebSocket) vs `Publish` (Go, SSE hub) vs `publish` (TS, channel).**
Three verbs, and the two Go ones differ by transport rather than by intent.
*Disposition:* **keep.** Renaming `SSEHub.Publish` to `Push` would collide conceptually with `borgo.Push`, which is worse. Document instead.
*Cost:* documentation.

**3. Only one of the two cookies borgo owns has an exported name.**
`borgo_csrf` is `CSRF_COOKIE` in TypeScript; `borgo_session` is the unexported `sessionCookie` in Go and a string literal in `util.ts`. Two halves of one convention, exported asymmetrically.
*Disposition:* **export neither, or both.** Preference: neither — hide `CSRF_COOKIE` (see above) and keep the cookie names a documented wire contract rather than an importable symbol.
*Cost:* zero.

**4. Environment variable prefixes are inconsistent.**
Most variables are `BORGO_*`; the exceptions are `PORT`, `API_PORT`, `API_URL`, `FRONT_URL`, `SESSION_SECRET`, `SESSION_SECURE` and `NO_COLOR`, plus bun's own `BUN_CONFIG_MAX_HTTP_REQUESTS`. Those are defensible — `PORT` and `NO_COLOR` are ecosystem conventions, `SESSION_*` is self-describing, and the bun one is not borgo's to rename. The two that were not defensible, `METRICS` and `DEV`, were prefixed in 0.21.
*Disposition:* **rename `METRICS` → `BORGO_METRICS`, accepting `METRICS` as an alias through all of 1.x. Rename `DEV` → `BORGO_DEV`** (internal, so no alias needed).
*Done in 0.21, without an alias.* `BORGO_DEV` is set only by borgo's own dev loop, so nothing outside the framework was reading it. `BORGO_METRICS` does not fall back to `METRICS`: honouring the old name would preserve the exact collision the prefix exists to end, and an app that wants metrics on an upgrade sets one variable.

**5. "Route" means three different things.**
TypeScript `Route` is a *page*; Go's internal `route` and `ApiRouteKey` are *api endpoints*; `filePathToPattern` produces a page pattern while `Handle` takes an api pattern. The docs use "route" for both and rely on context.
*Disposition:* **rename the TypeScript type to `PageRoute`** if it stays public at all; otherwise mark it internal (see above) and fix the prose. Prefer the latter.
*Cost:* zero if the type goes internal.

**6. Six casings of the brand token, all load-bearing.**
`//borgo:route`, `data-borgo-island`, `__borgo=props`, `X-Borgo-Action`, `borgo_session`, `BORGO_TAILWIND`. Each is idiomatic for its medium — Go directives, HTML attributes, query params, HTTP headers, cookies, env — so the inconsistency is real but correct.
*Disposition:* **freeze as-is at 1.0 and document the set.** These are wire contracts; renaming any of them breaks stored cookies, running proxies and existing HTML.
*Cost:* documentation only. Doing it later costs a major version.

### Gaps worth filling before 1.0

Not duplication or naming, but things the audit surfaced that a 1.0 API should probably have:

- **No way to read borgo's version from Go.** The npm package exposes its version internally (`colors.ts`); the Go module exposes nothing. A `borgo.Version` constant would cost one line and make bug reports better.
- **`SSEHub` has no subscriber count and no `Close`.** The WebSocket relay has a built-in `__count` event; the SSE hub has no equivalent, and no way to end all streams other than process shutdown.
- **The hash-slot semaphore is not configurable.** `max(1, GOMAXPROCS/2)` is computed once at package init with no env override, so a box tuned for login throughput cannot be tuned. Adding `BORGO_HASH_SLOTS` is additive and cheap.
- **`Serve()` cannot be composed or tested.** See the note above; `ServeContext(ctx) error` would be additive.

## What this page is not

It is not permission to depend on everything listed. Anything marked internal will move without a deprecation cycle. If you find yourself needing an internal export to do something ordinary, that is a bug worth reporting — the fix is usually a new stable API, not a promise about the old one.
