# Auth and sessions

Mechanics, not policy: borgo gives you signed-cookie sessions, password hashing behind a swappable interface, ready-made login/logout/register handlers over a user provider *you* supply, guards for both sides of the bridge, and CSRF protection for form actions and for browser calls that change something through `/api/*`. It imposes no database, no user schema, and no OAuth opinion — those stay in your hands.

The complete flow — register, login, protected page, logout — is wired in `examples/tasks` (`api/users.go`, `pages/login.tsx`, `pages/register.tsx`, `pages/account.tsx`).

## Sessions

Sessions are a JSON payload HMAC-signed with `SESSION_SECRET`, stored in an http-only cookie — no server-side storage, expiry signed in (set `SESSION_SECURE=1` behind https):

```go no-check
type Session struct{ User string `json:"user"` }

borgo.SetSession(w, Session{User: user}, 24*time.Hour)

session, ok := borgo.GetSession[Session](r) // false when missing, tampered or expired
borgo.ClearSession(w)                       // logout
```

The front server forwards the browser's cookies on every api call a loader or action makes, so Go sees the session during SSR — and forwards `Set-Cookie` headers coming back from Go to the browser, so an action that calls a login route actually logs the browser in.

Four behaviors worth knowing before you design around them:

- **An absent `SESSION_SECRET` is warned about, a short one is refused.** With none set, `borgo.Serve` logs `SESSION_SECRET not set: session and auth routes will fail until it is` before it binds and then boots anyway, because an app with no sessions is a legitimate app. The failure is per request and closed in both directions: `/healthz` stays green while `SetSession` returns `ErrNoSessionSecret`, login and register answer `500 {"error":"session write failed"}`, and no session verifies — so nothing can be forged against the missing key. With a secret **shorter than 32 bytes**, `Serve` stops instead of starting: that length is searchable offline from one captured cookie, and the rest of the framework treats such a value as no secret at all. Watch that log line on first boot; it is the only warning there is.
- **The principal rides in the cookie**, so keep it small — a username, an id, a role. `SetSession` returns an error rather than writing a cookie the browser would silently drop for exceeding 4 KB, and that error is worth surfacing: a dropped cookie looks exactly like a successful login that did not stick.
- **Logging in replaces any existing session**, so a session fixed on a victim before login cannot survive it.
- **Two `borgo_session` cookies with different values are treated as none.** A sibling subdomain can plant a duplicate; guessing which one to trust is how an attacker chooses your session for you. See [security](security.md#duplicate-cookies-are-treated-as-no-cookie).

## Password hashing

`borgo.DefaultHasher()` returns PBKDF2-HMAC-SHA256 with OWASP parameters (600,000 iterations, 16-byte random salt), from the standard library's `crypto/pbkdf2`. The choice, honestly: argon2id is the state of the art, but it lives in `golang.org/x/crypto`, and the Go runtime's zero-dependency guarantee is part of what borgo is. PBKDF2 at these parameters is an OWASP-recommended configuration and FIPS-approved; if your threat model wants argon2id, the hasher is one small interface away:

```go
type PasswordHasher interface {
    Hash(password string) (string, error)
    Verify(password, hash string) bool
}
```

Set `Auth.Hasher` to your own implementation and nothing else changes. Hashes embed their parameters (`pbkdf2$600000$<salt>$<key>`), so stored passwords keep verifying if defaults evolve — within bounds: a stored hash asking for parameters far beyond the defaults is rejected outright, because deriving the key it demands is minutes of CPU per attempt.

Hashing is deliberately expensive, which makes it a resource to protect. `LoginHandler` runs at most `max(1, GOMAXPROCS/2)` verifications at once — `BORGO_HASH_SLOTS` overrides that, read once at package init — and sheds the rest with `503` and a `Retry-After` after five seconds of queueing, so a burst of login attempts cannot starve every other route on the server. A failed lookup still runs a verification against a dummy hash — one built with *your* hasher, so swapping in argon2id does not reintroduce a timing oracle — which keeps "no such user" and "wrong password" indistinguishable in both the response and the clock.

## borgo.Auth: login, logout, register

`borgo.Auth[U]` turns a user provider into handlers. You supply `Lookup` (and optionally `Register`); the framework does the verification, the hashing, and the session:

```go no-check
var auth = borgo.Auth[User]{
    // username -> user + stored password hash. any error answers 401.
    Lookup: func(ctx context.Context, username string) (User, string, error) {
        var user User
        err := db.DB.First(&user, "username = ?", username).Error
        return user, user.Hash, err
    },
    // optional: creates the user from an already-hashed password.
    // return borgo.ErrUserExists for a taken username -> 409.
    Register: func(ctx context.Context, username, hash string) (User, error) {
        user := User{Username: username, Hash: hash}
        return user, db.DB.Create(&user).Error
    },
    // what the session stores - keep it minimal, it rides in a cookie
    Principal: func(u User) any { return Me{Username: u.Username} },
}

func init() {
    borgo.Handle("POST /api/login", auth.LoginHandler)
    borgo.Handle("POST /api/logout", auth.LogoutHandler)
    borgo.Handle("POST /api/register", auth.RegisterHandler)
}
```

- `LoginHandler` decodes `{username, password}` (`borgo.Credentials`), verifies against the stored hash, starts the session and responds with the principal as JSON. Empty fields are a 400 before any lookup; wrong password and unknown user are both a 401 `{"error": "invalid credentials"}` — and a failed lookup still runs a hash verification, so usernames cannot be enumerated by timing.
- `RegisterHandler` hashes the password, calls `Register`, starts the session, responds 201. `borgo.ErrUserExists` becomes a 409; with no `Register` configured the route answers 404.
- `LogoutHandler` clears the cookie, responds 204.

Defaults: 7-day sessions (`MaxAge`), `DefaultHasher()` (`Hasher`), the user itself as principal (`Principal`). All three are fields, not policy — and `Hasher` is the only way to change hashing, deliberately: `DefaultHasher` is a function, so no code in the process can reassign the default out from under an `Auth` that did not ask for it.

## Guarding api routes: borgo.Authed

```go
borgo.Handle("GET /api/me", borgo.Authed(currentUser))
```

Without a valid session the request is answered `401 {"error": "unauthenticated"}` and the handler never runs. borgogen sees through the wrapper, so the route keeps its generated TypeScript types. Need the principal inside the handler? `borgo.GetSession[Me](r)` as usual — `Authed` only checks validity, it does not impose a session type.

For anything beyond a boolean gate (roles, ownership), write the three-line wrapper yourself — handlers are ordinary `http.HandlerFunc`s:

```go no-check
func admin(h http.HandlerFunc) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        if s, ok := borgo.GetSession[Me](r); !ok || s.Role != "admin" {
            http.Error(w, "forbidden", http.StatusForbidden)
            return
        }
        h(w, r)
    }
}
```

## Guarding pages: the loader guard

**This is the pattern** for protected pages. A loader may return a `Response` to short-circuit rendering; `redirect()` makes it a guard, honored on full loads and client navigations alike:

```tsx
import { ApiError, redirect, type LoaderContext } from "borgo-framework";

export async function loader({ api }: LoaderContext) {
  try {
    return { me: await api("GET /api/me") };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return redirect("/login");
    throw error;
  }
}
```

The api call carries the browser's cookies, Go's `Authed` (or your own check) answers 401, the loader redirects. One source of truth — the Go route — guards both the page and the data.

## Login and logout as form actions

[Form actions](pages-and-routing.md#form-actions) work without client JavaScript, and `Set-Cookie` forwarding makes them the natural login flow:

```tsx
import { ApiError, redirect, type ActionContext } from "borgo-framework";

export async function action({ request, api }: ActionContext) {
  const form = await request.formData();
  try {
    await api("POST /api/login", {
      body: { username: form.get("username"), password: form.get("password") },
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return { error: "wrong username or password" };
    throw error;
  }
  return redirect("/account");
}
```

Go sets the session cookie on the api response; the front server forwards it on the action's redirect; the browser lands on `/account` logged in. Logout is the same shape: an action calling `POST /api/logout`, a redirect, done.

## CSRF protection for actions and api calls

Every `<form method="post">` needs `<CsrfField />` inside it:

```tsx
import { CsrfField } from "borgo-framework";

export default function NewTask() {
  return (
    <form method="post">
      <CsrfField />
      <input name="title" />
      <button>Add</button>
    </form>
  );
}
```

The front server issues a `borgo_csrf` cookie with the page, the field carries the same token back, and a mismatch is answered `403` before the action runs — a cross-site form cannot read the cookie, so it cannot produce the field. The check arms for any browser that holds the token, which is what closes login-CSRF; cookie-less clients are unaffected.

That covers forms. The other half of the obligation is browser calls to `/api/*` that change something — `POST`, `PUT`, `PATCH`, `DELETE` — which carry the same token in an `X-CSRF-Token` header instead of a field, because an api body is JSON and has no field to put it in. Use `apiFetch` and it is attached for you:

```ts
import { apiFetch } from "borgo-framework";

await apiFetch("/api/logout", { method: "POST" });
```

A loader or an action calling `api("POST /api/logout")` needs nothing: that client talks to the Go api directly and never crosses the proxy the check sits on. [Security](security.md#csrf-protection) has the exact scope, the mechanics and the environment overrides.

## What the framework protects, and what you still owe

borgo gives you the mechanics. These remain your decisions, and none of them are hard — but nothing here will do them for you:

- **Password policy.** Nothing enforces a minimum length or checks a breach list. `DefaultHasher()` makes a weak password expensive to crack, not safe.
- **Rate limiting and lockout.** The login handler caps concurrent hashing and sheds excess with `503`, which protects the *server*; it does not slow an attacker down per account. Count failures yourself, or rate-limit `/login` at the proxy.
- **Registration abuse.** No email verification, no captcha, no duplicate-signup throttling. `RegisterHandler` answers `409` on a taken username, which is an existence oracle you accept in exchange for a usable signup form — mask it if your threat model cannot.
- **Password reset, email change, 2FA, OAuth, SSO.** All absent by design. They are product decisions with wildly different answers per app, and each needs a channel (email, TOTP, an identity provider) that borgo has no business owning.
- **Session revocation.** Sessions are self-contained signed cookies, so there is no server-side list to delete from: a stolen cookie is valid until it expires. If you need instant revocation, keep a token version in your user row, put it in the principal, and check it in the guard — or rotate `SESSION_SECRET`, which logs everyone out at once.

The trade that buys: no session store, no lookup per request, and a server that can be restarted or replicated without anybody being logged out.

## Caching

Not auth, but usually decided together: `borgo.Cache(w, 5*time.Minute)` for anything public, `borgo.NoCache(w)` for anything personalized — see [caching in the deploy guide](deploy.md#caching). Call `Cache` *after* anything that sets a cookie: it downgrades itself to `private` when it sees one, and it cannot see a cookie that has not been set yet.
