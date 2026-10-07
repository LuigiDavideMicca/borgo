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

What is catalogued below: the Go exports (struct fields and interface methods included), the TypeScript exports across five entry points, the environment variables, the `borgo` subcommands plus `create-borgo` and `borgogen`, and the file conventions. Deliberately without totals — no test counts any of them, so a number here would go stale between two commits while the tables underneath stayed right. The [findings](#findings) at the end say what to do about each entry still marked provisional or internal.

## Go: `github.com/LuigiDavideMicca/borgo`

The module is the repository root. It has zero runtime dependencies; `golang.org/x/tools` is required only by `cmd/borgogen`.

### Routing and server

| Symbol | What it is for | Stability |
| --- | --- | --- |
| `Handle(pattern string, h http.HandlerFunc)` | Registers a handler under a `"METHOD /path"` pattern. Panics on a malformed pattern, a nil handler, a duplicate, or a call after `Serve`. | stable |
| `Serve()` | Mounts every registered route, adds `GET /healthz` unless an app route claims it, listens on `API_PORT`, handles signals and graceful shutdown. Blocks, and calls `log.Fatal` if the listener fails. | stable |
| `ServeContext(ctx) error` | The same server, ended by cancelling `ctx` and returning the error instead of exiting. For embedding in a larger program, and for tests. | stable |
| `Middleware(h http.Handler) http.Handler` | The chain `Serve` installs around its own routes — panic recovery, gzip, and the guard that makes a response carrying `Set-Cookie` say `Cache-Control: private` as its headers commit. For an app mounting borgo handlers on a mux of its own; `Serve` is defined in terms of it. | stable |
| `CheckEnv() error` | The startup validation `Serve` and `ServeContext` run: `BORGO_HASH_SLOTS`, `SESSION_SECURE`, the push variables, and `SESSION_SECRET` length. For an embedder that never calls either and still wants a typo to fail at boot rather than on the first request. | stable |
| `Version` | The released version this binary was built from, kept honest by a test that reads the release manifest. | stable |

`Serve` was provisional in 0.20 only in its *shape*: returning nothing and calling `log.Fatal` made it impossible to embed or to exercise from a test. 0.21 added `ServeContext` beside it rather than changing it, so both are stable and `Serve` stays the one you want when the process exists to be the server.

### Responses

| Symbol | What it is for | Stability |
| --- | --- | --- |
| `JSON[T any](w, status int, v T)` | Writes `v` as a JSON response. The type parameter is what `borgogen` reads to type the route's response for TypeScript. | stable |
| `WriteJSON(w, status int, v any)` | Same behaviour, untyped parameter. Also the framework's own internal JSON writer. | provisional |
| `Bind[T any](r) (T, error)` | Decodes the request body as JSON into `T`, capped at 1 MB. Requires `Content-Type: application/json` — a missing header is rejected like a wrong one. Types the route's request body for TypeScript. | stable |
| `BindMax[T any](r, limit int64) (T, error)` | `Bind` with an explicit byte cap; `limit <= 0` disables it. | stable |
| `BindError(w, err error)` | Answers a `Bind` error with the right status: 413 oversized, 415 missing or non-JSON content type, 400 otherwise. The same for `BindMultipart`, where 413 also covers the parser's limits (1000 parts, about 18 MiB of text), 415 is a content type that is neither `multipart/form-data` nor JSON, and 500 is a form type no part can fill. | stable |
| `BindMultipart[T any](r) (T, error)` | Decodes a `multipart/form-data` body into a struct, capped at 32 MiB: text parts into string, bool, integer, float and `[]string` fields by their json name, files into `File`, `*File` or `[]File`. A JSON body is read too, with every `File` zero: the client sends one when the form holds no file. Types the route's request body with the files as `Blob`. A field type no part can fill is a 500 on every request, named in the log. | provisional |
| `BindMultipartMax[T any](r, limit int64) (T, error)` | `BindMultipart` with an explicit byte cap; `limit <= 0` disables it. | provisional |
| `Uploads{Dir, Types}` | Stores uploaded files in `Dir` (created 0700) and serves them back. `Types` lists the sniffed media types accepted; empty accepts any. | provisional |
| `(*Uploads).Save(f File) (Stored, error)` | Sniffs the bytes, stores the file under a random key, returns what it learned. `ErrNoUpload` for an empty field, `ErrUploadType` for a type `Types` does not list; a failed write leaves nothing. | provisional |
| `(*Uploads).Serve(w, r, s Stored)` | Answers with the file after the caller's authorization: sniffed type, `nosniff`, `Cache-Control: private, no-cache`, a sandboxing CSP, inline only for PNG, JPEG, GIF and WebP. Ranges and conditionals work, never compressed; an unknown key, or one naming a link, is a 404. | provisional |
| `(*Uploads).Remove(key string) error` | Deletes a stored file; a missing one is not an error, a key `Save` could not have made is. | provisional |
| `Stored{Key, Name, Type, Size}` | What `Save` returns and `Serve` takes: keep it beside the file's owner. `Name` is the client's, cleaned for display; `Type` is sniffed. | provisional |
| `ReadEnv(vars []EnvVar) (map[string]any, error)` | Reads the app's server variables with `env.ts`'s rules and messages, for the generated `env/env.gen.go`; not written by hand. See [the Go half](environment.md#the-go-half-reads-the-same-contract). | provisional |
| `EnvVar{Name, Type, Optional, Default, Validated}` | One server variable of `env.ts`, as the generated package declares it. | provisional |
| `ErrNoUpload`, `ErrUploadType` | The two refusals of `Save` a handler answers itself, usually 400 and 415. | provisional |
| `File` | One uploaded file: `Name` and `ContentType` as the client sent them (claims, not evidence), `Size`, and `Open()` for the bytes, valid until the handler returns. | provisional |
| `Cache(w, maxAge time.Duration, staleWhileRevalidate ...time.Duration)` | Marks the response publicly cacheable; downgrades to `private` if the response already carries `Set-Cookie`. | provisional |
| `NoCache(w)` | Marks the response `no-store`. | stable |

`Cache` is provisional because of the variadic third parameter, which is Go's idiom for "I did not want to define an options type" and cannot grow a second option without another one.

### Sessions

| Symbol | What it is for | Stability |
| --- | --- | --- |
| `SetSession(w, v any, maxAge time.Duration) error` | Stores `v` JSON-encoded and HMAC-signed in the `borgo_session` cookie. The expiry is signed too. Errors if the cookie would exceed 4 KB. | stable |
| `GetSession[T any](r) (T, bool)` | Verifies signature and expiry and decodes into `T`. False for missing, tampered, expired — or ambiguous (two valid cookies). | stable |
| `ClearSession(w)` | Deletes the session cookie. | stable |
| `CheckSession(check func(r *http.Request, s SessionInfo) bool)` | Registers the one check Go runs on every session whose signature and expiry verified, before anything reads it: `GetSession`, `Authed`, and the session handed to the render service. `false`, or a panic (logged), makes the request one without a session; the cookie is not rewritten. Runs at most once per request under `Serve`. Panics on `nil`, on a second registration, and after `Serve`. See [revoking sessions](auth-and-sessions.md#revoking-sessions). | stable |
| `SessionInfo` | What the check sees: `IssuedAt time.Time`, to the millisecond (the Unix epoch for a session written before 0.30), and `Data json.RawMessage`, the stored JSON — decode it, do not modify it. | stable |
| `ErrNoSessionSecret` | Returned by `SetSession` when there is no usable `SESSION_SECRET` — unset, **or set to fewer than 32 bytes**, which `sessionSecret()` reports as absent deliberately so that every guard covering the missing case covers the weak key too. In practice only the unset case reaches a running handler: `Serve` refuses to boot on a short secret. | stable |

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
| `(*Auth[U]).RegisterHandler` | Hashes, creates, starts a session, 201. 409 for a taken username. `Signup` over `Credentials` alone. | stable |
| `Signup[U, S SignupForm](a *Auth[U], register func(ctx, form S, hash string) (U, error)) http.HandlerFunc` | The register handler for a body of the app's shape: any struct embedding `Credentials`, decoded with `Bind` and handed to `register` beside the password's hash. Same answers as `RegisterHandler`; the typed bridge reads `S` as the route's request type. | provisional |
| `SignupForm` | What `Signup` accepts: a struct embedding `Credentials` by value. The interface's method is unexported, so embedding is the way to satisfy it; the compiler also admits a pointer, an interface or an embedded `*Credentials`, and `Signup` refuses those by name where it is built, since a body of `null` would leave the promoted method a nil to call. | provisional |
| `Authed(next http.HandlerFunc) http.HandlerFunc` | Guards an API route: 401 JSON without a valid session. `borgogen` sees through the wrapper, so the route keeps its types. | stable |
| `Credentials` | The `{username, password}` JSON body the login and register handlers decode. | stable |
| `ErrUserExists` | Sentinel for `Auth.Register`, answered as 409. | stable |
| `PasswordHasher` | Interface: `Hash(password) (string, error)`, `Verify(password, hash) bool`. | stable |
| `DefaultHasher() PasswordHasher` | Returns the PBKDF2-SHA256 hasher used when `Auth.Hasher` is nil. | stable |

`Auth.Principal` is provisional because it returns `any` in a struct that is otherwise generic over `U` — the one place in the Go API where a type is thrown away. `DefaultHasher` was a package-level *variable* of interface type until 0.21, which meant any code in the process could reassign it and silently change hashing for every `Auth` that did not set `Hasher`; it is a function now, and to use another algorithm you set `Hasher` on the `Auth` you own.

### Middleware and request values

| Symbol | What it is for | Stability |
| --- | --- | --- |
| `With(r, key string, value any) *http.Request` | Returns `r` carrying `value` under `key` for the handlers behind the middleware that set it. Stays in the Go process. A derived request leaves its parent's values alone. See [middleware and authorization](middleware-and-authorization.md#handing-a-decision-on-with-value-forward). | stable |
| `Forward(r, key string, value any) *http.Request` | `With`, and the value also reaches the render service: `middleware.ts`, loaders and actions read it in `locals`. Must encode as JSON, and everything forwarded must fit in 16 KiB encoded; either failure answers `500` rather than rendering without it. | stable |
| `Value[T any](r, key string) (T, bool)` | Reads what `With` or `Forward` set. False when nothing was set or the value is not a `T`. | stable |
| `UseMiddleware(mw func(http.Handler) http.Handler, matcher []string)` | Registers `api/middleware.go`'s `Middleware` and `Matcher`. borgogen generates the call. Panics on `nil`, on a second registration, after `Serve`, and on a matcher entry that could never match. | internal |
| `Export(name string, h ExportHandler)` | Registers a `//borgo:export` adapter. borgogen generates the call. | internal |
| `ExportHandler` | `func(ctx, args []json.RawMessage) (any, error)`: the adapter borgogen generates for one export. | internal |
| `ExportArity(name, want, got)`, `ExportArgument(name, index, err)` | The errors a generated adapter returns for a call that does not fit the function; answered `400`. | internal |

### Server-sent events

| Symbol | What it is for | Stability |
| --- | --- | --- |
| `SSE(w, r) (*SSEStream, error)` | Prepares the response for SSE (headers, flush, deadlines cleared) and returns the stream. | stable |
| `SSEStream` | One open SSE response. | stable |
| `(*SSEStream).Send(event string, data any) error` | Writes one named event with a JSON payload. Rejects newlines in the event name. | stable |
| `(*SSEStream).Ping() error` | Writes a comment line so proxies do not close an idle stream. | stable |
| `(*SSEStream).Done() <-chan struct{}` | Closes on client disconnect, server shutdown, or `Close`. A stream handler must return when it fires. | stable |
| `(*SSEStream).Close()` | Ends the stream from the handler's side: fires `Done` and refuses every later `Send` and `Ping` with `ErrStreamClosed`. Idempotent, safe from any goroutine. For a handler that detached the request context and so has a stream no disconnect or shutdown will ever end. Writes nothing to the client. | stable |
| `ErrStreamClosed` | What `Send` and `Ping` return after `Close`. A stream ended by disconnect or shutdown reports the connection's own error instead — watch `Done` for those. | stable |
| `SSEHub` | Broadcasts events to every connected client. | stable |
| `NewSSEHub() *SSEHub` | Constructor. | stable |
| `(*SSEHub).Publish(event string, data any)` | Sends to every subscriber; slow clients skip rather than block the publisher. | stable |
| `(*SSEHub).ServeHTTP(w, r)` | Streams hub events to one client. Register it as a route handler. | stable |
| `(*SSEHub).Subscribers() int` | How many clients are connected right now. | stable |
| `(*SSEHub).Close()` | Ends every stream on the hub and drops its subscribers. Idempotent. | stable |

### WebSocket topics

| Symbol | What it is for | Stability |
| --- | --- | --- |
| `Push[T any](topic, event string, data T) error` | Publishes to a WebSocket topic, in this process: since 0.30 the relay lives beside the handlers and a push is a call. An error names a topic no handshake could hold or a payload over the message limit; a topic nobody holds right now is delivered to nobody and is not an error. `borgogen` records `T` in the generated event map, typing the browser's `subscribe` callback. | stable |
| `TopicCheck` | `func(r *http.Request, topic string) bool`: one topic on one request, the session readable with `GetSession`. | provisional |
| `CanSubscribe(check TopicCheck)` | The check every topic a socket asks for must pass, once per topic at the handshake. A refused topic closes the socket with `4403` naming it. Registered once, before `Serve`. Without one, `borgo dev` admits everything and `borgo start` refuses everything, each saying so at startup. A check that panics refuses. | provisional |
| `CanPublish(check TopicCheck)` | The check a browser's publish must pass, per message; without one, publishing follows `CanSubscribe`. A refused message is dropped, the socket stays open. | provisional |
| `Realtime() http.Handler` | The relay as a handler, for an app that mounts borgo on a server of its own: mount it at `/ws`. One per process, configured from the environment; an environment it cannot read answers `500` with the reason. | provisional |

`push.go` declares exactly one exported function for publishing. `PushT` was folded into it in 0.21 — see [finding 2](#duplicated-apis).

### Cache invalidation

| Symbol | What it is for | Stability |
| --- | --- | --- |
| `Revalidate(path string) error` | Drops the cached copy of one page (query variants included; a trailing `*` drops a prefix). Under `borgo start` a call into the cache in the same process; in `borgo dev`, where nothing is cached, it changes nothing. An empty or blank path, or one not starting with `/`, is an error. | provisional |
| `RevalidateTag(tag string) error` | Drops every cached page whose `tags` export named the tag, compared without surrounding spaces. An empty or blank tag is an error. | provisional |

Both refuse an empty name. Under `borgo start` the cache is in the process the call runs in, and the call drops the copies there directly; under `borgo dev`, where nothing is cached, it changes nothing. See [cached pages](pages-and-routing.md#cached-pages).

### Not exported, but worth knowing

`bindLimit` (1 MB), `sessionCookie` (`"borgo_session"`), `sessionCookieMaxLen` (4096), `gzipMinBytes` (1024), `sseWriteTimeout` (10 s), the PBKDF2 parameters, `hashSlots` (`max(1, GOMAXPROCS/2)` unless `BORGO_HASH_SLOTS` overrides it) and `hashWait` (5 s) are all unexported constants and variables. They are *behaviour* users can observe, so they are covered by [api stability](api-stability.md) as behaviour, but there is no symbol to import.

## TypeScript: `borgo-framework`

`packages/borgo/package.json` declares five importable entry points — the root, `/internal`, `/router`, `/runtime` and `/refresh-runtime` — plus `./package.json`. Only the root is intended for application code; the others exist because generated code has to import from somewhere, and their names say so.

### `borgo-framework` — values

| Export | What it is for | Stability |
| --- | --- | --- |
| `redirect(to: string, status = 303)` | Builds a redirect `Response` for a loader, an action or `middleware.ts`. | stable |
| `next(init?)` | What `middleware.ts` returns to let the page through; `init.headers` are added to its response. | stable |
| `rewrite(path, init?)` | What `middleware.ts` returns to render another page of this app for the request, once, without changing the URL. Refused for the page itself, `/api`, `/__borgo`, or a path with a query. | stable |
| `subscribe(topic, onEvent, options?)` | Opens a WebSocket channel on a topic, with reconnect and backoff. Returns a `Channel`. `options.onRefused(reason)` fires once when the relay refuses the socket — its origin, or a topic `CanSubscribe` said no to: the one close that will not change on a redial — and the channel is over. | stable |
| `Island({ name, props, client })` | Renders a hydration marker for a component in `islands/`. `client` is `"load"` or `"visible"`. | stable |
| `CsrfField()` | Renders the hidden CSRF input a `<form method="post">` needs. | stable |
| `registerServiceWorker(path = "/sw.js")` | Registers a service worker in production only; no-ops in dev, on the server and where unsupported. | stable |
| `ApiError` | Thrown by the api client for a non-2xx response. Carries `status`, `body` (first 2 KB) and a route-naming message. | stable |
| `GoError` | Thrown by a `//borgo:export` call: `exportName`, the Go error's text as `message`, and `status` — 200 for an error the function returned, 400 for a call that did not fit it, 500 for a contained panic. | stable |
| `apiFetch(input, init?)` | `fetch` for browser calls to `/api/*`, attaching the `X-CSRF-Token` header on unsafe methods. Identical to `fetch` otherwise. Loaders and actions do not need it — their `api` client calls the api's internal listener, where the header check does not run. | stable |
| `CSRF_COOKIE` (`"borgo_csrf"`) | The double-submit cookie name. | provisional |
| `CSRF_FIELD` (`"__borgo_csrf"`) | The hidden form field name, for a page form action. | provisional |
| `CSRF_HEADER` (`"X-CSRF-Token"`) | The header name, for an unsafe `/api/*` request. | provisional |
| `csrfCookieValue(header)` | Reads the CSRF token from a cookie header, treating conflicting duplicates as absent. Promoted from provisional in 0.21 — see [finding 4](#duplicated-apis). | stable |
| `defineEnv(schema, runtimeEnv?)` | Declares the app's [typed environment](environment.md) in `env.ts`: validated before the server binds, typed at the call site, client values allowlisted into the bundle by the `BORGO_PUBLIC_` prefix. | provisional |

### `borgo-framework` — types

| Export | What it is for | Stability |
| --- | --- | --- |
| `ApiRoutes` | Empty interface the generated `.borgo/api-types.d.ts` augments with one entry per Go route. The seam of the typed bridge. | stable |
| `WsEvents` | Empty interface mapping `"topic/event"` to a payload type. Filled by `borgo.Push` calls, or declared by hand for browser-published events. | stable |
| `LoaderContext` | `{ request, params, api, apiUrl, session, locals }` handed to a page's `loader`. | stable |
| `Session` | The session Go verified, as loaders, actions and `middleware.ts` receive it. An app types it by augmenting the interface: `declare module "borgo-framework" { interface Session { userId: number } }`. | stable |
| `Locals` | What `api/middleware.go` forwarded with `borgo.Forward`, typed the same way. | stable |
| `PageMiddleware` | The type of `middleware.ts`'s `middleware`: `(request, { url, params, session, locals }) => next() \| rewrite() \| Response`, or a promise of one. | stable |
| `PageMiddlewareContext` | The second argument of a `PageMiddleware`. | stable |
| `MiddlewareResult` | What `next()` and `rewrite()` return. | stable |
| `ActionContext` | The same shape, handed to a page's `action`. | stable |
| `PrerenderContext` | `{ api, apiUrl }` handed to `prerenderPaths` during `borgo export`. | stable |
| `Head` | `{ title?, meta? }`. Will grow optional fields (`link`, `script`); growth is additive. | stable |
| `HydrateMode` | `boolean \| "visible"`. | stable |
| `Channel<T>` | `{ publish(...), close() }` returned by `subscribe`. | stable |
| `SubscribeOptions` | `{ onRefused? }`, the third argument of `subscribe`. | stable |
| `Env<S>` / `EnvSchema` / `EnvSpec` / `EnvType` | The shapes behind `defineEnv`: the schema, one variable's spec, the built-in type names, the typed result. | provisional |
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

Imported by the generated `.borgo/routes.gen.tsx` for `type Route`. Since 0.21 nothing here is reachable from the root entry: `filePathToPattern`, `matchRoute` and `resolveHead` were dropped from it ([finding 7](#duplicated-apis)) and `safeDecode` was never on it. The type re-exports below still name the same types the root entry exports.

| Export | What it is for | Stability |
| --- | --- | --- |
| `safeDecode(s)` | `decodeURIComponent` that returns the input unchanged on a malformed escape. | internal |
| `safeHeadAttrs(meta)` | Filters a `head.meta` entry down to the attribute pairs safe to render. | internal |
| `filePathToPattern`, `matchRoute`, `resolveHead` | File path → route pattern, pattern matching with params, and `head` resolution — shared between the build, the SSR server and the browser runtime. | internal |
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
| `propsPathEnabled()`, `devUpdatePlan(files, current)`, `actionOutcome(res)`, `tooLargeDetail(res)` | Whether the `?__borgo=props` path was compiled in; what a dev update does to the page on screen; how an action response is classified (`action`, `raw`, `too-large`, `unknown`); the detail text of a 413. | internal |
| `ClientPageModule`, `ClientRoute`, `MountOptions`, `MountIslandsOptions`, `ActionOutcome` | Types of the above. `ClientRoute` appears in generated code. | internal |

### `borgo-framework/internal`

Everything the generated client entries need and nothing an application should write by hand. The name is the contract: this subpath carries no stability promise and may change in any release.

| Export | What it is for | Stability |
| --- | --- | --- |
| `registerCsrf(react: CsrfReact \| null)` | Installs the React functions (`createElement`, `createContext`, `useContext`) the CSRF context is built from; `null` clears the registration. The token itself travels through `withCsrf`, not through this call. | internal |
| `registerIslands(components, createElement)` | Registers the island components a `hydrate=false` page mounts, plus the app's own `createElement` — React is injected rather than imported so the framework never bundles a second copy. | internal |
| `withCsrf(element, token)` | Wraps a tree in the CSRF context `CsrfField` reads. | internal |
| `csrfRuntime()`, `islandRegistry()` | The registries themselves, read by the server and the runtime across module boundaries. | internal |
| `unsafeMethod(method)` | Whether a method is state-changing, and so subject to the CSRF checks. The safe set is `GET`, `HEAD`, `OPTIONS` and `TRACE`, read by `apiFetch` and by the render service's form-action check; the Go front's `/api` check spells the same four. | internal |
| `CsrfReact` | Type of the React functions `registerCsrf` takes. | internal |
| `callExport<T>(name, args)` | What the generated `.borgo/go.ts` calls: a `POST` to `/__borgo/export/<name>` on the internal listener with this boot's key. Throws outside the render service. | internal |

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
| `PORT` (`3000`) | Go, which binds it; the CLI, which resolves the topology | The public port, and the only one. | stable |
| `API_PORT` (`3501`) | Go, which binds it on `127.0.0.1` alone; the render service, to dial it | The API's internal listener, for loaders and form actions. The browser never reaches it — `/api/*` on the public port is the same mux in the same process. A value that is not a port number (0-65535, digits only) is refused before the Go server binds. | stable |
| `SESSION_SECRET` | Go | HMAC key for signed-cookie sessions. At least 32 bytes. Missing is logged at startup and fails session routes per request; **shorter than 32 bytes is fatal at startup** — see [sessions](auth-and-sessions.md#sessions). | stable |
| `SESSION_SECURE` | Go and the render service | Adds `Secure` to the session and CSRF cookies. The grammar is exactly Go's `strconv.ParseBool`, case-sensitive: `1`, `t`, `T`, `true`, `TRUE`, `True` mean on; `0`, `f`, `F`, `false`, `FALSE`, `False` mean off; unset means off. Both halves read that alphabet and **refuse anything else at startup** — `yes`, `on`, `Yes` included — rather than reading it as "not secure". The same grammar governs every boolean switch below (`BORGO_CSRF`, `BORGO_SECURITY_HEADERS`, `BORGO_METRICS`, `BORGO_WS_ALLOW_NO_ORIGIN`). | stable |
| `NO_COLOR` | Go and the render service | Any value disables ANSI colour. | stable |
| `BORGO_MAX_BODY` (`33554432`) | Both, each for what it reads | Largest request body either half reads, in bytes, counted as the bytes arrive rather than taken from a header — so a chunked body is bounded like any other, and one that lies about its length is bounded by the smaller of what it declares and what it sends. The front applies it to `/api/*`, the render service to a form action. `0` means no limit. Refused at boot if it is not a whole number. | stable |
| `BORGO_CSRF` | Both, each for its own half | `0` disables both CSRF checks, `1` forces them in dev. Unsafe `/api/*` requests are checked by the front, form actions by the render service, against the same cookie and the same rejection table. | stable |
| `BORGO_SECURITY_HEADERS` | Both | `0` drops the security headers and the CSP. Each half applies them to what it authors, and adds only what the other left empty. | stable |
| `BORGO_CSP` | Both | `0` drops the CSP alone; any other value replaces the policy, with `{nonce}` substituted per render. The nonced policy is the render service's, since only it knows the nonce; the front applies the same policy without one to what it writes itself. | stable |

### Render service only

| Variable | What it does | Stability |
| --- | --- | --- |
| `API_URL` (`http://localhost:$API_PORT`) | Where the render service reaches the api. | stable |
| `BORGO_RENDER_PORT` (a free port, picked at boot) | The loopback port the render service binds. Unset, `borgo start` and `borgo dev` pick a free one and set it on both halves from one place, so two apps on one machine never meet on it. Set, it is used as named, and a port that already answers on `127.0.0.1` refuses the boot: on Windows a second process binds a port another one listens on without an error, and takes its traffic. | provisional |
| `BORGO_INTERNAL_KEY` | The per-boot key that authorises the front's requests to the render service, at least 32 bytes. Normally you never set it: the CLI mints 32 random bytes per boot and hands the same value to both halves. A value shorter than the floor is announced and replaced; a render service that has no usable key refuses to boot, because a loopback listener without one is a listener anyone on the box can drive. | provisional |
| `BUN_CONFIG_MAX_HTTP_REQUESTS` (`16384` under `borgo dev` and `borgo start`; `256`, bun's default, otherwise) | How many outbound calls the render service may have in flight — in practice, loader and action calls to the api. Read by bun at process start and unraisable afterwards. Event streams and websockets are the front's own inbound sockets and are not drawn from this pool. | stable |

`BORGO_METRICS` was `METRICS` before 0.21. The old name is not honoured, and not honouring it is the point: a bare `METRICS` is the most collidable variable borgo ever read, and an alias kept for compatibility would keep the collision alive.

`BUN_CONFIG_MAX_HTTP_REQUESTS` is bun's, not borgo's, but borgo is why you would set it. A process cannot raise it for itself once bun has booted, so `borgo start` re-execs itself with `16384` when nothing set it, and `borgo dev` sets it, as do the two `borgo deploy init` targets that launch the app — the systemd unit and the compose file. The `caddy` and `nginx` targets are reverse-proxy configs and set no environment. Setting it yourself is still honoured: `start` sees a value and runs in one process rather than two.

### The front (Go) only

| Variable | What it does | Stability |
| --- | --- | --- |
| `BORGO_RENDER_URL` | The render service the front forwards pages to. **Setting it is what makes the binary a front**: there is no flag. Unset, the binary is an api alone on its single listener, which is what an app embedding borgo without pages wants. `borgo start` and `borgo dev` set it to the loopback render port. | provisional |
| `BORGO_RENDER_TIMEOUT` (`30s`) | How long the front waits for the render service's response *headers* before answering 504. The body is then unbounded, so a streaming document and a websocket are not cut. | provisional |
| `BORGO_TRUSTED_PROXIES` (loopback and the private ranges) | CIDRs or addresses whose `X-Forwarded-For` and `X-Forwarded-Proto` are believed. From anyone else those headers are the client's own claims and are rebuilt from the connection. Unset it trusts `127.0.0.0/8`, `::1/128`, `10/8`, `172.16/12`, `192.168/16` and `fc00::/7`, which is what makes the generated compose and reverse-proxy recipes work unconfigured — and it means that on a shared private network (a pod network, an office LAN) **any peer that can reach the port can forge the client address in your logs**. `none` trusts nobody; a list of your own proxies is better than both. A malformed entry is refused at boot naming the variable. | provisional |
| `BORGO_METRICS` | `1` exposes `/metrics` on the public port, in Prometheus text format. | stable |
| `BORGO_CACHE_DIR` (`.borgo/cache/html`) | Where cached pages persist across restarts, keyed to the build that rendered them. | provisional |
| `BORGO_WS_ALLOW_NO_ORIGIN` | `1`/`true` admits websocket clients sending no `Origin`. Browsers always send one, so this exists for non-browser clients — and it admits every other originless caller too. Read by Go since 0.30, where `/ws` is answered; the grammar is the boolean one above, and anything else refuses the boot. | stable |
| `BORGO_READ_HEADER_TIMEOUT` (`5s`) | Cap on reading request headers. | stable |
| `BORGO_IDLE_TIMEOUT` (`2m`) | Idle keep-alive reclaim, on both listeners. | stable |
| `BORGO_READ_TIMEOUT` (`60s` on the public port) | How long a request body may go without progress. Every read of the body moves the deadline forward, so an upload that keeps arriving is never cut and one that goes silent is. `0` turns it off; an api served alone defaults to `0`. | stable |
| `BORGO_WRITE_TIMEOUT` (`60s` on the public port) | How long a response may go without a write. Every write moves the deadline forward, so a streaming render or a large file going to a slow link is never cut, and a client that stops reading is. An event stream clears it at its first byte and keeps its own: `SSE` bounds each of its writes at 10 seconds. `0` turns it off; an api served alone defaults to `0`. | stable |
| `BORGO_SHUTDOWN_TIMEOUT` (`10s`) | Grace period for in-flight requests; `0` waits indefinitely. | stable |
| `BORGO_HASH_SLOTS` (`max(1, GOMAXPROCS/2)`) | Password hashes that may run at once. A value that is not a positive integer is refused by `CheckEnv`, and so by `Serve` and `ServeContext`. | stable |

The five `BORGO_*_TIMEOUT` entries are Go duration strings; `BORGO_HASH_SLOTS` is a positive integer. A malformed duration or a non-positive slot count stops the boot before the startup banner, as an error `ServeContext` returns and `Serve` exits on — never a panic, so a program that embeds the api keeps its process and can act on the refusal. The slot count is read while the package initialises, before `main`: there it can only fall back to the default cap and log, and `CheckEnv` is where it becomes a value.

> **Where `BORGO_FRONT_READ_TIMEOUT` went.** It was the Bun front's socket deadline, and it needed `FRONT` in the name because one environment reached both halves and Go reads `BORGO_READ_TIMEOUT` and `BORGO_IDLE_TIMEOUT` as durations while bun read whole seconds — `=2m` configured one half and silently left the other on its default. The public port is Go's now, so the deadlines a client meets are the Go ones above, in Go's grammar, refused loudly when malformed. The render service has no deadline knob at all: its only client is the front, on loopback, and a deadline there would have bounded the response write too — which is what the *keep-warm* mechanism existed to work around, and it is deleted with it. Neither old name is honoured as an alias.

### Build, dev loop and internal

| Variable | What it does | Stability |
| --- | --- | --- |
| `BORGO_TAILWIND` | Set to `1` by `--tailwind` for child processes. Use the flag, not the variable. | internal |
| `BORGO_PARENT_PID` | How the CLI tells a child process whose death to exit with. The Go server refuses a value that is not a positive integer, and refuses to start at all if that process is already gone — silently running unwatched is the orphaned api this variable exists to prevent. | internal |
| `BORGO_SUPERVISOR_PID` | Set by `borgo start` on the copy of itself it re-execs to raise `BUN_CONFIG_MAX_HTTP_REQUESTS`; the child polls it and exits when the supervisor does. | internal |
| `BORGO_RELOAD` | Marks a restart so the banner prints the short form. | internal |
| `BORGO_CHANGED` | Carries the changed file **set** into the dev fallback server — newline-separated, because a path may contain a comma or a space but not a newline. Two saves inside one debounce window announce both; carrying only the first meant the browser, which ignores an update naming a page other than the one on screen, could apply nothing at all. | internal |
| `BORGO_STATIC` | Set to `1` by `borgo export` for the build it drives, and substituted into the client bundle as a `define` rather than read at runtime — it is what compiles the `?__borgo=props` navigation path out of an exported site, where there is no server to ask for props. Not something to set by hand. | internal |
| `BORGO_DEV` | Set by the dev loop for `serve-entry.ts`. | internal |
| `BORGO_DEBUG` | `1` is the `--debug` flag for a build that has no command line. Read by the build alone, and only `1` — it is not one of the boolean switches above. | internal |
| `BORGO_FORCE_PROMPT` | Test hook: forces `create-borgo`'s interactive path. | internal |
| `BORGO_SPAWN_TIMEOUT_MS` | Test hook: overrides the deadlines `create-borgo` gives the tools it spawns. | internal |
| `NODE_ENV` | Not read at runtime — it is a build-time `define` substituted into client bundles. | internal |

`DB_PATH`, which appears in the deploy samples and the example app, is the *application's* variable, not borgo's.

## CLI

### `borgo`

Run from an app root — the directory holding `pages/`.

| Command | What it does | Stability |
| --- | --- | --- |
| `borgo dev` | Starts both servers, watches, fast-refreshes. | stable |
| `borgo build` | Runs `borgogen`, builds client assets into `public/assets/`, compiles the Go binary into `dist/`. | stable |
| `borgo start` | Runs from build output, supervising both processes. Rebuilds automatically if `public/assets` holds a dev build. Re-execs itself once with `BUN_CONFIG_MAX_HTTP_REQUESTS=16384` when nothing set it — the supervisor forwards signals and exits with the child's code. | stable |
| `borgo export` | Static site into `dist/site/`. | stable |
| `borgo deploy init <caddy\|nginx\|systemd\|compose>` | Writes a deploy config. | stable |
| `borgo pwa init` | Writes `public/manifest.webmanifest` and a service worker. | stable |
| `borgo doctor` | Runs fifteen checks over the toolchain (bun, a bun shim shadowing it, an `engines.bun` range in `package.json` borgo cannot read as a minimum, go, node, docker), the machine (both ports, disk space) and the project (api binary, generated types, `node_modules`, app deps, write access, playwright browsers). Checks that do not apply return nothing; informational ones (node, docker, the shim note) report without affecting the exit code. | stable |
| `borgo` / `borgo --help` / `-h` / `--version` / `-v` | Banner and usage; exits 0. An unknown command exits 1. | stable |

| Flag | Applies to | What it does | Stability |
| --- | --- | --- | --- |
| `--tailwind` | any command (parsed globally) | Hands the CSS pipeline to Tailwind (the `@tailwindcss/postcss` plugin); sets `BORGO_TAILWIND=1` for children. | stable |
| `--front-only` | `start` | Retired in 0.30 and refused with an explanation: the Go binary is the front now, so running the Bun half alone would bind loopback with nothing in front of it. A two-host split is not wired yet. | removed |
| `--force` | `pwa init`, `deploy init` | Overwrites existing files. | stable |
| `--debug` | any command (parsed globally) | Prints the stack and the `cause` chain behind a build failure instead of the one-line report. `BORGO_DEBUG=1` does the same for a build with no command line, such as the dev loop's own rebuilds. | stable |

An argument a command does not know — a stray positional or an unknown `--option` — is refused before the command runs, with usage; a build that ignored it would exit 0 having done something other than what was asked.

The exit codes are part of the contract: `build` exits 1 if `borgogen` or `go build` fails, `start` exits with the api's own code if the api dies, `doctor` and `export` exit with their own status.

### `create-borgo`

| Form | What it does | Stability |
| --- | --- | --- |
| `bunx create-borgo@latest <name>` | Scaffolds a new app. In an interactive terminal it asks seven questions — template, Tailwind, linter, git, docker, vscode, and whether to install dependencies and start the dev server; anywhere else (CI, piped stdin) it takes the defaults without blocking. | stable |
| `--template <base\|minimal\|full>`, `-t`, `--template=<x>` | Picks a template; default `base`. | stable |
| `--tailwind` / `--no-tailwind` | Wires Tailwind, or declines without prompting. Default off. | stable |
| `--linter <biome\|eslint\|none>`, `--linter=<x>` / `--no-linter` | Writes the chosen linter's config and the `lint` / `format` scripts. Default `none`. | stable |
| `--git` / `--no-git` | `git init` plus an initial commit. Default on. | stable |
| `--docker` / `--no-docker` | Keeps `Dockerfile`, `docker-compose.yml` and `.dockerignore`. Default on. | stable |
| `--vscode` / `--no-vscode` | Writes `.vscode/extensions.json` and `settings.json`. Default on. | stable |
| `--install` / `--no-install` | Runs `bun install` and `go mod tidy` after scaffolding. Default **on in a terminal, off everywhere else**, so a scaffold step in CI exits on its own. `--no-install` also settles `--start`: without dependencies the run prints the manual steps and exits. | stable |
| `--start` / `--no-start` | Installs, then hands over to the dev server. Same default rule as `--install`; `--start` in a script is honoured, because it is a request to block on a server. | stable |
| `--yes` / `-y` | Takes every default without opening stdin — the *terminal's* defaults when run in one, so `-y` in a terminal installs and starts too. | stable |
| `--help` / `-h` | Usage. | stable |

Every *on/off* option has a `--no-` twin (`--no-tailwind`, `--no-git`, `--no-docker`, `--no-vscode`, `--no-install`, `--no-start`). `--template` and `--linter` take a value instead, and only `--linter` has a `--no-` form (`--no-linter` means `none`). Install and start are one question at the prompt because they are one intent, and two flags because a script that wants the dependencies without a server that never exits has no other way to say so.

An unknown argument is an error, not a silently ignored token.

### `borgogen`

Invoked as `go tool borgogen`, wired through the app's `go.mod` `tool` directive. It takes no flags and reads the working directory. **stable** as a command; its *output* is a contract covered in [api stability](api-stability.md).

The names it writes into `.borgo/api-types.d.ts` are part of that output. A Go struct becomes an interface of the same name as `encoding/json` writes it; where it is read differently — every struct handed to `Bind`, since the decoder makes every property optional and nullable — it gets a second declaration under `<Name>$Request`, and where a pointer-receiver marshaler makes the written shape depend on position, a `<Name>$Addressable`. `$` cannot occur in a Go identifier, so neither suffix can collide with a type of yours. A Go type whose name is a TypeScript reserved word, or one of the two generics the file uses (`Array`, `Record`), is renamed with its package as a prefix — `type null struct{…}` in `api` comes out `ApiNull` — rather than emitted as a declaration that would break the whole file. The rules are in [the typed bridge](typed-bridge.md#the-request-side-what-the-decoder-accepts).

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
| `api/middleware.go` | By convention, where `func Middleware(http.Handler) http.Handler` and an optional `var Matcher []string` live; borgogen finds them anywhere in package `api`. See [middleware and authorization](middleware-and-authorization.md#apimiddlewarego). | stable |
| `middleware.ts` | The pages' middleware, at the app root: exports `middleware` and an optional `matcher`. A malformed one refuses the boot; a matcher naming `/api` or `/__borgo` refuses the build too. | stable |
| `.borgo/go.ts` | Generated when the api package declares a `//borgo:export`: `export const go = { ... }`, one typed stub per export; removed when there are none. | stable |
| `env.ts` | The app's [typed environment](environment.md), when it declares one: checked at boot, client values shipped by the build. | provisional |
| `env/env.gen.go` | Generated from `env.ts` by `borgo build` and `borgo dev` when it declares a server variable: package `env`, a typed `Server`, `Load()` and `Must()`. Committed; removed when no server variable is left. See [the Go half](environment.md#the-go-half-reads-the-same-contract). | provisional |
| `public/` | Served as-is. `public/assets/` is build output. | stable |
| `index.html` | The SSR shell. | stable |
| `style.scss` | Compiled to `public/assets/style.css` when present. | stable |
| `style.css` | Tailwind entry, used only with `--tailwind`. | stable |
| `.borgo/` | Generated: `api-types.d.ts`, `routes.gen.tsx`, `client-routes.gen.ts`, `islands.gen.ts`, `client.tsx`, `islands-client.tsx`, `refresh.ts` (dev only), `build-mode`, `build-incomplete` (present only while a build is running, or after one that died), and the dev api binary. Everything but `api-types.d.ts` is gitignored by the templates. | internal |
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
| `revalidate` | Seconds a shared cached copy stays fresh, or `"manual"` for invalidation-only. Production only; a malformed value is named in the log and the page served fresh. | provisional |
| `tags` | Array of tag names `borgo.RevalidateTag` drops the page by. Read only beside `revalidate`. | provisional |

### Go directives

| Directive | Meaning | Stability |
| --- | --- | --- |
| `//borgo:route METHOD /path` | Mounts the following package-level handler. Must be the function's doc comment, no space after `//`, and the handler must be `func(http.ResponseWriter, *http.Request)` with no type parameters. | stable |
| `//borgo:type <GoType> <TSType>` | Overrides the TypeScript type generated for a named Go type. May sit anywhere in the `api` package. | stable |
| `//borgo:type <GoType>@<file.go>:<line> <TSType>` | The same, aimed at one specific declaration — for when a bare name is ambiguous. | stable |
| `//borgo:export` | Makes the following package-level function callable from the render service as `go.<name>` in `.borgo/go.ts`. It must be exported, not generic, not variadic, take a `context.Context` first, return `(T, error)` or `error`, and use types that cross as JSON; borgogen refuses anything else with the file and line. | stable |
| `//borgo:topic <pattern>` | Names the shape of a computed topic on the `borgo.Push` call below it, or on the line the call starts on, one call per directive: literal text and `{name}` placeholders, no `/`, `,` or whitespace, at most 128 characters of literal text. The event lands in `WsEvents` as a template-literal key the client narrows on. On a literal topic, on no call, claimed twice, with a computed event, malformed, or colliding with another key of the same event on a different payload: the run fails naming the line. | provisional |

A comment that *looks* like a route directive but is not attached to a handler produces a warning rather than silence — as does a directive in a file the build excludes.

`<GoType>` takes three spellings, and each resolves to **at most one** type:

- `pkgpath.Name` for an imported type (`gorm.io/gorm.DeletedAt`). Checked against what the `api` package imports; a path it does not import is left alone, since the type may still be reached through a helper package.
- a bare `Name` for a type the `api` package declares, or a predeclared one. It resolves to the **package-level** type if there is one, and to the sole function-local one if there is not.
- `Name@file.go:line` to name one declaration outright. This form picks out a function-local type of the `api` package, so pairing it with a dotted imported name is an error.

A bare name used to apply to *every* type of that name, so a directive meant for a package-level type silently rewrote each function-local `type resp struct{…}` that shared it. When a bare name is genuinely ambiguous borgogen now **fails the run**, listing every candidate and the spelling that settles it:

```
ambig.go:13:1: //borgo:type stamp is ambiguous: this api package declares 2 types
named stamp, at ambig.go:17, ambig.go:25. Name the one you mean as stamp@ambig.go:17
```

Failing is the point: a directive that is well formed and still does nothing reads as applied, and leaves you looking at the type it was meant to replace. For the same reason the run also fails on a malformed directive, on one naming a Go type the `api` package cannot refer to, and on two directives mapping one type to different TypeScript.

### Markers, params and headers the runtime owns

| Name | Where | Meaning | Stability |
| --- | --- | --- | --- |
| `data-borgo-island`, `data-borgo-props`, `data-borgo-client` | DOM | Island hydration markers. | internal |
| `data-borgo-visible` | DOM | Hydration trigger element for `hydrate = "visible"`. | provisional |
| `data-borgo-head` | DOM | Meta tags the client runtime owns and replaces. | internal |
| `data-borgo-native` | `<form>` | Opts a form out of enhanced submission. | stable |
| `?__borgo=props` | URL | Asks a page for its loader props as JSON. | internal |
| `X-Borgo-Action`, `X-Borgo` | HTTP | Action request marker, and the response discriminator (`action` / `raw`). | internal |
| `X-Borgo-Cache` | HTTP | How a [cached page](pages-and-routing.md#cached-pages) answered: `miss`, `hit`, `stale` or `bypass`. Diagnostic — read it, do not build on it. | provisional |
| `X-CSRF-Token` | HTTP | The double-submit token on an unsafe `/api/*` request. `apiFetch` attaches it. | stable |
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
*Disposition taken:* **`cookieValue` was removed; `csrfCookieValue` is documented and promoted to stable.** `cookieValue`'s duplicate-tolerant behaviour is a footgun next to its neighbour. `csrfCookieValue` earned the promotion because an app doing hand-rolled `fetch` POSTs genuinely needs the token and `<CsrfField />` only covers `<form>`s.
*Migration cost:* effectively zero for removal — the symbol is undocumented and unused. Promoting `csrfCookieValue` is documentation.

**5. `Bind` and `BindMax` — justified duplication, keep.**
`Bind` is `BindMax` with the safe constant baked in. Keeping the default at the shorter name is the whole point.
*Disposition:* **keep.** *Cost:* zero.

**6. `isConnRefused` implemented twice.**
`packages/borgo/src/api.ts` defines a private copy; `packages/borgo/src/util.ts` exports another (`isConnRefused` in both). Same predicate, two chances to drift.
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
| `CSRF_HEADER` | root | Same, for an app rolling its own `/api` fetch instead of using `apiFetch` | **keep, document** | zero |
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
Most variables are `BORGO_*`; the exceptions are `PORT`, `API_PORT`, `API_URL`, `SESSION_SECRET`, `SESSION_SECURE` and `NO_COLOR`, plus bun's own `BUN_CONFIG_MAX_HTTP_REQUESTS`. Those are defensible — `PORT` and `NO_COLOR` are ecosystem conventions, `SESSION_*` is self-describing, and the bun one is not borgo's to rename. The two that were not defensible, `METRICS` and `DEV`, were prefixed in 0.21.
*Disposition taken:* **`METRICS` → `BORGO_METRICS` and `DEV` → `BORGO_DEV`, both in 0.21, neither with an alias.** An alias for `METRICS` was considered and rejected: honouring the old name would preserve the exact collision the prefix exists to end, and an app that wants metrics on an upgrade sets one variable. `BORGO_DEV` needed no alias either way — it is set only by borgo's own dev loop, so nothing outside the framework was reading it.

**5. "Route" means three different things.**
TypeScript `Route` is a *page*; Go's internal `route` and `ApiRouteKey` are *api endpoints*; `filePathToPattern` produces a page pattern while `Handle` takes an api pattern. The docs use "route" for both and rely on context.
*Disposition:* **rename the TypeScript type to `PageRoute`** if it stays public at all; otherwise mark it internal (see above) and fix the prose. Prefer the latter.
*Cost:* zero if the type goes internal.

**6. Six casings of the brand token, all load-bearing.**
`//borgo:route`, `data-borgo-island`, `__borgo=props`, `X-Borgo-Action`, `borgo_session`, `BORGO_TAILWIND`. Each is idiomatic for its medium — Go directives, HTML attributes, query params, HTTP headers, cookies, env — so the inconsistency is real but correct.
*Disposition:* **freeze as-is at 1.0 and document the set.** These are wire contracts; renaming any of them breaks stored cookies, running proxies and existing HTML.
*Cost:* documentation only. Doing it later costs a major version.

### Gaps the audit found — all four landed in 0.21

Not duplication or naming, but things a 1.0 API should have and did not. Every one of them was additive, so all four shipped in 0.21 and are marked **stable** in the tables above:

- **No way to read borgo's version from Go.** → `borgo.Version`, kept honest by a test that reads `.release-please-manifest.json`.
- **`SSEHub` had no subscriber count and no `Close`.** → `(*SSEHub).Subscribers() int` and `(*SSEHub).Close()`, the latter idempotent.
- **The hash-slot semaphore was not configurable.** → `BORGO_HASH_SLOTS`, read once at package init; a value that is not a positive integer is logged there and refused by `CheckEnv`, rather than silently reinstating the default.
- **`Serve()` could not be composed or tested.** → `ServeContext(ctx) error` beside it, rather than changing `Serve`'s shape.

No gap of this kind is currently open. What remains before 1.0 is the open half of [finding 1](#duplicated-apis) — deprecating `WriteJSON` as public surface.

## What this page is not

It is not permission to depend on everything listed. Anything marked internal will move without a deprecation cycle. If you find yourself needing an internal export to do something ordinary, that is a bug worth reporting — the fix is usually a new stable API, not a promise about the old one.
