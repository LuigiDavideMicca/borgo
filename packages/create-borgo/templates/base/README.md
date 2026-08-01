# {{name}}

A [borgo](https://github.com/LuigiDavideMicca/borgo) app: file-based React pages server-rendered by Bun, API routes written in Go.

This is the `base` template — a small tour of the framework: a loader-backed page (`/hello/world`), a form action, a zero-JS page with an island (`/about`), and live server-sent events from a goroutine (`/live`). Scaffold with `--template minimal` for a bare skeleton or `--template full` for auth + CRUD.

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
- `bun run doctor` — diagnose the environment (bun, go, ports, stale processes, generated types) with a fix per failing check

The `borgo` CLI also has `export` (prerender static pages into `dist/site/`) and `deploy init <caddy|nginx|systemd|compose>` (write the blessed deploy configs) — run them with `bunx borgo <cmd>`.

## Deploy

`docker compose up -d` builds the multi-stage `Dockerfile` (small `oven/bun:slim` runtime, static Go binary) and mounts a volume at `/data` for SQLite or anything persistent. See the [deploy guide](https://github.com/LuigiDavideMicca/borgo/blob/main/docs/deploy.md) for reverse proxy samples, systemd, and split-service setups.

## Layout

- `pages/` — React pages; file name is the route (`pages/hello/[name].tsx` → `/hello/:name`). Export a `loader` to fetch props on the server before rendering, `head` for the page title and metas, `action` to handle form posts, `hydrate` (`false` or `"visible"`) to ship less JavaScript. `_layout.tsx` wraps pages, `_404.tsx` / `_500.tsx` customize error pages.
- `api/` — Go API routes; annotate a handler with `//borgo:route GET /api/path` (or register manually in `init()` with `borgo.Handle`). Respond with `borgo.JSON` and the route's TypeScript type is generated into `.borgo/api-types.d.ts`, so the `api` client in loaders is fully typed. `borgo.NewSSEHub()` gives you live server-sent events, proxied to the browser without buffering. For two-way live updates, browsers join WebSocket topics with `subscribe` from `borgo-framework` and Go publishes into them with `borgo.Push(topic, event, data)` — literal topic and event make the payload type flow into the `subscribe` callback. Need users? Signed-cookie sessions, password hashing and the `borgo.Auth` login/logout/register helpers are built in — see the [auth guide](https://github.com/LuigiDavideMicca/borgo/blob/main/docs/auth-and-sessions.md).
- `main.go` — imports `api` and calls `borgo.Serve()`.
- `index.html` — HTML shell. `style.scss` — global styles.

Ports: front server on `PORT` (default 3000), Go API on `API_PORT` (default 3501).

---

borgo is built by [Luigi Micca](https://luigimicca.com).
