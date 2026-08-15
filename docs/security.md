# Security

What borgo does for you before you write a line, what it deliberately leaves to you, and how to change either. If you are the person who has to approve this framework for production, this is the page to read.

The short version: borgo ships a locked-down default posture — security headers, a strict Content-Security-Policy, CSRF on form actions *and* on proxied `/api/*` mutations, signed HttpOnly session cookies, bounded request bodies and timeouts — and it stays out of policy decisions like rate limiting, account lockout and TLS, which belong to your proxy and your product.

## Security headers

Every rendered document leaves the front server with three headers set (only if the response does not already carry them, so you can override any of them per route):

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

One double-submit token, echoed back in two different places — because the two request shapes borgo serves have nothing in common. The front server issues a single `borgo_csrf` cookie with every rendered page, and this is the whole scope of what it then demands back:

| Request | What must echo the token | Who attaches it |
| --- | --- | --- |
| `POST` to a page route (a form action) | the `__borgo_csrf` field of the form body | `<CsrfField />` |
| `POST`, `PUT`, `PATCH` or `DELETE` to a proxied `/api/*` route | the `X-CSRF-Token` request header | `apiFetch` |
| `GET`, `HEAD`, `OPTIONS` — anywhere | nothing. Safe methods are never checked | — |

Both checks run **before** the request body is read: a rejected form action never pays for a parse, and a rejected `/api` call never reaches Go at all. Both answer `403`.

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

**Loaders and actions need none of this.** Their `api` client and `apiUrl` address the Go API directly, on its own port; they never cross the front server's `/api/*` proxy, so a server-side `api("POST /api/login", …)` is not checked here and cannot start failing because of it. The form action that called it already passed the field check on the way in.

**What you get for free when you write your own `POST /api/…`:** a Go handler mounted at an `/api` route is covered the moment a browser calls it, with no annotation and no per-route wiring — the check sits on the proxy, not on the handler. The obligation that remains is the browser side: use `apiFetch`.

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

A second layer sits behind the `/api` one and is worth knowing about: `borgo.Bind` requires `Content-Type: application/json` and rejects anything else — including a request with no `Content-Type` at all, which matters because an empty-type `Blob` is a CORS-safelisted body that earns no preflight. So a handler that calls `Bind` was never reachable by a cross-site simple form post in the first place. A handler that does *not* call `Bind` — a body-less `POST /api/logout`, say — had nothing, which is exactly why the check above is on the proxy and not in `Bind`. See [the typed bridge](typed-bridge.md) for what `Bind` accepts.

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

If a request carries two `borgo_session` cookies with different values, borgo behaves as if there were none. The same rule applies to `borgo_csrf`, and Go, the front server and the browser runtime all agree on it.

This defends against **cookie tossing**. A cookie on a sibling subdomain (`blog.example.com`, or anything an attacker gets to run on your domain) can be set with `Domain=.example.com`, and the browser will then send *two* cookies with the same name. The order is not something you control — it depends on path length and creation time, both attacker-influenceable — so "take the first one" meant an attacker could decide which session or which CSRF token your server read. Refusing to guess is the only safe answer.

## Request limits and timeouts

| Limit | Default | Override |
| --- | --- | --- |
| JSON body decoded by `borgo.Bind` | 1 MB | `borgo.BindMax[T](r, bytes)` per route |
| Body buffered by the front server | 32 MB | `BORGO_MAX_BODY` (bytes) |
| Waiting for the Go API's response headers | 30 s | `BORGO_API_TIMEOUT` (ms, `0` disables) |
| Reading a client's request headers (Go) | 5 s | `BORGO_READ_HEADER_TIMEOUT` |
| Idle keep-alive connection (Go) | 2 m | `BORGO_IDLE_TIMEOUT` (duration; malformed panics at boot) |
| Reading a client's request headers and body (front server) | 30 s | `BORGO_FRONT_READ_TIMEOUT` (seconds, max 255, `0` disables; a positive value under 1 s becomes 1 s and is announced at boot; malformed is silently ignored) |
| Whole-request read/write deadline (Go) | none | `BORGO_READ_TIMEOUT` (duration), `BORGO_WRITE_TIMEOUT` |

Over the `Bind` cap the client gets a `413`; a missing or non-JSON `Content-Type` gets a `415`. Both come from `borgo.BindError`.

The whole-request deadlines are deliberately unset. They are wall-clock limits on an entire exchange, so any value would eventually kill a legitimate server-sent-events stream or a slow upload. Header timeouts stop slowloris without that cost, `Bind` bounds the body, and if you set the deadlines anyway, `borgo.SSE` clears them on its own connection so streams survive.

The front server's own read deadline is the internet-facing one, and it has its own variable for a reason given below. Bun's `idleTimeout` bounds the wait for an inbound request's headers *and* body, so switching it off — which borgo used to do, to protect proxied event streams — left every body-reading path with no deadline at all: a POST declaring a `Content-Length` and then dribbling a byte at a time was held open indefinitely. Worse, it did not come back. `server.timeout(req, 0)` disarms the *connection*, not the request, and bun re-arms one only when a next request **completes** — not when it starts arriving — so a client that sent a single `GET /healthz`, read the 200 and then went silent held the socket until the process restarted. The same detail is what made the ceiling that replaced it unsafe: an incomplete next request inherits whatever the connection is carrying, so a dribble that never completes held 256.36 s where a fresh connection got bun's own 12.0 s. Raising the deadline to a finite ceiling instead had the same shape one size smaller: whatever a request leaves on the connection is inherited by the next *unfinished* request on it, so one completed GET bought a slowloris the ceiling.

**The deadline is now never disarmed and never raised.** A request that provably has nothing left to dribble is instead *kept warm*: a shared two-second sweep re-arms a short, fixed deadline for as long as the response is still in flight, and stops the moment bun is done with the exchange. The two qualifying moments are the top of `fetch()` when a request carries no body and declared none — which is every GET and HEAD — and in the proxy the instant its body has been read in full, whether it was buffered or streamed through. Three things follow, and each was measured:

- **The value it re-arms to is not your `BORGO_FRONT_READ_TIMEOUT`.** They answer different questions: your knob bounds a client that has not finished sending, while this only ever applies to a request already fully received. It is fixed at 12 seconds, which is exactly bun's own bound on an incomplete request on a fresh connection — so what a released connection carries is never more than a new socket would have been handed for free.
- **Every value of the knob is honoured as written.** A tight setting is a real slowloris bound and does not weaken streaming: at `BORGO_FRONT_READ_TIMEOUT=1` a dribbled body is cut at 4.0 s while a stream silent for 20 s still completes.
- **Ordinary traffic is untouched.** A request that ends before its first sweep never has its deadline written at all, so a normal request/response is byte-for-byte a stock `Bun.serve`.

`Content-Type` was tried as the discriminator and was wrong in kind — it truncated every long-lived response outside the allowlist, and granted the exemption only after the handler had already resolved, which is too late for anything slower than the deadline. The cost that remains: a request whose body borgo never finished reading keeps its deadline for its whole life, so a proxied upload too large to buffer is still cut, and a form action's own render is not kept warm. There is also one declared limitation on streams under heavy load — see [realtime](realtime.md#streams-and-server-timeouts).

**The two halves deliberately do not share a name for any of this.** They parse with different grammars — Go a duration, the front server whole seconds — and fail in different directions: Go panics at boot on a value it cannot parse, the front server silently keeps 30 s. `borgo start` gives both children one environment, so a shared name would mean one of them is never getting what you wrote; that is why the front server's knob is `BORGO_FRONT_READ_TIMEOUT` and Go's are `BORGO_READ_TIMEOUT` and `BORGO_IDLE_TIMEOUT`. See the [environment reference](deploy.md#environment-reference).

A hung Go handler cannot take the front server with it: past `BORGO_API_TIMEOUT` the request answers `504` and the upstream body is cancelled.

## Realtime surface

WebSocket upgrades on `/ws` are refused when the `Origin` header names a different scheme or host, because browsers attach cookies to WebSocket handshakes regardless of origin — without the check, any page on the internet could open a socket as your logged-in user. **An absent `Origin` is refused too**, as of 0.21: admitting it meant the one header an attacker can simply leave out switched the check off. Non-browser clients send none and are now refused; `BORGO_WS_ALLOW_NO_ORIGIN=1` admits them, and admits every other originless caller with them. A client may subscribe to at most 32 topics of at most 128 characters, and a single message is capped at 1 MB.

Go pushes to browsers through `/__borgo/publish` on the front server. Without a shared key that endpoint accepts loopback traffic only — but behind a reverse proxy on the same box, *every* request arrives from loopback, so borgo additionally refuses anything carrying forwarding headers. In any deployment where Go and the front server are not the same machine, set a key on both sides:

```bash
BORGO_PUSH_KEY=$(openssl rand -hex 32)
```

The key is only worth what the connection carrying it is worth, so Go will not send it over `http://` to another host: use `https://`, or `BORGO_PUSH_INSECURE=1` to say the network between them is one you control. See [the key and cleartext](deploy.md#the-key-and-cleartext).

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
- `BORGO_PUSH_KEY` set on both processes if they are not on the same loopback, and `FRONT_URL` on `https://` — or `BORGO_PUSH_INSECURE=1` if the network between them is private and yours.
- CSRF left on (`BORGO_CSRF` unset in production), `<CsrfField />` in every `<form method="post">`, and `apiFetch` — not bare `fetch` — behind every browser `POST`/`PUT`/`PATCH`/`DELETE` to `/api/*`.
- The default CSP kept, or a custom one that still nonces or allows your own scripts — load a page and check the browser console for violations.
- Rate limiting configured in the proxy for `/login`, `/register` and anything expensive.
- `/healthz` wired to your supervisor; `/metrics` exposed only on a private network if you enable it.
- A backup and restore you have actually tested for whatever `DB_PATH` points at.

See [deploy](deploy.md) for the environment reference and the deployment layouts, and [auth and sessions](auth-and-sessions.md) for building login on top of this.
