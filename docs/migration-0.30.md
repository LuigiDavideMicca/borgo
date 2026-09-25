# Upgrading to 0.30

What this covers: the one structural change 0.30 makes, what it does to an app's code (almost nothing), and the five places it can break a deployment. If you run `borgo start` in a container and touch none of borgo's own environment variables, the upgrade is a version bump and this page is a five-minute read you can skip to the [checklist](#checklist).

The version number jumps 0.22 → 0.30 rather than 0.23 to make the break visible. It is a topology change, not a rename.

## What changed

Through 0.2x the Bun process answered the public port and forwarded `/api/*` to the Go binary behind it. In 0.30 that is inverted: **the Go binary answers the public port, and the Bun process is a render service behind it, on loopback.**

```
  0.2x   browser -> bun :3000 -> go :3501
  0.30   browser -> go :3000 -> bun (a free loopback port)
                       `-> /api/* answered in this same process
```

`borgo start` still starts everything with one command and still exits with one code. What moved is which process the browser talks to, and therefore who owns the request path: `/api/*`, static files, the shared page cache, `/healthz`, `/metrics`, the security headers, the CSRF check on unsafe API requests and the body limit are all Go's now. Pages are the one thing forwarded, and the front hands the render service a session it has already verified rather than asking it to verify anything.

Why: an API call no longer crosses a process boundary, and a static file is answered from memory by the process that owns the socket. The reasoning and the measurements are in [architecture](architecture.md#two-processes) and [performance](performance.md).

## What does not change

Nothing in your app's code. Pages, loaders, actions, layouts, islands, `env.ts`, `api/*.go` handlers, `//borgo:route`, the typed client, `borgo.SSE`, `borgo.Push`, `borgo.Revalidate`, sessions and CSRF tokens all behave as they did, and the generated types are the same. There is no new import and no new export to declare — with one exception for an app that uses WebSocket topics, which now has to say who may hold them: [realtime moved into the Go process](#realtime-moved-into-the-go-process).

`borgo dev`, `borgo build` and `borgo export` take the same arguments and produce the same output. The `.borgo/` layout is unchanged.

## The five things that can break a deployment

**1. `--front-only` is refused.** It ran the Bun front alone against an API on another host. The Bun process is now a renderer that binds loopback, so running it alone would start something nothing can reach. It exits 1 with that explanation. A two-host split is not supported in 0.30 — see the [deploy](deploy.md) page.

**2. A two-container layout no longer works.** Same reason: the render service answers only requests carrying the key the front minted for this boot, over loopback. Run both halves in one container, and scale by running more of them behind your reverse proxy. If you generated a compose file from the 0.2x docs with an `api` service and a `front` service, replace it with a single service, or regenerate it with `borgo deploy init compose`.

**3. `API_PORT` is loopback-only.** The Go API binds `127.0.0.1` for it. Anything that dialed the API directly — a sidecar, a cron container, a health check pointed at `:3501` — has to go through the public port instead, where `/api/*` is the same mux. The public port is the whole public surface now, which is the point.

**4. Two environment variables are gone.** They belonged to the Bun front server:

| 0.2x | 0.30 |
| --- | --- |
| `BORGO_FRONT_READ_TIMEOUT` (seconds) | `BORGO_READ_TIMEOUT` (Go duration, e.g. `30s`) |
| `BORGO_API_TIMEOUT` (ms, waiting for the API) | nothing — `/api` does not cross a process. For the wait on a *render*, `BORGO_RENDER_TIMEOUT` (duration, default `30s`) |

Neither old name is honoured as an alias, so a stale value is inert rather than half-applied. Three variables are new and normally set for you by `borgo start`: `BORGO_RENDER_URL` (naming a render service is what makes the binary a front), `BORGO_RENDER_PORT` (a free loopback port unless you name one) and `BORGO_INTERNAL_KEY` (minted per boot). Set `BORGO_TRUSTED_PROXIES` if borgo sits behind a TLS-terminating proxy — otherwise its `X-Forwarded-Proto` is not believed, and every WebSocket handshake is compared against `http` and refused. The full list is the [environment reference](deploy.md#environment-reference).

**5. Two smaller behaviour changes, both visible from outside.** An `/api/*` response now carries `X-Content-Type-Options`, `Referrer-Policy` and `X-Frame-Options` where your handler left them empty: the headers are applied by authorship rather than by path, and the whole public port is borgo's authorship. The CSP is unaffected — it still goes on HTML and SVG alone. And `/metrics` now labels API requests by the route pattern the mux matched rather than lumping them under `/api/*`, so a dashboard that grouped on that label needs its query adjusted.

## Four smaller changes, from verifying the above

The phase was reviewed by an adversarial pass whose findings are fixed in the same release. Four of them are visible from outside:

**A cached page is keyed on the host, not the path alone.** Two domains served by one borgo process now hold a copy each, where 0.2x's cache would have shared one. This closes a hole rather than adding a feature: one request carrying a chosen `Host` stored the render that every later visitor of the real host was served, and a loader that puts the request host in a canonical link or an `og:url` handed that out. If you deliberately served two hostnames one set of copies, you now pay for two renders.

**A page that declares `Vary` on anything but `Accept-Encoding` is no longer cached.** A `Vary` is the render saying its copy is not universal, and the cache cannot honour one. The page is served fresh per request with a line in the log, like every other storability refusal.

**An alias of a path is answered with a `308` by the front.** `/news/`, `/news//`, `/ne%77s` and `/x/../news` all redirect to `/news`, permanently and without changing the method. The render service has behaved this way since 0.21, so the visible outcome is the same for a page; what is new is that asset paths get the same treatment, so a doubled slash in an `/assets/...` URL now redirects instead of serving the file. Nothing the build emits looks like that. `/api/*` is exempt.

**`BORGO_PUSH_KEY` and `BORGO_PUSH_INSECURE` refuse the boot.** They authenticated `borgo.Push` to the front server across hosts; a push is a call inside the Go process now ([below](#realtime-moved-into-the-go-process)), so a key would authorize nothing, and a deployment carried over with one would run on a rule that no longer exists. The boot stops and names them. `FRONT_URL` is simply no longer borgo's: it named the front server, nothing reads it, and an app may declare it in `env.ts` as a name of its own.

One more that is not visible, and is a change in the other direction: an api-only deployment (`BORGO_RENDER_URL` unset, an app embedding borgo with no pages) now applies the request body limit and the security headers that the front applies, because what used to guard that port was the Bun front server that is no longer in front of it. It does **not** apply the CSRF check, and deliberately: nothing mints a CSRF cookie in a deployment with no page renders, so enforcing it would refuse every unsafe request rather than protect one.

## Realtime moved into the Go process

Through 0.2x the WebSocket relay lived in the Bun process, `borgo.Push` was a request to it, and a topic was a public broadcast channel that authorized nothing. In 0.30 the Go process answers `/ws` on the public port, behind `api/middleware.go` and the same session verification as every page; `borgo.Push` publishes into that relay with a call; and every topic a socket asks for is put to your app first.

**Register a `borgo.CanSubscribe`, or every subscription is refused in production.** That is the one change an app has to act on. The check runs once per topic at the handshake, with the session already verified, so it reads `GetSession` as a handler would; a refused topic closes the socket with `4403` naming it, and borgo's `subscribe` treats that as final. Without a check, `borgo dev` leaves every topic open and prints so at startup; `borgo start` refuses every subscription and prints so too — a production relay with no rule is a relay with the wrong rule. Put it in `api/`:

```go
func init() {
	borgo.CanSubscribe(func(r *http.Request, topic string) bool {
		return topic == "live"
	})
}
```

`borgo.CanPublish` decides a browser's publish separately when that should differ from holding; without one, a socket may publish to what it may hold. An app that mounts borgo's handlers on a server of its own mounts `borgo.Realtime()` at `/ws`. The details, the limits and the failure directions are on the [realtime](realtime.md#who-may-hold-a-topic) page.

Three smaller consequences:

- `borgo.Push` returns an error for an event no subscriber could ever receive — a topic no handshake could name, a payload over the 1 MB message limit — and `nil` for a topic nobody holds right now. It no longer has a network to fail on.
- `BORGO_WS_ALLOW_NO_ORIGIN` is read by Go now, with the grammar of every other boolean (`1`/`true`, `0`/`false`): a `yes` that the Bun relay once accepted refuses the boot by name.
- `borgo dev`'s fast-refresh channel is an event stream served by the Go front rather than a websocket forwarded to the render service. Nothing to do; the page reloads and hot-applies as before, and reconnects on its own after a `.go` restart.

## A new port to know about

`BORGO_RENDER_PORT`, on `127.0.0.1`: a free port picked at every boot unless you name one, so two borgo apps on one machine - a zero-downtime redeploy, two projects - never meet on it. A named port that already answers refuses the boot rather than taking another app's traffic: on Windows a second process binds a port another one listens on without an error. `borgo start` resolves the whole topology in one place and configures both halves from it, so they cannot disagree. It needs no firewall rule, and it must not get one: a listener reachable from outside the box is exactly what the boot key exists to make useless.

## Checklist

1. Bump `borgo-framework` and the Go module together — they are one version, as ever.
2. `borgo build`, then `borgo start`: the banner prints the public port and, under it, the render service and the internal api it resolved.
3. Grep your deployment for `--front-only`, `BORGO_API_TIMEOUT`, `BORGO_FRONT_READ_TIMEOUT`, `BORGO_PUSH_KEY`, `BORGO_PUSH_INSECURE`, `FRONT_URL` and any direct use of `API_PORT` from outside the app. The two push variables refuse the boot rather than failing quietly, so you will hear about them; `FRONT_URL` is simply not read.
4. If the app subscribes to WebSocket topics, add a `borgo.CanSubscribe` in `api/` — the startup banner says so until you do, and under `borgo start` every subscription is refused until then.
5. If you wrote your own compose or systemd file from the 0.2x docs, regenerate it (`borgo deploy init compose`, `borgo deploy init systemd`) and diff.
6. Behind a reverse proxy, set `BORGO_TRUSTED_PROXIES`.
7. `curl -si localhost:3000/healthz` reports both halves; a `503` with `Retry-After` on a page means the render service is not up, and the body says so.
