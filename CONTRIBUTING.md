# Contributing to borgo

Read [VISION.md](VISION.md) first if you are proposing a feature — it says what borgo will and will not grow into, and it will save you writing something that cannot be merged. This file is about the mechanics: how to set the repo up, how to run every gate CI runs, and what a mergeable change looks like.

## Prerequisites

| Tool | Version | Why |
| --- | --- | --- |
| [Bun](https://bun.sh) | `>= 1.3.0` | Declared in `engines.bun` for both packages. The CLI, the front server, the build and the TypeScript tests all run on it. |
| [Go](https://go.dev) | `>= 1.25.0` | The floor declared in `go.mod`. Two things below it are already hard requirements: `crypto/pbkdf2`, which the default password hasher uses, and the `go.mod` `tool` directive that apps invoke `borgogen` through — both arrived in 1.24. |
| Git | any recent | — |

CI pins Bun to `1.3.14` — the version the lockfiles were produced with, because `--frozen-lockfile` is resolver-sensitive — and Go to `stable`. So a change that needs a newer Go than the table says will pass CI and fail for contributors, and a change that needs a newer Bun than `1.3.14` fails CI. If you raise a floor, raise it in `go.mod` / `engines` and in this table too. A separate weekly job, `bun-latest`, runs `check:docs` and `bun run test` on Bun `latest` as an early warning for the pin; it runs on a schedule only, never on a pull request.

Playwright's browser is installed on demand:

```bash
npx playwright install --with-deps chromium
```

Nothing borgo itself builds or runs needs Node — the CLI, the front server, the build and the tests are all Bun. Node still has to be on your machine to develop borgo, because two things around the edges want it: the `npx playwright` line above (and the same line in CI), and the publish workflow, where npm's trusted publishing needs it. `borgo doctor` reports Node for this reason and treats its absence as a note, not a failure.

## Setup

```bash
git clone https://github.com/LuigiDavideMicca/borgo
cd borgo
bun install
```

`bun install` at the root installs the whole workspace: `packages/*` and `examples/*`. CI uses `bun install --frozen-lockfile`; if your change alters `bun.lock`, commit it.

The example app under `examples/tasks` has a `replace` directive pointing the Go module at the repository root, so it always builds against your working copy rather than a published tag. It is the fixture the doc snippets, the end-to-end tests and the smoke test all run against — a change that breaks it breaks CI.

## Repository layout

```text
*.go                     go module github.com/LuigiDavideMicca/borgo — route registry, server
                         bootstrap, sessions, auth, sse, push, cache, gzip, watchdog.
                         Standard library only.
cmd/borgogen             the codegen binary: go/ast + go/types static analysis, no reflection.
                         Part of the same module — it has no go.mod of its own — so the root
                         go.mod requires golang.org/x/tools and a scaffolded app inherits it
                         as an indirect requirement. Fixtures live in cmd/borgogen/testdata.
packages/borgo           npm "borgo-framework": the CLI, the Bun SSR front server, the router,
                         the build, the browser runtime, the typed api client.
packages/create-borgo    npm "create-borgo": the scaffolder and its three templates.
examples/tasks           the demo app CI exercises end to end.
docs/                    the user documentation. Every snippet in it is compiled by CI.
e2e/                     playwright specs, named *.e2e.ts so `bun test` does not collect them
                         (it cannot run them), run against a production build of examples/tasks.
scripts/                 check-doc-links.ts — the docs gate.
.github/workflows        ci.yml (everything below), release-please.yml, publish.yml.
```

Two rules follow from the layout. **No package an app links into its binary may import anything outside the standard library** — that is the promise "zero deps" is shorthand for, and it is about the *runtime*, not about `go.mod`. `golang.org/x/tools` is in `go.mod` because `cmd/borgogen` lives in this module and needs it; it is a build-time tool, so nothing it imports reaches a deployed api binary. A new requirement is acceptable only if `cmd/borgogen` is the only thing that imports it; anything the root package needs must come from the standard library. And `packages/borgo` is the only package apps import, so its `exports` map is the whole public TypeScript surface; see docs/api-reference.md before adding to it.

## The gates

CI runs all of these on every pull request and on every push to `main` — pushes to a branch with no pull request open are not built. Run them locally before opening one, in this order, because the cheap ones fail fastest.

```bash
bun run check:docs                    # docs links resolve, doc snippets compile
cd examples/tasks && bun run build    # writes the generated files typecheck covers, see below
bun run typecheck                     # tsc --noEmit across every project the gate owns
bun run test                          # bun test packages/borgo/test packages/create-borgo/test e2e
go test -race ./...                   # the go module and borgogen, race detector on
bunx playwright test                  # end to end, against a production build of examples/tasks
```

What each one actually is, verified against `package.json` and `.github/workflows/ci.yml`:

- **`bun run check:docs`** (`bun scripts/check-doc-links.ts`) — every internal link in the README, all of `docs/`, and each package and template README points at a file that exists, with the anchor it names. Then every `ts` / `tsx` fenced block becomes a module inside `examples/tasks` and is typechecked against the real framework types, and every `go` block that opens with a declaration is compiled inside the example's module. Failures are reported at the line of the doc file, not the scratch file.
- **`bun run typecheck`** — `bun scripts/typecheck.ts`, which owns the list of projects: the repo root (`e2e/`, `scripts/`, `playwright.config.ts`), `tsconfig.dts.json`, `packages/borgo`, `packages/create-borgo`, `examples/tasks`. Two things about it. First, it asserts that every literal path a project's `include` names actually exists before running `tsc` — an include entry that matches nothing is silent, and the six generated entries under `examples/tasks/.borgo` are gitignored, so on a clean checkout the gate used to report success having checked none of them. Run `cd examples/tasks && bun run build` first, as CI does. Second, `tsconfig.dts.json` is the only project with `skipLibCheck` off: everywhere else that option skips the body of *this repo's* `.d.ts` too, generated API contract included, so that one project checks them and nothing else. `bench/` is its own project with its own lockfile — `cd bench && bun install --frozen-lockfile && bun run typecheck`, which is exactly the CI step.
- **`bun run test`** — `bun test packages/borgo/test packages/create-borgo/test e2e`. The `e2e` argument collects exactly one file, `e2e/reach.test.ts`, which asserts that no Playwright spec is named in a way bun would collect. Mostly unit tests, but not exclusively: `proxy.test.ts`, `action-path.test.ts`, `serve-assets.test.ts`, `compress.test.ts`, `body-limit.test.ts`, `util.test.ts` and `doctor.test.ts` each bind a real listener with `Bun.serve` on an ephemeral port (`port: 0`) and drive it over HTTP, and `create-borgo`'s suite spawns the scaffolder as a subprocess into a temp directory. They clean up after themselves and need no fixed port, so the suite is still safe to run beside a live `borgo dev` — but it is not a pure in-memory suite, and a change to the proxy or the asset server is genuinely exercised over a socket here.
- **`go test -race ./...`** — the root module and `cmd/borgogen`, including its fixture apps under `testdata`. `bun run test:go` is the same suite without `-race`; CI uses `-race`, so use `-race`.
- **`bunx playwright test`** — the root script `bun run e2e` and CI's `npx playwright test` run the same config. It builds and starts `examples/tasks` itself on port 3400, then runs four projects in dependency order: the app specs, the destructive `clear-all` spec, a dev-server project for fast refresh, and an export project last. Expect a few minutes.

CI also runs, and you should reproduce locally when you touch the relevant area:

```bash
go build ./... && go vet ./...
gofmt -l . | grep -v testdata            # must print nothing
cd examples/tasks && go tool borgogen    # then: git diff --exit-code -- .borgo/api-types.d.ts api/borgo.gen.go
docker build -f examples/tasks/Dockerfile -t borgo-tasks .
```

The `borgogen` freshness check is the one that catches people: generated files are committed, so if your change alters what the generator emits, regenerate and commit the result in the same commit. CI compares byte for byte.

CI additionally asserts three *negative* type cases — that a wrong request body, a wrong WebSocket payload and a wrong published event each make `tsc` fail. If you change how types are generated, check that these still fail for the right reason and not because the file no longer compiles for an unrelated one.

The rest of the `ci` job, in the order it runs after the steps above, has no root script of its own:

- **build example go module** — `go build ./... && go vet ./...` inside `examples/tasks`.
- **server-only sentinel** — `examples/tasks/pages/index.tsx` contains the string `borgo-server-only-sentinel` and nothing under `examples/tasks/public/assets` does, after `bun run build`. It is the proof that loader code never reaches a client bundle.
- **smoke test** — `bun run start` in `examples/tasks`, then `curl` against `/`, `POST /api/tasks` and `/tasks/1`.
- **scaffold test** — packs `packages/borgo` with `bun pm pack`, scaffolds the `base` template against the tarball and the working-copy Go module, checks that `go tool borgogen` reproduces the shipped `.borgo/api-types.d.ts` byte for byte, runs `bunx tsc --noEmit` and `bun run build`, starts the app on `PORT=3100 API_PORT=3601` and curls `/`, `/hello/ci` and `/api/hello`. Then the same, without the serve round-trip, for `minimal`, `full` and `base --tailwind` (which also asserts the hashed stylesheet contains both the compiled utilities and the template's own rules).

Two more jobs run beside `ci`, not after it:

- **`docker`** — `docker build -f examples/tasks/Dockerfile -t borgo-tasks .`.
- **`go-macos`** — `go build`, `go vet` and the watchdog's darwin tests (`go test -race -count=1 -run '^(TestProcess|TestWaitParentExit|TestKinfo|TestProcStat|TestHelper)' .`) on `macos-latest`. It is the only place the `kern.proc.pid` sysctl reading, the struct offsets it hardcodes and the zombie cases execute; the ubuntu job takes the `/proc` branch. The job exists in the working tree but has not yet run on GitHub — it arrived in a commit that is not pushed — so treat it as unproven until its first green run, and if you touch `watchdog_*.go` run those tests on a Mac yourself.

## Commits and releases

release-please builds the release PR from commit subjects, so the format is load-bearing:

```text
<type>: <description in lowercase, present tense>
```

Types in use, by frequency: `fix`, `feat`, `docs`, `test`, `chore`, `refactor`, `perf`, `ci`, `build`. `feat` produces a minor, `fix` and `perf` produce a patch, everything else produces no release on its own. A `!` after the type, or a `BREAKING CHANGE:` trailer, marks a breaking change — see docs/api-stability.md for what qualifies, and expect a conversation before it merges.

Scopes are not used. Descriptions read as statements about behaviour, not as instructions:

```text
fix: a missing session secret is an error, not a panic mid-request
fix: the scaffolder lets go of the terminal instead of hanging after its summary
feat: borgo pwa init writes the manifest and service worker instead of describing them
docs: auth states what the framework guarantees and what you still owe
```

Two hard rules on commits:

- **One deliverable per commit.** A commit should be revertible on its own.
- **No AI attribution.** No `Co-Authored-By` for an assistant, no generated-with trailers, no tool names in the message. The commit log is a record of what changed and why, and nothing else.

Merging the release PR tags `vX.Y.Z` and publishes both npm packages with linked versions; the Go module resolves the same tag because it lives at the repository root. One version number across the four things that must agree — the Go module, the two npm packages, and the `borgo` CLI that ships as `borgo-framework`'s `bin` (see docs/api-stability.md). Do not bump versions by hand.

The one exception is `Version` in `borgo.go`, which release-please cannot reach: it resolves `extra-files` relative to a package's own path, and giving the repository root a package entry would have it claim the same tag `packages/borgo` already owns. So the release PR needs one extra commit setting that constant to the version the PR is cutting. You cannot forget silently — `TestVersionMatchesManifest` reads `.release-please-manifest.json` and fails the build when they disagree, naming the value it expected.

## What a mergeable change looks like

**A bug fix arrives with the test that would have caught it.** Not a test that exercises the area — the specific test that fails on the parent commit and passes on yours. If you cannot write one, say so in the pull request and explain why; sometimes the honest answer is that the bug is only reachable end to end, and an `e2e/` spec is the right home.

**Prove the test is not vacuous.** Before you commit it, break the implementation it covers — invert the condition, delete the guard, return the wrong status — and confirm the test goes red. A test that passes against a broken implementation is worse than no test, because it will be trusted. This is a habit, not a tool: there is no mutation-testing harness in the repo, so the mutation is something you do by hand and then undo.

Run the mutated suite **for the whole file or package, never filtered with `bun test -t` or `go test -run`.** This repository has been caught by that four times: a filtered run is a cold process with nothing else loading, so a test that waits on a timer, a watchdog probe or a subprocess gets more slack than it gets inside the full run, and passes with the defect present. The verdict you want is the one CI reaches, and CI runs `bun run test` and `go test -race ./...` unfiltered.

**A pruning must prove zero behaviour change, and the proof is not the binary hash.** `md5sum` of the Go binary moves when a line number moves, because file positions live in `pclntab`; the minified bundle moves when identifier frequencies change, because the minifier names by frequency. Compare what survives both: for Go, `go tool objdump` of the two binaries with the address and `file:line` columns stripped; for TypeScript, an unminified build of the two trees with comments stripped. Equal output there is the claim; a hash alone says nothing either way.

**Docs are part of the change.** A new API, a new convention, a new environment variable or a new CLI flag lands with its documentation in the same commit. Snippets in `docs/` are compiled by CI, so an example that does not build is a failing build, not a stale paragraph — which is the point. If a snippet is deliberately partial, mark the fence `no-check`; if it is a Go fragment rather than a declaration, the checker skips it automatically.

**New public API is a decision, not a detail.** Every export is a support obligation for the rest of the major version. Say in the pull request why it has to be exported, and add it to docs/api-reference.md with a stability marker. If it could be internal, make it internal.

**Performance claims come with numbers.** The codebase states costs where it makes a trade — the gzip buffer threshold, the header-snapshot cost, the hash-slot sizing. Follow that: if your change is for speed, say what you measured and how.

## House style

**Go.** `gofmt` decides formatting; CI enforces it. Standard library only in the root module. Errors are values and sentinel errors are compared with `errors.Is`. Panic at registration and boot, never in a request.

**TypeScript.** No formatter is enforced; match the surrounding file — two-space indent, double quotes, semicolons, trailing commas in multi-line literals. No default exports except where a convention requires one. Prefer `type` over `interface` unless the type has to be augmentable (`ApiRoutes` and `WsEvents` are interfaces for exactly that reason).

**Comments are sparse and explain constraints, not mechanics.** The code says what it does; a comment exists to say why it could not be done the obvious way. The ones already in the tree are the model:

```text
// an informational 1xx leaves the response uncommitted: a handler that
// panics right after sending early hints must still get its 500

// the nil writer means the server cannot mark the connection
// close-after-reply on overflow: Bind's signature has no ResponseWriter

// segments are compared without collapsing empty ones: "//foo" and "/a//b"
// are distinct urls, not aliases of "/foo"
```

Each of those exists because someone would otherwise have "simplified" the code and reintroduced a bug. A comment that restates the next line is noise; delete it. Lowercase prose in comments is the prevailing style — follow it.

**Error messages are instructions.** `borgo.Handle`'s panic names the bad pattern, the file and the line, and says what a correct one looks like. `borgo doctor` says what is wrong and how to fix it. Hold new messages to that standard: what happened, where, and what to do.

## Reporting bugs and proposing features

Bugs: [issues](https://github.com/LuigiDavideMicca/borgo/issues), with the versions of borgo, Bun and Go, and the smallest reproduction you can manage. [FAQ and troubleshooting](docs/faq-and-troubleshooting.md) has the symptoms that already have one-line answers.

Features: open an issue before the pull request, and frame it against the rule in [VISION.md](VISION.md) — a feature belongs in the core only if it moves work out of the request path, materially improves the developer experience, or is fundamental to the full-stack model. Anything else is a library someone can write, and saying so early is kinder than saying it after you have written the code.
