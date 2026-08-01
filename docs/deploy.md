# Deploying borgo

Everything between `borgo build` and traffic: container and bare-metal layouts, reverse proxy configs, [static export](#static-export), caching, health checks and the full environment reference. You need this page once, when the app first ships — and the `borgo deploy init` templates write most of it for you.

A borgo app in production is two processes: the Go API binary and the Bun front server. `borgo start` runs both and exits if either dies, so one supervisor — Docker, systemd, compose — supervises the pair.

## borgo deploy init

The command writes this page's blessed config for a target into your project, templated with the app's name (from `package.json`) and ports (`PORT`/`API_PORT`, defaulting to 3000/3501). It never overwrites an existing file unless you pass `--force`, and it prints the next command to run.

```bash
bunx borgo deploy init <caddy|nginx|systemd|compose> [--force]
```

| Target | Writes | It is | Then |
| --- | --- | --- | --- |
| `caddy` | `Caddyfile` | reverse proxy with automatic TLS, three lines | set your domain, `caddy run --config Caddyfile` |
| `nginx` | `site.conf` | reverse proxy: websocket upgrades, `proxy_buffering off` for SSE, long read timeout | set domain and certs, link into `sites-enabled/` |
| `systemd` | `borgo.service` | a unit running `bun run start` with the environment stubbed in | copy to `/etc/systemd/system/`, `systemctl enable --now` |
| `compose` | `docker-compose.yml` | the scaffolded compose shape (build, ports, `/data` volume, restart policy) | `docker compose up -d` |

Which one? **One box, Docker installed** → `compose` and you are done. **One box, no Docker** → `systemd`, plus `caddy` or `nginx` in front for TLS. **A proxy already terminates TLS for other apps** → just `caddy`/`nginx` to add the site. The generated files are a starting point in your repo, not managed state — edit them freely; `deploy init` never touches them again without `--force`.

## Docker, one container (recommended)

Every scaffolded app ships a multi-stage `Dockerfile` and a `docker-compose.yml` (missing one? `borgo deploy init compose` writes the same shape, templated with your app's port):

```bash
docker compose up -d
```

The builder image compiles the Go binary (static, `CGO_ENABLED=0`) and the client assets; the runtime image is `oven/bun:slim` with the app sources the SSR server needs, production `node_modules`, and `dist/`. The compose file mounts a named volume at `/data` — point `DB_PATH` (or your own database path) there so SQLite survives redeploys.

Set real values before going live:

```yaml
environment:
  SESSION_SECRET: <long random string>   # required if you use sessions
  DB_PATH: /data/app.db
```

## Docker, two services

Prefer separate containers? Run the API alone and the front server with `--front-only`, pointing `API_URL` at the api service:

```yaml
services:
  api:
    build: .
    command: ["./dist/api"]
    environment:
      API_PORT: "3501"
    volumes:
      - data:/data
    restart: unless-stopped

  front:
    build: .
    command: ["bun", "run", "start", "--front-only"]
    environment:
      API_URL: http://api:3501
    ports:
      - "3000:3000"
    depends_on:
      - api
    restart: unless-stopped

volumes:
  data:
```

`borgo.Push` needs the reverse direction across containers: set `FRONT_URL=http://front:3000` on the api service and the same `BORGO_PUSH_KEY` on both.

## Reverse proxy

Only the front server needs to be reachable — it proxies `/api/*` to Go and speaks WebSockets natively. Compression is built-in — static assets are precompressed to `.gz`/`.br` at build time, dynamic responses are gzipped on the fly — so the proxy should not compress again (no `encode` directive in Caddy, `gzip off` is nginx's default). `borgo deploy init caddy` (or `nginx`) writes these configs into your project — `Caddyfile` and `site.conf` respectively — templated with your app's name and port; an existing file is never overwritten unless you pass `--force`. Caddy gives you TLS in three lines:

```caddy
example.com {
    reverse_proxy localhost:3000
}
```

nginx needs the upgrade headers for WebSockets and SSE left unbuffered:

```nginx
server {
    listen 443 ssl;
    server_name example.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
```

Behind https, set `SESSION_SECURE=1` so session cookies carry the `Secure` attribute. Responses marked with `borgo.Cache` carry ordinary `Cache-Control` headers — see [Caching](#caching) below.

## Static export

`borgo export` prerenders every statically exportable page into `dist/site/`: plain HTML next to the built assets, precompressed siblings included. Pages without a loader export as-is; a page with a loader opts in with `export const prerender = true` — its loader runs once, at export time, against a temporary api process, so exporting needs the Go toolchain just like `borgo build` (borgogen runs, a scratch api binary is compiled and booted on an ephemeral port). Dynamic routes list their param sets:

```tsx
import type { PrerenderContext } from "borgo-framework";

export const prerender = true;
export const prerenderPaths = async ({ api }: PrerenderContext) =>
  (await api("GET /api/tasks")).tasks.map((task) => ({ id: task.ID }));
```

Pages with `hydrate = false` export with zero JavaScript; hydrated pages carry their chunks and hydrate against the exported props (client-side navigation falls back to plain page loads — there is no server to ask for props). A `pages/_404.tsx` exports as `dist/site/404.html` — the filename most static hosts pick up as their error page automatically. Everything else is skipped, with the reason printed.

Any static file server can host the result — for nginx the one-liner is `try_files`, plus `error_page` for the exported 404:

```nginx
server {
    listen 80;
    root /srv/my-app/dist/site;
    error_page 404 /404.html;
    location / { try_files $uri $uri/index.html =404; }
}
```

An exported site is pages only: [form actions](pages-and-routing.md#form-actions), [SSE and WebSocket topics](realtime.md) need the running borgo servers (`borgo start`). Which pages ship JavaScript is the page's own `hydrate` choice — see [hydration modes](client-navigation.md#partial-hydration).

## Caching

`borgo.Cache(w, 5*time.Minute)` sets `Cache-Control: public, max-age=300` (optional second argument adds `stale-while-revalidate`); `borgo.NoCache(w)` sets `no-store` for anything personalized. A reverse proxy in front turns these headers into actual caching — enable `proxy_cache` in nginx or `cache` in Caddy plugins if you want the proxy to serve them.

## systemd, no Docker

Build on the server (`bun install && bun run build`), then drop in a unit — `borgo deploy init systemd` generates exactly this file as `borgo.service`, with your app's name and ports filled in:

```ini
[Unit]
Description=my-app (borgo app)
After=network.target

[Service]
WorkingDirectory=/srv/my-app
ExecStart=/usr/local/bin/bun run start
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=API_PORT=3501
Environment=SESSION_SECRET=change-me
Restart=on-failure
User=www-data

[Install]
WantedBy=multi-user.target
```

`borgo start` exits when the Go process dies, and `Restart=on-failure` brings both back.

## Health and metrics

Point the uptime monitor at the front server's `/healthz` — it returns `{status, uptime, api}`, probing the Go server's own `/healthz` (mounted by `borgo.Serve`) with a short timeout. The answer is always HTTP 200: `status` is `"ok"` or `"degraded"` and `api` is `"reachable"` or `"down"`, so a monitor that only checks the status code will never fire — match on the body.

Set `BORGO_METRICS=1` and the front server also serves `/metrics` in Prometheus text format, hand-rolled, zero dependencies:

- `borgo_http_requests_total{route, status}` — counter by route pattern and status code
- `borgo_http_request_duration_seconds{route, le}` — histogram, buckets `0.005 0.025 0.1 0.5 1 5`
- `borgo_process_uptime_seconds` — gauge

Route labels are the file-convention patterns (`/tasks/[id]`, not each concrete URL); after 100 distinct routes new ones fold into `route="other"`, so cardinality stays bounded.

## Environment reference

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | front server port |
| `API_PORT` | `3501` | go api port |
| `API_URL` | `http://localhost:$API_PORT` | where the front server reaches the api (split deployments) |
| `FRONT_URL` | `http://localhost:$PORT` | where `borgo.Push` reaches the front server |
| `BORGO_PUSH_KEY` | unset | shared secret for `borgo.Push` across hosts — once set it *replaces* the loopback check, so set it on both halves or neither |
| `SESSION_SECRET` | unset | HMAC key for signed-cookie sessions (required to use them) |
| `SESSION_SECURE` | unset | `1` adds `Secure` to the session and csrf cookies |
| `BORGO_CSRF` | unset | `0` disables csrf checks on form actions, `1` forces them in dev |
| `BORGO_METRICS` | unset | `1` exposes `/metrics` (Prometheus text) on the front server |
| `BORGO_SECURITY_HEADERS` | unset | `0` drops the security headers *and* the CSP — see [security](security.md#changing-the-policy) |
| `BORGO_CSP` | unset | `0` drops the CSP alone; any other value replaces the policy, with `{nonce}` substituted per request |
| `BORGO_MAX_BODY` | `33554432` (32 MB) | front server: largest request body it will accept and buffer, in bytes |
| `BORGO_API_TIMEOUT` | `30000` (30 s) | front server: milliseconds to wait for the api's response headers before answering `504`; `0` disables |
| `BUN_CONFIG_MAX_HTTP_REQUESTS` | `256` (bun's default) | front server: how many proxied requests may be in flight at once. Each event stream holds one for its whole life, so the default ceilings concurrent SSE subscribers at ~255. borgo sets `16384` in `dev` and in the configs it generates; set it yourself if you launch the server another way. Read at process start — exporting it afterwards has no effect |
| `BORGO_READ_HEADER_TIMEOUT` | `5s` | go server: cap on reading request headers (slow-header clients) |
| `BORGO_IDLE_TIMEOUT` | `2m` | go server: idle keep-alive connections are reclaimed after this |
| `BORGO_READ_TIMEOUT` | `0` (off) | go server: whole-request read deadline — leave off unless you have no streams |
| `BORGO_WRITE_TIMEOUT` | `0` (off) | go server: whole-response write deadline — `borgo.SSE` streams exempt themselves |
| `BORGO_SHUTDOWN_TIMEOUT` | `10s` | go server: grace period for in-flight requests on shutdown; `0` waits indefinitely |
| `BORGO_HASH_SLOTS` | `max(1, GOMAXPROCS/2)` | go server: password hashes that may run at once. One costs ~140 ms of cpu, so the cap is what keeps a login flood from starving every other route. A value that is not a positive integer is refused at startup rather than ignored |
| `NO_COLOR` | unset | disable ANSI colors in logs |

The Go timeouts are duration strings (`5s`, `2m`; `0` disables one) and a malformed value fails loudly at boot rather than silently defaulting; the front server's two are plain numbers. `DB_PATH` in the samples above is the app's own variable, not the framework's.

Two more exist for the build, not the runtime: `BORGO_TAILWIND=1` is what `borgo build --tailwind` sets for its child processes (use the flag, not the variable — see [styling](dev-experience.md#styling)), and `BORGO_PARENT_PID` is how the CLI tells its children whose death to exit with. `BORGO_RELOAD` and `BORGO_CHANGED` are internal to the dev loop.

## Shutdown and zero-downtime redeploys

`borgo.Serve` traps `SIGINT` and `SIGTERM`. On either, it stops accepting new connections, lets in-flight requests finish, and ends every open SSE stream immediately through a shutdown hook — a long-lived stream does not hold the process hostage for the whole grace period. Anything still open when `BORGO_SHUTDOWN_TIMEOUT` expires is cut, so the process always exits and your supervisor never hangs.

The front server exits with the API it supervises, and both exit if their launcher dies — a force-killed deploy script cannot leave a process holding port 3000.

For a redeploy with no dropped requests, run two instances and switch the proxy between them:

```bash
# start the new version on a second port
PORT=3001 API_PORT=3502 bun run start &
# wait until it reports both halves healthy - /healthz is always HTTP 200,
# so the readiness signal is in the body, not the status code
until curl -fs http://localhost:3001/healthz | grep -q '"status":"ok"'; do sleep 0.5; done
# point the proxy at :3001, reload it, then stop the old instance
systemctl reload caddy
kill -TERM "$OLD_PID"
```

That `grep` is not decoration: `/healthz` answers 200 even while the API is down, reporting `"status":"degraded"`. See [health and metrics](#health-and-metrics).

With a single instance and a supervisor that restarts on exit, the window is the shutdown grace plus the boot time — usually under a second, but not zero. Docker's default `docker stop` grace is 10 seconds, which matches `BORGO_SHUTDOWN_TIMEOUT`'s default; lower one if you lower the other.
