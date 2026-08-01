# borgo's vision

This file is for people who work *on* borgo, not people who build *with* it. Users get [the README](README.md) and [the docs](docs/README.md). Contributors get this: the principles the codebase already lives by, why each one is grounded in how borgo actually works, and the list of things that will not be added no matter how often they are asked for.

Read it before opening a pull request that adds a feature. Every principle below has cost someone a rewrite at least once.

## The principles

### 1. Move work out of the request path

Anything that can be decided at build time, at boot, or once per process must not be decided per request.

This is not an aspiration, it is how the code is shaped. `borgogen` derives the entire type bridge at build time so no request pays for it. The route manifest, the client manifest and the island registry are generated `.tsx` files, not directory scans. `borgo build` precompresses assets to `.gz`/`.br` so serving one is a file read and a header, not a compression. `gzip.Writer`s and HMAC session signers are pooled in `sync.Pool` because a deflate window is ~800 KB and rebuilding one per response dwarfs everything else in a handler. `borgo.Serve` snapshots the route registry into its mux exactly once — which is why `Handle` panics if it is called afterwards, rather than quietly accepting a route nobody will serve.

The corollary is the review question: *what does this cost per request?* If the answer is "a little", the feature needs to earn it.

### 2. Prefer code generation over runtime reflection

`borgogen` is `go/ast` + `go/types`. There is no `reflect` in the type bridge, no decorators, no runtime route registry built by scanning a directory. The generated `.borgo/api-types.d.ts` and `api/borgo.gen.go` are ordinary files a human can read, diff and blame — and CI does exactly that, failing if regenerating them produces a diff.

Generation also makes the framework's blind spots *visible*. A response written through a helper in another module types as `unknown` in TypeScript, and the escape hatch is a `//borgo:type` directive you can see. Reflection would have guessed, and guessed silently.

### 3. Prefer conventions over configuration

There is no `borgo.config.js`. There never will be. `pages/` are routes, `islands/` are islands, `api/` is Go, `public/` is served, `index.html` is the shell, `_layout.tsx` / `_404.tsx` / `_500.tsx` are special because their names say so, and `export const hydrate` is read *statically from the source text* precisely so the convention cannot depend on running the page.

What configuration exists is environment variables, and they describe facts about the deployment (which port, which secret, where the api lives), not choices about behaviour. A knob that changes what the framework *does* is a convention that was not decided firmly enough.

### 4. Keep the public API small

The Go module exports roughly two dozen symbols. The npm package has one entry point users are expected to import. That is the whole surface, and it is small enough that [the reference](docs/api-reference.md) fits on one page.

Every export is a promise that outlives the release it shipped in. An unexported helper can be rewritten on a Tuesday; an exported one is a support obligation for the rest of 1.x. When a change can be made without adding a name, make it without adding a name.

### 5. Ship a complete framework, not a framework plus twenty required plugins

An app scaffolded with `create-borgo` can serve pages, call typed Go routes, sign sessions, hash passwords, defend form actions against CSRF, stream server-sent events, relay WebSocket topics, compress its own responses, export itself statically, generate its deploy configs and diagnose its own environment — with zero runtime dependencies in the Go module and three in the npm package.

The point is not minimalism for its own sake. It is that a framework whose "getting started" ends with choosing between four session libraries has moved its hardest decisions onto its users. Everything in the list above is something nearly every app needs and nearly every app would otherwise get subtly wrong.

### 6. Every feature must justify its runtime and maintenance cost

Features arrive with numbers. The gzip middleware buffers the first kilobyte because below that the gzip header eats the saving. The response-header snapshot in that middleware is documented as two allocations and ~0.3 µs per response, "under a percent of serving a real request", because someone measured it before shipping it. Login hashing is admitted through a semaphore sized at half of `GOMAXPROCS`, because one PBKDF2 verify costs ~140 ms of CPU and unauthenticated login traffic is otherwise a denial-of-service vector.

A feature proposal that cannot state its cost has not been finished yet.

### 7. The core stays boring, predictable and stable

Go handlers are `func(http.ResponseWriter, *http.Request)` registered on `net/http` method patterns — the standard library's own router is the authority on pattern syntax and conflicts. Pages are plain React components. There is no custom module graph, no proprietary component protocol, no bespoke async model.

Boring means a Go developer can read `borgo.go` in an afternoon, and a React developer already knows how a page works. It also means most bugs are in *your* code, which is where you can fix them.

### 8. Security is a default, not an option

CSRF enforcement is on in production without anyone opting in. Session cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` behind one env var. A request carrying two session cookies is treated as having none, because "first cookie wins" is a session-fixation attack. A failed login verifies a dummy hash so a missing user costs the same as a wrong password. `Bind` caps bodies at 1 MB by default and you must ask for more.

Every one of those is a default someone would have failed to set. Any feature that makes the safe path the longer path is the wrong shape.

### 9. Fail loudly at the boundary, quietly in the request path

`Handle` panics at registration for a malformed pattern, with the file and line of the offending call. A malformed `BORGO_*_TIMEOUT` panics at boot, before the startup banner prints. A missing `SESSION_SECRET` warns at startup instead of surfacing as per-request 500s while `/healthz` stays green.

Once requests are flowing, the polarity flips: a panicking handler becomes a 500 with the abandoned response's headers cleared, an unencodable SSE payload is logged and dropped rather than disconnecting every subscriber, and a slow client skips messages instead of blocking the publisher. Mistakes should be impossible to miss at startup and impossible to escalate at runtime.

### 10. Two processes, one front door — the deployment shape is part of the design

borgo is self-hosted by conviction: a Bun front server, a Go API server, a reverse proxy, one box. `borgo start` supervises both, and the Go side watches `BORGO_PARENT_PID` so a force-killed supervisor on Windows — which delivers no signal — cannot leave an orphan holding the port.

This is why edge and serverless targets are not on the roadmap. They are not merely unimplemented; they contradict a shape the rest of the framework depends on.

### 11. Types are end to end, or honest about not being

The typed bridge covers what static analysis can prove and says `unknown` where it cannot. CI actively asserts the *negative* cases — that a wrong request body, a wrong WebSocket payload and a wrong published event all fail `tsc`. A type system that only proves the happy path is decoration.

### 12. The tool tells you what it did

Startup prints the mounted route table. `borgo build` prints every asset with its gzipped size and the Go binary's size. `borgo doctor` explains what is wrong *and* how to fix it. Output that a user has to interpret is a bug report waiting to be filed.

## Out of scope

The following will not be added to borgo's core:

- **An ORM.** Use `database/sql`, `sqlc`, GORM, whatever fits. The core imposes no database and no schema, which is what lets `borgo.Auth` be mechanics rather than policy.
- **A job queue.**
- **Email sending.**
- **A scheduler / cron.**
- **A Redis abstraction.**
- **GraphQL.**
- **A Prisma wrapper**, or any other adapter for a specific data tool.
- **Cloud provider SDKs.**
- **A CMS.**
- **A large plugin system.** The framework is small enough that the extension mechanism is reading the source and changing it. A plugin API is a second public API surface with all the stability obligations of the first and none of the test coverage.
- **Magic configuration.** No config file that changes framework behaviour, no auto-detection of tooling (Tailwind is opt-in via an explicit flag, never sniffed), no implicit middleware ordering.

### The rule behind the list

A feature belongs in borgo's core only if it does at least one of these:

1. **Makes the runtime more efficient** — it removes work from the request path, or from the build, in a way an application author could not do for themselves.
2. **Materially improves the developer experience** — it eliminates a whole class of mistakes or a whole category of boilerplate, not one afternoon of typing.
3. **Is fundamental to the full-stack model** — it lives on the seam between Bun and Go, where an external library cannot reach: the typed bridge, session cookies both halves can verify, the WebSocket relay, CSRF that spans an SSR render and a form post.

Anything else is a library someone can write, publish and version on their own schedule — and should. That is not a rejection of the idea; it is a statement about where it belongs. An app that needs a queue is better served by a queue library that does nothing else than by a queue that ships inside a web framework and moves at the framework's release cadence.

The list above is not a mood. It is what keeps principles 1, 4, 6 and 7 affordable. Every item on it, added, would be a permanent tax on the ones that make borgo worth using.

## When you disagree

Open an issue before the pull request. A principle that no longer matches the codebase is a bug in this file, and it should be fixed here first — deliberately, with the reasoning written down — rather than eroded one merge at a time.

See also: [CONTRIBUTING.md](CONTRIBUTING.md) for how to work on the repo, [docs/api-stability.md](docs/api-stability.md) for what 1.x will promise, and [docs/api-reference.md](docs/api-reference.md) for the surface that promise covers.
