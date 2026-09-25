# Security

What borgo does for you before you write a line, what it deliberately leaves to you, and how to change either. If you are the person who has to approve this framework for production, this is the page to read.

The short version: borgo ships a locked-down default posture — security headers, a strict Content-Security-Policy, CSRF on form actions *and* on browser `/api/*` mutations, signed HttpOnly session cookies, bounded request bodies and timeouts — and it stays out of policy decisions like rate limiting, account lockout and TLS, which belong to your proxy and your product.

## Security headers

Every response on the public port leaves with three headers set, only where it does not already carry them — so you can override any of them per route. That is every response, by where it leaves and not by who wrote it: a rendered document, a static file, what an `/api/*` handler returns, and the front's own refusals — the `403` of a failed csrf check, the `413` over `BORGO_MAX_BODY`, the `503`/`504` of a render service that did not answer.

| Header | Value |
| --- | --- |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `X-Frame-Options` | `DENY` |

`X-Frame-Options: DENY` means your app cannot be framed. If you deliberately embed it somewhere, replace the header (and the CSP's `frame-ancestors`) rather than dropping the whole set.

## Content-Security-Policy

The default policy, applied to HTML documents and SVG responses:

```
default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none';
form-action 'self'; img-src 'self' data: blob:; font-src 'self' data:;
style-src 'self' 'unsafe-inline'; connect-src 'self'; script-src 'self' 'nonce-…'
```

The interesting part is `script-src`. Server-rendered pages carry their loader props in an inline `<script>`, which a strict policy would block — so borgo mints a random nonce per response, puts it on that script tag, and names it in the header. React's own streaming boundary scripts inherit the same nonce. The result is a policy with no `'unsafe-inline'` for scripts in production, without you configuring anything.

In development the policy uses `'unsafe-inline'` instead of a nonce, because the dev client and the error overlay inject scripts outside the render.

### CSP on cached pages

A [cached page](pages-and-routing.md#cached-pages) is one render served many times, and a nonce shared across responses is no nonce at all — anyone can read it off the page and inject a script that names it, which is exactly what the header exists to block. `borgo export` refuses a nonce for that reason: a file cannot change. A live server can, so it re-mints instead: the cached copy keeps the nonce its render produced as a substitution key — a value that never ships, not even on the first response — and every replay swaps a fresh one into the body and the `Content-Security-Policy` header together. Each response a cached page produces therefore carries a nonce as unpredictable as a fresh render's, and a page nonced by anything other than borgo's own render is refused from the cache rather than guessed at.

`style-src` keeps `'unsafe-inline'` in both modes: React writes inline styles, and so does almost every component library.

### Changing the policy

```bash
BORGO_CSP=0                      # no CSP header at all, other headers stay
BORGO_CSP="default-src 'self'; script-src 'self' {nonce} https://plausible.io"
BORGO_SECURITY_HEADERS=0         # drop the CSP and the three static headers
```

A custom policy is used verbatim, with `{nonce}` replaced per request by ` 'nonce-<random>'`. Keep `{nonce}` in your `script-src` unless you also add `'unsafe-inline'` — without either, your own pages will not hydrate. Adding a third-party script is the common case:

```bash
BORGO_CSP="default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob: https://cdn.example.com; font-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self' https://api.example.com; script-src 'self' {nonce}"
```

## CSRF protection

One double-submit token, echoed back in two different places — because the two request shapes borgo serves have nothing in common. The render service issues a single `borgo_csrf` cookie with every rendered page, and this is the whole scope of what it then demands back:

| Request | What must echo the token | Who attaches it |
| --- | --- | --- |
| `POST` to a page route (a form action) | the `__borgo_csrf` field of the form body | `<CsrfField />` |
| `POST`, `PUT`, `PATCH` or `DELETE` to an `/api/*` route | the `X-CSRF-Token` request header | `apiFetch` |
| `GET`, `HEAD`, `OPTIONS` — anywhere | nothing. Safe methods are never checked | — |

Both checks run **before** the request body is read: a rejected form action never pays for a parse, and a rejected `/api` call never reaches your handler. Both answer `403`.

### Form actions

```tsx
import { CsrfField } from "borgo-framework";

export default function NewPost() {
  return (
    <form method="post">
      <CsrfField />
      <input name="title" placeholder="Title" />
      <button>Publish</button>
    </form>
  );
}
```

A cross-site form cannot read the cookie, so it cannot produce the field.

### `/api/*` routes

A header rather than a body field, and that is not a lesser mechanism — on this path it is the stronger one. An `/api` body is JSON and has no hidden input to carry an echo; meanwhile the one request shape a browser will send cross-origin with no preflight is a *simple* form `POST`, and a form cannot set a custom header **at all**. A cross-site `fetch` that sets one is preflighted, and borgo approves no CORS, so the preflight is where it stops.

Calls you write by hand from a hydrated page go through `apiFetch`, which is `fetch` with the token attached on unsafe methods:

```ts
import { apiFetch } from "borgo-framework";

async function remove(noteId: number) {
  await apiFetch(`/api/notes/${noteId}`, { method: "DELETE" });
}

async function logout() {
  await apiFetch("/api/logout", { method: "POST" });
}
```

Everything else about it is `fetch`: same arguments, same return, safe methods passed straight through. A plain `fetch("/api/x", { method: "POST" })` from a page in a browser holding the cookie answers `403` — that is the check doing its job, and swapping the call for `apiFetch` is the fix. If you would rather roll it yourself, `csrfCookieValue(document.cookie)` reads the token and `CSRF_HEADER` is the header name.

**Loaders and actions need none of this.** Their `api` client and `apiUrl` address the api's internal listener — loopback, behind the key minted for this boot — and the header check guards the public port, not that listener, so a server-side `api("POST /api/login", …)` is not checked here and cannot start failing because of it. The form action that called it already passed the field check on the way in.

**What you get for free when you write your own `POST /api/…`:** a Go handler mounted at an `/api` route is covered the moment a browser calls it, with no annotation and no per-route wiring — the check sits on the public port, not on the handler. The obligation that remains is the browser side: use `apiFetch`.

### What arms the check, and what stays untouched

Both halves arm on **presence of the `borgo_csrf` cookie**, not on a live session. If the check only applied to authenticated requests, an attacker could cross-post to a login route with their own credentials and silently log the victim *into the attacker's account*, where everything the victim then types belongs to someone else. Covering anonymous requests closes that. (The form-action check additionally arms on a `borgo_session` cookie; the `/api` check does not, because an API caller holding a session cookie may perfectly well be a mobile app.)

Clients that carry no `borgo_csrf` cookie at all — `curl`, a mobile app, a server-to-server caller — are **unaffected on both paths**. Nothing arms for them, so nothing 403s. That is deliberate: a check that armed on cookie-less callers would break every non-browser client of your API on the day you turned it on.

Conflicting duplicate `borgo_csrf` cookies read as **no token**, and the request is refused rather than waved through — see [duplicate cookies](#duplicate-cookies-are-treated-as-no-cookie). The check still *runs*: an attacker who can plant a duplicate must not be able to switch the check off by making the browser look token-less.

```bash
BORGO_CSRF=1    # force both checks on in development
BORGO_CSRF=0    # disable both (do not do this in production)
```

### What this is actually defending against

Worth being precise, because the token is not the only thing holding this line. `SameSite=Lax` on both cookies already stops the classic cross-*site* `POST`: a form on `evil.com` aimed at your app is sent without your cookies, so it is anonymous, and the token cookie is not there to arm anything.

The token is for the attacker `SameSite` says nothing about: a **same-site, cross-origin** one — a sibling subdomain you do not control, a stored XSS on another host of the same registrable domain, anything at `blog.example.com` shooting at `example.com`. The browser sends every cookie to that attacker's requests. They still cannot read the host-only `borgo_csrf` cookie, and they still cannot set a custom header cross-origin without a CORS approval borgo does not grant. That is the gap the double-submit closes, on both paths.

A second layer sits behind the `/api` one and is worth knowing about: `borgo.Bind` requires `Content-Type: application/json` and rejects anything else — including a request with no `Content-Type` at all, which matters because an empty-type `Blob` is a CORS-safelisted body that earns no preflight. So a handler that calls `Bind` was never reachable by a cross-site simple form post in the first place. A handler that does *not* call `Bind` — a body-less `POST /api/logout`, say — had nothing, which is exactly why the check above is on the public port and not in `Bind`. See [the typed bridge](typed-bridge.md) for what `Bind` accepts.

## Cookies and sessions

Session cookies are signed with HMAC-SHA256 over a payload that includes the expiry, so neither the data nor its lifetime can be edited by the holder. Attributes:

| Attribute | Value |
| --- | --- |
| `HttpOnly` | always — JavaScript cannot read the session |
| `SameSite` | `Lax` |
| `Path` | `/` |
| `Secure` | when `SESSION_SECURE` is `1`/`true` |

Set `SESSION_SECURE=1` in production. It is off by default only so that `http://localhost` works. A value that is neither a true nor a false spelling is refused at startup rather than read as "not secure" — that check used to be `== "1"`, which meant `SESSION_SECURE=true` silently issued a cookie the browser would send back over plain http.

`SESSION_SECRET` is treated differently depending on how it is wrong, because the two cases fail in opposite directions.

**Absent is reported, not enforced.** `borgo.Serve` logs `SESSION_SECRET not set: session and auth routes will fail until it is` before it binds the port, then boots: an app with no sessions is a legitimate app, and nothing at boot can tell one from the other. The failure is per request and it is closed — `SetSession` returns `ErrNoSessionSecret`, and borgo refuses to *verify* a session too, so a deployment that loses the variable logs everyone out rather than letting anyone in.

**Shorter than 32 bytes refuses to boot.** A short key is not a weaker secret, it is a searchable one: the security of the cookie rests on nobody being able to produce its HMAC, and a handful of bytes can be exhausted offline from a single captured cookie. Setting one is a deliberate act with a wrong value, so borgo treats it like any other malformed environment variable and stops, naming the length it got and the length it needs. Everywhere else in the framework a secret under the floor is indistinguishable from no secret at all.

The *absent* case is the one whose failure mode is per request, and you should know its shape: `/healthz` stays green, every page that does not touch a session keeps working, and `SetSession` returns `ErrNoSessionSecret`, which `LoginHandler` and `RegisterHandler` answer as a `500` with `{"error":"session write failed"}`. **Read the startup log on first boot, or assert on it in your deploy script** — that line is the only warning you get. Making it fatal is on the table for a future major ([api stability](api-stability.md#what-counts-as-a-breaking-change) lists it as breaking), because tightening it would stop apps that boot fine today.

Generate one properly:

```bash
openssl rand -base64 48
```

### Duplicate cookies are treated as no cookie

If a request carries two `borgo_session` cookies with different values, borgo behaves as if there were none. The same rule applies to `borgo_csrf`, and Go, the render service and the browser runtime all agree on it.

This defends against **cookie tossing**. A cookie on a sibling subdomain (`blog.example.com`, or anything an attacker gets to run on your domain) can be set with `Domain=.example.com`, and the browser will then send *two* cookies with the same name. The order is not something you control — it depends on path length and creation time, both attacker-influenceable — so "take the first one" meant an attacker could decide which session or which CSRF token your server read. Refusing to guess is the only safe answer.

## Request limits and timeouts

| Limit | Default | Override |
| --- | --- | --- |
| JSON body decoded by `borgo.Bind` | 1 MB | `borgo.BindMax[T](r, bytes)` per route |
| Request body read on the public port | 32 MB | `BORGO_MAX_BODY` (bytes, `0` for no limit) |
| Waiting for the render service's response headers | 30 s | `BORGO_RENDER_TIMEOUT` (duration, `0` disables) |
| Reading a client's request headers | 5 s | `BORGO_READ_HEADER_TIMEOUT` |
| Idle keep-alive connection | 2 m | `BORGO_IDLE_TIMEOUT` (duration; malformed is refused before the port binds — `borgo.Serve` exits naming the variable, `ServeContext` returns the error) |
| A request body without progress, a response without a write | 60 s on the public port | `BORGO_READ_TIMEOUT`, `BORGO_WRITE_TIMEOUT` (duration, `0` disables) |

Over the `Bind` cap the client gets a `413`; a missing or non-JSON `Content-Type` gets a `415`. Both come from `borgo.BindError`. Over `BORGO_MAX_BODY` the front answers its own `413` before your handler is reached, and it counts the bytes as they arrive — a body with no `Content-Length`, chunked, is cut at the same byte as one that declared its size, so the declaration is not what the limit reads. The render service applies the same number to the one body it reads itself, a form action's.

The read and write deadlines are not limits on the whole exchange. net/http's own are, and any value for those would eventually kill a legitimate stream or a slow upload - so borgo moves each deadline forward whenever the exchange makes progress: a read of the body moves the read deadline, a write of the response moves the write deadline. A peer that stays silent for a minute is cut; one that keeps sending or keeps reading never is. An event stream clears its write deadline at its first byte and keeps its own, and `borgo.SSE` bounds each of its writes at 10 seconds.

The deadlines a client meets are all on the public port, which is Go's, and they are separate numbers by construction: `BORGO_READ_HEADER_TIMEOUT` and `BORGO_READ_TIMEOUT` bound what a client sends, `BORGO_WRITE_TIMEOUT` what the server writes. Setting a read deadline therefore cannot cut a stream, and that is the whole reason this section is now a few paragraphs instead of a page.

It used to be a page. The public port was bun's, and bun's `idleTimeout` bounds the wait for an inbound request's headers *and* body *and* the response write with one number — so the deadline that stopped a slowloris was the same one that cut an event stream. Switching it off left every body-reading path unbounded and did not come back: `server.timeout(req, 0)` disarms the connection, not the request, and bun re-arms one only when a next request **completes**, so a client that sent one `GET /healthz`, read the 200 and went silent held the socket until the process restarted. What borgo ran instead was a two-second sweep that re-armed a short fixed deadline for a request already fully received — measured, documented, and deleted in 0.30 with the listener it protected. If you are looking for `BORGO_FRONT_READ_TIMEOUT`, that is where it went.

A hung render cannot take the front with it: past `BORGO_RENDER_TIMEOUT` the request answers `504` and the render's body is cancelled. A hung Go handler is now a hung handler in the process that answered the port, and no server deadline stops a handler that writes nothing: that is what your own context deadlines are for.

## Realtime surface

A WebSocket on `/ws` — answered by the Go process on the public port since 0.30, behind `api/middleware.go` like every other path — whose `Origin` header names a different scheme or host is refused, because browsers attach cookies to WebSocket handshakes regardless of origin — without the check, any page on the internet could open a socket as your logged-in user. **An absent `Origin` is refused too**, as of 0.21: admitting it meant the one header an attacker can simply leave out switched the check off. Non-browser clients send none and are now refused; `BORGO_WS_ALLOW_NO_ORIGIN=1` admits them, and admits every other originless caller with them.

The shape of that refusal matters to whoever reads the client's log. A non-101 answer to a handshake reaches the browser as close code `1006` with no reason, indistinguishable from a server that is down, so the origin refusal is not a `403`: the handshake completes, and the socket is closed at once with code `4403` and a reason naming the origin it saw and the switch that would admit it — `origin "http://evil.example" is not this server (app.example.com): /ws accepts the page's own origin only`. The socket is subscribed to nothing and lives one tick. borgo's own client treats exactly that code as final (`onRefused` fires, once) rather than redialling a refusal every 30 seconds for the life of the tab — see [realtime](realtime.md#websocket-topics). Every other refusal on the handshake stays a `400`: a client may subscribe to at most 32 topics of at most 128 characters, and a single message is capped at 1 MB. A topic the socket may not hold is the same `4403`, with the topic in the reason.

What a socket may hold is your app's decision: `borgo.CanSubscribe` is asked for every topic at the handshake, with the session the front verified, and `borgo.CanPublish` for every message a browser publishes — see [who may hold a topic](realtime.md#who-may-hold-a-topic). A production relay with no `CanSubscribe` refuses every subscription and says so at startup, because a relay with no rule is a relay with the wrong rule. Go pushes to browsers with a call: `borgo.Push` publishes into the relay in its own process, so there is no endpoint to guard and no key to share. The push road of 0.2x — `/__borgo/publish`, `BORGO_PUSH_KEY`, `BORGO_PUSH_INSECURE` — is gone, and the two variables refuse the boot by name if still set.

## What borgo does not do

Deliberate omissions. Each is a policy decision that belongs to your app or your infrastructure, and pretending otherwise would be worse than the gap:

- **No rate limiting or brute-force lockout.** The login handler caps concurrent password hashing and sheds excess with `503` plus `Retry-After`, which stops a flood from starving the rest of the API — but that is resource protection, not an attempt policy. Put rate limiting in your reverse proxy, or count failures per account in your own store.
- **No WAF, no bot detection, no captcha.**
- **No TLS.** Terminate it at Caddy, nginx, or your load balancer. `borgo deploy init caddy` writes a config that gets you a certificate in three lines.
- **No OAuth, no SSO, no 2FA, no email verification, no password reset.** `borgo.Auth` gives you the mechanics — hashing, session issuance, guards — over *your* user store. The policy is yours. See [auth and sessions](auth-and-sessions.md).
- **No secret management.** `SESSION_SECRET` and friends come from the environment; use your platform's secret store.
- **No audit log.** `/metrics` counts requests by route and status; it is not an audit trail.
- **No dependency scanning of your app.** The framework itself has zero Go dependencies and a small npm surface, which is the part borgo can control.

## Before you go live

- `SESSION_SECRET` set, 32+ random bytes, out of version control — confirmed by the *absence* of the startup warning, since nothing else stops a secretless boot.
- `SESSION_SECURE=1`, and TLS terminating in front of the app.
- `borgo.CanSubscribe` registered in `api/` if the app uses WebSocket topics — without one every subscription is refused — and deciding by the session, never by how hard a topic name is to guess.
- CSRF left on (`BORGO_CSRF` unset in production), `<CsrfField />` in every `<form method="post">`, and `apiFetch` — not bare `fetch` — behind every browser `POST`/`PUT`/`PATCH`/`DELETE` to `/api/*`.
- The default CSP kept, or a custom one that still nonces or allows your own scripts — load a page and check the browser console for violations.
- Rate limiting configured in the proxy for `/login`, `/register` and anything expensive.
- `/healthz` wired to your supervisor; `/metrics` exposed only on a private network if you enable it.
- A backup and restore you have actually tested for whatever `DB_PATH` points at.

See [deploy](deploy.md) for the environment reference and the deployment layouts, and [auth and sessions](auth-and-sessions.md) for building login on top of this.
