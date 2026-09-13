# Middleware and authorization

`borgo.Authed` answers one question: is there a session. Everything past that — a role, a workspace, a page only some users may open, a login endpoint that must not be hammered — needs code that runs before the handler, the page or the cached copy it protects. This page covers the three places that code lives, what each one stands in front of, and the bridge that lets TypeScript ask Go before deciding.

## Where each decision runs

A request on the public port meets them in this order:

1. The Go front answers its own names first: `/healthz`, `/metrics`, and a `404` for the names the two processes use between themselves. No middleware runs on these — a middleware that answered a health probe `403` would restart the container in a loop.
2. A page path with a second spelling is redirected to its one spelling (`/app/` to `/app`, dot segments and doubled slashes resolved). `/api` is exempt.
3. **`api/middleware.go`** runs, for the paths its `Matcher` covers: before the `/api/*` handlers, the public files, the page cache and the render service. A WebSocket handshake on `/ws` passes through it as well.
4. The request is answered: by the api handler in the same process, a file, a cached page, or the render service.
5. In the render service, **`middleware.ts`** runs for the pages its `matcher` covers, before the page's action, its loader and its document.
6. Every read of the session along the way — `borgo.GetSession`, `borgo.Authed`, the `session` handed to `middleware.ts` and to loaders — first passes **`borgo.CheckSession`**, when the app registered one.

Loaders reach the api on its internal listener, and `api/middleware.go` guards that listener too, so a loader meets the rule a browser meets. `//borgo:export` functions are the one deliberate exception, [explained below](#calling-go-borgoexport).

| Place | Written in | Stands in front of | Decides from |
| --- | --- | --- | --- |
| `api/middleware.go` | Go | api routes, public files, cached pages, pages, `/ws` handshakes, loaders' api calls | the request, `borgo.GetSession` |
| `middleware.ts` | TypeScript | a page's document, the props a client navigation fetches, its form actions | `session`, `locals`, `params`, `url` |
| `borgo.CheckSession` | Go | every read of the session | when the session was issued, and its data |

Which one: a rule about the api, or about everything the app serves, belongs in `api/middleware.go`. A rule about pages that wants the page's URL parameters or a redirect to a login page belongs in `middleware.ts`. A rule that takes a session away belongs in `CheckSession`. They compose — the Go middleware can decide a role once and [forward it](#handing-a-decision-on-with-value-forward) to `middleware.ts`.

## `api/middleware.go`

One function with the shape every Go developer already writes, and an optional list of the paths it covers:

```go
// the paths this middleware stands in front of; without Matcher, everything
var Matcher = []string{"/api/admin/*", "/admin/*"}

func Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		me, ok := borgo.GetSession[Me](r)
		if !ok || !isAdmin(me.Username) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, borgo.Forward(r, "role", "admin"))
	})
}

func isAdmin(username string) bool { return username == "ada" }
```

borgogen finds `Middleware` and `Matcher` in package `api` and registers them in `borgo.gen.go` beside the routes; nothing else wires them. What holds:

- **One middleware.** Several concerns are composed inside the file — `return limited(admin(next))` — where their order is visible. A second registration panics at boot.
- **The matcher grammar is `Revalidate`'s.** `/admin` is that path; `/admin/*` is the path and everything below it; `/admin*` is a prefix, so it covers `/administrators` too. Entries are matched on the cleaned path, so `/api//admin` and `/api/x/../admin` cannot slip past `/api/admin/*`. Entries are written decoded — `/città`, not `/citt%C3%A0` — because the path they are compared with is. An entry that could never match — not absolute, a `*` anywhere but the end, a query string, a percent-encoded character, a path that is not clean — is refused at boot with its value, because a matcher that silently matched nothing would be a guard that guards nothing.
- **A panic is a `500`.** The middleware runs inside its own recover, and the handler behind it is not reached by falling through.
- **The same rule on every door Go has.** The public port, the internal listener the loaders call, and an api served alone with no pages all put the middleware in front of the mux.

### Handing a decision on: With, Value, Forward

What the middleware decided, the handler behind it reads instead of deciding again:

```go
func workspace(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, borgo.With(r, "workspace", 42))
	})
}

func projects(w http.ResponseWriter, r *http.Request) {
	id, ok := borgo.Value[int](r, "workspace")
	if !ok {
		http.Error(w, "no workspace", http.StatusBadRequest)
		return
	}
	borgo.WriteJSON(w, http.StatusOK, map[string]int{"workspace": id})
}
```

- **`With` stays in the Go process. `Forward` also crosses** to the render service: `middleware.ts` and every loader and action of the page see the value in `locals`. Forwarding is explicit because the rest of the request context — a database handle, a logger — cannot cross, and a call that names the value shows in the code what does.
- **A forwarded value must encode as JSON, and all of them together must fit in 16 KiB** once encoded. Either failure answers `500` and is logged: a page is never rendered without the decision it was meant to carry. Forward an id, not a record.
- **`Value[T]` is false** when nothing was set, and when what was set is not a `T` — `Value[int64]` does not read an `int`.
- **A request derived with `With` leaves its parent alone**: what the request it came from reads does not change.

On the TypeScript side, `locals` and `session` are typed by the app, once:

```ts
declare module "borgo-framework" {
  interface Locals {
    role?: string;
  }
}
```

## `middleware.ts`

At the root of the app, beside `pages/`:

```ts
import { next, redirect, rewrite, type PageMiddleware } from "borgo-framework";

export const matcher = ["/app/:path*", "/w/:slug/:path*"];

export const middleware: PageMiddleware = (_request, { session, locals, params, url }) => {
  if (!session) return redirect(`/login?next=${encodeURIComponent(url.pathname)}`);
  if (params.slug && locals.role !== "admin") return rewrite("/forbidden");
  return next({ headers: { "Cache-Control": "private, no-store" } });
};
```

- **Three doors, one decision.** A page is reached three ways: its document, the props a client navigation fetches, and the `POST` of its form action. The middleware runs once per request, before any loader or action, on all three — a guard on two doors of three is not a guard. A redirect reaches a client navigation and an enhanced form as a navigation, not as a `303` the runtime could not follow.
- **What it returns.** `next()`, optionally with headers for the response; `redirect(to)`; `rewrite(path)`, which renders another page of this app for this request, once, without changing the browser's URL; or any `Response`. A rewrite takes a path inside the app, without a query, and not to the page itself. Anything else thrown or returned is an error for that request.
- **`session` is what Go verified**, after `CheckSession`, or `null`. The render service never holds `SESSION_SECRET` and never reads the cookie to decide who is asking. `locals` is what `api/middleware.go` forwarded.
- **The matcher.** `/account` is that page. `:name` matches one segment and lands decoded in `params`; `:name*`, only as the last segment, matches the rest of the path — including nothing, so `/app/:path*` covers `/app` itself. Without a `matcher`, every page is covered. Static segments match the way the router matches them, as written or decoded, so `/città` guards the page a browser requests as `/citt%C3%A0`; an entry written percent-encoded is refused. An entry ending in `/` is refused too, because the Go front redirects every other spelling of a page to one.
- **Never on `/api`.** An entry naming `/api` or `/__borgo` refuses the build and the boot: the api is guarded in `api/middleware.go`, and asking the render service for permission on every api call would put back the hop the Go front removed. The other mistakes — no `middleware` function, a `matcher` that is not an array, an empty one, an entry the grammar does not allow — refuse the boot with the file's name.
- **A page the matcher can reach is never shared from the cache.** A page that exports `revalidate` under the guard renders for each request instead: a cached copy is served before any middleware runs, so caching it would serve the guarded page to whoever asks.

## Calling Go: `//borgo:export`

`middleware.ts` and loaders often need an answer only Go has — is this user a member of that workspace — and an api route written just for that is an endpoint the browser can reach as well. An export is a Go function the render service calls by name:

```go
type Member struct {
	Role string `json:"role"`
}

//borgo:export
func Membership(ctx context.Context, userID int64, slug string) (*Member, error) {
	if slug == "" {
		return nil, errors.New("no workspace named")
	}
	return &Member{Role: "admin"}, nil
}
```

borgogen writes a typed stub for each export into `.borgo/go.ts`, named after the Go function with its first letter lowered:

```ts no-check
// no-check: .borgo/go.ts exists only in an app that declares an export
import { go } from "@/.borgo/go";
import { GoError, next, redirect, type PageMiddleware } from "borgo-framework";

export const matcher = ["/w/:slug/:path*"];

export const middleware: PageMiddleware = async (_request, { session, params }) => {
  if (!session) return redirect("/login");
  try {
    const member = await go.membership(session.userId as number, params.slug!);
    return member ? next() : redirect("/");
  } catch (error) {
    if (error instanceof GoError && error.status === 200) return redirect("/");
    throw error;
  }
};
```

- **The shape is checked by borgogen**, which stops with the file and line: a package-level, exported, non-generic, non-variadic function; `context.Context` first; returning `(T, error)` or `error`; parameters and result that cross as JSON — no channels, no functions.
- **Answered on the internal listener only**, behind the key minted for this boot, at `/__borgo/export/<Name>`. On the public port every `/__borgo/` name is a `404`, and outside the render service the call throws before it is made.
- **Not behind `api/middleware.go`, on purpose.** That middleware judges browsers by their cookies; the caller here is the render service, authenticated by the key. The function receives what it needs to decide as arguments, and decides — pass the user id from the verified `session`, never from something the browser sent.
- **Errors arrive as `GoError`.** An error the function returned has `status` 200 and the Go error's text as its message; arguments that do not fit the function — a `.borgo/go.ts` older than the running binary — are 400; a panic is contained, logged with its stack, and 500. A `nil` result is `null`.
- **An api served alone has no internal listener**, so its exports are registered and unreachable.
- **What a call costs** was measured on the channel before the feature was built: 0.089 ms at the median and 0.223 ms at p99 over loopback, and 58,453 calls a second at 64 concurrent callers.

## Taking a session away

A role removed in the database stays in a session cookie until the cookie expires, unless the app registers a check. `borgo.CheckSession` runs before either middleware sees the session: a revoked session is `null` in `middleware.ts` and in loaders, and `borgo.GetSession` answers false in Go. [Revoking sessions](auth-and-sessions.md#revoking-sessions) has the example and its rules.

## Rate limiting

borgo ships no limiter. `api/middleware.go` is where one goes, composed with the rest of the file:

```go
var logins = struct {
	sync.Mutex
	window time.Time
	hits   map[string]int
}{hits: map[string]int{}}

func limited(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || path.Clean(r.URL.Path) != "/api/login" {
			next.ServeHTTP(w, r)
			return
		}
		client, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			client = r.RemoteAddr
		}
		logins.Lock()
		if time.Since(logins.window) > time.Minute {
			logins.window, logins.hits = time.Now(), map[string]int{}
		}
		logins.hits[client]++
		over := logins.hits[client] > 10
		logins.Unlock()
		if over {
			w.Header().Set("Retry-After", "60")
			http.Error(w, "too many login attempts", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(w, r)
	})
}
```

- **The `Matcher` has to cover `/api/login`** for this to run at all.
- **The map starts over every minute**, so it cannot grow past one minute of distinct clients.
- **`r.RemoteAddr` is the peer that connected**, and borgo does not rewrite it. Behind a reverse proxy that peer is the proxy, and every client would share one budget: key on the address the proxy states, and only when the peer is that proxy — or limit at the proxy, as [security](security.md#what-borgo-does-not-do) suggests.
- **It is per process.** Several instances behind a load balancer each keep their own count.

## Honest limits

- **One of each.** One `api/middleware.go` middleware and one `middleware.ts`; composition happens inside them.
- **`middleware.ts` never runs on `/api`.** The api is Go's, and its guard is `api/middleware.go`.
- **WebSocket topics are not authorized per topic.** `api/middleware.go` sees the `/ws` handshake when its matcher covers `/ws`, but nothing yet decides which topics an accepted socket may subscribe to — see [realtime](realtime.md#honest-limits).
- **Exports skip the app's middleware by design**, and trust the render service that holds the key.
- **What the examples keep in memory is per process** — the limiter's counts, a revocation cutoff. Several instances need a store they share.
- **Forwarded values are capped at 16 KiB** in total, encoded.
