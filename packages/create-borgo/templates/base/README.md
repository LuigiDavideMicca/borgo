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
- `bun run export` — prerender the statically exportable pages into `dist/site/`
- `bun run doctor` — diagnose the environment (bun and go versions, the bun shim on `PATH`, node, docker, the two ports and who holds them, disk space, the generated types, your dependencies, write access) with a fix beside each failing check

The `borgo` CLI also has `deploy init <caddy|nginx|systemd|compose>` (write the blessed deploy configs) and `pwa init` (manifest and service worker) — run them with `bunx borgo <cmd>`. The [deploy guide](https://github.com/LuigiDavideMicca/borgo/blob/main/docs/deploy.md) covers reverse proxy samples, systemd, and split-service setups.

## Deploy

`docker compose up -d` builds the multi-stage `Dockerfile` (small `oven/bun:slim` runtime, static Go binary) and serves the app on port 3000. The compose file is deliberately bare, because this app is: everything it shows off keeps its state in memory, so there is no database to mount a volume for and no sessions to sign. Both are commented into `docker-compose.yml` for the day you add one.

## Layout

- `pages/` — React pages; the file name is the route. This template ships four: `index.tsx` → `/`, `about.tsx` → `/about`, `live.tsx` → `/live`, and `hello/[name].tsx` → `/hello/:name`, where `[name]` matches one path segment and arrives as `params.name`. A page may export a `loader` (props fetched on the server before rendering — `hello/[name].tsx` calls the Go route from one), `head` (title and metas), `action` (form posts), and `hydrate` (`false` or `"visible"`) to ship less JavaScript. A file whose name starts with `_` is never routed: `_layout.tsx` wraps its directory, `_404.tsx` and `_500.tsx` are the error pages, and anything else with that prefix is simply not served.
- `islands/Counter.tsx` — an island: a component that hydrates on its own inside a page that ships no bundle of its own. `pages/about.tsx` sets `hydrate = false` and drops `<Island name="Counter" />` into the markup, so that page loads only the counter's JavaScript and nothing else. Any default-exported component in `islands/` can be used the same way, by its file name.
- `api/` — Go API routes; annotate a handler with `//borgo:route GET /api/path` (or register manually in `init()` with `borgo.Handle`). `hello.go` responds with `borgo.JSON`, and that call is what types the route: `borgogen` reads the Go type and writes `.borgo/api-types.d.ts`, so the `api` client in a loader knows the response shape. `events.go` opens a `borgo.NewSSEHub()` and a goroutine publishes into it, which is what `/live` subscribes to — server-sent events, proxied to the browser without buffering.
- `main.go` — imports `api` and calls `borgo.Serve()`.
- `index.html` — HTML shell. `style.scss` — global styles. `public/` — served as-is, which is where `logo.svg` comes from.

Not in this template, but one page away in the docs: two-way WebSocket topics (`subscribe` in the browser, `borgo.Push(topic, event, data)` in Go, with the payload type flowing from one to the other) and users — signed-cookie sessions, password hashing and the `borgo.Auth` login/logout/register helpers are built in. `--template full` has both wired up; the [auth guide](https://github.com/LuigiDavideMicca/borgo/blob/main/docs/auth-and-sessions.md) and the [realtime guide](https://github.com/LuigiDavideMicca/borgo/blob/main/docs/realtime.md) explain them.

Ports: front server on `PORT` (default 3000), Go API on `API_PORT` (default 3501).

---

borgo is built by [Luigi Micca](https://luigimicca.com).
