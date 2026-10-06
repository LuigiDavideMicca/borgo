# Deploying borgo

Everything between `borgo build` and traffic: container and bare-metal layouts, reverse proxy configs, [static export](#static-export), caching, health checks and the full environment reference. You need this page once, when the app first ships — and the `borgo deploy init` templates write most of it for you.

A borgo app in production is two processes: the Go binary, which answers the public port and runs your API, and the Bun render service behind it on loopback. `borgo start` is the one thing your supervisor — Docker, systemd, compose — starts and stops; it holds the pair together and exits if either dies.

One wrinkle worth knowing before you read a `ps` listing: bun sizes its outbound fetch pool when the process boots and cannot raise it afterwards, so when `BUN_CONFIG_MAX_HTTP_REQUESTS` is unset `borgo start` re-execs itself once with it set. You then see three processes — the supervisor `borgo start`, the child that actually runs the render service, and the Go binary the child spawned. The supervisor is the pid a service manager signals; it forwards `SIGINT`/`SIGTERM` to the child and exits with the child's code, and the child exits if the supervisor disappears. Set `BUN_CONFIG_MAX_HTTP_REQUESTS` yourself and there is no re-exec and no third process. Every config on this page that *starts* the app does exactly that — the template `Dockerfile`, the compose file and the systemd unit. The Caddyfile and the nginx `site.conf` do not: they are reverse proxies, they launch nothing, and they set no environment at all. Behind one of those the variable belongs in whatever actually starts the app — a unit file, a container, your shell — or you leave it unset and let `borgo start` re-exec.

## borgo deploy init

The command writes this page's blessed config for a target into your project, templated with the app's name (from `package.json`) and ports (`PORT`/`API_PORT` **as your `.env` sets them**, defaulting to 3000/3501). It never overwrites an existing file unless you pass `--force`, and it prints the next command to run.

The ports come from the app's `.env`, deliberately, and not from the shell you ran the command in: a `PORT` exported for something else that afternoon would otherwise be baked into the unit file, the compose file and the proxy in front of them, giving you a deployment that works from one terminal with nothing in any of the three files to say why. A `.env` that names no port, or names something that is not one, gets 3000/3501.

```bash
bunx borgo deploy init <caddy|nginx|systemd|compose> [--force]
```

| Target | Writes | It is | Then |
| --- | --- | --- | --- |
| `caddy` | `Caddyfile` | reverse proxy with a 1 MiB body cap, the forwarding headers, and `tls internal` so it runs offline as written | `caddy run --config Caddyfile`; to go live, set your domain and delete `tls internal` |
| `nginx` | `site.conf` | the same, spelled out: websocket upgrades, `proxy_buffering off` for SSE, long read timeout | set domain and certs, link into `sites-enabled/` |
| `systemd` | `borgo.service` | a hardened unit running `bun run start`, reading its secrets from the app's `.env` | copy to `/etc/systemd/system/`, `systemctl enable --now` |
| `compose` | `docker-compose.yml` | build, ports, `BUN_CONFIG_MAX_HTTP_REQUESTS`, restart policy, a `/healthz` healthcheck, a required `SESSION_SECRET` if the app already signs sessions, and a commented-out `DB_PATH`/volume block | `docker compose up -d` |

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
  # 32 characters minimum, or the Go binary refuses to boot
  SESSION_SECRET: "${SESSION_SECRET:?missing - openssl rand -base64 48}"
  DB_PATH: /data/app.db   # with a matching volume, below
volumes:
  - data:/data
```

`borgo deploy init compose` writes neither of those on spec. It reads your `.env` first, and only writes the `SESSION_SECRET` line when the app *already* has a usable key there — as the required form above, interpolated by compose from that same `.env`, which the image itself never receives (`.dockerignore` excludes it). An app that signs nothing gets no line at all, because a line the app does not need is a line that overrides the key it does: a real environment variable beats `.env` in bun, so a stub here silently invalidates every session the app ever issued. The `DB_PATH` and volume block is written **commented out**, for a different reason: nothing in a scaffolded app persists anything yet, and a mount docker creates root-owned is a permission error waiting for the first app that uses it. The scaffolded `Dockerfile` already creates `/data` owned by the image's user, so uncommenting the block is the whole change when you do have something to store. The scaffolded templates match: `base` and `minimal` have neither a database nor sessions and their compose files say so, and `full` signs sessions but keeps its stores in memory, so its compose file requires `SESSION_SECRET` — reading the random one `create-borgo` wrote into `.env` — and declares no volume.

The two ways `SESSION_SECRET` can be wrong fail in opposite directions, and only one of them is loud. **Missing** is the quietest failure on this page: the Go server boots, `/healthz` is green, and only session routes fail — closed, never open, so nothing forges against the absent key. **Set but shorter than 32 bytes** is the reverse: `borgo.Serve` refuses to start at all, so the container restart-loops with the reason on stdout. See [cookies and sessions](security.md#cookies-and-sessions).

## Two containers? Not yet

The two halves cannot be split across containers or hosts in 0.30. The render service binds loopback and answers only requests carrying the boot key the front minted, which is the property that lets it skip verifying anything for itself; reaching it from another container would mean a key on the wire, a listener on a routable address, and a deployment shape that has been neither designed nor tested. `borgo start --front-only`, which used to run the Bun front against a remote API, refuses with that explanation rather than starting a renderer nothing can reach.

So one container runs both, as the generated `Dockerfile` and compose file do. Scale by running more of them behind your reverse proxy, each with its own public port; nothing in a borgo process is shared between instances anyway — the SSE hub, the topic relay and an in-memory session store are per-process, which the [realtime](realtime.md#honest-limits) page states as a limit in its own right.

## Cold start, measured — and the serverless question

borgo targets no serverless platform, and [why](why.md#why-self-hosted-only-no-serverless-targets) is argued where the other design positions are. What belongs here is the number that decision is usually litigated with. A scaffolded `full` app, built into its shipped `Dockerfile` and started cold — measured from the moment `docker run` is issued, polling every 15 ms:

| First 200 on | Median of 5 runs |
| --- | --- |
| `/healthz` (both halves supervised and answering) | 330 ms |
| `/` (a real server-rendered page) | 343 ms |

Measured on Docker Desktop (WSL2) on a development laptop. Most of that is Docker, not borgo: the container's own timestamped log shows the Go binary answering ~40 ms after the entrypoint runs and the render service printing `ready in 12ms` about 100 ms in — the rest is container creation, which a Linux host does faster than Docker Desktop. The runtime image is 353 MB: `oven/bun:slim` plus production `node_modules`, the app sources the SSR server needs, and the static Go binary.

A third of a second matters for one deployment shape this page otherwise doesn't cover: scale-to-zero *container* platforms (Fly machines, Cloud Run and their kind), where the first visitor after an idle period pays the boot. borgo makes that visitor wait roughly a blink, and inside the container nothing platform-specific is needed — it is the same image this page builds. Two honest caveats before you do it: everything in-memory (the SSE hub, the WebSocket relay, the `full` template's session store) evaporates with the instance and is never shared across instances, and an event stream held open is exactly the connection such platforms bill or cut. If that shape fits your app anyway, the number above says the platform's cold-start economics are not the obstacle.

What stays refused is function-per-request — bundling the server into a FaaS runtime, one invocation per render. It is not a matter of boot time: the SSE hub, the topic relay, the page cache, the asset index and the supervised shutdown all assume a process that outlives the request, and on a per-invocation platform each becomes either a lie or a managed service borgo would have to document and test six ways. That adapter matrix is the weight this framework exists to not carry — the [full argument, with its bill](why.md#why-self-hosted-only-no-serverless-targets), stands in one place rather than being re-fought per platform.

## Reverse proxy

Only the public port needs to be reachable — the Go front answers `/api/*` itself, serves the files, answers `/ws` itself, and forwards the pages to the render service. Compression is built-in — static assets are precompressed to `.gz`/`.br` at build time, dynamic responses are gzipped on the fly — so the proxy should not compress again (no `encode` directive in Caddy, `gzip off` is nginx's default). `borgo deploy init caddy` (or `nginx`) writes these configs into your project — `Caddyfile` and `site.conf` respectively — templated with your app's name and port; an existing file is never overwritten unless you pass `--force`. Caddy gives you TLS in one block, and the rest of it is the policy nginx has to spell out longhand:

```caddy
example.com {
    # local CA, no ACME, no network. delete when the domain above is real.
    tls internal
    # borgo.Bind reads at most 1 MiB; a route that takes more uses
    # borgo.BindMax, and this line has to be raised with it.
    request_body {
        max_size 1MiB
    }
    reverse_proxy localhost:3000 {
        # written from the peer, never from what the client sent
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
    }
}
```

nginx needs the upgrade headers for WebSockets, SSE left unbuffered, and the forwarding headers it does not add on its own — the same body cap and the same two headers, so that the two files describe one app and not two:

```nginx
# at http level, which is where sites-enabled is included from: `Connection:
# upgrade` belongs on a request that asked to upgrade and on no other. A fixed
# value sends it on every proxied request, which stops nginx from keeping the
# upstream connection alive and hands borgo a hop-by-hop header to strip. The
# empty branch makes nginx omit the header entirely on ordinary requests.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      '';
}

server {
    listen 443 ssl;
    server_name example.com;
    server_tokens off;

    # borgo.Bind reads at most 1 MiB; a route that takes more uses
    # borgo.BindMax, and this line has to be raised with it.
    client_max_body_size 1m;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        # written from the peer, never from what the client sent
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
```

**`tls internal` is why the file runs offline, and it is the line you delete.** Caddy's automatic HTTPS has no local mode to fall back to: a site block naming `example.com` with no `tls` directive is not a placeholder waiting to be filled in, it is a real ACME order placed against Let's Encrypt, for a domain you do not own, from your account — and Caddy retries that failure for thirty days while serving nothing. Rate limits are counted per requesting account, so the bill for trying our example arrives at your name. So the generated `Caddyfile` issues from Caddy's own local CA and reaches no network at all: `caddy run --config Caddyfile` works as written, and the first run offers to add that CA to your trust store (decline it and your browser warns; nothing else changes). Going live is two edits in adjacent lines — your domain in place of `example.com`, and delete `tls internal` — after which Caddy obtains and renews a public certificate on its own. Leave the line in on a real domain and you serve a certificate no browser trusts, which is loud, local and one line from fixed; that is the failure this default prefers. `caddy adapt` shows which of the two you have: with the line, the adapted config carries `"issuers":[{"module":"internal"}]`; without it, no `tls` app at all, which is Caddy's way of saying *the public default*.

**The body cap is the app's, not a number.** `borgo.Bind` reads at most 1 MiB and answers `413` above it (`borgo.BindError` picks the status); a route that legitimately takes more declares it with `borgo.BindMax`, and then the proxy line moves with it. A proxy that lets more through does not make the app accept more — it only moves the refusal one hop later, into a Go handler, where nothing in the proxy's logs explains it. `BORGO_MAX_BODY` (32 MB) is a different ceiling: the most the Go front will *read* on the public port, not what a handler will decode. It is counted byte by byte as the body arrives, so how the body is framed does not change where the refusal happens.

**Neither header is the client's to write.** borgo believes `X-Forwarded-For` and `X-Forwarded-Proto` from a peer in `BORGO_TRUSTED_PROXIES` and from nobody else — and from that peer it believes them: the client address in your logs and the scheme a WebSocket `Origin` is compared against come from those headers. Both generated configs write `X-Real-IP` and `X-Forwarded-For` from the peer they read the request from — `$remote_addr` in nginx, `{remote_host}` in Caddy — and neither appends to, or passes through, what arrived. An inbound `X-Real-IP` is a header anyone on the internet can send, and nothing downstream can tell it from a real one; `$proxy_add_x_forwarded_for`, which nginx used to use here, keeps the client's invention as the *first* entry of the chain, which is the entry most code reads.

Behind a proxy that is not this one — a CDN, a load balancer, another nginx — `$remote_addr` is that proxy and the headers describe *it*, not the client. Then, and only then, tell your proxy which hop to trust: `set_real_ip_from` plus `real_ip_header` in nginx, `trusted_proxies` in Caddy — and name that hop in `BORGO_TRUSTED_PROXIES`.

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

Pages with `hydrate = false` export with zero JavaScript; hydrated pages carry their chunks and hydrate against the exported props (client-side navigation falls back to plain page loads — there is no server to ask for props). A `pages/_404.tsx` exports as `dist/site/404.html` — the filename most static hosts pick up as their error page automatically. A page `middleware.ts` can reach is skipped, since a static host would serve it without the guard, and so is `404.html` when the matcher can reach a path no page answers. Everything else is skipped, with the reason printed.

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

Rendered HTML has its own cache: pages that export `revalidate` are rendered once and shared — see [cached pages](pages-and-routing.md#cached-pages). Two deployment notes belong here. The copies persist under `.borgo/cache/html` (`BORGO_CACHE_DIR` moves it), keyed to the build that rendered them, so a restart on the same build boots warm and a redeploy sweeps them — mount the directory as a volume if you want the warmth to survive a container replacement, and nothing breaks if you do not. And the cache is per instance: `borgo.Revalidate`/`RevalidateTag` drop copies in the process they are called in — the cache lives in the Go front, beside your handlers — so with several instances behind a load balancer each holds its own copies and the invalidation reaches only the instance whose handler made the call — keep `revalidate` windows short in that layout, or invalidate against each instance.

## systemd, no Docker

Build on the server (`bun install && bun run build`), then drop in a unit — `borgo deploy init systemd` writes this file as `borgo.service`, with your app's name and ports filled in:

```ini
[Unit]
Description=my-app (borgo app)
After=network.target

[Service]
WorkingDirectory=/srv/my-app
# absolute path is systemd's rule, not borgo's: check yours with `command -v bun`.
# the official installer writes ~/.bun/bin/bun, which is not readable by User=
# below - copy or symlink it somewhere system-wide, or point this line at it.
ExecStart=/usr/local/bin/bun run start
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=API_PORT=3501
# secrets stay in the app's gitignored .env and never in this file. the
# leading dash tolerates its absence; what the file sets wins over the
# Environment= lines above, which is why the ports come from it too.
EnvironmentFile=-/srv/my-app/.env
# bun's outbound fetch pool defaults to 256, which ceilings concurrent
# proxied requests - event streams above all - see docs/realtime.md
Environment=BUN_CONFIG_MAX_HTTP_REQUESTS=16384
Restart=on-failure
User=www-data

NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
ProtectKernelModules=yes
ProtectClock=yes
ProtectHostname=yes
RestrictSUIDSGID=yes
RestrictNamespaces=yes
RestrictRealtime=yes
LockPersonality=yes
SystemCallArchitectures=native
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
# nothing here needs a capability: not root, and the port is above 1024.
CapabilityBoundingSet=
UMask=0077
# the app writes only under its own directory; anywhere else it writes
# (a database, a cache) has to be listed here too, or the write fails.
ReadWritePaths=/srv/my-app

[Install]
WantedBy=multi-user.target
```

**The unit holds no key.** It used to: with no `SESSION_SECRET` in your `.env`, `deploy init` wrote a real 48-character one straight into `borgo.service`, in your project directory, next to the `.env` that `create-borgo` goes out of its way to gitignore *and* dockerignore — and in neither ignore file itself. One `git add .` commits it; one `docker build` bakes it into a layer; `systemctl show` prints it to anyone who can run it. So the key lives in the `.env` and the unit is told to read that file, which is what `EnvironmentFile=` is for. The leading `-` means "start anyway if it is not there", so an app that signs nothing needs no file at all. `deploy init systemd` also adds `borgo.service` to `.gitignore` and `.dockerignore`, because the file is deployment-local either way — the host's paths, the host's user — and because it is the file you would hand-edit if you ever did want an `Environment=` line of your own.

Nothing else about the unit varies with the machine it was generated on: both branches used to differ by a comment block and a live key, and an artefact that changes with its surroundings is one whose review tells you nothing about the next one.

If the app has no key yet, the command prints one for you to append to `.env` — a terminal is not a file anything commits. It has to be 32 characters or more: shorter is not a weak key but a refusal, and `borgo.Serve` exits at startup rather than signing with it, so the unit would restart-loop instead of serving.

**And it is hardened.** A public service running as `www-data` with no `[Service]` restrictions at all scored **9.0 UNSAFE** under `systemd-analyze security`; the set above brings the same unit to **3.2 OK**. None of it costs the app anything it does — it renders pages, proxies to a local api, and writes only under its own directory. Two lines are worth knowing before you edit:

- `ProtectSystem=strict` makes the entire filesystem read-only, so `ReadWritePaths=` names the one place the app may write. Storing a database or a cache anywhere else? Add that path there, or the write fails with `EROFS`.
- `MemoryDenyWriteExecute` is deliberately **not** in the list. Bun JITs, and it would stop the service from starting at all.

Check your own edits with `systemd-analyze verify ./borgo.service` and `systemd-analyze security --offline=true ./borgo.service` before you copy the file into `/etc/systemd/system/`.

Do not drop that `BUN_CONFIG_MAX_HTTP_REQUESTS` line when you edit the unit. Without it `borgo start` re-execs itself to set it, which works but gives systemd a supervisor process in front of the server for no reason; with it, the unit is one process tree with the pool already sized.

`borgo start` exits when the Go process dies, and `Restart=on-failure` brings both back.

## Health and metrics

Point the uptime monitor at `/healthz` on the public port — it returns `{status, uptime, render}`, the Go front probing the render service behind it with a short timeout whose answer is shared for a second. The answer is always HTTP 200: `status` is `"ok"` or `"degraded"` and `render` is `"reachable"` or `"down"`, so a monitor that only checks the status code will never fire — match on the body. The api needs no probe of its own: it is the process answering.

`borgo deploy init compose` writes exactly that check into the file, because `restart: unless-stopped` only ever sees the process *exit*: a Go front that is alive and answering `"degraded"` is a container docker considers perfectly fine. These are the values it writes, and they are the values on this page on purpose — two numbers that drift apart are worse than one:

```yaml
healthcheck:
  # /healthz answers 200 even when the api is down - the state is in
  # the body. bun is the runtime image's own binary, so no curl needed.
  test: ["CMD", "bun", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>r.text()).then(t=>process.exit(t.includes('\"status\":\"ok\"')?0:1)).catch(()=>process.exit(1))"]
  interval: 30s
  timeout: 5s
  start_period: 20s
  retries: 3
```

`start_period` is the app's boot budget: failures inside it do not count against `retries`. Know what this buys and what it does not — docker marks the container **unhealthy** and stops there. It does not restart it, and neither does `restart: unless-stopped`, which reacts to exits only. What the state does do is show up in `docker ps`, gate a `depends_on: {condition: service_healthy}`, and give an orchestrator (Swarm, Kubernetes, a compose-aware watchdog) something true to act on.

Set `BORGO_METRICS=1` and the Go front also serves `/metrics` in Prometheus text format, hand-rolled, zero dependencies:

- `borgo_http_requests_total{route, status}` — counter by route pattern and status code
- `borgo_http_request_duration_seconds{route, le}` — histogram, buckets `0.005 0.025 0.1 0.5 1 5`
- `borgo_process_uptime_seconds` — gauge

Route labels are the matched route *pattern*, not each concrete URL — and the pattern is the router's colon form, so `pages/tasks/[id].tsx` is labelled `route="/tasks/:id"`, never `/tasks/[id]` and never `/tasks/7`. After 100 distinct routes new ones fold into `route="other"`, so cardinality stays bounded.

## Where the push key went

Through 0.2x `borgo.Push` was a request from the Go process to the front server, and `BORGO_PUSH_KEY` authenticated it across hosts, with a page of rules about cleartext. Since 0.30 the relay is in the Go process and a push is a call: there is no request, no key, and nothing for a key to protect. `BORGO_PUSH_KEY` and `BORGO_PUSH_INSECURE` refuse the boot by name if still set, so a deployment carried over with them cannot run on a rule that no longer exists. `FRONT_URL` is no longer borgo's: nothing reads it. The [migration page](migration-0.30.md#realtime-moved-into-the-go-process) has the checklist.

## Environment reference

These are borgo's own variables. Your application's variables get the same discipline — declared, typed, refused at boot by name — through [`env.ts`](environment.md).

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | the public port, bound by the go binary — the only port a browser reaches |
| `API_PORT` | `3501` | the api's internal listener, on `127.0.0.1` alone, for loaders and form actions; a value that is not 0-65535 is refused before the server binds |
| `API_URL` | `http://localhost:$API_PORT` | where the render service reaches the api |
| `BORGO_RENDER_URL` | set by `borgo start` | the render service the front forwards pages to. Setting it is what makes the binary a front; unset, it is an api alone on its single listener |
| `BORGO_RENDER_PORT` | a free port | the loopback port the render service binds. Unset, `borgo start` picks a free one at boot and configures both halves from it; set, a port that already answers on `127.0.0.1` refuses the boot |
| `BORGO_INTERNAL_KEY` | minted per boot | the key that authorises the front's requests to the render service, 32 bytes minimum. Normally never set by hand: the CLI mints one per boot for both halves. A render service without a usable one refuses to boot |
| `BORGO_TRUSTED_PROXIES` | loopback and the private ranges | CIDRs or addresses whose `X-Forwarded-For` and `X-Forwarded-Proto` are believed. Behind nginx or Caddy, set it to your proxy — a TLS terminator whose `X-Forwarded-Proto` is not trusted has every websocket origin compared against `http`. The default is what makes the recipes on this page work unconfigured, and on a shared private network it lets any peer that can reach the port forge the client address in your logs; `none` trusts nobody |
| `SESSION_SECRET` | unset | HMAC key for signed-cookie sessions, **32 bytes minimum**. Unset warns and boots anyway — session routes then fail per request, closed in both directions. Set but shorter than 32 is fatal at startup: `borgo.Serve` refuses to bind |
| `SESSION_SECURE` | unset | `1`/`true` adds `Secure` to the session and csrf cookies; `0`/`false` and unset do not. A value that is neither is refused at startup by both halves, rather than read as "not secure" |
| `BORGO_CSRF` | unset | `0` disables both csrf checks (form actions on the render service, unsafe `/api/*` requests on the front), `1` forces them in dev |
| `BORGO_METRICS` | unset | `1` exposes `/metrics` (Prometheus text) on the public port |
| `BORGO_CACHE_DIR` | `.borgo/cache/html` | where [cached pages](pages-and-routing.md#cached-pages) persist across restarts. The front owns the cache; swept at boot when the build changed |
| `BORGO_SECURITY_HEADERS` | unset | `0` drops the security headers *and* the CSP — see [security](security.md#changing-the-policy) |
| `BORGO_CSP` | unset | `0` drops the CSP alone; any other value replaces the policy, with `{nonce}` substituted per request |
| `BORGO_MAX_BODY` | `33554432` (32 MB) | most either half will read of a request body, in bytes, counted as it arrives; `0` means no limit |
| `BORGO_RENDER_TIMEOUT` | `30s` | how long the front waits for the render service's response headers before answering `504`. The body is then unbounded, so streaming renders and websockets are not cut |
| `BORGO_WS_ALLOW_NO_ORIGIN` | unset | `1`/`true` admits websocket clients that send no `Origin` header. Browsers always send one, so this is for non-browser clients — and it re-admits **every** originless caller with them, which is the whole hole it opens. Read by the Go front since 0.30, with the grammar of every other boolean: anything else refuses the boot |
| `BUN_CONFIG_MAX_HTTP_REQUESTS` | `16384` under `borgo dev` and `borgo start`; `256` (bun's default) otherwise | render service: how many outbound calls it may have in flight, which in practice means loader and action calls to the api. Event streams and websockets are the front's own inbound sockets and do not draw on it. `borgo dev` sets it, every config borgo generates that *launches* the app sets it (Dockerfile, compose, systemd — not the caddy/nginx proxy configs, which set no environment), and `borgo start` re-execs itself to set it when nothing else did. Read at process start — exporting it afterwards has no effect, which is why the re-exec exists |
| `BORGO_READ_HEADER_TIMEOUT` | `5s` | cap on reading request headers (slow-header clients), on the public port and the internal one |
| `BORGO_IDLE_TIMEOUT` | `2m` | idle keep-alive reclaim (duration string) |
| `BORGO_READ_TIMEOUT` | `60s` on the public port, `0` for an api alone | how long a request body may go without progress (duration string); each read moves it, so a slow upload that keeps arriving is not cut |
| `BORGO_WRITE_TIMEOUT` | `60s` on the public port, `0` for an api alone | how long a response may go without a write; each write moves it, so a streaming render is not cut, and an event stream keeps its own |
| `BORGO_SHUTDOWN_TIMEOUT` | `10s` | grace period for in-flight requests on shutdown; `0` waits indefinitely |
| `BORGO_HASH_SLOTS` | `max(1, GOMAXPROCS/2)` | password hashes that may run at once. One costs ~140 ms of cpu, so the cap is what keeps a login flood from starving every other route. A value that is not a positive integer is refused at startup rather than ignored |
| `NO_COLOR` | unset | disable ANSI colors in logs |

Every timeout is a Go duration string now (`5s`, `2m`; `0` disables one) and a malformed value fails loudly at boot, naming the variable. `BORGO_MAX_BODY` is the one plain number, in bytes, and it is refused the same way rather than replaced by the default — that changed in 0.21, and the direction matters because `0` means *no limit*. The booleans — `SESSION_SECURE`, `BORGO_CSRF`, `BORGO_METRICS`, `BORGO_SECURITY_HEADERS`, `BORGO_WS_ALLOW_NO_ORIGIN` — share one grammar on both halves: `1`/`true` and `0`/`false` in Go's `strconv.ParseBool` spellings (`t`/`f`/`True` included); anything else is refused at boot naming the variable, and a control character such as the `\r` a Windows-authored `.env` carries is shown in the refusal rather than swallowed. `DB_PATH` in the samples above is the app's own variable, not the framework's.

> **Where `BORGO_FRONT_READ_TIMEOUT` and `BORGO_API_TIMEOUT` went.** Both belonged to the Bun front server, which stopped answering the public port in 0.30. The first is `BORGO_READ_TIMEOUT`, in Go's grammar; the second has no successor, because `/api/*` no longer crosses a process boundary. Neither old name is honoured as an alias, and the collision that made the first one spell out `FRONT` — one environment reaching two halves that parsed the same name differently — cannot happen now that one half reads every deadline.

Three more exist for the build, not the runtime: `BORGO_TAILWIND=1` is what `borgo build --tailwind` sets for its child processes (use the flag, not the variable — see [styling](dev-experience.md#styling)); `BORGO_STATIC=1` is what `borgo export` sets for the build it drives, and it is substituted into the client bundle rather than read at runtime, which is what compiles the props-fetching navigation path out of an exported site; and `BORGO_PARENT_PID` is how the CLI tells the Go api whose death to exit with (`BORGO_SUPERVISOR_PID` is the same trick pointing the other way, set on the copy of itself `borgo start` re-execs). `BORGO_RELOAD` and `BORGO_CHANGED` are internal to the dev loop — the latter carries the whole set of changed files, newline-separated.

## Shutdown and zero-downtime redeploys

`borgo.Serve` traps `SIGINT` and `SIGTERM`. On either, it stops accepting new connections, lets in-flight requests finish, and ends every open event stream immediately through a shutdown hook — `borgo.SSE`'s own and any the front proxies from the render service alike — so a long-lived stream does not hold the process hostage for the whole grace period. Anything still open when `BORGO_SHUTDOWN_TIMEOUT` expires is cut. `0` is the one value that does not cut: it waits for the last ordinary request however long it takes, which is why the streams are ended regardless of it.

`borgo start` exits with the Go binary it launched, the Go binary exits when `borgo start` does, and both exit if their launcher dies — a force-killed deploy script cannot leave a process holding port 3000.

**A rebuild is not a redeploy: restart the process after one.** `borgo start` resolves the document and the built asset names *once, at boot* — `index.html` is read into the shell it serves and the hashed filenames come from the record that build wrote — and neither is consulted again. Run `bun run build` (or `borgo build`) while a `borgo start` is live and the running process keeps serving the old document, naming chunks the finished build has already swept from `public/assets`; the new bytes are on disk and nothing is using them. Restart it and the boot reads both afresh. The reverse case is handled for you: a `borgo start` that finds no route manifest, or one of the three entry names missing from `public/assets`, builds before it serves and prints on stdout the cause it verified and how long the build took. So does one that finds assets left by `borgo dev` or `borgo export`, which are unfit to serve for different reasons. What it does *not* check is every chunk the record names — a `public/assets` that lost a file other than the three entries boots silently.

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
