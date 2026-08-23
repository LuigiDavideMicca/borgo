# Architecture

How borgo actually works, end to end: the two processes and why there are two, what happens between `borgo start` and the first request, the path a request takes through both servers, what the build leaves on disk, how the Go source becomes TypeScript types, and how the dev loop is the same machinery with different switches. Read this before you change the framework, or when you need to reason about where a millisecond went.

## Two processes

A running borgo app is a Bun process and a Go process.

```
   browser
      |
      | http, port 3000 (PORT)
      v
 +-----------------------------------------------------------+
 |  bun front server            packages/borgo/src/server.ts  |
 |                                                            |
 |  ssr documents (react-dom/server)   static files (public/) |
 |  loaders and form actions           websocket topic relay  |
 |  /healthz  /metrics                 gzip, csp, csrf        |
 +-----------------------------------------------------------+
      |
      | http, port 3501 (API_PORT), loopback
      v
 +-----------------------------------------------------------+
 |  go api server                       borgo.Serve()         |
 |                                                            |
 |  net/http ServeMux, method patterns  sessions, sse         |
 |  your api/*.go handlers              gzip, panic recovery  |
 +-----------------------------------------------------------+
```

The split is not decorative. React server rendering needs a JavaScript runtime that can execute your page components, so something has to be JavaScript. Everything else — your database work, your business logic, the code that runs on every request forever — does not, and Go is a better place for it. Rather than pretend one language can be good at both, borgo runs each in the process suited to it and gives them one front door: the browser only ever talks to port 3000, and the front server proxies `/api/*` onward.

There is only one hop, and it is over loopback. The front server does not sit in front of Go for policy reasons — it does not authenticate, rewrite or interpret API responses. It forwards the request, strips the headers that belong to the browser-to-Bun connection, and hands the response back untouched, gzip and all.

In production the two servers are supervised as one command. `borgo start` spawns `dist/api` as a child and runs the front server itself, so `docker run` and a systemd unit both have exactly one thing to start and one thing to stop. If the API exits on its own, the front server exits with the API's code so a supervisor restarts the pair. `borgo start --front-only` skips the child entirely, for a split deployment where the Go server runs on another host and `API_URL` points at it.

"Itself" has a caveat. Bun fixes the size of its outbound fetch pool when the process starts and no code can raise it afterwards, so if `BUN_CONFIG_MAX_HTTP_REQUESTS` is not already in the environment, `borgo start` re-execs itself once with it set to `16384` and that child becomes the one holding both the front server and the API. The outer process stays as a thin supervisor: it forwards `SIGINT` and `SIGTERM` and exits with the child's code, so a service manager still sees one pid to signal and one exit status to trust, and the child polls `BORGO_SUPERVISOR_PID` so a hard kill of the supervisor cannot orphan it. Every deployment borgo writes — the Dockerfiles, the systemd unit, the compose file — sets the variable, so the re-exec only happens to a hand-launched server, which is exactly the one that was silently capped at ~255 concurrent event streams. See [realtime](realtime.md#honest-limits).

In dev there are three processes: the `borgo dev` watcher, the Go binary it builds, and a separate Bun process running the front server — separate so a code change can be applied by restarting it without losing the watcher. More on that below.

### The watchdog

Each half watches the other, because a pair supervised as one command must die as one. The Bun side is simple: `borgo start` spawns `dist/api` with `BORGO_PARENT_PID` set to its own pid, and if the API exits on its own the front exits with its code; the re-exec'd child polls `BORGO_SUPERVISOR_PID` every 2 seconds. The Go side lives in `watchdog_*.go` and is the part with platform branches:

- **A probe at boot.** Before binding, `borgo.Serve` checks whether the pid in `BORGO_PARENT_PID` is already gone and refuses to start if it is, with an error — otherwise an API launched under a dead supervisor would mount, serve nobody, and report a clean exit. `kill(pid, 0)` alone is not the probe: it succeeds on a zombie, so the check also asks the kernel whether the pid is a corpse.
- **A 250 ms poll after that.** For the direct parent the evidence is reparenting — `getppid()` changing — which survives the freed pid being reused. For a pid that is not the parent (a hand-set variable; borgo prints one line at boot when that is the case) the poll falls back to the probe.
- **Where the corpse check reads.** Linux and WSL read `/proc/<pid>/stat` and look at the state field. macOS and the BSDs have no `/proc`: they read the `kern.proc.pid.<pid>` sysctl and the process-state offset inside the `kinfo_proc` struct, which is why that code is covered by a separate macOS CI job. Windows holds a handle and waits on it with `WaitForSingleObject`, on the same 250 ms tick. Every platform answers "alive" when it cannot tell, because refusing a boot needs certainty.

When the parent is gone the server runs the same graceful shutdown a `SIGTERM` would, bounded by `BORGO_SHUTDOWN_TIMEOUT`.

## What happens at boot

`serve()` in `packages/borgo/src/server.ts` runs a fixed sequence before it binds a port. Everything here is work that would otherwise happen on every request.

**1. Build or verify the assets.** In production the boot serves what `borgo build` left on disk only when it can establish that a finished production build is there; anything else is rebuilt, and the reason is printed. Four things have to hold. `.borgo/routes.gen.tsx` exists. Every name the build recorded is on disk as a file, of the length recorded — not merely present, because an entry truncated to nothing answers 204 with no body and nothing hydrates, silently. `.borgo/build-mode` says `production` in so many words: absent, empty or unreadable is not a licence to serve, since a half-copied `.borgo` is exactly how a tree reaches that state and the cost of guessing wrong is a development bundle on a production port. And `.borgo/build-incomplete` is gone — it is written before the first generated file and removed after the last byte of a successful build, so a build that died in the middle cannot be mistaken for one that finished. Under `borgo dev` the assets are built every time.

**2. Load the route manifests.** `.borgo/routes.gen.tsx` is imported as a module. It exports `routes` (each with its pattern, its file, its module, its resolved layout chain and whether it uses islands), plus `notFound` and `serverError` for `_404.tsx` and `_500.tsx`. The array is already sorted by the build so that static segments beat dynamic ones — `/tasks/new` is ahead of `/tasks/:id` in the list, so a linear scan finds the right one first.

**3. Register the islands and the CSRF runtime.** `.borgo/islands.gen.ts` maps island names to components. React is passed in at registration rather than imported by the framework package, so a linked checkout can never introduce a second copy of React and break hooks.

**4. Prepare the shell.** `index.html` is read once and cut into the pieces a render concatenates: everything before `<!--app-->`, that prefix split again at `</head>` (with and without its `<title>`), the tail split at `<!--props-->`, and two prebuilt zero-JS tails for pages that opt out of hydration. Injecting a page's `<head>` is then a three-string join instead of a rewrite of the whole shell.

**5. Resolve the environment.** Port, API base URL, proxy timeout and retry counts, maximum request body, the security header and CSP policy, whether CSRF is enforced. Each is read once here, not per request. The full list is in the [environment reference](deploy.md#environment-reference).

**6. Index the static files.** In production one walk of `public/` records every file's size, mtime, content type, cache-control, whether it has `.br`/`.gz` siblings and an ETag for each variant. A static request then answers from a `Map` lookup with no `stat` call. Dev skips this: it rewrites assets in place under stable names, where a cached ETag would pin the browser to yesterday's bundle.

**7. Bind.** `Bun.serve` with a 30-second socket read deadline (`idleTimeout`, overridable with `BORGO_FRONT_READ_TIMEOUT` in seconds, capped at bun's maximum of 255; `0` disables it), and a WebSocket handler for both the app topic relay and the dev channel. That deadline is not a response-side setting — the same number bounds how long bun waits for an inbound request's headers and body — so a long-lived response needs something other than the knob. The deadline is never lifted and never raised. Instead, for a request that provably has nothing left to send, borgo **keeps the socket warm**: a shared two-second sweep re-arms a short deadline for as long as the exchange is still in flight, and stops the moment bun is done with it. The two moments a request qualifies are the top of `fetch()` when it carries no body and declared none — every GET and HEAD — and in the proxy the instant its body has been read in full, streamed or buffered. A stream reached by a GET qualifies at the first; one reached by a POST qualifies at the second, once its body is in. Streams survive; a POST that declares a `Content-Length` and then dribbles one byte does not. A request that finishes before its first sweep is never touched at all, so ordinary traffic behaves exactly as it does on a stock `Bun.serve`.

The route table is then printed and the server is live. Nothing about the table can change afterwards: adding a page means a restart, which in dev is what the watcher does for you.

## The path of a request

Every request enters one `fetch` handler. The order below is the order in the source, and it matters — the first match wins.

```
  request
    |
    +-- /ws ................ websocket upgrade, Origin checked, topics joined
    +-- POST /__borgo/publish  go -> browser push (loopback, or BORGO_PUSH_KEY)
    +-- /__borgo/dev* ...... dev only: the fast-refresh channel
    +-- /healthz ........... status of both halves
    +-- /metrics ........... prometheus text, only with BORGO_METRICS=1
    |
    +-- /api/* ............. proxied to the go server
    +-- GET|HEAD + a file in public/ ..... static asset
    +-- POST + a page with an action ..... form action
    +-- GET|HEAD + ?__borgo=props ........ loader data as json
    +-- GET|HEAD + a page ................ rendered document
    +-- otherwise ......................... 404 (or the _404 page), 405
```

Four of those are worth following in full.

### A rendered document

`GET /tasks/7` matches `pages/tasks/[id].tsx` at pattern `/tasks/:id` with `params = { id: "7" }`. Then:

1. The page's `loader` runs, handed the request, the params, and a typed `api` client bound to this request's cookies. Every call the loader makes to Go carries the browser's `Cookie` header, so Go handlers see the session during SSR; every `Set-Cookie` Go sends back is collected and will ride out on this response. A loader may also return a `Response` instead of props — that is how [a redirect guard](pages-and-routing.md#a-loader-can-answer-instead-of-returning-props) short-circuits the render.
2. A CSRF token is resolved: the one in the request's cookie, or a fresh one minted alongside this page.
3. A nonce is minted, before the render, because React's own streaming scripts need the same one as the props script.
4. The props are serialized to JSON *before* the render starts. A loader returning something JSON cannot carry fails here, cheaply, instead of abandoning a render already in flight.
5. `renderToReadableStream` produces the React stream. `documentStream` wraps it: shell head, React's chunks, shell tail with the props script.
6. The stream is scanned for the path of the machine it runs on and every occurrence is replaced with `[redacted]`. A loader that renders `import.meta.url` or `new URL("./x.png", import.meta.url)` into markup writes the server's own directory into the document; on Windows the root's native, forward-slash and JSON-escaped spellings are all needles, and the `file://` form is one everywhere. A bare POSIX root such as `/app` is *not* redacted — it is textually a valid root-relative URL — which is why the build refuses the expressions that produce it (see below). The same scan runs on the props JSON, on the head a page computes from it, and on every JSON answer.
7. In production the whole thing goes through a gzip stream with a sync flush per chunk, so streamed Suspense boundaries still arrive progressively.

The response carries `Content-Type: text/html; charset=utf-8`, `Cache-Control: private, no-store`, `Vary: Accept-Encoding`, the CSP with this render's nonce, and any cookies the loader's API calls produced. Documents are never cached, because a document embeds the session-shaped props of whoever asked for it.

A `HEAD` renders for real — the status and headers must be what a `GET` would say — and only the body is dropped and cancelled, so the render does not keep going into a stream nobody reads.

### `/api/*`

The proxy is the thinnest layer in the framework. It rewrites nothing about the payload:

- Hop-by-hop headers (`Connection` and everything it names, `Upgrade`, `Transfer-Encoding`, the `Proxy-*` family) are stripped, because they govern the browser-to-Bun connection, not this one.
- `Host` is dropped and moved to `X-Forwarded-Host` if nothing set one already, so Go's `r.Host` is the API borgo actually dialed rather than whatever the client typed.
- Bodies of at most 10 MB with a stated `Content-Length` are buffered so the request can be retried; larger or chunked bodies stream through once, without retry.
- The response is passed back with `decompress: false` — Go's gzip reaches the browser as Go wrote it, never inflated and recompressed.
- The deadline (`BORGO_API_TIMEOUT`, 30s) covers the wait for response *headers* only, then is dropped, so an SSE stream runs as long as it wants.
- A refused connection is retried three times in production, fifteen in dev, where the API restarts on every `.go` edit.

Failures answer as an API would: `502` when Go is unreachable, `504` on the deadline. Never the rendered 500 page — an API path must not answer HTML. The `/api/*` response is also the one response borgo does not add its own security headers to; Go's headers pass through as they are.

On the Go side two middlewares sit between `ServeMux` and your handler, and both are deliberately pedantic about header spelling, because a cache or a client is allowed to be:

- **gzip.** Responses of at least 1024 bytes are compressed when the client accepts it; smaller ones, event streams, pre-encoded responses and `HEAD` bodies pass through. `Accept-Encoding` is read as one folded list across repeated field lines and coding names compare case-insensitively, so `GZIP` compresses and `gzip, gzip;q=0` is a refusal. `Vary: Accept-Encoding` is set whether or not the response ends up compressed, and the writer is wrapped for every request so a panic means the same thing to a gzip client and an identity one.
- **cache.** `borgo.Cache` writes `public, max-age=…`, but a response that carries `Set-Cookie` is rewritten to `private` on the way out, in whichever order the handler called the two. The guard finds the cookie under any spelling of the key — `w.Header()["set-cookie"]` reaches the wire in `net/http` without canonicalisation — and rewrites `Cache-Control` across every field line a handler left, in the order the writer emits them, so a shared cache can never store a personalised body.

### A static asset

`GET /assets/client-a1b2c3d4.js` is decoded, checked for traversal and separator tricks (on Windows also for the NTFS alternate-stream and reserved characters that alias a file under a name the path checks never saw), and looked up in the boot-time index. A hit answers with the ETag, `Last-Modified`, `Content-Length` and — when the client accepts it — the `.br` or `.gz` sibling written at build time, with `Cache-Control: public, max-age=31536000, immutable` for content-hashed files. `If-None-Match` gets a `304` with no file read at all.

Two classes of file under `public/` are never served, on either the indexed road or the live fallback: a file whose own name starts with a dot (`.DS_Store`, `.gitkeep`, an `.env` somebody dropped, an editor's `.swp`), and anything under a directory whose name starts with a dot (`public/.git/config`, `public/.svn/entries`). The one exception is `.well-known` as the *first* segment, exact and lower-case, because RFC 8615 puts ACME renewals and `security.txt` there and nowhere else. `borgo export` applies the same rule before copying `public/`.

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

The asset build is one `Bun.build` call with `splitting: true` and two entry points. A plugin transpiles your own `pages/*.tsx` with the `loader`, `action`, `prerender` and `prerenderPaths` exports eliminated and unused imports trimmed, which is why a page can `import { db } from "../db"` at the top of its loader and ship none of it to the browser. In production every output is named `[name]-[hash]`, entry points included; `index.html` keeps naming `/assets/client.js` and `/assets/style.css`, and the build records which hashed file each logical name became so the server resolves them at boot. A dev build names its entries `client.js` and `islands-client.js` whatever they contain, which is why `precache.json` carries a content stamp rather than trusting the names.

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
import type { Task } from "../.borgo/api-types";

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

`borgo dev` is the same machinery with three switches flipped: React is built in development mode, precompression and the asset index are skipped, and the front server opens a WebSocket channel to the browser.

```
  borgo dev  (the watcher)
     |
     |-- go build -o .borgo/next-api .   -> swap -> spawn -> poll until it answers
     |                                                          |
     |-- bun serve-entry.ts (BORGO_DEV=1) -----------------------+-> front server :3000
     |                                                                |
     |   fs.watch(".", recursive)                                     |  ws /__borgo/dev
     |     *.go     -> borgogen, rebuild, restart api, reload         v
     |     *.css    -> recompile, hot-swap the <link>              browser
     |     *.ts(x)  -> restart the front server, fast refresh
```

The interesting part is what "restart the front server" means for the browser. A `.tsx` edit kills and respawns the front Bun process with `BORGO_CHANGED` set to the file. That process rebuilds the assets, and while building it records which output chunk each page landed in. When the browser's socket reconnects, the server greets it with that map, and the browser re-imports only the chunk for the page it is on, runs `performReactRefresh`, refetches props through the same `?__borgo=props` endpoint a navigation uses, and re-renders. Component state survives. A layout, the shell or a `.go` file cannot be applied that way and take a full reload instead.

Restarting the whole process for every edit sounds heavy and is not: the module graph is clean every time, so there is no stale-module class of bug at all, and the cost is the asset rebuild, which is a `Bun.build` of your app. A boot that throws does not take the port down — the process falls back to a tiny server that answers every request with the error overlay and keeps the dev channel alive, so the next successful rebuild reloads the browser instead of leaving you with a dead port.

Go edits go through a scratch binary: the build writes `.borgo/next-api` while the old API keeps serving, the output is hashed to skip no-op rebuilds, and only then is the old process killed and the file swapped. The browser is reloaded after the new API answers, not before. [Dev experience](dev-experience.md#fast-refresh) covers the contract from the other side.

## Honest limits

**The route table is a linear scan.** `matchRoute` walks the array and splits strings for each candidate until one matches. Fine for the tens-to-low-hundreds of pages a borgo app has; it is not a compiled trie, and an app with a thousand routes will feel it.

**Everything is resolved at boot, including the route table.** Adding, renaming or deleting a page requires a restart. There is no watch mode in production, by design.

**One process per server.** `Bun.serve` is bound without port reuse, so you cannot run several front servers behind one port. Scale horizontally with several instances behind your reverse proxy, each with its own port.

**The API hop is a real HTTP round trip.** JSON is serialized in Go and parsed in Bun for every loader call, over loopback. It is fast, but it is not a function call, and a page whose loader makes six sequential API calls pays for six. Use `Promise.all`.

**The front server is a proxy, not a gateway.** It does not cache, transform, rate-limit or authenticate `/api/*`. Anything of that kind belongs in Go, or in the reverse proxy in front of borgo.

**Islands ship with the entry, not as separate chunks.** Island components are registered eagerly in `islands.gen.ts`, so `client="visible"` defers the hydration work, not the download. See [islands](client-navigation.md#islands).

**Two processes mean two things to supervise.** `borgo start` hides that behind one command and one exit code, but a `docker stop` still has to reach both, and a split deployment (`--front-only`) puts the burden back on you. [Deploy](deploy.md) covers the layouts that work.
