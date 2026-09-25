# Architecture

How borgo actually works, end to end: the two processes and why there are two, what happens between `borgo start` and the first request, the path a request takes through both servers, what the build leaves on disk, how the Go source becomes TypeScript types, and how the dev loop is the same machinery with different switches. Read this before you change the framework, or when you need to reason about where a millisecond went.

## Two processes

A running borgo app is a Go process and a Bun process. The Go binary answers the public port; the Bun process renders the pages it asks for.

```
   browser
      |
      | http, port 3000 (PORT) - the only public port
      v
 +------------------------------------------------------------+
 |  go server                    borgo.Serve(), front.go      |
 |                                                            |
 |  your api/*.go handlers       static files (public/)       |
 |  sessions, sse                the shared page cache        |
 |  /healthz  /metrics           gzip, csp, csrf, body limit  |
 +------------------------------------------------------------+
    |                                                ^
    | a page: BORGO_RENDER_PORT (free),              | a loader's api call:
    | loopback, X-Borgo-Internal                     | API_PORT (3501),
    v                                                | loopback
 +------------------------------------------------------------+
 |  bun render service           packages/borgo/src/server.ts |
 |                                                            |
 |  ssr documents                loaders, form actions        |
 |  (react-dom/server)                                        |
 +------------------------------------------------------------+
```

The split is not decorative. React server rendering needs a JavaScript runtime that can execute your page components, so something has to be JavaScript. Everything else — your database work, your business logic, the code that runs on every request forever — does not, and Go is a better place for it. Rather than pretend one language can be good at both, borgo runs each in the process suited to it and gives them one front door. The Go binary is that door: it answers `/api/*` in the same process that holds your handlers — no hop at all — serves what the build wrote into `public/`, keeps the cache of shared pages, and asks the Bun process for the one thing that needs a JavaScript runtime, a document.

A page costs one hop, over loopback; an API call costs none. The render service binds `127.0.0.1` alone, and every request forwarded to it carries `X-Borgo-Internal`, a key minted for this boot and compared in constant time at the top of its handler — a loopback listener is reachable by every process on the box, and this one must answer none of them. It is also never asked to decide anything: Go verifies the session cookie and forwards the result as a fact in `X-Borgo-Session`, so a loader reads who is asking without the render service ever holding the signing key or re-verifying a cookie.

In production the two processes are supervised as one command, and the roles are not the obvious way round: `borgo start` *is* the Bun process, and it spawns `dist/api` as a child that takes the public port while its parent renders behind it. `docker run` and a systemd unit still have exactly one thing to start and one thing to stop. If the Go process exits on its own, the parent exits with its code so a supervisor restarts the pair. A deployment split across two hosts is not wired yet: `--front-only`, which used to run the Bun front alone against a remote API, is refused with that explanation, because what it would start now is a renderer nothing can reach.

"Itself" has a caveat. Bun fixes the size of its outbound fetch pool when the process starts and no code can raise it afterwards, so if `BUN_CONFIG_MAX_HTTP_REQUESTS` is not already in the environment, `borgo start` re-execs itself once with it set to `16384` and that child becomes the one that renders and spawns the Go binary. The outer process stays as a thin supervisor: it forwards `SIGINT` and `SIGTERM` and exits with the child's code, so a service manager still sees one pid to signal and one exit status to trust, and the child polls `BORGO_SUPERVISOR_PID` so a hard kill of the supervisor cannot orphan it. Every deployment borgo writes — the Dockerfiles, the systemd unit, the compose file — sets the variable, so the re-exec only happens to a hand-launched server. What the ceiling bounds is how many loader calls this process can have in flight against the Go server: event streams and the topic relay are the front's own sockets now, inbound, and are not drawn from this pool.

In dev there are three processes: the `borgo dev` watcher, the Go binary it builds, and a separate Bun process running the render service — separate so a code change can be applied by restarting it without losing the watcher. More on that below.

### The watchdog

Each half watches the other, because a pair supervised as one command must die as one. The Bun side is simple: `borgo start` spawns `dist/api` with `BORGO_PARENT_PID` set to its own pid, and if the Go process exits on its own the parent exits with its code; the re-exec'd child polls `BORGO_SUPERVISOR_PID` every 2 seconds. The Go side lives in `watchdog_*.go` and is the part with platform branches:

- **A probe at boot.** Before binding, `borgo.Serve` checks whether the pid in `BORGO_PARENT_PID` is already gone and refuses to start if it is, with an error — otherwise an API launched under a dead supervisor would mount, serve nobody, and report a clean exit. `kill(pid, 0)` alone is not the probe: it succeeds on a zombie, so the check also asks the kernel whether the pid is a corpse.
- **A 250 ms poll after that.** For the direct parent the evidence is reparenting — `getppid()` changing — which survives the freed pid being reused. For a pid that is not the parent (a hand-set variable; borgo prints one line at boot when that is the case) the poll falls back to the probe.
- **Where the corpse check reads.** Linux and WSL read `/proc/<pid>/stat` and look at the state field. macOS and the BSDs have no `/proc`: they read the `kern.proc.pid.<pid>` sysctl and the process-state offset inside the `kinfo_proc` struct, which is why that code is covered by a separate macOS CI job. Windows holds a handle and waits on it with `WaitForSingleObject`, on the same 250 ms tick. Every platform answers "alive" when it cannot tell, because refusing a boot needs certainty.

When the parent is gone the server runs the same graceful shutdown a `SIGTERM` would, bounded by `BORGO_SHUTDOWN_TIMEOUT`.

## What happens at boot

Both halves have one. The front's is short: read the inventory the build left in `.borgo/build-output.json`, walk `public/` once, hold the outputs the build vouched for in memory under a 64 MiB budget, read the environment, bind the public port and a loopback listener for the API. It has no route table of its own — the pages it may cache are the render service's answer to `/__borgo/routes`, asked once per boot of that process.

The long sequence is the render service's. `serve()` in `packages/borgo/src/server.ts` runs it before it binds a port, and everything in it is work that would otherwise happen on every request.

**1. Build or verify the assets.** In production the boot serves what `borgo build` left on disk only when it can establish that a finished production build is there; anything else is rebuilt, and the reason is printed. Four things have to hold. `.borgo/routes.gen.tsx` exists. Every name the build recorded is on disk as a file, of the length recorded — not merely present, because an entry truncated to nothing answers 204 with no body and nothing hydrates, silently. `.borgo/build-mode` says `production` in so many words: absent, empty or unreadable is not a licence to serve, since a half-copied `.borgo` is exactly how a tree reaches that state and the cost of guessing wrong is a development bundle on a production port. And `.borgo/build-incomplete` is gone — it is written before the first generated file and removed after the last byte of a successful build, so a build that died in the middle cannot be mistaken for one that finished. Under `borgo dev` the assets are built every time.

**2. Load the route manifests.** `.borgo/routes.gen.tsx` is imported as a module. It exports `routes` (each with its pattern, its file, its module, its resolved layout chain and whether it uses islands), plus `notFound` and `serverError` for `_404.tsx` and `_500.tsx`. The array is already sorted by the build so that static segments beat dynamic ones — `/tasks/new` is ahead of `/tasks/:id` in the list, so a linear scan finds the right one first.

**3. Register the islands and the CSRF runtime.** `.borgo/islands.gen.ts` maps island names to components. React is passed in at registration rather than imported by the framework package, so a linked checkout can never introduce a second copy of React and break hooks.

**4. Prepare the shell.** `index.html` is read once and cut into the pieces a render concatenates: everything before `<!--app-->`, that prefix split again at `</head>` (with and without its `<title>`), the tail split at `<!--props-->`, and two prebuilt zero-JS tails for pages that opt out of hydration. Injecting a page's `<head>` is then a three-string join instead of a rewrite of the whole shell.

**5. Resolve the environment.** The render port and the boot key, the API base URL, the maximum body an action may read, the security header and CSP policy, whether CSRF is enforced on form actions. Each is read once here, not per request; the body limit and the CSRF check on `/api` are the front's, read once there. The full list is in the [environment reference](deploy.md#environment-reference).

**6. Index the static files.** The front serves `public/` and rarely leaves anything for this process, so the index here is the fallback: in production one walk records every file's size, mtime, content type, cache-control, whether it has `.br`/`.gz` siblings and an ETag for each variant. What still reaches it is the path the front deliberately declines — a file whose name carries no extension, which is almost always a page — so the lookup has to be there when a route misses. Dev skips this on both sides: it rewrites assets in place under stable names, where a cached ETag would pin the browser to yesterday's bundle.

**7. Bind.** `Bun.serve` on `127.0.0.1` and the render port, with no websocket handler at all — the topic relay and the dev channel are the front's since 0.30 — and no socket deadline at all. That is not a relaxation: bun's `idleTimeout` bounds the response write as well as the inbound read, so on the public port it used to cut a document that streamed longer than it had, and borgo had to keep re-arming it by hand for every request that provably had nothing left to send. The deadlines that matter moved to where the browser actually is — the front's read, read-header and write timeouts, and a header deadline on the render hop — and the only client of this listener is the front, on loopback, which has its own.

The route table is then printed and the server is live. Nothing about the table can change afterwards: adding a page means a restart, which in dev is what the watcher does for you.

## The path of a request

A request meets two dispatchers, and in both the order below is the order in the source: the first match wins.

The front's, on the public port:

```
  request
    |
    +-- /__borgo/dev ....... dev only: the fast-refresh stream, this process's
    +-- /__borgo/* ......... a name the two processes use: 404 to the browser
    +-- /healthz ........... status of both halves
    +-- /metrics ........... prometheus text, only with BORGO_METRICS=1
    +-- /api/* ............. your go handlers, in this process
    +-- /ws ................ the websocket relay: Origin checked, CanSubscribe asked per topic
    |
    +-- an alias of a path ................ 308 to its one spelling
    +-- GET|HEAD + a file under public/ ... from memory, or opened per request
    +-- a page that exports revalidate .... the shared cache, when it may
    +-- everything else ................... forwarded to the render service
```

And the render service's, behind it:

```
  request  (loopback; without this boot's key, 403 before the path is read)
    |
    +-- POST /__borgo/dev/css  dev only: recompile the css in place
    +-- /__borgo/routes .... which pages may be shared, and under which tags
    +-- /healthz ........... this process alone, for the front's probe
    |
    +-- GET|HEAD + a file in public/ ..... the late probe, for an odd name
    +-- POST + a page with an action ..... form action
    +-- GET|HEAD + ?__borgo=props ........ loader data as json
    +-- GET|HEAD + a page ................ rendered document
    +-- otherwise ......................... 404 (or the _404 page), 405
```

Five of those paths are worth following in full, starting with the one that is new.

### One spelling per page

Before anything routes, caches or counts on a path, the front reduces it to one spelling and answers a `308` if the request named another: percent-encodings of unreserved characters decode (`/ne%77s` **is** `/news`, rfc 3986), a kept escape gets uppercase hex, `%2F` stays `%2F` because decoding it would change how many segments there are, runs of slashes collapse, a trailing slash goes, and dot segments resolve. The redirect is permanent and method-preserving, so a form action posted to an alias arrives at the page as a POST. `/api/*` is exempt: an api client's path is its own business, and `ServeMux` has its own rules for it.

This is `canonicalPath` in `router.ts`, mirrored in `canonical.go`, with a table of the same rows on both sides pinning them to each other. Both halves have to agree about it, and the front applying it *late* was a defect with teeth: the cache keyed on the cleaned path while the request went on as written, so one visit to `/news/` came back as the render service's own 308 — and a 308 is unstorable, so the refusal was recorded under the canonical key. One free request turned the cache off for the real page: for a whole revalidate window, and forever for a `manual` one.

### The render hop

What the front does not answer itself it forwards to the render service, and what travels with the request is the design:

- **`X-Borgo-Internal`**, the key for this boot: minted by the parent process, handed to both halves in the environment, compared in constant time at the top of the render service's handler and again on everything that calls back this way. Without it the answer is 403, before the path is even looked at.
- **`X-Borgo-Session`**, the session the front already verified, as the stored JSON. The render service has never held the signing key; a loader reads a fact, not a credential. A client presenting either of these header names is a client forging something only this process may state, so both are deleted before the key is set.
- **`Host` as the browser stated it**, because the render service builds absolute URLs from it. `X-Forwarded-For` and `X-Forwarded-Proto` are kept only from a peer in `BORGO_TRUSTED_PROXIES` and otherwise rebuilt from the connection alone: from anyone else they are the client's own claims. The front holds itself to the same rule on `/ws`, where a TLS-terminating proxy whose `X-Forwarded-Proto` is not believed has every WebSocket handshake refused as cross-origin.
- **`X-Borgo-Boot`**, on the way back: the render service stamps every response with the moment it booted, so a restart makes the front re-read the page policies rather than cache against a table that no longer exists. That header and the internal names beside it are stripped before the response reaches the browser.

The deadline on the hop (`BORGO_RENDER_TIMEOUT`) covers the wait for response *headers* only and is then dropped, so a streaming document runs as long as it wants. When the render service cannot be reached the front answers 503, and 504 when it did not answer in time, each with `Retry-After` — never a rendered error page, which would need the half that is down.

### A rendered document

`GET /tasks/7` matches `pages/tasks/[id].tsx` at pattern `/tasks/:id` with `params = { id: "7" }`. Then:

1. The page's `loader` runs, handed the request, the params, and a typed `api` client bound to this request's cookies. Every call the loader makes to Go carries the browser's `Cookie` header, so Go handlers see the session during SSR; every `Set-Cookie` Go sends back is collected and will ride out on this response. A loader may also return a `Response` instead of props — that is how [a redirect guard](pages-and-routing.md#a-loader-can-answer-instead-of-returning-props) short-circuits the render.
2. A CSRF token is resolved: the one in the request's cookie, or a fresh one minted alongside this page.
3. A nonce is minted, before the render, because React's own streaming scripts need the same one as the props script.
4. The props are serialized to JSON *before* the render starts. A loader returning something JSON cannot carry fails here, cheaply, instead of abandoning a render already in flight.
5. `renderToReadableStream` produces the React stream. `documentStream` wraps it: shell head, React's chunks, shell tail with the props script.
6. The stream is scanned for the path of the machine it runs on and every occurrence is replaced with `[redacted]`. A loader that renders `import.meta.url` or `new URL("./x.png", import.meta.url)` into markup writes the server's own directory into the document; on Windows the root's native, forward-slash and JSON-escaped spellings are all needles, and the `file://` form is one everywhere. A bare POSIX root such as `/app` is *not* redacted — it is textually a valid root-relative URL — which is why the build refuses the expressions that produce it (see below). The same scan runs on the props JSON, on the head a page computes from it, and on every JSON answer.
7. In production the whole thing goes through a gzip stream with a sync flush per chunk, so streamed Suspense boundaries still arrive progressively.

The response carries `Content-Type: text/html; charset=utf-8`, `Cache-Control: private, no-store`, `Vary: Accept-Encoding`, the CSP with this render's nonce, and any cookies the loader's API calls produced. Documents are not cached by default, because a document embeds the session-shaped props of whoever asked for it; the exception is a page that exports `revalidate`, whose anonymised render is cached and shared under guards of its own — see [cached pages](pages-and-routing.md#cached-pages).

A `HEAD` renders for real — the status and headers must be what a `GET` would say — and only the body is dropped and cancelled, so the render does not keep going into a stream nobody reads.

### `/api/*`

There is no proxy left on this path. The `ServeMux` that holds your handlers is in the process that answered the port, so the request reaches `api/*.go` with nothing between but the front's own middleware: the body limit (`BORGO_MAX_BODY`, 32 MB), the CSRF check on unsafe methods, and the request counters. Nothing is serialized, nothing is buffered to make a retry possible, and there is no second deadline to tune.

The security headers changed direction here, and it is worth knowing which way. They used to stop at the proxy: whatever Go wrote on an `/api` response was what shipped. Now they are applied by authorship rather than by path — the wrapper sits on the whole public port — so an `/api` response picks up `X-Content-Type-Options`, `Referrer-Policy` and `X-Frame-Options`, and only where your handler left that header empty. The CSP is the exception it always was: it goes on `text/html` and `image/svg+xml` alone, so a JSON answer never carries one. The body is still untouched, gzip and all.

"The whole public port" includes the one response that escapes the wrapper. `httputil.ReverseProxy` hijacks the connection for an upgrade and writes the `101` to the socket itself, so a handshake never passes through the writer that adds the headers; they are set in `ModifyResponse` instead, where the response is still a map. The CSP stays off it, because a `101` has no content type and a policy on a socket is noise the client has to parse.

Loaders pay a hop in the other direction — the render service's typed client calls the Go server on `API_PORT`, a listener bound to `127.0.0.1` alone. That one is a real round trip; see the limit at the end of this page.

Two more middlewares sit between `ServeMux` and your handler, and both are deliberately pedantic about header spelling, because a cache or a client is allowed to be:

- **gzip.** Responses of at least 1024 bytes are compressed when the client accepts it; smaller ones, event streams, pre-encoded responses and `HEAD` bodies pass through. `Accept-Encoding` is read as one folded list across repeated field lines and coding names compare case-insensitively, so `GZIP` compresses and `gzip, gzip;q=0` is a refusal. `Vary: Accept-Encoding` is set whether or not the response ends up compressed, and the writer is wrapped for every request so a panic means the same thing to a gzip client and an identity one.
- **cache.** `borgo.Cache` writes `public, max-age=…`, but a response that carries `Set-Cookie` is rewritten to `private` on the way out, in whichever order the handler called the two. The guard finds the cookie under any spelling of the key — `w.Header()["set-cookie"]` reaches the wire in `net/http` without canonicalisation — and rewrites `Cache-Control` across every field line a handler left, in the order the writer emits them, so a shared cache can never store a personalised body.

### A static asset

`GET /assets/client-a1b2c3d4.js` is answered by the front, in Go. The path is decoded, checked for traversal and separator tricks (on Windows also for the NTFS alternate-stream and reserved characters that alias a file under a name the path checks never saw), and looked up in the boot-time index. A name the build vouched for is served from memory — measured, and the reason this moved: the same 31 kB file read from disk per request queued badly under 64 connections where memory answered four times as fast. Anything else under `public/` is opened per request. A hit answers with the ETag, `Last-Modified`, `Content-Length` and — when the client accepts it — the `.br` or `.gz` sibling written at build time. `If-None-Match` gets a `304` with no file read at all.

`Cache-Control: public, max-age=31536000, immutable` needs three facts at once, none of which is the shape of the name: the build recorded this exact path, the length on disk matches what it recorded, and so does the length of the identity behind the representation being sent. A partial deploy that left a stale `.gz` beside a fresh file must not pin either for a year.

A path whose last segment carries no extension is not served here at all: it is almost always a page, so it goes to the router, and the render service keeps a late probe for the rare plain file that collides with no route. Two classes of file under `public/` are never served, on either side and on either the indexed road or the live fallback: a file whose own name starts with a dot (`.DS_Store`, `.gitkeep`, an `.env` somebody dropped, an editor's `.swp`), and anything under a directory whose name starts with a dot (`public/.git/config`, `public/.svn/entries`). The one exception is `.well-known` as the *first* segment, exact and lower-case, because RFC 8615 puts ACME renewals and `security.txt` there and nowhere else. `borgo export` applies the same rule before copying `public/`.

Assets are checked *before* page routes, so a file in `public/` shadows a page of the same path for `GET` and `HEAD`. It does not shadow a `POST`: a page action must not be hijacked by a static file.

### The props endpoint

When the client-side runtime navigates, it does not ask for a document. It asks the same URL with `?__borgo=props` and gets `{ props }` — the loader's return value alone, as JSON, `private, no-store`. The component is already in the browser (or arrives in parallel as its own chunk), so the second render is client-side. A loader that answers with a redirect surfaces as `{ redirect }` so the runtime can follow it without a round trip through the document path.

The same endpoint is what hover prefetching warms. See [client navigation](client-navigation.md#prefetching).

## What the build produces

`borgo build` runs `borgogen`, then the asset build, then `go build`. It leaves this:

```
  .borgo/                     generated, rebuilt at will - gitignored except api-types.d.ts
    api-types.d.ts            route pattern -> response and request types (borgogen)
                              the one file here you commit: it is what makes a fresh
                              checkout typecheck before anyone has run the generator
    routes.gen.tsx            the server route table: patterns, modules, layout chains
    client-routes.gen.ts      the client route table: patterns and dynamic import()s
    islands.gen.ts            island name -> component
    client.tsx                the browser entry point
    islands-client.tsx        the smaller entry for zero-js pages that use islands
    build-mode                "dev", "production" or "export" - which build wrote public/assets
    build-incomplete          present while a build runs, and after one that died partway
  api/
    borgo.gen.go              init() { borgo.Handle(...) } for every //borgo:route (borgogen)
  public/assets/
    client-<hash>.js          entry: runtime + react + layouts
    islands-client-<hash>.js  entry: island hydration only (when islands/ exists)
    <page>-<hash>.js          one chunk per hydrated page, content-hashed
    style-<hash>.css          compiled from style.scss, or from tailwind
    *.gz  *.br                precompressed siblings of everything compressible
    precache.json             the hashed asset list a service worker precaches, plus a stamp
  dist/
    api                       the go binary (api.exe on windows)
```

The asset build is one `Bun.build` call with `splitting: true` and two entry points. A plugin transpiles your own `pages/*.tsx` with the `loader`, `action`, `prerender` and `prerenderPaths` exports eliminated and unused imports trimmed, which is why a page can `import { db } from "@/db"` at the top of its loader and ship none of it to the browser. In production every output is named `[name]-[hash]`, entry points included; `index.html` keeps naming `/assets/client.js` and `/assets/style.css`, and the build records which hashed file each logical name became so the server resolves them at boot. A dev build names its entries `client.js` and `islands-client.js` whatever they contain, which is why `precache.json` carries a content stamp rather than trusting the names.

The build also refuses output it would not serve. Importing a file from beside a source — `import logo from "./logo.png"`, `import "./x.css"`, `new URL("./x.png", import.meta.url)` aimed at a path `public/` does not hold, or `import.meta.dir + "/x.png"` — emits a URL no route answers and, in the SSR pass, writes the machine's absolute path into the document. The check reads the *emitted* bundles, never the sources, because the same pattern is correct in a loader; any hit throws `AssetChannelRefused` before the build mark is cleared, so the next `borgo start` rebuilds and refuses again rather than serving the leak.

`borgo export` is a fourth output path — it drives the same render machinery to write plain HTML into `dist/site/`. See [static export](deploy.md#static-export).

## How code generation fits

`borgogen` is a Go program that reads your Go source and writes one TypeScript file and one Go file. It runs before every build and before every API restart in dev. It never runs at request time, and there is no reflection anywhere.

```
   api/*.go                          borgogen                    outputs
  ------------                      ----------                  ---------
  //borgo:route GET /api/tasks  --> route discovery      -->  api/borgo.gen.go
  borgo.Handle("GET /api/x", h)      (directives + calls)      init() { borgo.Handle(...) }
                                                                       |
  borgo.JSON[T](w, 200, v)      --> handler body walk               (compiled into
  borgo.WriteJSON(w, 200, v)        (helpers followed)               your binary)
  json.NewEncoder(w).Encode(v)
  borgo.Bind[T](r)              --> request types        -->  .borgo/api-types.d.ts
  borgo.Push("t", "e", v)      --> websocket payloads         declare module "borgo-framework"
```

The load uses `go/packages` with syntax and type information but without a full source re-typecheck of the dependency graph — dependency types come from export data, which is what keeps the run fast enough to sit in the dev loop.

Route discovery has two sources: `borgo.Handle` calls found in the AST, and `//borgo:route METHOD /path` doc comments. A directive on something that is not a `func(http.ResponseWriter, *http.Request)`, or on a method, or on a generic function, fails the run with the position. So does a duplicate pattern.

Response types come from walking the handler body for `borgo.JSON[T]`, `borgo.WriteJSON`, and an inline `json.NewEncoder(w).Encode(v)` aimed at the handler's own `ResponseWriter`. Calls into helpers are followed: freely within the `api` package, and into other packages of your module when the helper is a package-level function that takes a `ResponseWriter` or a `*Request`, capped at three package hops. Calls under a constant status of 300 or more are left out, because the TypeScript client throws on a non-2xx instead of resolving with the body.

So this handler:

```go
//borgo:route GET /api/tasks
func ListTasks(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, TaskList{Tasks: tasks})
}
```

produces a mounting file you never edit:

```go no-check
// generated by borgogen - do not edit
package api

import "github.com/LuigiDavideMicca/borgo"

func init() {
	borgo.Handle("GET /api/tasks", ListTasks)
}
```

and a declaration file that merges into the framework's own types:

```ts no-check
// generated by borgogen - do not edit

export interface Task {
  ID: number;
  title: string;
  body: string;
}

export interface TaskList {
  tasks: Array<Task> | null;
}

declare module "borgo-framework" {
  interface ApiRoutes {
    "GET /api/tasks": { response: TaskList };
  }
}
```

A type is not rendered the same way in both directions. Going out, `encoding/json` writes every field unless `omitempty`/`omitzero` or a nil-able kind says otherwise; coming in, every property is optional and nullable. When the two renderings differ, the request side gets its own declaration with a `$Request` suffix — unconditionally, not as a fallback for a taken name, so the generated file does not change shape depending on which route reached the type first. A struct every field of which renders identically (`type Money int`, or a slice of one) gets a single declaration.

Because `ApiRoutes` is an interface the framework declares empty and `borgogen` augments, the `api` client in every loader is typed by that map — the route string is a key, the return type follows from it, and a body is required exactly when the handler binds one:

```tsx
import type { LoaderContext } from "borgo-framework";
import type { Task } from "@/.borgo/api-types";

export async function loader({ api }: LoaderContext) {
  const { tasks } = await api("GET /api/tasks");
  return { tasks };
}

export default function Tasks({ tasks }: { tasks: Task[] }) {
  return (
    <ul>
      {tasks.map((task) => (
        <li key={task.ID}>{task.title}</li>
      ))}
    </ul>
  );
}
```

Rename the Go field, and `tsc` fails on the page. That is the whole point, and [the typed bridge](typed-bridge.md) covers what it can and cannot see.

Both outputs are written only after every check has passed, so a failed run never leaves one file regenerated and the other stale. Writes are content-compared, so an unchanged output does not touch the file — except for its mtime, which `borgo doctor` uses to judge freshness.

## The dev loop

`borgo dev` is the same machinery with three switches flipped: React is built in development mode, precompression and the asset indexes are skipped, and the front answers the browser an event stream on `/__borgo/dev` — the one internal name it answers instead of refusing — fed by what the watcher and the render service post to its internal listener.

```
  borgo dev  (the watcher)
     |
     |-- go build -o .borgo/next-api .  -> swap -> spawn -> the front, :3000
     |                                                          |
     |-- bun serve-entry.ts (BORGO_DEV=1) -> the render service, a free loopback port
     |                                                          |
     |   fs.watch(".", recursive)                               |  sse /__borgo/dev,
     |     *.go     -> borgogen, rebuild, restart api, reload    |  from the front
     |     *.css    -> recompile, hot-swap the <link>            v
     |     *.ts(x)  -> restart the render service, fast refresh  browser
```

The interesting part is what "restart the render service" means for the browser. A `.tsx` edit kills and respawns the render Bun process with `BORGO_CHANGED` set to the file. That process rebuilds the assets, and while building it records which output chunk each page landed in. Once bound it posts that map to the front's dev channel, which hands it to every open stream — and to a stream that opens later, stamped, so a page loaded after the change ignores it — and the browser re-imports only the chunk for the page it is on, runs `performReactRefresh`, refetches props through the same `?__borgo=props` endpoint a navigation uses, and re-renders. Component state survives. A layout, the shell or a `.go` file cannot be applied that way and take a full reload instead.

Restarting the whole process for every edit sounds heavy and is not: the module graph is clean every time, so there is no stale-module class of bug at all, and the cost is the asset rebuild, which is a `Bun.build` of your app. A boot that throws does not take the site down — the public port is the Go process's and stays bound, and the render service falls back to a tiny server that answers every request with the error overlay; the dev channel is the front's and stays open, so the next successful rebuild reloads the browser instead of leaving you looking at a 503.

Go edits go through a scratch binary: the build writes `.borgo/next-api` while the old API keeps serving, the output is hashed to skip no-op rebuilds, and only then is the old process killed and the file swapped. The browser is reloaded after the new API answers, not before. [Dev experience](dev-experience.md#fast-refresh) covers the contract from the other side.

## Honest limits

**The route table is a linear scan.** `matchRoute` walks the array and splits strings for each candidate until one matches. Fine for the tens-to-low-hundreds of pages a borgo app has; it is not a compiled trie, and an app with a thousand routes will feel it.

**Everything is resolved at boot, including the route table.** Adding, renaming or deleting a page requires a restart. There is no watch mode in production, by design.

**One process per port.** Neither listener is bound with port reuse, so you cannot run two borgo apps behind one port. Scale horizontally with several instances behind your reverse proxy, each with its own port.

**A loader's API call is a real HTTP round trip.** JSON is serialized in Go and parsed in Bun for every loader call, over loopback. It is fast, but it is not a function call, and a page whose loader makes six sequential calls pays for six. Use `Promise.all`. A browser's own `/api` call pays none of this: it never leaves the Go process.

**The front is your API's own process, not a gateway.** It does not cache, transform or rate-limit `/api/*`; what it adds is the body limit, the CSRF check and the counters. Anything else of that kind belongs in your handlers, or in the reverse proxy in front of borgo. Pages are the only thing it proxies, and only to the render service beside it.

**Islands ship with the entry, not as separate chunks.** Island components are registered eagerly in `islands.gen.ts`, so `client="visible"` defers the hydration work, not the download. See [islands](client-navigation.md#islands).

**Two processes mean two things to supervise.** `borgo start` hides that behind one command and one exit code, but a `docker stop` still has to reach both, and splitting them across two hosts is not supported: the render service must be on loopback from the front. [Deploy](deploy.md) covers the layouts that work.
