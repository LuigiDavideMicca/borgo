# {{name}}

A [borgo](https://github.com/LuigiDavideMicca/borgo) app: file-based React pages server-rendered by Bun, API routes written in Go.

This is the `full` template — a working app skeleton: notes CRUD through form actions, register/login/logout with signed-cookie sessions and CSRF (`/login`, `/account`), a protected page guard, SSE refresh across tabs, and a typed WebSocket channel (`/live`). Users and notes live in memory — swap the two stores in `api/users.go` and `api/notes.go` for real persistence and everything else keeps working.

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

`docker compose up -d` builds the multi-stage `Dockerfile` (small `oven/bun:slim` runtime, static Go binary) and serves the app on port 3000.

This template signs session cookies, so it cannot run without `SESSION_SECRET`. `create-borgo` generated a random one into `.env` when it scaffolded this app, and the compose file reads it from there — nothing to fill in, and nothing to commit: `.env` is gitignored, and it is the one file worth copying to the server by hand. The compose file declares the variable as *required*, so a missing key stops `docker compose up` with a message instead of producing an app whose every login answers 500. Serving over https? Uncomment `SESSION_SECURE: "1"` so the session and CSRF cookies carry `Secure`.

The users and notes stores are in memory, so there is no volume here yet; swap them for a real database and `docker-compose.yml` has the two lines commented in. See the [deploy guide](https://github.com/LuigiDavideMicca/borgo/blob/main/docs/deploy.md) for reverse proxy samples, systemd, and split-service setups.

## Layout

- `pages/` — React pages; the file name is the route. This template ships `index.tsx` → `/` (the notes list, with its form actions), `login.tsx` → `/login`, `register.tsx` → `/register`, `account.tsx` → `/account` (guarded in its own loader — an unauthenticated visitor is redirected, the guard is not middleware) and `live.tsx` → `/live`. A page may export a `loader` (props fetched on the server before rendering), `head` (title and metas), `action` (form posts), and `hydrate` (`false` or `"visible"`) to ship less JavaScript. A file whose name starts with `_` is never routed: `_layout.tsx` — which this template uses for the header and the session strip — wraps its directory and everything below it, `_404.tsx` and `_500.tsx` are the error pages, and anything else with that prefix is simply not served.
- `api/` — Go API routes; annotate a handler with `//borgo:route GET /api/path` (or register manually in `init()` with `borgo.Handle`). Respond with `borgo.JSON` and the route's TypeScript type is generated into `.borgo/api-types.d.ts`, so the `api` client in a loader is fully typed. `users.go` wires `borgo.Auth` to an in-memory user store for register / login / logout over signed-cookie sessions; `notes.go` is the CRUD behind the home page, guarded with `borgo.Authed`; `events.go` exposes the `borgo.NewSSEHub()` that `notes.go` publishes into, which is how an open tab learns another one added a note. `notes.go` also calls `borgo.Push("live", "note-created", …)`, relaying the same fact onto the WebSocket topic `/live` subscribes to — and the type of that third argument is what makes the browser's callback typed.
- `ws-events.d.ts` — declares the payload of an event the *browser* publishes. Events Go pushes are generated from the `borgo.Push` calls; one going the other way has no Go source to read, so it is declared by hand here and typed just as strictly.
- `main.go` — imports `api` and calls `borgo.Serve()`.
- `index.html` — HTML shell. `style.scss` — global styles. `public/` — served as-is, which is where `logo.svg` comes from.

The user and note stores are maps in memory, so everything disappears on restart — swap the two stores in `api/users.go` and `api/notes.go` for a real database and no page changes. The [auth guide](https://github.com/LuigiDavideMicca/borgo/blob/main/docs/auth-and-sessions.md) explains what the framework guarantees and what stays yours.

Ports: front server on `PORT` (default 3000), Go API on `API_PORT` (default 3501).

---

borgo is built by [Luigi Micca](https://luigimicca.com).
