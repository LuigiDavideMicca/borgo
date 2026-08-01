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
- `borgo doctor` — diagnoses the environment, one actionable fix per failing check

Run the CLI through Bun (`bun run dev` in an app). If you hit `error: bun is not installed in %PATH%`, the bin shim was spawned without Bun on `PATH` (e.g. by `npm run`) — see the [troubleshooting section](https://github.com/LuigiDavideMicca/borgo/blob/main/docs/faq-and-troubleshooting.md).

## Exports

- `borgo-framework` — browser-safe: `redirect`, `Island`/`registerIslands`, `CsrfField`, the websocket `subscribe` helper (typed against the borgogen-generated event map), `ApiError`, plus `LoaderContext`, `ActionContext`, `PrerenderContext`, `Head`, `PageModule`, `Route` types and the router functions
- `borgo-framework/server` — `serve`, the SSR front server (server-only)
- `borgo-framework/router` — router internals shared by server and client
- `borgo-framework/runtime` — the hydration/navigation runtime and islands mounter, imported by the generated client entries
- `borgo-framework/refresh-runtime` — react-refresh re-export used by the generated dev entry

The client hydration entry is generated into the app (`.borgo/client.tsx`) so that React always resolves from the app's own `node_modules`.

---

Built by [Luigi Micca](https://luigimicca.com).
