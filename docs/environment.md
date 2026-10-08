# The app's environment, typed

What this covers: declaring your application's environment variables once, having the boot refuse when they are missing or malformed, reading them typed, and the wall between what the server knows and what the browser may see. For borgo's *own* variables (`PORT`, `BORGO_*`, session settings) see the [environment reference](deploy.md#environment-reference) — those are validated by the framework with the same discipline, and [declaring them twice is refused](#what-this-is-not).

## Declaring

One file by convention, `env.ts` at the app root — beside `pages/` and `api/`, where the build and the boot check know to look:

```ts
import { defineEnv } from "borgo-framework";

export const env = defineEnv({
  server: {
    DATABASE_URL: { type: "url" },
    SMTP_PORT: { type: "port", default: 25 },
    STRICT_MODE: { type: "boolean", optional: true },
  },
  client: {
    BORGO_PUBLIC_APP_NAME: { default: "my app" },
  },
});
```

Anything can import `env` — a loader, an action, a page, a layout — and every read is typed: `env.SMTP_PORT` is a `number`, `env.STRICT_MODE` is `boolean | undefined`, `env.DATABASE_URL` is a `string` that parsed as an absolute URL. A name the schema does not declare is a type error *and* a named throw at runtime, so a typo cannot read as `undefined` and limp on.

The built-in types are `string` (the default), `number`, `boolean`, `url` and `port`. Booleans speak the same grammar as borgo's own variables — Go's `ParseBool` spellings, `1`/`0`/`true`/`false`/`t`/`f` — because an app variable should not invent a second dialect. The empty string counts as missing: every way of writing `FOO=` into an environment means "not set" more often than it means "the empty string".

For anything beyond the built-ins, `validate` is the escape hatch — it receives the raw string, returns the parsed value (which becomes the type), and throws to refuse. A zod user writes `validate: (raw) => mySchema.parse(raw)` and borgo never learns zod exists:

```ts
import { defineEnv } from "borgo-framework";

export const env = defineEnv({
  server: {
    ALLOWED_HOSTS: { validate: (raw) => raw.split(",").map((h) => h.trim()) },
  },
});
```

## Failing at boot, not at the first read

`borgo dev`, `borgo start` and `borgo export` check the schema before anything binds. A missing required variable or a value the type refuses stops the boot with every failure named at once:

```
borgo: the environment refused the boot - 2 variables:
  - DATABASE_URL: missing (expected a url)
  - SMTP_PORT: expected a port (an integer 0-65535), got "banana"
```

That is the same posture the 0.21 release gave borgo's own variables, extended to yours: the alternative — discovering the typo at whichever request happens to read it first, in production, at night — is the thing this feature exists to delete. A script that imports `env` without booting a server gets the same refusal on its first read, as a backstop.

## The wall

Server variables and client variables are different species, and the schema keys say which is which.

**Client variables must wear the `BORGO_PUBLIC_` prefix** — a schema that declares an unprefixed client variable throws at once, and borgo promises never to claim that namespace for itself. Their *validated values* are frozen into the client bundle at build time as one explicit object through the build's define: an allowlist, never a scrape of the environment. In the browser, `env.BORGO_PUBLIC_APP_NAME` reads from that object.

**Server variables never reach the bundle by construction**: their values are read from the process environment at runtime, and the browser has no process environment to read. Client code that references one gets a throw naming the variable — `SECRET is a server variable - it never reaches the browser` — during SSR the same component works, so the failure shows up in development the first time the page hydrates, not in an attacker's screenshot. CI keeps the construction honest the way it keeps loaders honest: a sentinel value planted in a server variable is grepped out of every built asset.

## The Go half reads the same contract

The Go API is usually the half that opens the database, so a schema only TypeScript reads would check the variable in the process that does not use it. `borgo build` and `borgo dev` therefore write `env/env.gen.go` from `env.ts`: a package `env` with one typed field per **server** variable, read by `borgo.ReadEnv` with the same rules and refused in the same words.

```go no-check
import "myapp/env"

func main() {
	// DB_PATH and its default are declared once, in env.ts
	db.Open(context.Background(), env.Must().DB_PATH)
	borgo.Serve()
}
```

- **Types.** A string or url is `string`, a number `float64`, a boolean `bool`, a port `int`. An optional variable without a default is a pointer, `nil` when unset. A validate spec is the raw `string`: its validator is JavaScript, and the render service runs it at boot.
- **`Load()`** returns the values or one error naming every refusal; **`Must()`** prints that error and exits, for `main` and package-level variables.
- **Rules.** The empty string is missing, a default fills it, numbers read as JavaScript's `Number` reads them, booleans with the `strconv.ParseBool` spellings, ports 0-65535. A url is checked after the WHATWG algorithm for what can refuse one - the scheme, and an authority's host and port - and where the Go side cannot follow it, it is the stricter of the two: a host outside ASCII, which the browser's parser would map, is refused. So the Go side never accepts a value the render service refuses. A parity table in the repository holds both halves to the same answers; one difference is left on purpose: a hex, octal or binary number past 2^53 is rounded correctly in Go, where Bun's `Number` can be one unit off in the last place.
- **The file is generated and committed**, like `api/borgo.gen.go`, so `go build`, `go vet` and `go test` work without a Bun step. It is written only when its text changes, and removed when `env.ts` no longer declares a server variable. Client variables never appear in it.
- **What refuses the build, by name.** `env/` is the generated package's directory: a `.go` file of your own there, other than a test, would share its package or sit beside it as another, so the build stops and says which file to move. A server variable must be a capital letter followed by letters, digits and underscores (`[A-Z][A-Za-z0-9_]*`) to become a field, may be declared by one exported schema only, and a default must be a string Go can hold - a lone surrogate cannot be.

## Where the values come from, honestly

- **Server values** are read on the machine that runs, at boot. Change the environment, restart, done.
- **Client values** are read on the machine that *builds*, and frozen. A `BORGO_PUBLIC_` value changed on the server without a rebuild does not reach the browser — and since the server render reads the live environment while the hydrating client reads the frozen one, letting them drift also earns you React's hydration mismatch warning. Treat client values as build inputs, because that is what they are.
- `.env` files work because [bun loads them](https://bun.sh/docs/runtime/env) before borgo runs; borgo adds no loader of its own.

## What this is not

- **Not a validator for borgo's variables.** Declaring `PORT`, `API_URL` or anything `BORGO_*` in the schema is refused at define time: the framework already validates those at boot, and a second source of truth is how two halves drift.
- **Not a replacement for borgo's own checks in Go.** `borgo.Serve` hardens the variables it owns (`SESSION_SECRET`'s length rule, the timeout grammars) on its own terms. The full template's `SESSION_SECRET` entry mirrors Go's rule on purpose, it does not replace it, and its validator is not run by the Go side.
- **Not a build-time ban on referencing server variables in client code.** The wall is a named runtime throw plus the CI grep, not static analysis of your components; a page that reads `env.SECRET` typechecks (the type is honest — the value exists on the server) and fails loudly the first time it hydrates. The [scaffolded templates](https://github.com/LuigiDavideMicca/borgo/tree/main/packages/create-borgo/templates) show the working pattern.
