# {{name}}

A [borgo](https://github.com/LuigiDavideMicca/borgo) app: file-based React pages server-rendered by Bun, API routes written in Go.

This is the `minimal` template — one page, one Go route, nothing else. Scaffold with `--template base` for a guided tour of the framework or `--template full` for auth + CRUD.

## Prerequisites

- [Bun](https://bun.sh) >= 1.3
- [Go](https://go.dev) >= 1.25

## Setup

```bash
bun install
go mod tidy   # fetches github.com/LuigiDavideMicca/borgo at its latest version
bun run dev
```

Open http://localhost:3000.

If you are developing against a local borgo checkout, uncomment the `replace` directive in `go.mod` and point it at the checkout; drop it again once you depend on the published module.

> **`error: bun is not installed in %PATH%`?** Start the app with `bun run dev` — Bun resolves its own bin shims even when `bun` is not on `PATH`. The error appears when the shim is spawned by something else (`npm run dev`, or `node_modules/.bin/borgo` directly). To call the shim from anywhere, install Bun with the [official installer](https://bun.sh).

## Commands

- `bun run dev` — both servers with watch, fast refresh and css hot swap
- `bun run build` — production client assets in `public/assets/` and the Go API binary in `dist/`
- `bun run start` — run from the build output (supervises both processes)
- `bun run export` — prerender the statically exportable pages into `dist/site/`
- `bun run doctor` — diagnose the environment (bun, go, ports, stale processes, generated types) with a fix per failing check

The `borgo` CLI also has `deploy init <caddy|nginx|systemd|compose>` (write the blessed deploy configs) and `pwa init` (manifest and service worker) — run them with `bunx borgo <cmd>`. The [deploy guide](https://github.com/LuigiDavideMicca/borgo/blob/main/docs/deploy.md) covers reverse proxy samples, systemd, and split-service setups.

## Deploy

`docker compose up -d` builds the multi-stage `Dockerfile` (small `oven/bun:slim` runtime, static Go binary) and serves the app on port 3000. The compose file is deliberately bare, because this app is: no database, so no volume; no sessions, so no `SESSION_SECRET`. Both are commented into `docker-compose.yml` for the day you add one.

## Layout

What this template ships is the whole list:

- `pages/index.tsx` — the only page. The file name is the route, so this one is `/`; add `pages/about.tsx` and `/about` exists, add `pages/notes/[id].tsx` and `/notes/:id` does. A page may export a `loader` (props fetched on the server before rendering), `head` (title and metas), `action` (form posts), `hydrate` (`false` or `"visible"`) to ship less JavaScript, and `prerender` (`true` lets `bun run export` run the loader once and bake the result into `dist/site/`; a page with a loader and no `prerender` is skipped by the export). A file whose name starts with `_` is never routed: `_layout.tsx` wraps its directory, `_404.tsx` and `_500.tsx` are the error pages, and anything else with that prefix is simply not served.
- `api/hello.go` — the only Go route, mounted by its `//borgo:route GET /api/hello` directive (you can also register one by hand in `init()` with `borgo.Handle`). It responds with `borgo.JSON`, and that call is what types the route: `borgogen` reads the Go type and writes `.borgo/api-types.d.ts`, so the `api` client in a loader knows the response shape without you declaring it twice.
- `main.go` — imports `api` and calls `borgo.Serve()`.
- `index.html` — the HTML shell every page renders into. `style.scss` — global styles. `public/` — served as-is, which is where `logo.svg` comes from.

Nothing else is wired up here on purpose. Sessions and auth, server-sent events, WebSocket topics and islands are all in the framework and none of them are in this template — `--template base` demonstrates SSE and islands, `--template full` adds auth and CRUD, and the [docs](https://github.com/LuigiDavideMicca/borgo/blob/main/docs/README.md) cover each one on its own page.

Ports: front server on `PORT` (default 3000), Go API on `API_PORT` (default 3501).

---

borgo is built by [Luigi Micca](https://luigimicca.com).
