# Security

What borgo does for you before you write a line, what it deliberately leaves to you, and how to change either. If you are the person who has to approve this framework for production, this is the page to read.

The short version: borgo ships a locked-down default posture — security headers, a strict Content-Security-Policy, CSRF on form actions, signed HttpOnly session cookies, bounded request bodies and timeouts — and it stays out of policy decisions like rate limiting, account lockout and TLS, which belong to your proxy and your product.

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

Form actions use a double-submit token. The front server issues a `borgo_csrf` cookie with the page, `<CsrfField />` renders the same value into a hidden input, and a `POST` must echo it back:

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

A cross-site form cannot read the cookie, so it cannot produce the field. The check runs **before** the request body is parsed, and it arms for any browser holding the token cookie — not only for logged-in sessions. That last detail matters: if the check only applied to authenticated requests, an attacker could cross-post to `/login` with their own credentials and silently log the victim *into the attacker's account*, where everything the victim then types belongs to someone else. Covering anonymous posts closes that.

Clients that carry no cookies at all — `curl`, a mobile app, a server-to-server caller — are unaffected.

```bash
BORGO_CSRF=1    # force the check on in development
BORGO_CSRF=0    # disable it (do not do this in production)
```

`/api/*` is proxied straight to Go and is not covered by this check. It does not need to be: `borgo.Bind` requires `Content-Type: application/json` and rejects anything else — including a request that sends no `Content-Type` at all, which matters because an empty-type `Blob` is a CORS-safelisted body that earns no preflight. A cross-site HTML form cannot declare JSON, and a cross-site `fetch` that does has already been preflighted, so every request that reaches a handler is same-origin or CORS-approved. See [the typed bridge](typed-bridge.md) for what `Bind` accepts.

## Cookies and sessions

Session cookies are signed with HMAC-SHA256 over a payload that includes the expiry, so neither the data nor its lifetime can be edited by the holder. Attributes:

| Attribute | Value |
| --- | --- |
| `HttpOnly` | always — JavaScript cannot read the session |
| `SameSite` | `Lax` |
| `Path` | `/` |
| `Secure` | when `SESSION_SECURE=1` |

Set `SESSION_SECURE=1` in production. It is off by default only so that `http://localhost` works.

`SESSION_SECRET` is treated differently depending on how it is wrong, because the two cases fail in opposite directions.

**Absent is reported, not enforced.** `borgo.Serve` logs `SESSION_SECRET not set: session and auth routes will fail until it is` before it binds the port, then boots: an app with no sessions is a legitimate app, and nothing at boot can tell one from the other. The failure is per request and it is closed — `SetSession` returns `ErrNoSessionSecret`, and borgo refuses to *verify* a session too, so a deployment that loses the variable logs everyone out rather than letting anyone in.

**Shorter than 32 bytes refuses to boot.** A short key is not a weaker secret, it is a searchable one: the security of the cookie rests on nobody being able to produce its HMAC, and a handful of bytes can be exhausted offline from a single captured cookie. Setting one is a deliberate act with a wrong value, so borgo treats it like any other malformed environment variable and stops, naming the length it got and the length it needs. Everywhere else in the framework a secret under the floor is indistinguishable from no secret at all.

So the failure mode is per request, and you should know its shape: `/healthz` stays green, every page that does not touch a session keeps working, and `SetSession` returns `ErrNoSessionSecret`, which `LoginHandler` and `RegisterHandler` answer as a `500` with `{"error":"session write failed"}`. **Read the startup log on first boot, or assert on it in your deploy script** — that line is the only warning you get. Making it fatal is on the table for a future major ([api stability](api-stability.md#what-counts-as-a-breaking-change) lists it as breaking), because tightening it would stop apps that boot fine today.

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
| Reading a client's request headers and body (front server) | 30 s | `BORGO_IDLE_TIMEOUT` (seconds, max 255, `0` disables; malformed is silently ignored) |
| Whole-request read/write deadline | none | `BORGO_READ_TIMEOUT`, `BORGO_WRITE_TIMEOUT` |

Over the `Bind` cap the client gets a `413`; a missing or non-JSON `Content-Type` gets a `415`. Both come from `borgo.BindError`.

The whole-request deadlines are deliberately unset. They are wall-clock limits on an entire exchange, so any value would eventually kill a legitimate server-sent-events stream or a slow upload. Header timeouts stop slowloris without that cost, `Bind` bounds the body, and if you set the deadlines anyway, `borgo.SSE` clears them on its own connection so streams survive.

The front server's own read deadline is the internet-facing one, and it is the reason the table lists `BORGO_IDLE_TIMEOUT` twice. Bun's `idleTimeout` bounds the wait for an inbound request's headers *and* body, so switching it off — which borgo used to do, to protect proxied event streams — left every body-reading path with no deadline at all: a POST declaring a `Content-Length` and then dribbling a byte at a time was held open indefinitely. The deadline is on, and the exemption for streams is granted per response instead, on the connections whose `Content-Type` says they are meant to sit idle. **The two halves read that one variable name with different grammars** — Go a duration, the front server whole seconds — and the failure modes differ too: Go panics at boot on a value it cannot parse, the front server silently keeps 30 s. Setting it in an environment both halves share means one of them is not getting what you wrote. See the [environment reference](deploy.md#environment-reference).

A hung Go handler cannot take the front server with it: past `BORGO_API_TIMEOUT` the request answers `504` and the upstream body is cancelled.

## Realtime surface

WebSocket upgrades on `/ws` are refused when the `Origin` header names a different host, because browsers attach cookies to WebSocket handshakes regardless of origin — without the check, any page on the internet could open a socket as your logged-in user. A client may subscribe to at most 32 topics of at most 128 characters, and a single message is capped at 1 MB.

Go pushes to browsers through `/__borgo/publish` on the front server. Without a shared key that endpoint accepts loopback traffic only — but behind a reverse proxy on the same box, *every* request arrives from loopback, so borgo additionally refuses anything carrying forwarding headers. In any deployment where Go and the front server are not the same machine, set a key on both sides:

```bash
BORGO_PUSH_KEY=$(openssl rand -hex 32)
```

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
- `BORGO_PUSH_KEY` set on both processes if they are not on the same loopback.
- CSRF left on (`BORGO_CSRF` unset in production) and `<CsrfField />` in every `<form method="post">`.
- The default CSP kept, or a custom one that still nonces or allows your own scripts — load a page and check the browser console for violations.
- Rate limiting configured in the proxy for `/login`, `/register` and anything expensive.
- `/healthz` wired to your supervisor; `/metrics` exposed only on a private network if you enable it.
- A backup and restore you have actually tested for whatever `DB_PATH` points at.

See [deploy](deploy.md) for the environment reference and the deployment layouts, and [auth and sessions](auth-and-sessions.md) for building login on top of this.
