# FAQ and troubleshooting

Questions people actually ask, and symptoms with their one-line fixes. When something misbehaves, start with `bunx borgo doctor` — most of the answers below are checks it runs for you.

## FAQ

**Why Go for the API instead of TypeScript end to end?**
A single static binary, small memory footprint and real concurrency in production — while Bun still gives you the modern dev loop. The typed bridge ([borgogen](typed-bridge.md)) is what makes the split ergonomic: Go handlers become typed TypeScript calls with no OpenAPI to maintain.

**Can I write API routes in TypeScript?**
No, by design — the API side is Go. But loaders and actions run in Bun on the server, so server-side TypeScript (aggregation, PDF generation, calling the Go API) has a first-class home. See [pages and routing](pages-and-routing.md).

**Does my app work without JavaScript?**
Yes. Pages are server-rendered, forms post natively (the client runtime only *enhances* them when present), and `hydrate = false` pages ship no page JavaScript at all. See [client navigation and hydration](client-navigation.md).

**Are there React Server Components?**
No. borgo's model is one loader per page feeding plain components — simpler to reason about, and honest about where code runs. The [README](../README.md) lists what borgo deliberately is not.

**Which databases can I use?**
Any — the API is plain Go, so every Go driver works. The examples use SQLite with a `/data` volume (`DB_PATH`); swap in Postgres or anything else without touching the framework.

**Can I deploy to Vercel, Netlify or Cloudflare?**
No — borgo is self-hosted by design: any VPS, container host or bare-metal box. That is the point: no platform lock-in. See [deploy](deploy.md).

**Can I use Tailwind?**
Yes, opt-in via the `--tailwind` CLI flag — never autodetected. New projects: `bunx create-borgo@latest my-app --tailwind` scaffolds it wired. See [styling](dev-experience.md#styling).

**How do I add users and login?**
`borgo.Auth[U]` gives you login/logout/register handlers, PBKDF2 hashing and signed-cookie sessions on the stdlib only; the front server adds CSRF for form actions. See [auth and sessions](auth-and-sessions.md).

**Does borgo run on Windows?**
Yes, first-class — it is developed on one. The dev loop (binary swap, watcher, console glyphs, orphan-process watchdog) has Windows-specific handling throughout.

**Can a Go handler hijack the connection or use sendfile?**
Partially. `http.ResponseController` (flush, deadlines) works through borgo's middleware via `Unwrap`, and that is what SSE uses. Direct `http.Hijacker` casts and `io.ReaderFrom` (sendfile) don't survive a compressing wrapper — an inherent trade-off, not an oversight. If a route truly needs a raw connection, register it on your own `http.Server` beside borgo's.

## Troubleshooting

- **Start with `bunx borgo doctor`** — it checks bun, go and its version against `go.mod`, both ports (naming the process holding a taken one), stale api processes, generated-types freshness and the app's dependencies, each failure with its one-line fix.
- **`error: bun is not installed in %PATH%`** — the `borgo` bin shim locates `bun` through `PATH`. Start the app through Bun itself (`bun run dev`): Bun resolves its own shims even when `bun` is not on `PATH`. The error appears when something else spawns the shim, e.g. `npm run dev` or calling `node_modules/.bin/borgo` directly. To make the shim callable from anywhere, install Bun with the [official installer](https://bun.sh).
- **Two Buns on one machine** — an npm-installed Bun (`npm i -g bun`) puts a wrapper ahead of the official install on `PATH`. `borgo dev` spawns its workers by absolute path, so either install works for the dev loop, but prefer the official installer and check `where bun` (`which bun`) points where you expect.
- **`tsc` cannot find the api types** — TypeScript skips dot-directories, so `.borgo/api-types.d.ts` must be listed explicitly in `tsconfig.json`'s `include` (every template ships this). If the types look stale instead, save any `api/*.go` file in dev or run `go tool borgogen`.
- **`413 request body too large`** — `borgo.Bind` caps bodies at 1&nbsp;MB. Routes that legitimately take more use `borgo.BindMax[T](r, limit)`; the cap exists so the default posture is safe. The front server has its own 32&nbsp;MB ceiling (`BORGO_MAX_BODY`) for what it will buffer at all.
- **`415 Content-Type must be application/json`** — `borgo.Bind` rejects a request that *declares* a non-JSON content type. A request with no `Content-Type` at all still binds, so `curl -d` keeps working.
- **A page or API call hangs, then answers `504`** — the front server waited `BORGO_API_TIMEOUT` (30 s by default) for the Go API's response headers and gave up rather than holding the connection. A Go handler blocked on a lock or a slow query is the usual cause.
- **`403 invalid csrf token` on a form post** — the form is missing `<CsrfField />` (required inside every `<form method="post">` once a csrf cookie exists). In dev the check is off by default; `BORGO_CSRF=1` forces it on, `BORGO_CSRF=0` disables it in production — don't.
- **The api refuses to start: `SESSION_SECRET must be set`** — sessions sign cookies with it. Set a long random string (32+ bytes); the server refuses weak setups at startup instead of failing per-request in the dark.
- **`502 api unreachable` in dev** — almost always a Go compile error: the watcher output shows it. The proxy retries briefly while the api restarts, so a healthy save heals on its own.
- **A stale api process holds the port or the binary** (`EPERM` renaming, "port in use") — this should no longer happen: every process borgo starts exits when its launcher dies, even on a force kill. If you do see it — a process started before you upgraded, or one detached deliberately — `borgo doctor` names the pid, and `taskkill /F /PID <pid>` (or `kill`) clears it.
- **The api died and the page keeps 502-ing** — `borgo dev` prints the api's exit code when it goes down on its own (a panic, a failed bind, someone killing it). Save any `.go` file to rebuild and restart it.
- **A third-party script is blocked in the console** (`Refused to load … violates the Content-Security-Policy`) — borgo ships a strict CSP by default. Widen it with `BORGO_CSP`, keeping `{nonce}` in `script-src`, or drop it with `BORGO_CSP=0`. See [changing the policy](security.md#changing-the-policy).
- **WebSockets or SSE die behind the reverse proxy** — the proxy must forward upgrade headers and not buffer streams. `borgo deploy init nginx` writes the working config (`proxy_buffering off`, upgrade headers, long read timeout); Caddy needs nothing special.
- **The browser shows yesterday's app in production** — if you registered a service worker, remember its cache keys on the [precache stamp](pwa.md); if not, check you rebuilt: `borgo start` refuses to serve a dev-built asset tree and rebuilds it for production.
- **Odd characters like `âŒ‚` in the terminal** — a legacy Windows console codepage renders UTF-8 as mojibake; borgo detects this and falls back to plain ASCII marks. `chcp 65001`, or Windows Terminal, brings the branded glyphs back.
- **`borgo build` fails oddly while `borgo dev` is running** — both write `public/assets`, and they will fight over it. Stop the dev session first.
- **`go: finding module for package …/cmd/borgogen`** — progress output from `go mod tidy`, not an error. The code generator is wired as a Go tool dependency, so the first tidy fetches it.

## Reporting a bug

Open an [issue](https://github.com/LuigiDavideMicca/borgo/issues) with the output of `bunx borgo doctor`, your Bun and Go versions, and the smallest app that shows the problem. A failing case someone else can run is worth ten paragraphs of description — and if you can express it as a page, a route or a test, it usually becomes the regression test that keeps the bug fixed.
