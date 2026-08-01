# Contributing to borgo

Read [VISION.md](VISION.md) first if you are proposing a feature — it says what borgo will and will not grow into, and it will save you writing something that cannot be merged. This file is about the mechanics: how to set the repo up, how to run every gate CI runs, and what a mergeable change looks like.

## Prerequisites

| Tool | Version | Why |
| --- | --- | --- |
| [Bun](https://bun.sh) | `>= 1.3.0` | Declared in `engines.bun` for both packages. The CLI, the front server, the build and the TypeScript tests all run on it. |
| [Go](https://go.dev) | `>= 1.25.0` | The floor declared in `go.mod`. Two things below it are already hard requirements: `crypto/pbkdf2`, which the default password hasher uses, and the `go.mod` `tool` directive that apps invoke `borgogen` through — both arrived in 1.24. |
| Git | any recent | — |

CI pins Bun to `latest` and Go to `stable`, so a change that needs a newer toolchain than the table says will pass CI and fail for contributors. If you raise a floor, raise it in `go.mod` / `engines` and in this table too.

Playwright's browser is installed on demand:

```bash
npx playwright install --with-deps chromium
```

Node is not a dependency of development — it appears only in the publish workflow, where npm's trusted publishing needs it.

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
                         bootstrap, sessions, auth, sse, push, cache, gzip, watchdog. Zero deps.
cmd/borgogen             the codegen binary: go/ast + go/types static analysis, no reflection.
                         Depends on golang.org/x/tools. Fixtures live in cmd/borgogen/testdata.
packages/borgo           npm "borgo-framework": the CLI, the Bun SSR front server, the router,
                         the build, the browser runtime, the typed api client.
packages/create-borgo    npm "create-borgo": the scaffolder and its three templates.
examples/tasks           the demo app CI exercises end to end.
docs/                    the user documentation. Every snippet in it is compiled by CI.
e2e/                     playwright specs, run against a production build of examples/tasks.
scripts/                 check-doc-links.ts — the docs gate.
.github/workflows        ci.yml (everything below), release-please.yml, publish.yml.
```

Two rules follow from the layout. The Go module at the root must stay dependency-free — `golang.org/x/tools` belongs to `cmd/borgogen`, which apps do not link into their binaries. And `packages/borgo` is the only package apps import, so its `exports` map is the whole public TypeScript surface; see docs/api-reference.md before adding to it.

## The gates

CI runs all of these on every push and pull request. Run them locally before opening one — in this order, because the cheap ones fail fastest.

```bash
bun scripts/check-doc-links.ts     # docs links resolve, doc snippets compile
bun run typecheck                  # tsc --noEmit across both packages and the example app
bun run test                       # bun test packages/borgo/test packages/create-borgo/test
go test -race ./...                # the go module and borgogen, race detector on
bunx playwright test               # end to end, against a production build of examples/tasks
```

What each one actually is, verified against `package.json` and `.github/workflows/ci.yml`:

- **`bun scripts/check-doc-links.ts`** — every internal link in the README, all of `docs/`, and each package and template README points at a file that exists, with the anchor it names. Then every `ts` / `tsx` fenced block becomes a module inside `examples/tasks` and is typechecked against the real framework types, and every `go` block that opens with a declaration is compiled inside the example's module. Failures are reported at the line of the doc file, not the scratch file.
- **`bun run typecheck`** — `bunx tsc --noEmit` in `packages/borgo`, then `packages/create-borgo`, then `examples/tasks`.
- **`bun run test`** — `bun test packages/borgo/test packages/create-borgo/test`. Unit tests only; nothing here starts a server.
- **`go test -race ./...`** — the root module and `cmd/borgogen`, including its fixture apps under `testdata`. `bun run test:go` is the same suite without `-race`; CI uses `-race`, so use `-race`.
- **`bunx playwright test`** — the root script `bun run e2e` and CI's `npx playwright test` run the same config. It builds and starts `examples/tasks` itself on port 3400, then runs four projects in dependency order: the app specs, the destructive `clear-all` spec, a dev-server project for fast refresh, and an export project last. Expect a few minutes.

CI also runs, and you should reproduce locally when you touch the relevant area:

```bash
go build ./... && go vet ./...
gofmt -l . | grep -v testdata            # must print nothing
cd examples/tasks && go tool borgogen    # then: git diff --exit-code -- .borgo/api-types.d.ts api/borgo.gen.go
cd examples/tasks && bun run build
docker build -f examples/tasks/Dockerfile -t borgo-tasks .
```

The `borgogen` freshness check is the one that catches people: generated files are committed, so if your change alters what the generator emits, regenerate and commit the result in the same commit. CI compares byte for byte.

CI additionally asserts three *negative* type cases — that a wrong request body, a wrong WebSocket payload and a wrong published event each make `tsc` fail. If you change how types are generated, check that these still fail for the right reason and not because the file no longer compiles for an unrelated one.

## Commits and releases

release-please builds the release PR from commit subjects, so the format is load-bearing:

```text
<type>: <description in lowercase, present tense>
```

Types in use, by frequency: `fix`, `feat`, `docs`, `test`, `chore`, `refactor`, `perf`, `ci`. `feat` produces a minor, `fix` and `perf` produce a patch, everything else produces no release on its own. A `!` after the type, or a `BREAKING CHANGE:` trailer, marks a breaking change — see docs/api-stability.md for what qualifies, and expect a conversation before it merges.

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

Merging the release PR tags `vX.Y.Z` and publishes both npm packages with linked versions; the Go module resolves the same tag because it lives at the repository root. One version number, four artifacts — do not bump versions by hand.

The one exception is `Version` in `borgo.go`, which release-please cannot reach: it resolves `extra-files` relative to a package's own path, and giving the repository root a package entry would have it claim the same tag `packages/borgo` already owns. So the release PR needs one extra commit setting that constant to the version the PR is cutting. You cannot forget silently — `TestVersionMatchesManifest` reads `.release-please-manifest.json` and fails the build when they disagree, naming the value it expected.

## What a mergeable change looks like

**A bug fix arrives with the test that would have caught it.** Not a test that exercises the area — the specific test that fails on the parent commit and passes on yours. If you cannot write one, say so in the pull request and explain why; sometimes the honest answer is that the bug is only reachable end to end, and an `e2e/` spec is the right home.

**Prove the test is not vacuous.** Before you commit it, break the implementation it covers — invert the condition, delete the guard, return the wrong status — and confirm the test goes red. A test that passes against a broken implementation is worse than no test, because it will be trusted. This is a habit, not a tool: there is no mutation-testing harness in the repo, so the mutation is something you do by hand and then undo.

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
