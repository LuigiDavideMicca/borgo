<h1 align="center">
  <img src="assets/logo.svg" width="200" alt=""/>
  <br/>
  borgo
</h1>

<p>
  <a href="https://www.npmjs.com/package/borgo-framework"><img src="https://img.shields.io/npm/v/borgo-framework?label=borgo-framework&amp;color=c2552b" alt="npm borgo-framework"/></a>
  <a href="https://www.npmjs.com/package/create-borgo"><img src="https://img.shields.io/npm/v/create-borgo?label=create-borgo&amp;color=c2552b" alt="npm create-borgo"/></a>
  <a href="https://github.com/LuigiDavideMicca/borgo/actions/workflows/ci.yml"><img src="https://github.com/LuigiDavideMicca/borgo/actions/workflows/ci.yml/badge.svg" alt="ci"/></a>
  <a href="https://pkg.go.dev/github.com/LuigiDavideMicca/borgo"><img src="https://pkg.go.dev/badge/github.com/LuigiDavideMicca/borgo.svg" alt="go reference"/></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-sage" alt="license MIT"/></a>
</p>

*Italian for "village": small, self-governing, self-hosted.*

**The self-hosted React framework.** Vercel developer experience. Go performance. Bun tooling.

File-based React pages server-rendered by Bun, API routes written in Go. You get the DX — `bunx create-borgo@latest my-app`, drop a file in `pages/`, drop a file in `api/`, one dev command — without the platform. Deployment is one Go binary and one Bun server on any box you control.

Pages get nested layouts, per-page `<head>` management, streaming SSR through Suspense, client-side navigation with hover/viewport prefetching and scroll restoration, per-route code splitting, opt-out and deferred hydration plus islands, form actions that submit in place without losing your scroll (and still work with JavaScript off), live updates over server-sent events and first-class typed WebSocket topics, signed-cookie sessions, fast refresh in dev, opt-in Tailwind, the PWA mechanics (precache manifest, service worker serving, guarded registration), custom 404/500 pages, and static export for the pages that need no server — all through file conventions. Loaders and actions talk to the Go API through a client typed end to end by `borgogen`, which reads the Go handlers with `go/types` and generates the TypeScript route map, request bodies and WebSocket payloads included. Around the core: `/healthz` on both servers with opt-in Prometheus metrics, `borgo deploy init` for the blessed reverse-proxy/systemd/compose configs, and `borgo doctor` when something is off.

The entire framework is a few thousand lines of readable TypeScript and Go; the Go runtime has zero dependencies. It exists because most of what makes Next-style frameworks pleasant is conventions, not machinery — and conventions are cheap.

## Why borgo?

Not a feature list — the reasoning:

- **Go in production.** One static binary, small memory footprint, real concurrency. The API server is `net/http` with zero dependencies; what you deploy is what you read.
- **Bun for development.** Fast builds, fast refresh, one toolchain — the dev loop of a modern meta-framework without a bundler config to own.
- **React, unmodified.** The ecosystem you already know; no fork, no compiler magic, no proprietary component model.
- **Types generated, not maintained.** `borgogen` reads the Go handlers and emits the TypeScript bridge — request bodies, responses, WebSocket payloads. No OpenAPI spec drifting out of date.
- **Self-hosted, by conviction.** Any VPS, container host or bare-metal box. React, SSR, typed APIs, WebSockets, streaming and Docker — without depending on Vercel, Cloudflare or Netlify.

## Quickstart

Prerequisites: [Bun](https://bun.sh) >= 1.3, [Go](https://go.dev) >= 1.25.

```bash
bunx create-borgo@latest my-app
cd my-app
bun install
go mod tidy   # fetches the borgo go module
bun run dev
```

Three templates: `base` (default — a tour of loaders, actions, islands and SSE), `minimal` (one page, one route) and `full` (notes CRUD + auth + typed WebSockets) — pick with `--template`, or let the interactive prompt ask.

Open http://localhost:3000 — edit a page and watch fast refresh keep your state. For a guided build instead of a tour, [getting started](docs/getting-started.md) takes you from here to a working feature in about twenty minutes. When it's time to ship: `docker compose up -d` (the scaffold includes the Dockerfile), or see the [deploy guide](docs/deploy.md).

To poke at the full demo instead, clone this repo and run `bun install`, then `cd examples/tasks && bun run dev`.

## Conventions

Everything below is a file convention. Each gets one paragraph here and a deep-dive page in [docs/](docs/README.md).

### Pages

React components in `pages/`, routed by file name — `pages/tasks/[id].tsx` → `/tasks/:id`. A page may export a `loader` that runs on the server before rendering; its result becomes the component's props. Loader and action code is stripped from client bundles, so server-only imports never reach the browser.

```tsx
import type { LoaderContext } from "borgo-framework";
import type { Task } from "../.borgo/api-types";

export async function loader({ params, api }: LoaderContext) {
  const { task } = await api("GET /api/tasks/{id}", { params: { id: params.id } });
  return { task };
}

export default function TaskDetail({ task }: { task: Task }) { /* ... */ }
```

Layouts (`_layout.tsx`, nested), per-page `head` exports, streaming SSR through Suspense, and custom `_404.tsx`/`_500.tsx` error pages round out the page model. Deep dive: [pages and routing](docs/pages-and-routing.md).

### API routes and the typed bridge

API routes are Go files in `api/`; annotate a handler with a route directive and it is mounted for you. The Go runtime imposes no database and has zero dependencies.

```go
//borgo:route GET /api/tasks
func ListTasks(w http.ResponseWriter, r *http.Request) {
    borgo.JSON(w, http.StatusOK, TaskList{Tasks: tasks})
}
```

`borgogen` statically analyzes the `api` package — no reflection, nothing at runtime — and generates the TypeScript route map the `api` client is typed by: response types from `borgo.JSON[T]`/`borgo.WriteJSON` calls (helpers followed), request types from `borgo.Bind[T]`, custom marshalers covered by `//borgo:type` overrides. A wrong body fails `tsc`, and CI proves it. Deep dive: [the typed bridge](docs/typed-bridge.md).

### Form actions

A page may export an `action`; the front server runs it for `POST` requests to that page's URL. On hydrated pages the runtime enhances the form — the action runs over `fetch`, the page re-renders in place and the scroll position stays put — while without JavaScript the same form falls back to the classic post cycle. `redirect(to)` gives you post/redirect/get either way:

```tsx
import { redirect, type ActionContext } from "borgo-framework";

export async function action({ request, api }: ActionContext) {
  const form = await request.formData();
  const title = String(form.get("title") ?? "").trim();
  await api("POST /api/tasks", { body: { title, body: String(form.get("body") ?? "") } });
  return redirect("/");
}
```

Deep dive: [pages and routing](docs/pages-and-routing.md#form-actions).

### Client navigation and hydration

Plain `<a>` tags become client-side transitions — no `<Link>` component — with per-route code splitting, hover/viewport prefetching, and scroll restoration on back/forward. Pages control their JavaScript: `export const hydrate = false` ships zero JS, `"visible"` defers hydration until scrolled into view, and `<Island>` components hydrate independently inside otherwise-static pages. Deep dive: [client navigation and hydration](docs/client-navigation.md).

### Realtime

`borgo.SSE` and `borgo.NewSSEHub` make any handler an event stream, proxied without buffering. The front server is also a native WebSocket server: browsers join named topics with `subscribe`, Go publishes into them with `borgo.Push(topic, event, data)` — and borgogen types the payloads end to end, so checking `event` narrows `data` and an undeclared event name fails `tsc`.

```go
borgo.Push("live", "task-created", task.Title)
```

Deep dive: [realtime](docs/realtime.md).

### Sessions and auth

Mechanics, not policy: signed-cookie sessions (`borgo.SetSession`/`GetSession`/`ClearSession`, HMAC with `SESSION_SECRET`, expiry signed in), stdlib PBKDF2 password hashing behind a swappable interface, and `borgo.Auth[U]` — you supply a `Lookup` (and optionally `Register`) over *your* user store, it provides the login/logout/register handlers. `borgo.Authed` guards api routes with a JSON 401; loaders guard pages by returning `redirect()`; form actions are CSRF-protected with a double-submit token (`<CsrfField />`) for any browser that has been issued one — login forms included. Deep dive: [auth and sessions](docs/auth-and-sessions.md).

```go
var auth = borgo.Auth[User]{Lookup: lookupUser, Register: createUser}

func init() {
    borgo.Handle("POST /api/login", auth.LoginHandler)
    borgo.Handle("GET /api/me", borgo.Authed(currentUser))
}
```

### Static export

`borgo export` prerenders every statically exportable page into `dist/site/` — plain HTML next to the built assets, servable by nginx, a CDN, anything. Pages with loaders opt in with `export const prerender = true`; dynamic routes list their param sets with `prerenderPaths`. `hydrate = false` pages export with zero JavaScript. Deep dive: [static export](docs/deploy.md#static-export).

### Dev experience

`borgo dev` keeps the browser hot: component and hook edits apply through react-refresh with state intact, styles recompile and swap in place (`style.scss` by default, Tailwind v4 behind the opt-in `--tailwind` flag), Go changes rebuild the binary and reload once the new API answers, and a broken build keeps serving the error overlay instead of taking the port down. When something is off, `borgo doctor` diagnoses the environment — bun, go, ports, stale processes, generated types — with a one-line fix per failing check. Deep dive: [dev experience](docs/dev-experience.md); stuck? [FAQ and troubleshooting](docs/faq-and-troubleshooting.md).

### Security

A locked-down default posture, not a checklist you assemble: security headers and a strict Content-Security-Policy on every document — with the server-rendered props script nonced, so no `'unsafe-inline'` is needed in production — CSRF on form actions, signed `HttpOnly` session cookies, bounded request bodies, a slowloris-resistant timeout matrix, an `Origin` check on WebSocket upgrades, and duplicate cookies treated as no cookie at all. Everything is overridable by environment variable, and [the security page](docs/security.md) is equally explicit about what borgo deliberately leaves to you.

### Health checks and metrics

The front server answers `/healthz` with `{status, uptime, api}` — probing the Go server's own `/healthz` (mounted automatically by `borgo.Serve`). Set `BORGO_METRICS=1` and `/metrics` serves Prometheus text: request counts and a duration histogram by route pattern and status, hand-rolled, zero dependencies. Deep dive: [deploy guide](docs/deploy.md#health-and-metrics).

## Architecture

Two processes, one front door:

- **Bun front server** (`borgo dev` / `borgo start`) — server-renders pages with `react-dom/server`, serves static assets, proxies `/api/*` to the Go server. Loaders run here, fetching from Go during SSR; props are serialized into the HTML and the client bundle hydrates the same tree. Compression is built-in: `borgo build` precompresses assets to `.gz`/`.br` (hashed chunks served immutable), SSR HTML and API JSON are gzipped at runtime.
- **Go API server** — plain `net/http` with method patterns, bootstrapped by `borgo.Serve()`.

```
packages/borgo          npm: the bun/typescript core (cli, ssr server, router, build, runtime, typed api client)
packages/create-borgo   npm: project scaffolder (three templates: base, minimal, full)
*.go                    go module github.com/LuigiDavideMicca/borgo: route registry, server bootstrap,
                        sse, websocket push, sessions, cache helpers (standard library only)
cmd/borgogen            go: static analysis codegen for the typed bridge and route mounting. same module,
                        so go.mod requires golang.org/x/tools - a build-time tool that never links into
                        your api binary, which is why "zero deps" means zero *runtime* deps
examples/tasks          demo app: tasks crud with gorm + sqlite, sse, websockets, islands, deferred hydration
docs/                   getting started, then deep dives: pages, typed bridge, client nav, realtime,
                        auth, security, dev experience, pwa, deploy, faq
```

Commands (in an app): `borgo dev` (both servers, watch, fast refresh), `borgo build` (client assets in `public/assets/`, Go binary in `dist/`), `borgo start` (run from build output, supervising both processes; `--front-only` for split deployments with `API_URL`), `borgo export` (static site in `dist/site/`), `borgo deploy init <caddy|nginx|systemd|compose>` (deploy configs), `borgo pwa init` (manifest and service worker), `borgo doctor` (environment diagnosis). Ports via `PORT` (front, 3000) and `API_PORT` (Go, 3501).

### Deploying

Scaffolded apps ship a multi-stage `Dockerfile` (Go builds static, the runtime is `oven/bun:slim`) and a `docker-compose.yml` with a `/data` volume for SQLite — `docker compose up -d` is a deployment. The [deploy guide](docs/deploy.md) covers the single-container and two-service layouts, Caddy and nginx reverse-proxy samples (WebSockets and SSE included), a systemd unit for bare metal, static export hosting, and the full environment reference — and `borgo deploy init` writes those configs into your project, templated with the app's name and ports.

## Tests

Three layers, all run by CI on every pull request and on every push to `main`:

- **Go** (`go test ./...`) — table-driven tests for the route registry, sessions (sign/verify/tamper/expiry), password hashing and the `borgo.Auth` handlers (login/register/logout, timing-safe 401s, `Authed`), cache headers, the `/healthz` handler, SSE stream framing and hub broadcast/slow-client behavior, `borgo.Push`, and borgogen against a committed fixture app: route discovery (directives + `Handle` calls), helper following, `WriteJSON`, `Bind`, type overrides, `Push` event extraction, snapshot freshness, and the error paths (duplicate patterns, malformed directives, dynamic push topics).
- **TypeScript** (`bun test packages/borgo/test`) — the router (patterns, matching, params), the api client (URL building, headers, `ApiError`, typed bodies plumbing), hydrate/refresh source parsing, manifest generation against a temp fixture (islands flags, client-route exclusion, precedence), every `borgo doctor` check against a fake environment, the export planner (loader/prerender/dynamic partitioning, path filling), the deploy config templates (ports, names, refuse-overwrite), and the Prometheus exposition format.
- **End-to-end** (`npx playwright test`) — against a production build of `examples/tasks`: client navigation, hover/viewport prefetching, scroll restoration, islands, hydration modes, form actions (enhanced in-place submits, crash surfacing, anonymous-post CSRF), the auth round trip (register, loader guard, logout, login, forged-post CSRF rejection), the precache manifest, SSE, two-tab WebSockets with Go push, streaming SSR, error pages, `/healthz` on both servers, `/metrics` series, a `borgo doctor` smoke — plus a dev-server project asserting fast refresh preserves component state (including five consecutive rapid edits), hook add/remove remounts without a reload, custom hook edits hot-apply, Go edits reload exactly once and only after the api answers, CSS hot-swaps, and layouts fall back to a reload — and an export project that runs `borgo export` and serves `dist/site` from a plain static file server, asserting content, hydration against exported props, and the zero-JS page.

## Versioning and releases

[release-please](https://github.com/googleapis/release-please) maintains a release PR from conventional commits; merging it tags `vX.Y.Z` and publishes both npm packages (`borgo-framework`, `create-borgo`) with linked versions via npm trusted publishing, provenance attached. The Go module `github.com/LuigiDavideMicca/borgo` lives at the repo root and resolves the **same** `vX.Y.Z` tag — one version number across all four artifacts that have to agree: the Go module, the two npm packages, and the `borgo` CLI that ships as `borgo-framework`'s `bin`. See [api stability](docs/api-stability.md#one-version-number-four-artifacts).

## How it compares

Honest comparison with the frameworks a borgo adopter would otherwise pick. ✓ means shipped and documented here; a — links to the reasoning in the next section.

| | borgo | Next.js | Nuxt | SolidStart |
| --- | --- | --- | --- | --- |
| Backend language | **Go** | Node | Node | Node |
| File-based routing, nested layouts | ✓ | ✓ | ✓ | ✓ |
| SSR + streaming Suspense | ✓ | ✓ | ✓ | ✓ |
| Typed server↔client bridge | ✓ generated from Go source, request bodies included | ✓ Server Actions (API routes: manual / tRPC) | ✓ Nitro `$fetch` | ✓ server functions |
| Client nav, prefetch, scroll restoration | ✓ | ✓ | ✓ | ✓ |
| Per-route code splitting | ✓ | ✓ | ✓ | ✓ |
| Hydration control | ✓ page-level opt-out, deferred, islands | — (RSC instead) | ✓ islands (experimental) | — (fine-grained reactivity instead) |
| Form actions | ✓ | ✓ | ✓ | ✓ |
| SSE + WebSockets first-class | ✓ typed event payloads | bring your own | ✓ Nitro | bring your own |
| Static export | ✓ `borgo export` | ✓ | ✓ | ✓ |
| Health endpoint + metrics | ✓ built-in, opt-in Prometheus | DIY | DIY | DIY |
| Sessions/auth | ✓ signed cookie, hashing, login helpers, CSRF | libraries | modules | libraries |
| Security headers + CSP by default | ✓ nonced, overridable | DIY | modules | DIY |
| Fast refresh | ✓ full transform | ✓ full transform | ✓ | ✓ |
| React Server Components | — | ✓ | n/a | n/a |
| ISR / edge / serverless targets | — | ✓ | ✓ | ✓ |
| Image/font optimization | — | ✓ | ✓ | — |
| Plugin ecosystem | — | ✓ | ✓ | ✓ |
| Deploy story | one box: Docker/compose/systemd, generated configs | Vercel or DIY | many presets | many presets |
| Framework size | small enough to read: the whole thing, codegen and cli tooling included, is a few thousand lines of Go and TypeScript | large | large | medium |

## What this is not

Everything here is a deliberate choice, with the reason attached:

- **No React Server Components.** Loaders returning serialized props are the model: they cover data-on-the-server with a runtime small enough to read. RSC needs deep bundler/runtime integration that would be most of the framework's weight for one feature.
- **No edge, serverless or ISR targets.** borgo is self-hosted by conviction — one box, two processes, a reverse proxy. `borgo.Cache` headers plus proxy caching cover what ISR covers on a single-site scale, and `borgo export` covers the fully static case.
- **No image/font optimization pipeline.** The build is one `Bun.build` call and stays that way; put a CDN or `vips` in front if you need it.
- **No plugin system.** The framework is small enough that the extension mechanism is reading the source and changing it.
- **Loader data is not streamed on client navigations** — one JSON payload, fetched in parallel with the route chunk (and usually prefetched on hover). Streaming applies to initial SSR, where it matters most.
- **Auth is mechanics, not policy.** Signed cookie, hashing, login/logout/register handlers and CSRF for actions are provided; the user store, its schema, OAuth and everything beyond username/password stay in your hands.
- **The typed bridge is static analysis, no runtime reflection.** Helpers are followed across the packages of your module, inline `json.NewEncoder(w).Encode(v)` is read, and `//borgo:type` covers custom marshalers; what stays invisible is a helper *outside* your module, an encoder stored in a variable, and a dynamically chosen type — those routes type as `unknown`, so the escape hatch is visible, not silent.
- **WebSocket topics are a relay, not RPC.** The front server forwards `{event, data}` between subscribers and Go; per-message business logic belongs in Go routes. `borgo.Push` types the payloads end to end — the relay itself stays dumb.

Development happens in [issues](https://github.com/LuigiDavideMicca/borgo/issues).

---

Built by [Luigi Micca](https://luigimicca.com).
