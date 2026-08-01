# Deploying borgo

Everything between `borgo build` and traffic: container and bare-metal layouts, reverse proxy configs, [static export](#static-export), caching, health checks and the full environment reference. You need this page once, when the app first ships — and the `borgo deploy init` templates write most of it for you.

A borgo app in production is two servers: the Go API binary and the Bun front server. `borgo start` is the one thing your supervisor — Docker, systemd, compose — starts and stops; it holds the pair together and exits if either dies.

One wrinkle worth knowing before you read a `ps` listing: bun sizes its outbound fetch pool when the process boots and cannot raise it afterwards, so when `BUN_CONFIG_MAX_HTTP_REQUESTS` is unset `borgo start` re-execs itself once with it set. You then see three processes — the supervisor `borgo start`, the child that actually runs the front server, and the Go binary the child spawned. The supervisor is the pid a service manager signals; it forwards `SIGINT`/`SIGTERM` to the child and exits with the child's code, and the child exits if the supervisor disappears. Set `BUN_CONFIG_MAX_HTTP_REQUESTS` yourself and there is no re-exec and no third process. Every config on this page that *starts* the app does exactly that — the template `Dockerfile`, the compose file and the systemd unit. The Caddyfile and the nginx `site.conf` do not: they are reverse proxies, they launch nothing, and they set no environment at all. Behind one of those the variable belongs in whatever actually starts the app — a unit file, a container, your shell — or you leave it unset and let `borgo start` re-exec.

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
| `compose` | `docker-compose.yml` | build, ports, a `SESSION_SECRET`/`DB_PATH` stub, a `/data` volume, `BUN_CONFIG_MAX_HTTP_REQUESTS`, restart policy | `docker compose up -d` |

Which one? **One box, Docker installed** → `compose` and you are done. **One box, no Docker** → `systemd`, plus `caddy` or `nginx` in front for TLS. **A proxy already terminates TLS for other apps** → just `caddy`/`nginx` to add the site. The generated files are a starting point in your repo, not managed state — edit them freely; `deploy init` never touches them again without `--force`.

## Docker, one container (recommended)

Every scaffolded app ships a multi-stage `Dockerfile` and a `docker-compose.yml` (missing one? `borgo deploy init compose` writes one, and `--force` overwrites what is there):

```bash
docker compose up -d
```

The builder image compiles the Go binary (static, `CGO_ENABLED=0`) and the client assets; the runtime image is `oven/bun:slim` with the app sources the SSR server needs, production `node_modules`, and `dist/`. `NODE_ENV` and `BUN_CONFIG_MAX_HTTP_REQUESTS` are set in the Dockerfile, so the compose file carries only what the *app* needs.

Two of those are worth setting deliberately, because the failure modes are quiet:

```yaml
environment:
  SESSION_SECRET: <long random string>   # required if you use sessions
  DB_PATH: /data/app.db                  # with a matching volume, below
volumes:
  - data:/data
```

`borgo deploy init compose` writes both of those with a named `/data` volume already declared, on the assumption that an app being deployed has data. The scaffolded templates do not: `base` and `minimal` have neither a database nor sessions and their compose files say so, and `full` signs sessions but keeps its stores in memory, so its compose file requires `SESSION_SECRET` — reading the random one `create-borgo` wrote into `.env` — and declares no volume. Add a volume when you add something to persist; a `data:` volume in front of an app with no database is a promise nothing keeps.

Missing `SESSION_SECRET` is the quietest failure of the three: the Go server boots, `/healthz` is green, and only session routes fail. See [cookies and sessions](security.md#cookies-and-sessions).

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
export const prerenderPaths = async ({ api }: PrerenderContext) => {
  const { tasks } = await api("GET /api/tasks");
  // a nil Go slice is null on the wire, so the generated type is
  // Array<Task> | null - see the typed bridge
  return (tasks ?? []).map((task) => ({ id: task.ID }));
};
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
# bun's outbound fetch pool defaults to 256, which ceilings concurrent
# proxied requests - event streams above all - see docs/realtime.md
Environment=BUN_CONFIG_MAX_HTTP_REQUESTS=16384
Restart=on-failure
User=www-data

[Install]
WantedBy=multi-user.target
```

Do not drop that `BUN_CONFIG_MAX_HTTP_REQUESTS` line when you edit the unit. Without it `borgo start` re-execs itself to set it, which works but gives systemd a supervisor process in front of the server for no reason; with it, the unit is one process tree with the pool already sized.

`borgo start` exits when the Go process dies, and `Restart=on-failure` brings both back.

## Health and metrics

Point the uptime monitor at the front server's `/healthz` — it returns `{status, uptime, api}`, probing the Go server's own `/healthz` (mounted by `borgo.Serve`) with a short timeout. The answer is always HTTP 200: `status` is `"ok"` or `"degraded"` and `api` is `"reachable"` or `"down"`, so a monitor that only checks the status code will never fire — match on the body.

Set `BORGO_METRICS=1` and the front server also serves `/metrics` in Prometheus text format, hand-rolled, zero dependencies:

- `borgo_http_requests_total{route, status}` — counter by route pattern and status code
- `borgo_http_request_duration_seconds{route, le}` — histogram, buckets `0.005 0.025 0.1 0.5 1 5`
- `borgo_process_uptime_seconds` — gauge

Route labels are the matched route *pattern*, not each concrete URL — and the pattern is the router's colon form, so `pages/tasks/[id].tsx` is labelled `route="/tasks/:id"`, never `/tasks/[id]` and never `/tasks/7`. After 100 distinct routes new ones fold into `route="other"`, so cardinality stays bounded.

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
| `BUN_CONFIG_MAX_HTTP_REQUESTS` | `16384` under `borgo dev` and `borgo start`; `256` (bun's default) otherwise | front server: how many proxied requests may be in flight at once. Each event stream holds one for its whole life, so bun's default ceilings concurrent SSE subscribers at ~255. `borgo dev` sets it, every config borgo generates that *launches* the app sets it (Dockerfile, compose, systemd — not the caddy/nginx proxy configs, which set no environment), and `borgo start` re-execs itself to set it when nothing else did. Read at process start — exporting it afterwards has no effect, which is why the re-exec exists |
| `BORGO_READ_HEADER_TIMEOUT` | `5s` | go server: cap on reading request headers (slow-header clients) |
| `BORGO_IDLE_TIMEOUT` | go `2m`, front server `30` | **one name, both halves, two grammars** — go reads a duration and panics on anything else; the front server reads whole seconds (its socket read deadline, capped at 255, `0` disables) and silently keeps its default on anything else. See the warning under this table |
| `BORGO_READ_TIMEOUT` | `0` (off) | go server: whole-request read deadline — leave off unless you have no streams |
| `BORGO_WRITE_TIMEOUT` | `0` (off) | go server: whole-response write deadline — `borgo.SSE` streams exempt themselves |
| `BORGO_SHUTDOWN_TIMEOUT` | `10s` | go server: grace period for in-flight requests on shutdown; `0` waits indefinitely |
| `BORGO_HASH_SLOTS` | `max(1, GOMAXPROCS/2)` | go server: password hashes that may run at once. One costs ~140 ms of cpu, so the cap is what keeps a login flood from starving every other route. A value that is not a positive integer is refused at startup rather than ignored |
| `NO_COLOR` | unset | disable ANSI colors in logs |

The Go timeouts are duration strings (`5s`, `2m`; `0` disables one) and a malformed value fails loudly at boot rather than silently defaulting; the front server's three — `BORGO_MAX_BODY` in bytes, `BORGO_API_TIMEOUT` in milliseconds, `BORGO_IDLE_TIMEOUT` in seconds — are plain numbers, and a malformed one is silently replaced by the default. `DB_PATH` in the samples above is the app's own variable, not the framework's.

> **Careful with `BORGO_IDLE_TIMEOUT`.** Both halves read that one name and neither knows the other does. `2m` is two minutes to Go and unparseable to the front server, which keeps 30 s without saying so; `120` is two minutes to the front server and a boot panic for the Go binary. `borgo start` hands both children the same environment, so there is no setting that means one thing. Leave it unset unless you run the two halves as separate processes with separate environments — and note that raising it is *not* how you keep event streams alive on the front server: streams are exempted from the deadline per response, automatically.

Three more exist for the build, not the runtime: `BORGO_TAILWIND=1` is what `borgo build --tailwind` sets for its child processes (use the flag, not the variable — see [styling](dev-experience.md#styling)); `BORGO_STATIC=1` is what `borgo export` sets for the build it drives, and it is substituted into the client bundle rather than read at runtime, which is what compiles the props-fetching navigation path out of an exported site; and `BORGO_PARENT_PID` is how the CLI tells its children whose death to exit with. `BORGO_RELOAD` and `BORGO_CHANGED` are internal to the dev loop — the latter carries the whole set of changed files, newline-separated.

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
