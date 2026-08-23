# borgo benchmarks

This directory exists so that somebody who does not trust us can check our
performance claims on their own machine.

Everything here is method first, numbers second. The method is written down
before any result, the harness refuses to report a number it could not verify
was correct, and the biases we know about are listed below rather than left for
a reader to find.

**Start here, in order:** this file, then [CONTRACT.md](CONTRACT.md) (what every
implementation must serve), then the runner (`run.ts`), then whatever is in
[results/](results/).

---

## The biases, stated first

A benchmark's credibility is decided by what its authors admit before the
table, not after it.

1. **We wrote the harness and one of the subjects.** borgo is this repository's
   framework. We chose the scenarios, we chose the load parameters, and we wrote
   the borgo implementation with full knowledge of borgo's strengths. Nobody on
   the Next.js, Astro, Hono, Elysia, Express or Fastify teams has reviewed their
   implementation here.
2. **We are better at borgo than at the alternatives.** Each competitor is a
   straightforward, idiomatic implementation, but an expert in that framework
   would very likely make it faster. Where we know a framework has a faster mode
   we deliberately did not use, the manifest's `notes` field says so —
   Fastify's compiled response schemas and Elysia's schema specialisation are
   both called out. Read those notes as "this number is a floor for that
   framework", not a ceiling.
3. **A benchmark app is not an application.** There is no database, no
   authentication, no template of any real weight, no third-party middleware
   stack. Real applications spend most of their time in code no framework wrote.
   A framework that wins here by 3× will not make your app 3× faster.
4. **The comparison is self-hosted-to-self-hosted.** Next.js is measured with
   `next start` on Node, not on Vercel. That is the deployment borgo competes
   with and the one we can reproduce, but it is not the configuration Next.js is
   most optimised for.
5. **Single machine.** The load generator runs on the same box as the server, so
   they compete for the same cores. This compresses the differences between fast
   implementations — at the top end you are partly measuring the load generator.
   Numbers from a two-machine setup on a quiet network would be higher and more
   separated; treat these as conservative, not as maxima.

If you find a scenario tilted our way, that is a bug in the harness. Please open
an issue with the case, or send a better implementation of a competitor.

---

## What is measured

Five scenarios, defined precisely in [CONTRACT.md](CONTRACT.md). Every
implementation serves the *same paths* on one port, so no per-framework path
mapping can quietly point a scenario at a cheaper route.

| scenario | request | what it is for |
| --- | --- | --- |
| `hello-json` | `GET /api/hello` | the floor: request plumbing with almost no work attached |
| `api-list` | `GET /api/items?n=100` | ~15 kB of JSON, generated per request; serialisation and body writing |
| `ssr-page` | `GET /page` | a page with a layout, nav, 20 rendered rows and one hydrated component, server-rendered per request |
| `static-asset` | `GET /static/payload.json` | a 31,607-byte file from disk, byte-identical for every implementation |
| `memory-conn` | `GET /api/events` | RSS at rest, RSS holding N open SSE connections, and the delta per connection |

Plus, recorded for every implementation on every run:

- **time to first successful response** — process spawn to the first 200 on the
  readiness path.
- **RSS after boot** — resident memory once it answers, before any load.

### The memory metric, in detail

`memory-conn` is the metric the roadmap singles out, so it gets the most care:

1. The server is started and left alone. RSS is sampled repeatedly until two
   consecutive windows agree within 2% — a runtime that is still growing (or
   still handing pages back after earlier work) does not give a usable baseline.
   If it never stabilises, the result is flagged `reliable: false` and says so.
2. N SSE connections are opened, over **raw TCP sockets, not `fetch`**. Every
   runtime's `fetch` pools and caps connections per host, so a `fetch`-based
   probe measures the client's pool size. Only sockets that came back with a
   `200` status line are counted.
3. After a settle, RSS is sampled again.
4. The reported figure is `(loaded − idle) / connections established`.

RSS is summed over the **whole process tree**. borgo runs two processes (the Bun
front server and the Go API binary) and is charged for both. The per-process
breakdown is in every report, so you can see what the total is made of rather
than trusting one figure.

Because the tree is charged in full, each implementation is started the way it
would be started in production, not the way it is started in a terminal. borgo
is launched through its CLI entrypoint directly — the invocation in its own
shipped `Dockerfile` — rather than via `bun run start`. The latter interposes a
launcher chain that no deployment runs and that tree-summed RSS would charge to
the framework: measured on this machine, boot RSS was 131.0 MiB through
`bun run start` and 93.2 MiB through the CLI entrypoint, a 37.8 MiB difference
that is entirely wrapper processes.

**That exemption used to be borgo's alone.** Next.js was started with
`bun x next start`, which interposes exactly the kind of launcher borgo had been
excused from, and its boot and idle RSS were charged for it. It now starts on
`node node_modules/next/dist/bin/next start`, the same shape as everybody else,
and `bench/test/parity.test.ts` fails any manifest that reintroduces a launcher.
Expect borgo's margin over Next.js in the startup and memory tables to be
smaller than it was, by roughly the size of a bunx process.

Boot RSS is also polled until it stops moving, rather than sampled 600 ms after
the first response. A runtime read mid-allocation reports how far along its
growth curve it happened to be, and these runtimes do not grow at the same rate.
If it never settles, the row says so. This raises the figure for the runtimes
that grow lazily, borgo's Bun front server among them.

Honest limits of this metric:

- Absolute RSS says more about an allocator's growth policy than about a
  framework. The *delta* is the comparable number, and even it is a lower bound:
  neither runtime returns freed pages to the OS promptly.
- The probe runs **before** the load scenarios, deliberately. A server that has
  just absorbed 90 seconds at full concurrency is not at rest, and using it as a
  baseline can produce a negative delta. (We know because it did, before the
  ordering was fixed.)
- A negative or zero delta is reported as a measurement floor with an explicit
  note, never as "connections are free".

### What is deliberately *not* measured

- **Cold start / serverless.** borgo is a self-hosted long-running process. Cold
  start is a metric for a deployment model we do not target, and quoting it
  would be picking a fight we set up to win.
- **Build times and bundle sizes.** They matter, but they are a different claim
  and belong in a different table.
- **A page that fetches through the framework's data layer.** `ssr-page` renders
  a locally generated list. Adding an API round trip would make it a compound
  measurement of rendering *plus* each framework's preferred data layer, with
  much higher variance and much lower interpretability.
- **Compression.** The load tool requests identity encoding and no
  implementation compresses. This is a choice *against* borgo: `borgo build`
  precompresses assets to `.gz`/`.br`, and that real advantage is excluded here
  so that every implementation ships identical bytes.
- **TLS.** Everything is plain HTTP on loopback. In production a reverse proxy
  usually terminates TLS.
- **Latency under a fixed request rate.** The load scenarios run open-throttle,
  which means the latency percentiles are throughput-saturated and subject to
  coordinated omission. They are reported because they are informative about
  tail behaviour at saturation, not because they are service-level latencies.

---

## Method

### Load generator

[`oha`](https://github.com/hatoo/oha), pinned to **v1.15.0**, chosen because it
emits machine-readable JSON including a per-status-code breakdown — so a run
that is fast because it is returning 500s cannot be reported as a win.

`bun tools/get-oha.ts` downloads the pinned release into `bench/.tools/` and
verifies its sha256 against a hash recorded in that file. The Windows x64
artefact is pinned at
`cfd51293ba621eea0616848a78caf360855859364d2ea8e23df515d791c91383`; hashes for
platforms we have not downloaded ourselves are `null`, and the tool prints what
it saw rather than us inventing a value.

The exact invocation is recorded in every result file. It is:

```
oha -z <duration>s -c <connections> --no-tui --output-format json --disable-compression <url>
```

Keep-alive stays **on**: it is what browsers and reverse proxies do, and
disabling it would measure the OS accept path instead of the server.

`wrk` is supported as a fallback and its text output is parsed. **That parser
has not been exercised on this machine** (wrk does not build on Windows) — treat
the first wrk-based run as a test of the parser as much as of the server.

If neither tool is present and `--no-download` was passed, the runner **refuses
to run**. It does not fall back to a hand-written request loop: that would put
the load generator in the same runtime as one of the subjects and measure our
own client.

### Parameters

| setting | default | why |
| --- | --- | --- |
| connections | 64 | enough to saturate a fast server on a laptop without the load tool becoming the bottleneck |
| duration | 30 s per run | see the warmup note below — short runs badly undercount JIT runtimes |
| warmup | 5 s, discarded | JITs warm, pools fill, the first GC happens |
| runs | 3 | **the median is reported, never the best** |
| memory connections | 1000 | large enough that per-connection cost clears the sampling noise |

**Warmup is not a formality.** During development the same borgo scenario
measured 4,550 req/s over 3 s at 16 connections and 17,127 req/s over 10 s at
64 connections. A JIT runtime measured over a short window reports roughly a
quarter of its steady-state throughput. Any benchmark of Bun, Node or Deno with
sub-10-second runs should be disbelieved, including ours if we ever publish one.

Beside the median the report prints the **range over the runs**, a **95%
confidence interval** of the mean, and the **relative standard deviation**. Three
runs is a small sample and the interval is correspondingly wide; that width is
the point. With fewer than two runs there is no dispersion at all, and the
columns say `n/a` rather than `0.0%` — a figure that has never been repeated is
not a figure with zero variance.

Each app is measured once early and once late in the campaign (two sweeps, in
opposite directions), and the report **compares them**: if an app's two sweeps
disagree by more than the run-to-run noise inside a sweep, that row is marked as
drift and is not a framework comparison. The second sweep costs an hour and used
to buy nothing but a second row.

### Correctness before speed

Before any scenario is loaded, the runner issues one request and checks it
against the contract: status, content type, required substrings, structural
counts, and — where CONTRACT.md pins the answer exactly — the **whole body**.
`/api/hello` and `/api/items` are compared value for value, including the key
order on the wire, against an independent transliteration of the contract in
`lib/canonical.ts`. `/static/payload.json` is compared by exact length and
sha256. A scenario that fails the check is reported as `failed` with the reason.
A fast wrong answer is not a result, and an item list whose `done` flag is
permanently `false` is a fast wrong answer that a count-based check could not
see.

After the load, a median success rate below 99% fails the scenario too, so a
server that hits its concurrency ceiling and starts refusing connections cannot
post a throughput number.

When a scenario fails, the result records whether the server was still running
and the tail of whatever it printed — so "unable to connect" comes with the
evidence rather than requiring a guess.

### Environment recording

Every result file carries an environment block captured automatically: OS type
and release, architecture, CPU model and logical core count, total and free
memory, the versions of Go, Bun, Node, npm and Deno, the borgo package version,
the repository commit **and whether the working tree was dirty**, and the load
tool and its version.

It also carries a **CPU-idle reading taken before the first app is started and
another after the last one is killed**. "Run it on a quiet machine" was advice
and nothing more: a campaign run alongside a build produced numbers that looked
exactly like a campaign run on an idle box. If more than 10% of CPU time was
busy before anything was measured, the runner says so on the terminal and the
report opens with a warning that the numbers are contaminated. Free memory is
recorded at both ends for the same reason.

What the runner still cannot know — mains power, thermal state, what else was
running — is what `--note` is for. It is recorded verbatim and printed in the
report. If it is omitted, the report says out loud that nobody attested to any
of it, rather than printing an empty cell.

### What the report says it cannot check

Every report ends with a section listing what the harness does not enforce: that
each competitor is implemented as well as its own experts would implement it,
that borgo was not written with more care than the others, that the load
generator is not itself the bottleneck, that the machine stayed quiet
*throughout*, and that the latency percentiles are anything other than
saturation percentiles. A harness that cannot enforce a condition has to print
that fact, not stay quiet and let the table imply otherwise.

### Process hygiene

This repository has been bitten by orphaned processes before, so:

- Every spawned process is killed as a **tree** (`taskkill /T /F` on Windows,
  process-group kill on POSIX), which matters because borgo's front server has a
  Go child.
- Live PIDs are written to `bench/.tools/running.pids` as
  `<runnerPid>:<serverPid>`, so a runner that is hard killed leaves a trail.
  `bun run.ts --cleanup` drains it, and every run drains it on startup.
- **Only orphans are drained.** An entry whose owning runner is still alive is
  left strictly alone, because it is being measured with. Without the owner
  field, starting any second runner — even one that immediately refuses for an
  unrelated reason — kills the first one's server mid-measurement and turns a
  valid run into a page of "unable to connect". That happened once here; the
  owner field is the fix, and `--cleanup` now reports what it left alone.
- Cleanup runs from `SIGINT`, `SIGTERM`, `SIGHUP`, `exit`, uncaught exceptions
  and unhandled rejections.
- Before starting an implementation the runner checks its port is free, and
  **refuses** rather than measuring somebody else's server. After stopping it, it
  waits for the port to be released before the next app.

---

## Running it

```bash
bun bench/run.ts --list                 # implementations and scenarios, run nothing
bun bench/run.ts --apps borgo           # one implementation, default parameters
bun bench/run.ts                        # every non-stub implementation
bun bench/run.ts --cleanup              # kill servers left by a crashed run
bun bench/run.ts --help                 # all options
```

Results are written to `bench/results/` as a JSON file (everything, including
each individual run) and a markdown file (the readable table). Both carry the
environment block.

Prerequisites: Bun ≥ 1.3 and Go ≥ 1.25 for borgo; Node for the Node
implementations; Deno if you implement Fresh. The runner downloads `oha` on
first use unless you pass `--no-download`.

---

## Implementations

| directory | framework | status | scenarios |
| --- | --- | --- | --- |
| `apps/borgo` | borgo (this repo) | implemented | all five |
| `apps/nextjs` | Next.js 15, App Router, `next start` | implemented | all five |
| `apps/astro` | Astro 5, standalone Node adapter | implemented | all five |
| `apps/hono` | Hono on Bun | implemented | all but `ssr-page` |
| `apps/elysia` | Elysia on Bun | implemented | all but `ssr-page` |
| `apps/express` | Express 4 on Node | implemented | all but `ssr-page` |
| `apps/fastify` | Fastify 5 on Node | implemented | all but `ssr-page` |
| `apps/fresh` | Fresh on Deno | **stub** | none |

Hono, Elysia, Express and Fastify are routers, not meta-frameworks. They do not
claim `ssr-page`, because rendering React through them would be an application
we wrote rather than anything the framework provides. The runner reports those
cells as skipped, not as zero. They are here as a floor: they show what the
request plumbing costs when there is almost no framework above it.

Fresh is a stub because Deno is not installed on the machine this harness was
built on. Writing a Fresh app blind and shipping its numbers would be worse than
leaving the row empty: if it were slow because we got it wrong, the table would
say Fresh is slow. See `apps/fresh/README.md` for how to finish it.

Adding an implementation: create `apps/<name>/`, satisfy
[CONTRACT.md](CONTRACT.md), write a `bench.manifest.json`. Set `status` to
`"stub"` with a `todo` until it genuinely works — there is no third state, and
in particular none in which a half-finished competitor produces a number.

---

## Verified on Windows / needs Linux

This harness was built and run on Windows 11 (x64). Being explicit about what
that does and does not establish:

**Verified on Windows, end to end**

- The runner: tool detection, pinned `oha` download and checksum, build, start,
  readiness probe, warmup, measured runs, teardown, JSON and markdown output.
- Process-tree kill via `taskkill /T /F`, including borgo's Go child; confirmed
  no listener survives a run, and `--cleanup` drains a stale pidfile.
- RSS sampling via `Get-CimInstance Win32_Process` (`WorkingSetSize`), summed
  over the process tree.
- All seven non-stub implementations built, started and satisfied the contract.
- The `oha` JSON parser, against real `oha` output.

**Written but not verified — needs a Linux (or macOS) run**

- `sampleLinux()` (`/proc/<pid>/status`, `VmRSS`) and the `ps` fallback used on
  macOS. The tree-walking logic is shared and exercised; the per-platform
  readers are not.
- POSIX process-group kill (`process.kill(-pid)`) and the `detached: true`
  spawn that makes it exact.
- The `wrk` output parser.
- Fresh, entirely.

**Expect the numbers themselves to differ on Linux**, probably substantially.
Loopback networking, the scheduler and the allocators all behave differently.
Do not carry a number from a Windows run into a Linux claim, or the reverse.

---

## Findings from building the harness

Three things fell out of building this that are worth recording, because all
three are the sort of thing a benchmark exists to surface. The first two have
since been fixed in borgo itself; they stay here because the harness is what
found them.

### 1. Concurrent SSE streams were capped at ~255 by default

borgo's front server proxies `/api/*` to the Go binary using Bun's `fetch`, and
Bun caps simultaneous outbound HTTP requests at **256** by default. Every held
SSE stream is one in-flight request, so a stock borgo app ceilinged at roughly
255 concurrent event-stream clients — the 256th connected and then waited.

Measured directly: 400 requested → 255 established. With
`BUN_CONFIG_MAX_HTTP_REQUESTS=16384`, 800 requested → 800 established.

**Fixed since.** `borgo start` now re-runs itself once with the variable set to
`16384` when nothing set it, and every deployment borgo writes sets it
explicitly — see [realtime](../docs/realtime.md#honest-limits). The borgo bench
app still sets it in its manifest `env` so that no re-exec'd supervisor
process appears in the tree the memory probe charges, and its `notes` say so.

### 2. Bun withholds end-of-headers until the first body byte

A response whose body is a stream that has not yet produced a byte is written
by `Bun.serve` as its header *lines* without the terminating blank line, so a
client that waits for `\r\n\r\n` — as the HTTP spec requires, and as Bun's own
`fetch` does — hangs indefinitely against a server that is behaving otherwise
correctly. `curl` streams and shows the headers, which is why this is easy to
miss. Reproduced on Bun 1.3.14 with a bare `Bun.serve` and an empty
`ReadableStream`, so it is the runtime, not the proxy: the Go API terminates
its header block correctly when hit directly on `API_PORT`.

**Fixed since, for borgo apps.** `borgo.SSE` writes an `:ok` comment frame and
flushes before returning the stream, so a quiet stream crosses the proxy with
its headers complete. The contract still requires every implementation to flush
a `: ping` comment immediately, which is good SSE practice anyway and removes
the variable from the comparison.

### 3. An SSE connection is charged to both processes

The committed proof run measures **65.8 kiB of RSS per held SSE connection** across the
tree. That is not obviously a Go-runtime win, and the per-process breakdown says
why: a browser's event stream traverses the Bun front server *and* the Go API,
so each connection costs a Bun-side proxied fetch plus a Go-side goroutine and
its stack. Holding 1,000 streams grew the Bun process and the Go process
together.

Before the release claims memory-per-connection as a borgo advantage, this
number needs a competitor beside it — and the architecture, not just the
runtime, is what it will be measuring. The harness now makes that easy to check;
it does not make the claim.

---

## Layout

```
bench/
  README.md              this file - method, biases, limits
  CONTRACT.md            what every implementation must serve
  run.ts                 the runner
  tsconfig.json          typechecks run.ts, lib/ and tools/
  lib/
    env.ts               automatic environment capture
    load.ts              oha/wrk detection, invocation, parsing
    manifest.ts          manifest loading and validation
    memory.ts            RSS sampling and the SSE connection-holding probe
    paths.ts             directory resolution
    proc.ts              spawning, tree-kill, pidfile, port checks
    report.ts            JSON and markdown output
    canonical.ts         CONTRACT.md's bodies, transliterated as an oracle
    scenarios.ts         the scenario definitions
    stats.ts             median, RSD, range, 95% CI
    types.ts             shared types
  test/                  the harness's own tests: stats, oracle, report, parity
  shared/
    items.js             the one dataset definition for every JS implementation
    payload.json         the one static asset, copied into every app
    copy-assets.ts       copies the above into an implementation
  apps/<name>/           one implementation each, plus bench.manifest.json
  tools/get-oha.ts       pinned, checksummed load-generator download
  results/               committed example output
```
