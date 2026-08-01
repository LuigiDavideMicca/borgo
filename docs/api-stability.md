# API stability

What borgo's version number promises, what counts as breaking it, and what happens when something has to change anyway.

Until 1.0 this page describes the policy we are committing to *at* 1.0, and 0.x releases are already run by it in spirit: breaking changes are avoided, announced, and given a migration path. The difference after 1.0 is that they become forbidden outside a major.

The catalogue of what is covered — every symbol, with a stable / provisional / internal marker — is [the API reference](api-reference.md).

## One version number, four artifacts

borgo ships as four things that must agree:

| Artifact | Where it lives | How it is versioned |
| --- | --- | --- |
| `github.com/LuigiDavideMicca/borgo` | the repository root | resolves the `vX.Y.Z` git tag |
| `borgo-framework` | `packages/borgo` | npm, same `X.Y.Z` |
| `create-borgo` | `packages/create-borgo` | npm, same `X.Y.Z`, linked |
| the `borgo` CLI | `bin` of `borgo-framework` | same package, so the same version |

They move together. release-please maintains a release PR from conventional commits, merging it tags `vX.Y.Z`, and both npm packages publish from that tag with linked versions; the Go module resolves the same tag because it lives at the repository root. There is no combination of "Go module 1.4 with `borgo-framework` 1.2" that we test or support.

The practical consequence: **a breaking change to any one of the four is a major bump for all four.** A Go-only rename does not get to be cheap because the npm packages were untouched.

## Semantic versioning, as applied here

Once 1.0 ships:

- **Major (`2.0.0`)** — any breaking change to any covered surface, as defined below.
- **Minor (`1.4.0`)** — new APIs, new conventions, new CLI commands and flags, new environment variables, new deprecation warnings. Anything additive.
- **Patch (`1.4.1`)** — bug fixes, performance work, documentation, and behaviour changes that bring the implementation into line with documented intent.

The commit types map onto that directly: `feat:` produces a minor, `fix:` and `perf:` produce a patch, and a `!` or a `BREAKING CHANGE:` trailer produces a major. During 0.x, `bump-minor-pre-major` is set, so a breaking change lands as a minor — which is exactly why 0.x is not the stability promise.

## What counts as a breaking change

Each surface breaks differently. All five of these are contracts.

### The Go module

Breaking:

- Removing or renaming an exported symbol, or changing its signature.
- Adding a required field or a method to an exported interface (`PasswordHasher` gaining a method breaks every app that implements it).
- Changing the meaning of a return value — for example, making `GetSession` report `true` for an expired session.
- Changing an HTTP status a documented handler produces: `LoginHandler` answering 400 instead of 401, `RegisterHandler` answering 200 instead of 201, `Authed` answering 403 instead of 401.
- Changing a wire format both halves rely on: the session cookie envelope, the password hash string format, the SSE frame shape, the `/__borgo/publish` body.
- Tightening a default such that previously working apps stop working — dropping `Bind`'s cap from 1 MB, say, or making `SESSION_SECRET` fatal at boot.

Not breaking:

- Adding a new exported function, type or struct field.
- Adding an optional field to a struct users construct with field names (which is how `Auth` is documented and used).
- Loosening a limit, or making an error message clearer.
- Anything about unexported symbols.

### The npm packages

Breaking:

- Removing or renaming a **stable** export from `borgo-framework`.
- Changing the shape of `LoaderContext`, `ActionContext` or `PrerenderContext` in a way that invalidates existing loaders.
- Narrowing an accepted type, or widening a returned one, such that a previously compiling app stops compiling. **A change that turns green `tsc` red is breaking, even if the runtime behaviour is identical.**
- Removing an entry from `exports` in `package.json`.
- Raising the minimum Bun or React version. `engines.bun` and `peerDependencies` are part of the contract.

Not breaking:

- Adding an export, an optional property, or a new overload that accepts strictly more.
- Changing anything reachable only through `borgo-framework/router`, `/runtime`, `/refresh-runtime` or `/package.json`, all of which are internal.
- Making an inferred type *more* precise, where the extra precision only rejects code that was already wrong. (This one is a judgement call. If it turns real apps red, it is breaking regardless of who was right.)

### The CLI

Breaking:

- Removing a command or a flag, or changing what one does.
- Changing an exit code. `borgo build` exiting non-zero on failure is what CI pipelines branch on.
- Changing an output path: `public/assets/`, `dist/`, `dist/site/`.
- Requiring a flag that used to be optional.

Not breaking:

- New commands, new flags, new subcommands.
- Changing what the banner or the build table looks like.

### Generated output

`borgogen` and the build write files that other files import. That makes their *interface* a contract, even though nobody writes them by hand:

Breaking:

- Changing the module specifier generated code imports from, without keeping the old one working.
- Changing the exported names or types of `.borgo/routes.gen.tsx`, `.borgo/client-routes.gen.ts` or `.borgo/api-types.d.ts` — `routes`, `notFound`, `serverError`, the `ApiRoutes` and `WsEvents` augmentations.
- Changing how a Go type maps to a TypeScript type, where the new mapping fails to compile against existing app code.
- Changing the generated file *paths*, which apps commit, `.gitignore` and diff in CI.

Not breaking:

- The exact formatting: whitespace, key order, comment wording, the header line. CI compares regenerated output against the committed copy, so formatting changes do produce a diff and a `chore:` commit — that is a repository chore, not a user-facing break.

### File conventions

The conventions in the [reference](api-reference.md#file-conventions) are the framework's real API for most users. Changing one is breaking:

- Renaming or re-scoping a directory (`pages/`, `islands/`, `api/`, `public/`).
- Changing what a special filename means, or which names are special.
- Changing route derivation: how `[id]` maps to `:id`, how `index` collapses, how static and dynamic segments are ordered against each other.
- Changing the meaning of a page export, or making `hydrate` accept something it previously rejected — or reject something it accepted.
- Changing directive syntax (`//borgo:route`, `//borgo:type`) or its attachment rules.
- Changing a cookie name, a reserved URL path, or a `data-borgo-*` attribute that persists in server-rendered HTML.

Adding a new convention — a new special filename, a new optional page export — is a minor.

## What the promise does not cover

Deliberately outside the guarantee, in any release:

- **Internal exports.** Everything marked internal in [the reference](api-reference.md), including all of `borgo-framework/router`, `/runtime` and `/refresh-runtime`, and every unexported Go symbol. These move without notice.
- **Exact generated formatting.** Whitespace, ordering, comments and the file header in generated files.
- **Log lines.** Wording, colour, ordering and the presence of any particular startup, build or warning message. Do not parse them; `/healthz` and `/metrics` exist for machines.
- **Console output shape.** The startup route table, the build asset table, `borgo doctor`'s report layout. The exit codes are covered; the text is not.
- **Error message text.** Sentinel errors (`ErrUserExists`, `ErrNoSessionSecret`) are covered because they are compared with `errors.Is`; the strings inside them are not.
- **Timing and internal tuning.** Pool sizes, buffer thresholds, the hash-slot count, backoff schedules, prefetch delays and cache TTLs in the client runtime. Documented defaults for *user-visible* behaviour — `Bind`'s 1 MB, the 7-day session, the timeouts with environment variables — are covered.
- **Dependencies' own APIs.** React, Bun and Go's standard library are yours to track; borgo pins ranges but does not re-promise their surfaces.
- **The example app, the templates' application code, and anything under `examples/`.** Templates are a starting point, not a library.
- **Provisional APIs**, by definition. They are shipped and supported, but a minor may change them with a migration note.

## Deprecation policy

Nothing stable disappears without warning. The sequence:

1. **Deprecated.** The API is documented as deprecated, with a named replacement and a concrete migration, in the release notes and in [the reference](api-reference.md). It keeps working exactly as before.
2. **Warned, in a minor.** The next minor emits a warning that names the replacement — a `//` `Deprecated:` doc comment on the Go side (which `go vet` and every editor surface) and a one-time runtime log line where a comment is not enough; a `@deprecated` JSDoc tag on the TypeScript side, which turns the symbol strikethrough in an editor and is reported by `tsc` under `--noUnusedLocals`-style linting. Behaviour is unchanged.
3. **Removed, only in a major**, and only after **at least two minor releases** have carried the warning. If 1.4 deprecates something, the earliest removal is 2.0, and 2.0 must be preceded by 1.5 and 1.6 shipping the warning.

The warning must always name the replacement and must be actionable without reading the source. A deprecation with no replacement is not a deprecation; it is a removal, and it waits for the major.

Security fixes are the one exception, and a narrow one: if an API cannot be made safe without changing it, it changes in a patch, with the reason published. This has not happened and we would rather it did not.

## When borgo will not add what you need

[VISION.md](../VISION.md) lists what is permanently out of scope — an ORM, a queue, email, a scheduler, a Redis abstraction, GraphQL, cloud SDKs, a CMS, a plugin system, magic configuration. That list is not going to shrink, so the question worth answering here is what you do instead.

**Reach for the platform underneath.** borgo is deliberately thin over things that already exist. The Go side is `net/http` — any middleware, any client library, any `database/sql` driver works unchanged, and `borgo.Handle` takes an ordinary `http.HandlerFunc`, so wrapping it is composition, not a plugin. The front server is Bun and React; a loader is an async function that can call anything.

**Put it beside borgo, not inside it.** A queue is a goroutine and a table, or a separate process. A scheduler is a `time.Ticker` in `main.go`, or cron. Email is one library call in a handler. None of these need to know borgo exists, which is precisely why borgo does not need to know they do.

**Own the seam yourself if it is on the seam.** If what you need genuinely spans Bun and Go — a new kind of typed bridge, a different session encoding — that is the one category where an external library cannot help, and it is worth an issue. It may be in scope. Bring the use case and the cost, in the terms [VISION.md](../VISION.md) sets out: does it move work out of the request path, materially remove a class of mistakes, or live somewhere no library can reach?

**Fork the file.** The framework is small enough that reading and changing the source is the supported extension mechanism, and it is stated as such. If you need a different gzip threshold or a different cookie policy, the code that decides it is a few dozen lines in one file. That is a feature of the design, not a failure of it.

**And if you have to leave, leaving is cheap.** No proprietary component protocol, no bespoke module graph, no platform lock-in: pages are React, handlers are `net/http`, the build is one `Bun.build` call. Whatever borgo will not give you, it also will not hold onto.

## Reporting a stability problem

If a release breaks you and this page says it should not have, that is a bug and it takes priority over the feature it shipped with. Open an issue with the version you moved from and to, and the smallest thing that stopped working. See [reporting a bug](faq-and-troubleshooting.md#reporting-a-bug).
