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
No. borgo's model is one loader per page feeding plain components — simpler to reason about, and honest about where code runs. [Why, what it costs, and what would reopen the decision](why.md#why-no-react-server-components) is argued with the other design positions.

**Which databases can I use?**
Any — the API is plain Go, so every Go driver works. The `full` template and the examples use SQLite with a `/data` volume (`DB_PATH`); [the database](database.md) has the driver, the migration runner the template scaffolds, and what changes for Postgres.

**Can I deploy to Vercel, Netlify or Cloudflare?**
No — borgo is self-hosted by design: any VPS, container host or bare-metal box. That is the point: no platform lock-in. See [deploy](deploy.md).

**Can I use Tailwind?**
Yes, opt-in via the `--tailwind` CLI flag — never autodetected. New projects: `bunx create-borgo@latest my-app --tailwind` scaffolds it wired. See [styling](dev-experience.md#styling).

**How do I add users and login?**
`borgo.Auth[U]` gives you login/logout/register handlers, PBKDF2 hashing and signed-cookie sessions on the stdlib only; borgo adds CSRF for form actions and for browser mutations of `/api/*`. See [auth and sessions](auth-and-sessions.md).

**Does borgo run on Windows?**
Yes, first-class — it is developed on one. The dev loop (binary swap, watcher, console glyphs, orphan-process watchdog) has Windows-specific handling throughout.

**Can a Go handler hijack the connection or use sendfile?**
Partially. `http.ResponseController` (flush, deadlines) works through borgo's middleware via `Unwrap`, and that is what SSE uses. Direct `http.Hijacker` casts and `io.ReaderFrom` (sendfile) don't survive a compressing wrapper — an inherent trade-off, not an oversight. If a route truly needs a raw connection, register it on your own `http.Server` beside borgo's.

## Troubleshooting

- **Start with `bunx borgo doctor`** — fifteen checks over the toolchain (bun against borgo's floor or your `engines.bun`, a shim shadowing it, an `engines.bun` range it could not read, go against your `go.mod` floor, node, docker), the machine (both ports, naming the process holding a taken one; free disk) and the project (a stale api process holding the dev binary, generated-types freshness, `node_modules`, app deps, write access to the build directories, playwright browsers if the app depends on playwright). Each failure prints its one-line fix. Checks that do not apply to your app are skipped entirely, and node, docker, the shim note and the `engines.bun` note are informational — they print but never change the exit code.
- **`error: bun is not installed in %PATH%`** — the `borgo` bin shim locates `bun` through `PATH`. Start the app through Bun itself (`bun run dev`): Bun resolves its own shims even when `bun` is not on `PATH`. The error appears when something else spawns the shim, e.g. `npm run dev` or calling `node_modules/.bin/borgo` directly. To make the shim callable from anywhere, install Bun with the [official installer](https://bun.sh).
- **Two Buns on one machine** — an npm-installed Bun (`npm i -g bun`) puts a wrapper ahead of the official install on `PATH`. `borgo dev` spawns its workers by absolute path, so either install works for the dev loop, but prefer the official installer and check `where bun` (`which bun`) points where you expect.
- **`tsc` cannot find the api types** — TypeScript skips dot-directories, so `.borgo/api-types.d.ts` must be listed explicitly in `tsconfig.json`'s `include` (every template ships this). If the types look stale instead, save any `api/*.go` file in dev or run `go tool borgogen`.
- **`413 request body too large`** — `borgo.Bind` caps bodies at 1&nbsp;MB. Routes that legitimately take more use `borgo.BindMax[T](r, limit)`; the cap exists so the default posture is safe. The public port has its own 32&nbsp;MB ceiling (`BORGO_MAX_BODY`) for what it will read at all, counted as the bytes arrive — so the front answers `413` and stops reading rather than taking the whole body first.
- **`415 Content-Type must be application/json`** — `borgo.Bind` *requires* the header, it does not merely object to a wrong one: a missing `Content-Type` is a 415 too. That is what shuts the door on a cross-site post, since neither an HTML form nor an unpreflighted `fetch` can declare `application/json`. `curl -d` sends `application/x-www-form-urlencoded` and gets the 415; say what you are sending and it binds: `curl -H 'Content-Type: application/json' -d '{"title":"x"}'`.
- **A page hangs, then answers `504`** — the front waited `BORGO_RENDER_TIMEOUT` (30 s by default) for the render service's response headers and gave up rather than holding the connection. A loader blocked on a slow api call is the usual cause; an API call cannot reach this, since `/api/*` is answered in the front's own process.
- **A page answers `503` with `Retry-After`** — the render service is not reachable at all. Under `borgo start` that means the Bun half died or has not finished booting; the api is unaffected, which is why the front says so instead of serving an error page it cannot render.
- **Which `*_TIMEOUT` variable is whose** — all of them are Go's now, in one grammar. The front reads `BORGO_READ_HEADER_TIMEOUT` (5s), `BORGO_READ_TIMEOUT` (60s without the body making progress), `BORGO_WRITE_TIMEOUT` (60s without a write), `BORGO_IDLE_TIMEOUT` (2m), `BORGO_RENDER_TIMEOUT` (30s) and `BORGO_SHUTDOWN_TIMEOUT` (10s) as Go durations — `45s`, `2m`, `0` to disable; a bare `45` is refused at boot: `borgo: BORGO_READ_TIMEOUT: invalid duration "45" (want e.g. "5s"; "0" disables)` and the process exits 1. The render service has none: its only client is the front, over loopback. If you are looking for `BORGO_FRONT_READ_TIMEOUT` or `BORGO_API_TIMEOUT`, they were the Bun front's and went with it in 0.30 — the first is `BORGO_READ_TIMEOUT`, the second has no successor because `/api` no longer crosses a process boundary.
- **`403 invalid csrf token` on a form post** — the form is missing `<CsrfField />` (required inside every `<form method="post">` once a csrf cookie exists). In dev the check is off by default; `BORGO_CSRF=1` forces it on, `BORGO_CSRF=0` disables it in production — don't.
- **`403 invalid csrf token` on a browser `POST`/`PUT`/`PATCH`/`DELETE` to `/api/…`** — the call is a bare `fetch`. Unsafe `/api/*` requests carry the token in an `X-CSRF-Token` header; swap `fetch` for `apiFetch` from `borgo-framework` and it is attached for you. A loader or action calling `api("POST /api/…")` is never affected — that client calls the api's internal listener, which the header check does not guard. See [CSRF protection](security.md#csrf-protection).
- **Login answers `500 {"error":"session write failed"}` while everything else works** — `SESSION_SECRET` is unset, so `SetSession` returns `ErrNoSessionSecret` (`borgo: SESSION_SECRET must be set to at least 32 bytes to use sessions (openssl rand -base64 48)`). The api does *not* refuse to boot over an *absent* secret — an app without sessions is legitimate — so the only signal is the line it logs at startup: `borgo: SESSION_SECRET not set: session and auth routes will fail until it is`. Set a long random string and restart; `/healthz` will have been green the whole time. A secret that is *set but shorter than 32 bytes* is a different story: `borgo.Serve` refuses to start at all, so you will not see this 500 for that case.
- **The page stops answering for a moment after a `.go` save in dev** — the Go binary is the front now, so a rebuild restarts the process holding the public port; the browser reloads once it answers again. If it never comes back, it is almost always a Go compile error, and the watcher output shows it.
- **A stale api process holds the port or the binary** (`EPERM` renaming, "port in use") — this should no longer happen: every process borgo starts exits when its launcher dies, even on a force kill. The one way left to make it happen is to force-kill the *shell* under `bun run dev` rather than the run itself — on Windows the `bun run` wrapper survives its shell and the session survives with it (see [nothing outlives the session](dev-experience.md#nothing-outlives-the-session)). If you do see it — that, a process started before you upgraded, or one detached deliberately — `borgo doctor` names the pid, and `taskkill /F /PID <pid>` (or `kill`) clears it.
- **The page stopped answering in dev and did not come back** — the Go front went down on its own (a panic, a failed bind, someone killing it), and `borgo dev` printed its exit code. Save any `.go` file to rebuild and restart it. If instead pages answer `503` while `/api` still works, it is the render service that died: `borgo dev` prints that too, and saving any page or style restarts it.
- **A third-party script is blocked in the console** (`Refused to load … violates the Content-Security-Policy`) — borgo ships a strict CSP by default. Widen it with `BORGO_CSP`, keeping `{nonce}` in `script-src`, or drop it with `BORGO_CSP=0`. See [changing the policy](security.md#changing-the-policy).
- **WebSockets or SSE die behind the reverse proxy** — the proxy must forward upgrade headers and not buffer streams. `borgo deploy init nginx` writes the working config (`proxy_buffering off`, upgrade headers, long read timeout); Caddy needs nothing special.
- **The browser shows yesterday's app in production** — if you registered a service worker, remember its cache keys on the [precache stamp](pwa.md); if not, check you rebuilt: `borgo start` refuses to serve a dev-built asset tree and rebuilds it for production.
- **Odd characters like `âŒ‚` in the terminal** — a legacy Windows console codepage renders UTF-8 as mojibake; borgo detects this and falls back to plain ASCII marks. `chcp 65001`, or Windows Terminal, brings the branded glyphs back.
- **`borgo build` fails oddly while `borgo dev` is running** — both write `public/assets`, and they will fight over it. Stop the dev session first.
- **`go: finding module for package …/cmd/borgogen`** — progress output from `go mod tidy`, not an error. The code generator is wired as a Go tool dependency, so the first tidy fetches it.

## Reporting a bug

Open an [issue](https://github.com/LuigiDavideMicca/borgo/issues) with the output of `bunx borgo doctor`, your Bun and Go versions, and the smallest app that shows the problem. A failing case someone else can run is worth ten paragraphs of description — and if you can express it as a page, a route or a test, it usually becomes the regression test that keeps the bug fixed.
