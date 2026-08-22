# borgo

The Bun/TypeScript core of [borgo](https://github.com/LuigiDavideMicca/borgo): SSR front server, file-based router, build pipeline and dev orchestrator. See the repository README for the full picture.

Requires Bun >= 1.3. The package ships its TypeScript source directly — Bun runs it natively, and what you read on npm is what runs.

```bash
bunx create-borgo@latest my-app
```

## CLI

- `borgo dev` — runs the Go API server and the SSR front server with fast refresh and css hot swap
- `borgo build` — production client assets in `public/assets/` and the Go binary in `dist/`
- `borgo start` — runs both servers from the build output (`--front-only` for split deployments, with `API_URL`)
- `borgo export` — prerenders the statically exportable pages into `dist/site/`
- `borgo deploy init <caddy|nginx|systemd|compose>` — writes the deploy guide's config for the project
- `borgo pwa init` — writes `public/manifest.webmanifest` and a working service worker
- `borgo doctor` — diagnoses the environment, one actionable fix per failing check

`deploy init` and `pwa init` never overwrite a file that already exists; pass `--force` when you want them to.

Run the CLI through Bun (`bun run dev` in an app). If you hit `error: bun is not installed in %PATH%`, the bin shim was spawned without Bun on `PATH` (e.g. by `npm run`) — see the [troubleshooting section](https://github.com/LuigiDavideMicca/borgo/blob/main/docs/faq-and-troubleshooting.md).

## Upgrading from 0.20

Every line below is a behaviour that changed on purpose between 0.20.1 and this release. The full list is in the [changelog](https://github.com/LuigiDavideMicca/borgo/blob/main/packages/borgo/CHANGELOG.md); these are the ones an existing app meets first.

- Generated request types are `<Name>$Request`, with every field `?` and `| null`. An object literal that sets every field still compiles; a variable declared with the old name does not.
- A build whose emitted bundle references a file beside its own source — `new URL("./x.png", import.meta.url)`, `import.meta.dir + "/x.png"`, `import x from "./x.png"` — **fails** instead of warning, naming the file. Put the file under `public/` and name it by absolute URL (`/x.png`).
- `registerCsrf`, `registerIslands` and `withCsrf` moved to `borgo-framework/internal`; `cookieValue` and the `borgo-framework/server` subpath are gone; `filePathToPattern`, `matchRoute` and `resolveHead` live on `borgo-framework/router` only.
- `METRICS` and `DEV` are `BORGO_METRICS` and `BORGO_DEV`. No alias.
- Every boolean switch (`BORGO_CSRF`, `BORGO_CSP`, `BORGO_SECURITY_HEADERS`, `BORGO_METRICS`, `SESSION_SECURE`, …) reads Go's `strconv.ParseBool` grammar and **refuses to boot** on anything else. `BORGO_CSRF=false` now means off in production; `BORGO_DEV=0` means off.
- `BORGO_MAX_BODY` counts the bytes that arrive, not the `Content-Length` header: a chunked body with no declared length is limited too, the answer is a `413` naming the variable, and `0` removes the limit (it used to refuse every POST).
- `borgo.Push` is generic and `PushT` is gone; `Push[any](topic, event, nil)` for an untyped nil. `DefaultHasher` is a function, not a variable. `ServeContext(ctx)` sits beside `Serve`.
- `SSEStream.Send` and `Ping` return `borgo.ErrStreamClosed` once the client has gone; `borgo.SSE` flushes a comment on open so the browser's `fetch()` resolves before the first event.
- The gzip layer reads every `Content-Encoding` value, so a handler that produced `["", "br"]` (an `Add("")` before `Add("br")`) is left alone instead of recompressed.
- A `SESSION_SECRET` under 32 bytes is refused at startup, not warned about. An unsigned cookie never authenticates.
- `BORGO_PUSH_KEY` does not leave the Go process in clear: pushing to an `http://` `FRONT_URL` on another host fails unless `BORGO_PUSH_INSECURE=1` says that network is yours.
- `subscribe(topic, handler, { onRefused })`: a WebSocket closed for its origin (code `4403`) is final — no redial — and the reason reaches `onRefused` once, or the console.
- A comma, an empty string or padding in a subscribe topic throws at the call site.
- `borgo deploy init caddy` writes `tls internal` (a local CA, no ACME order against a domain you may not own — delete the line to go live); `deploy init systemd` reads secrets from `EnvironmentFile=-/srv/<app>/.env` and carries hardening; `deploy init nginx` sets the forwarding headers that keep `/__borgo/publish` closed to the internet.
- `borgo doctor` is new: versions, Docker, permissions, disk, the Bun shim.

## Exports

The root entry is the application-facing API: what you write by hand, and nothing else. Everything the generated code needs lives on a subpath whose name says it is not for you.

- `borgo-framework` — browser-safe: `redirect`, `Island`, `CsrfField`, `apiFetch`, `registerServiceWorker`, the websocket `subscribe` helper (typed against the borgogen-generated event map), `ApiError`, `csrfCookieValue`, plus the `LoaderContext`, `ActionContext`, `PrerenderContext`, `Head` and `PageModule` types
- `borgo-framework/internal` — the CSRF and island registries the generated client entries import. No stability promise
- `borgo-framework/router` — router internals shared by server and client
- `borgo-framework/runtime` — the hydration/navigation runtime and islands mounter, imported by the generated client entries
- `borgo-framework/refresh-runtime` — react-refresh re-export used by the generated dev entry

The client hydration entry is generated into the app (`.borgo/client.tsx`) so that React always resolves from the app's own `node_modules`.

---

Built by [Luigi Micca](https://luigimicca.com).
