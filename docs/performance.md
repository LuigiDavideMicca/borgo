# Performance

Where borgo's speed comes from, mechanically: what work has been moved out of the request path, what the network is asked to carry, and where the streams push back. No numbers on this page — it is about the machinery, and every claim on it is something you can go read in the source. Where borgo will lose is at the end, in as much detail as the rest.

If you are looking for the shape of the system first, read [architecture](architecture.md); this page assumes it.

## Work moved out of the request path

The cheapest request is the one that finds everything already computed. borgo's boot sequence exists mostly to make that true.

**The HTML shell is cut up once.** `index.html` is read at boot and split into the exact pieces a render concatenates: the part before `<!--app-->`, that part split again at `</head>` in two versions (with and without the shell's `<title>`, so a page that sets its own does not end up with two), the tail split at the props slot, and two prebuilt tails for pages that ship no JavaScript. Injecting a page's `<head>` is then a join of three strings that already exist. The naive alternative — a regex rewrite of the shell head per request — is the kind of thing that costs nothing on a single request and shows up under load.

**The asset index is built once.** In production, one recursive walk of `public/` records, for every file, its size, mtime, content type, cache-control policy, whether a `.br` and a `.gz` sibling exist, and an ETag per variant. Serving a static file is then a `Map` lookup. No `stat`, no `exists()`, no directory read, no ETag computed per request. A file written after boot is not in the index and falls back to a live lookup, so nothing breaks; it costs more.

**The route table is decided at build time.** `pages/` is scanned by `borgo build`, not by the server. The generated manifest already holds each route's pattern, its module, its resolved layout chain, and whether it uses islands — and the array is already sorted so static segments come before dynamic ones. Matching a request is a walk of that array with no sorting, no filesystem access and no layout resolution.

**The environment is read once.** Ports, the API base URL, proxy timeouts and retry budgets, the body limit, the CSP template, whether CSRF is enforced — all resolved at boot into closures the handler captures. No `process.env` lookups per request, and no chance of a request seeing a half-parsed limit.

**Compression happens at build time where it can.** `borgo build` writes `.gz` and `.br` siblings next to every compressible asset — gzip at maximum level, brotli at maximum quality with a size hint — and keeps them only when they are actually smaller. At request time the server picks a variant and streams the file off disk. Nothing is compressed per request that could have been compressed once.

**Metrics reuse the match the request already did.** The route pattern is the label a Prometheus histogram wants, and it is handed back from the single match rather than recomputed, so turning `METRICS=1` on does not add a second scan of the route table. Asset paths and `/favicon.ico` skip the histogram and the request log entirely.

## Static assets

A static request in production answers from the index, with three things attached: `ETag`, `Last-Modified`, and `Content-Length`.

The ETag is derived from the file's size and mtime, and it is **per variant** — the brotli sibling has a different tag from the identity file, because the same URL negotiates to different bytes depending on `Accept-Encoding`. That matters more than it sounds: a shared tag across encodings is how a cache ends up handing brotli bytes to a client that asked for identity.

```http
GET /assets/client-a1b2c3d4.js
If-None-Match: "1f4c-mkq2p1-br"

304 Not Modified
```

A `304` costs a map lookup and a header comparison. No file is opened. `If-Modified-Since` is honored too, but only when there is no `If-None-Match` to decide first, as RFC 9110 requires.

Content-hashed build outputs — the `[name]-[hash].js` chunks — are served `public, max-age=31536000, immutable`, so a returning browser does not even revalidate them. Entry points and `style.css` keep stable names and are revalidated instead. A generated service worker is deliberately `no-cache`: a heuristically cached `sw.js` would make every deploy lag behind by however long the browser felt like holding it.

Range requests get one subtlety right that matters for correctness rather than speed. `If-Range` makes a range conditional on the client still holding the representation it started downloading; when the validator no longer matches, the whole representation must be sent instead. Because a borgo asset URL negotiates to different bytes per encoding, that mismatch is not exotic — a resume arriving without the original `Accept-Encoding` is asking for a slice of the brotli file to be filled from the identity one. borgo answers the full file, still streamed off disk, never buffered through memory.

## Compression, on both sides

**Go pools its gzip writers.** A `gzip.Writer` carries roughly 800 KB of deflate window and hash tables; allocating one per response would dominate everything else the handler does. `borgo.Serve` keeps them in a `sync.Pool`, and a finished writer is reset to point at `io.Discard` before being parked — so a completed request is not kept alive by the pool, and a stray late write cannot land in someone else's stream.

**Small responses stay identity.** The Go middleware buffers the first kilobyte before deciding: under that, the gzip header and trailer eat most of the saving, so the response ships uncompressed. The same threshold governs buffered JSON on the Bun side. A `Vary: Accept-Encoding` is set regardless of the decision, because a cache that stored an identity response without it would serve those bytes to gzip-capable clients too.

**Nothing is compressed twice.** The `/api/*` proxy forwards Go's response with decompression disabled: gzip written in Go reaches the browser exactly as Go wrote it. Without that, Bun would inflate the body and re-send it as identity — paying for a decompress, throwing away the compression, and inflating the transfer.

**Pre-encoded and streaming responses pass through.** The Go middleware detects `text/event-stream` and an existing `Content-Encoding` at `WriteHeader` time and switches to passthrough, so an event stream is never buffered waiting to reach a compression threshold, and `Flush` on a still-buffering response commits it as identity immediately rather than holding it.

**Documents are gzipped, not brotli'd.** Brotli's compression ratio is worth paying for once at build time; it is not worth paying for on every server-rendered document. Rendered HTML goes through gzip with a sync flush per chunk, which is what keeps streamed Suspense boundaries arriving progressively instead of pooling behind the compressor.

## Streaming with real backpressure

Server rendering produces a stream, and borgo pulls it rather than pushing it.

`documentStream` implements `pull`: React is asked for its next chunk only when the consumer has room for it. A slow client therefore throttles the render instead of letting a whole document pile up in memory ahead of a socket that is not draining. When the consumer goes away — the tab closed, the request aborted — the stream's `cancel` calls `return()` on React's iterator, which ends the render rather than letting it finish a page nobody will read.

Compression is where that property is usually lost, and borgo goes out of its way to keep it. Node's gzip pushes output from a `data` event that cannot consult the consumer's queue, so the pump does the waiting instead: before each read it parks while `desiredSize` is at or below zero, and wakes from the consumer's next `pull`. Without that, the moment a response was compressed — which in production is every document — the render would be drained as fast as zlib accepts writes and the backpressure would be decorative.

Two smaller versions of the same idea:

- A `HEAD` renders for real, because its status and headers have to be honest, and then cancels the body. The render stops; it does not keep going into a stream with no reader.
- A request whose client has already hung up answers `499` and builds nothing. The alternative is expensive in exactly the wrong situation: a client that declares a long body and disconnects would otherwise buy a full `_500` render — loader, API round trip, document — per abandoned upload.

## What the browser is asked to download

**Loader and action code never ships.** Pages are transpiled for the client build with the `loader`, `action`, `prerender` and `prerenderPaths` exports eliminated and unused imports trimmed. A page can import your database module at the top of the file and the browser receives none of it — not the call, not the import, not the transitive dependency. CI greps the built assets for a sentinel to keep that honest.

**One chunk per page.** The client route manifest maps each pattern to a dynamic `import()`, and the build runs with splitting on, so the initial document carries the runtime, React and your layouts, and each page's code arrives when that page is first visited. Navigating fetches the chunk and the loader data in parallel.

**Pages can opt out of JavaScript entirely.** `export const hydrate = false` removes the page from the client manifest, and the render skips the props script and the client entry tag:

```tsx
export const hydrate = false;

export default function About() {
  return (
    <main>
      <h1>About</h1>
      <p>Nothing on this page needs a runtime.</p>
    </main>
  );
}
```

That page ships HTML and CSS. The props are not serialized at all — not sent and not built — and the client entry is not referenced, so the browser never requests it. If such a page contains an `<Island>`, it gets a second, smaller entry that hydrates only the island markers. `export const hydrate = "visible"` keeps the full page bundle but defers the hydration work until the page scrolls into view. [Client navigation and hydration](client-navigation.md#partial-hydration) covers the three modes.

**Navigation transfers props, not documents.** A client-side navigation asks the same URL with `?__borgo=props` and gets the loader's return value as JSON — no shell, no markup, no re-render of anything the browser already has. The response is `private, no-store`, because it carries session-shaped data.

**Prefetching is budgeted.** Links scrolled into view get their route chunk prefetched — the chunk only, because that is a static file and prefetching it costs the server nothing. Loader props are prefetched on a *settled* hover (a short intent delay, so a pointer crossing a long list does not fire one loader per anchor it passes) and immediately on focus or touch, which are deliberate already. Prefetched props live in a small cache with a short TTL and a hard entry cap, and an entry that is evicted without being used has its response body cancelled — an abandoned prefetch would otherwise hold its socket open until the tab closed. A form submission clears the whole cache, because a mutation invalidates any loader data prefetched before it.

## Realtime

**An SSE hub renders each frame once.** `Publish` encodes the event and its JSON payload into wire bytes a single time, then hands the same byte slice to every subscriber's channel. The cost of a broadcast is one encode plus one channel send per subscriber, not one encode per subscriber.

The sends are non-blocking against a small per-subscriber buffer: a client too slow to keep up skips messages rather than blocking the publisher and, through it, every other subscriber. Each write arms a short deadline so one blackholed connection cannot pin its goroutine forever, and the connection's server-wide read and write deadlines are cleared when the stream opens, so a stream is not killed by a timeout meant for slow requests.

**WebSocket topics are a relay, and the relay is dumb on purpose.** A publish serializes the message once and hands it to Bun's topic publish; fan-out is the server's, not a loop in framework code. There is no per-message business logic in the path — that belongs in Go routes, reachable over `/api/*`.

**The event stream is not buffered anywhere.** The Go handler sets `X-Accel-Buffering: no`, the proxy forwards without a body deadline once headers have arrived, and the front server is bound with its idle timeout disabled so a long-lived stream is not cut. [Realtime](realtime.md#server-sent-events) has the handler side.

## The Go side

The `borgo` package imports nothing outside the Go standard library. The `golang.org/x/tools` requirement in `go.mod` belongs to `borgogen`, which is a build-time tool and never links into your API binary; what you deploy is `net/http` plus your code. There is no router library allocating a context per request, no middleware chain of closures, no ORM you did not choose, no dependency injection container resolving graphs at startup.

`borgo.Serve` mounts a plain `http.ServeMux` with method patterns — the standard library's own matcher, which is a trie, so the Go half of the routing is not the linear scan the page side is. Handlers are wrapped in exactly two things: gzip, and a panic recovery that answers `500` only while the response is still uncommitted, so a handler that panicked halfway through a streamed body is logged rather than having garbage appended to it.

`borgo.WriteJSON` marshals before it commits a status, which buys two things: an unencodable value becomes a logged `500` instead of a truncated `200`, and the response can state an honest `Content-Length` instead of falling into chunked encoding.

The timeout matrix is chosen rather than defaulted. `ReadHeaderTimeout` is set, because slow-header clients are a cheap denial of service. Read and write timeouts are deliberately left off, because they are wall-clock deadlines on the whole request and would kill every event stream and every long response; body abuse is bounded by `borgo.Bind`'s reader limit instead. `IdleTimeout` reclaims kept-alive connections. All of them are overridable — see [request limits and timeouts](security.md#request-limits-and-timeouts).

For anything genuinely cacheable, `borgo.Cache` writes the header and lets a proxy do the work:

```go
//borgo:route GET /api/tasks
func ListTasks(w http.ResponseWriter, r *http.Request) {
	borgo.Cache(w, 60*time.Second, 10*time.Minute)
	borgo.JSON(w, http.StatusOK, TaskList{Tasks: tasks})
}
```

It downgrades itself to `private` when the response already carries a `Set-Cookie`, so a shared cache never stores a personalized response by accident. [Caching](auth-and-sessions.md#caching) covers the rule.

## What borgo does not optimize

The list below is where borgo will lose, and to whom.

**Rendered documents are never cached.** Every document goes out `private, no-store`, because it embeds the props of whoever asked for it. There is no full-page cache, no ISR, no stale-while-revalidate for HTML. A framework that can serve a prerendered page from a CDN edge will beat borgo on a cacheable marketing page, badly and correctly. borgo's answers are `borgo export` for pages that are genuinely static and `borgo.Cache` on the API routes underneath the dynamic ones — not the same thing, and no substitute at scale.

**No image or font pipeline.** No resizing, no format negotiation, no font subsetting. The build is one `Bun.build` call and stays that way. Put a CDN, an image proxy or `vips` in front if you need it.

**The page route table is a linear scan.** Every request walks the route array splitting path segments until something matches. Perfectly fine at the scale a `pages/` directory reaches; a framework with a compiled radix trie wins on an app with a thousand routes.

**The front server does not pool its gzip streams.** Go pools its writers; the Bun side allocates a fresh zlib gzip stream per compressed document. That is one allocation on a path that also renders a React tree, so it is not where the time goes — but it is asymmetric with the Go side, and it is not a claim borgo can make about both halves.

**The API hop is a real HTTP round trip.** Every loader call serializes JSON in Go, crosses loopback, and parses it in Bun. A monolith calls a function. Six sequential API calls in one loader cost six round trips — use `Promise.all` — and no amount of framework tuning removes the boundary, because the boundary is the design.

**No component or fragment caching in SSR.** Every document renders the whole tree. There is no memoized subtree, no partial rendering, no equivalent of a server component cache.

**Loader data is not streamed on client navigations.** One JSON payload, fetched in parallel with the route chunk. Streaming is applied to the initial SSR, where it matters most; a navigation waits for the whole loader result before rendering.

**Islands download with the entry.** Island components are registered eagerly, so `client="visible"` defers hydration work, not bytes. A page full of heavy islands ships them all.

**Broadcast fan-out is a loop under a mutex.** The SSE hub holds one mutex while it offers the frame to every subscriber's channel. Correct and cheap for hundreds of connected clients; it is not a message bus, and at tens of thousands of subscribers you want one.

**One process per server.** No clustering, no port reuse, no worker pool. Scale by running more instances behind your reverse proxy.

**No HTTP/2, no TLS.** Both are the reverse proxy's job. That is a deliberate simplification and it means borgo alone, on port 3000, is not a complete edge.

**Dev is not the thing to measure.** In development React is built unminified, precompression is skipped, the asset index is not built, every module carries react-refresh instrumentation, and the front server restarts on every code change. Benchmark `borgo start` against a `borgo build`, or you are measuring the dev loop.
