# The implementation contract

Every app under `bench/apps/<name>/` is a different framework answering the same
requests on one public port. This file is the specification. If your
implementation deviates from it, the runner's pre-flight check fails the
scenario rather than reporting a number — a fast wrong answer is not a result.

The point of fixing the paths rather than letting each manifest map scenario
ids to "wherever this framework naturally puts it" is that a per-framework
mapping is exactly the crack a flattering shortcut crawls in through.

## Ports and process shape

- One public port, taken from the `PORT` environment variable, falling back to
  the `port` in `bench.manifest.json`.
- An implementation may run more than one process (borgo runs a Bun front
  server and a Go API binary). The runner measures the whole process tree, so
  a multi-process design is charged for all of it.
- For the same reason, `start` must launch the server **directly**, not through
  `bun x`, `bunx`, `npx`, `bun run` or a package-manager script. A launcher is a
  process, tree-summed RSS charges it to the framework underneath it, and no
  deployment runs one. borgo was already exempting itself from that overhead by
  invoking its CLI entrypoint directly while Next.js went through `bun x`; the
  rule now applies to everyone and `bench/test/parity.test.ts` fails a manifest
  that breaks it.
- `API_PORT` is provided for implementations that need a second port. Do not
  expose it to the load tool.

## Routes

### `GET /api/hello` — scenario `hello-json`

```
200 OK
content-type: application/json
{"message":"hello, world"}
```

Also used as the readiness probe by default, because it proves the whole chain
is up (for borgo: the front server *and* the Go API behind it).

### `GET /api/items?n=100` — scenario `api-list`

```
200 OK
content-type: application/json
{"items":[ … ],"count":100}
```

`n` is clamped to `[1, 1000]`; a missing or unparsable `n` means 100. Item `i`
(1-based) is exactly:

```json
{
  "id": 1,
  "title": "Item 1",
  "done": false,
  "tag": "beta",
  "createdAt": "2026-01-01T00:00:00Z"
}
```

with `done = (id % 3 == 0)` and `tag = ["alpha","beta","gamma","delta"][id % 4]`.
Key order is `id, title, done, tag, createdAt`.

The list is **generated per request**. Caching it — or precomputing the JSON
string — is out of contract: it would measure the cache, and any framework that
happens to cache would read as a framework that happens to be fast.

The canonical JavaScript implementation is `bench/shared/items.js` — plain ESM
with JSDoc types, so Node, Bun, Deno and every bundler here import the same
file rather than each keeping a copy that can drift. The canonical Go
implementation is `bench/apps/borgo/api/items.go`. New implementations should
import or transliterate one of them, not reinvent it.

The runner checks the whole body, value for value, and the key order as it
appears on the wire, against `bench/lib/canonical.ts` — which is a third
implementation, written from the paragraph above rather than imported from
either of the two. An oracle that imports the module the subject imports agrees
with the subject by construction; it can only catch an implementation that wrote
its own dataset, and it goes blind exactly when the shared module drifts. The
earlier check counted occurrences of `"done":`, which an implementation
returning a hundred items with `done` permanently `false` passes while doing
less work than this asks for.

### `GET /page` — scenario `ssr-page`

Server-rendered HTML, `content-type: text/html`. It must contain:

- a `<title>` of `bench ssr page`
- an element carrying `data-bench-page="ssr"`
- an `<h1>`
- a `<nav>` with five links
- twenty rows rendered from `items(20)`, each showing the item's `title`, `tag`
  and `done` state — so the string `Item 20` appears in the body
- one interactive component that hydrates on the client (a counter button)

The page renders the dataset locally; it does **not** call `/api/items`. That
keeps the scenario a measurement of rendering rather than a compound
measurement of rendering plus whatever data layer the framework prefers. A
loader/fetch variant is deliberately not part of this suite (see the README's
"what is not measured").

### `GET /static/payload.json` — scenario `static-asset`

The file `bench/shared/payload.json` (31,607 bytes,
sha256 `ad25993fad9a7fce485dcfbf570e6559666046c5d532d84f78467b70d14e944c`),
served from disk with `content-type: application/json`. It contains the marker
string `bench-static-asset`.

Every implementation copies that exact file in as a build step
(`bun ../../shared/copy-assets.ts <public-dir>`) so nobody serves a different
number of bytes.

That is now enforced rather than asserted: the pre-flight check hashes the body
that actually arrived and compares both its length and its sha256 with the
values above. A build step is a promise about what is on disk; the hash is a
fact about what went on the wire, and `--skip-build` means the two can differ.

### `GET /api/events` — scenario `memory-conn`

A server-sent-event stream: `content-type: text/event-stream`, and the
connection held open until the client disconnects.

**The first flush must happen immediately**: send a `: ping` comment (or any
event) before blocking. This is not decoration. Some servers — borgo's Bun
front server among them — do not complete the response's header block until the
first body byte, so an endpoint that blocks silently leaves a spec-abiding
client waiting for a `\r\n\r\n` that never comes. The probe would then be
measuring which framework happens to flush eagerly rather than what each
connection costs. Requiring an initial flush from everyone removes the
variable.

After that first flush nothing more need be sent; the probe measures the cost
of *holding* connections, not of pushing through them.

The server must survive the client abandoning connections abruptly, since that
is how the probe ends.

## `bench.manifest.json`

```jsonc
{
  "name": "borgo",                  // directory name, report label
  "framework": "borgo 0.20.1",
  "language": "TypeScript + Go",
  "runtime": "bun 1.3 (SSR) + go 1.25 (API)",
  "status": "implemented",          // or "stub" - see below
  "port": 43000,
  "readyPath": "/api/hello",
  "install": ["bun", "install"],    // optional, run before the build
  "build": [["bun", "run", "build"]],
  "start": ["bun", "run", "start"],
  "env": { "SESSION_SECRET": "…" }, // ${PORT} and ${API_PORT} are substituted
  "implements": ["hello-json", "api-list", "ssr-page", "static-asset", "memory-conn"],
  "notes": "free text shown in the report"
}
```

`notes` and every non-plumbing entry in `env` are printed in the report, in a
table above the results, along with the exact `start` argv. Any key set by
exactly one implementation is additionally called out as tuning that one subject
received and the others did not. This is not bookkeeping: the two things most
worth disclosing in this directory — that borgo raises
`BUN_CONFIG_MAX_HTTP_REQUESTS`, and that Fastify and Elysia are deliberately run
without their fast serialisation modes — both lived only in `notes`, which
nothing printed.

`status` is the honesty valve:

- `"implemented"` — we wrote it, it builds, and it satisfies this contract. The
  runner will run it and publish its numbers.
- `"stub"` — the directory and manifest exist, the app does not run. A stub
  **must** carry a `todo` saying what is missing. The runner skips it and the
  report lists it under "not measured".

There is no third state, and in particular there is no state in which a
half-finished competitor produces a number. A missing competitor is honest; a
badly implemented one is a lie told with a table.
