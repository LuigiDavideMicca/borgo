# Realtime

Live updates in both directions: server-sent events for one-way feeds, WebSocket topics for anything browsers also write to, and typed event payloads generated from the Go source.

## Server-sent events

`borgo.SSE(w, r)` turns any handler into an event stream — it writes the headers and flushes them at once, so the browser's `EventSource` opens before the first event, and returns the stream, with `Send(event, data)` (data JSON-encoded), `Ping()` to keep idle proxies from closing it, and `Done()` for the end of the stream — the client disconnecting, or the server beginning to shut down:

```go no-check
//borgo:route GET /api/ticker
func Ticker(w http.ResponseWriter, r *http.Request) {
    stream, err := borgo.SSE(w, r)
    if err != nil {
        return
    }
    for {
        select {
        case tick := <-ticks:
            stream.Send("tick", tick)
        case <-stream.Done():
            return
        }
    }
}
```

`borgo.NewSSEHub()` adds broadcast — `hub.Publish(event, data)` from anywhere, `hub.ServeHTTP` as the route handler:

```go
var events = borgo.NewSSEHub()

//borgo:route GET /api/events
func Events(w http.ResponseWriter, r *http.Request) {
	events.ServeHTTP(w, r)
}

//borgo:route POST /api/tasks
func CreateTask(w http.ResponseWriter, r *http.Request) {
	body, err := borgo.Bind[TaskCreate](r)
	if err != nil {
		borgo.BindError(w, err)
		return
	}
	task := Task{Title: body.Title}
	events.Publish("task-created", task)
	borgo.JSON(w, http.StatusCreated, TaskItem{Task: task})
}
```

And in the page:

```tsx
import { useEffect, useState } from "react";
import type { Task } from "@/.borgo/api-types";

export default function Tasks({ tasks: initial }: { tasks: Task[] }) {
  const [tasks, setTasks] = useState(initial);
  useEffect(() => {
    const source = new EventSource("/api/events");
    const refresh = async () => setTasks((await (await fetch("/api/tasks")).json()).tasks);
    source.addEventListener("task-created", refresh);
    return () => source.close();
  }, []);
  return <ul>{tasks.map((t) => <li key={t.ID}>{t.title}</li>)}</ul>;
}
```

`Send` and `Ping` return an error, and it is worth reading: a stream the handler ended itself with `stream.Close()` answers every later write with `borgo.ErrStreamClosed` (one value, `errors.Is`-able), while a stream the client dropped or the server is shutting down reports whatever the connection reported — that is the more useful answer, and `Done()` is where you watch for it. `Close()` is for the handler that detached the request context (`context.WithoutCancel`, a clone onto a background context) and so holds a stream no disconnection will ever end: idempotent, safe from any goroutine, and it writes nothing — the response ends when the handler returns. The hub has the same pair: `hub.Subscribers()` for the live count (publish it on a timer for presence, or skip producing when it is zero) and `hub.Close()`, which ends every open stream and makes later `Publish` calls no-ops.

Create a task in one tab, watch it appear in the other. The stream is written by the process that answers the port, nothing between it and the socket buffers, so a plain `EventSource` works with no client library, and the whole thing is standard library on the Go side.

A publish never blocks on a slow subscriber — a subscriber whose buffer is full misses that frame rather than stalling everyone else, which is one more reason to refetch state rather than apply deltas — and a subscriber that disappears without closing its connection — a laptop lid, a dropped mobile connection — is reaped rather than holding a goroutine and a file descriptor forever: every write carries a 10-second deadline, so a stream nobody is reading errors out on its next frame and unsubscribes itself.

## WebSocket topics

> **A topic is what your app says it is.** Every topic a socket asks for is
> put to `borgo.CanSubscribe` at the handshake, with the session already
> verified, before the socket is upgraded — see [who may hold a topic](#who-may-hold-a-topic).
> Without a check, `borgo dev` leaves every topic open and says so at
> startup; `borgo start` refuses every subscription, and says so too.
> Through 0.22 nothing was asked: an anonymous client with no cookie read a
> private channel by guessing its name, and `__count` told it how many
> people were in the room. That is the hole the check closes.

The Go process that answers the public port is also the WebSocket server: `/ws` is answered in-process, behind `api/middleware.go` and the same session verification as every page, by a relay written on `net/http` alone. Browsers join named topics with the `subscribe` helper; every `{event, data}` published on a topic reaches every subscriber, including the publisher's other tabs:

```tsx
import { subscribe } from "borgo-framework";

const channel = subscribe("live", (event, data) => { /* ... */ });
channel.publish("message", "hello");   // browser -> everyone on the topic
channel.close();
```

The built-in `__count` event reports the topic's subscriber count (presence for free), and the connection reconnects itself. One close is final: a socket the server refuses — the handshake's `Origin` is not the server's own, or there is no `Origin` and `BORGO_WS_ALLOW_NO_ORIGIN` is unset, or a topic `CanSubscribe` said no to — is closed with code `4403` and a reason naming the origin and the switch, or the topic; `subscribe` stops redialling, and reports the reason to an `onRefused` callback — `subscribe(topic, handler, { onRefused })` — or to `console.error` without one. Every other close keeps reconnecting with backoff.

On the Go side, `borgo.Push(topic, event, data)` publishes into the same topics. Since 0.30 that is a call inside the process, not a request: there is no endpoint, no key, and nothing crosses the network. It returns an error for an event no subscriber could ever receive — a topic no handshake could name (empty, blank, over 128 characters, containing a comma), or a payload over the 1 MB a socket may carry — and `nil` for a topic nobody holds right now, which is delivered to nobody. An app that mounts borgo's handlers on a server of its own mounts `borgo.Realtime()` at `/ws` — one relay per process, configured from the environment, its `101` carrying the security headers — and `Push` reaches it the same way.

```go
borgo.Push("live", "task-created", task.Title)
```

### Who may hold a topic

`borgo.CanSubscribe` registers the check every topic a socket asks for must pass. It runs once per topic at the handshake, before the socket is upgraded, with the request the socket came in on — so it reads the session with `GetSession` as a handler would, the front having verified it, and a `CheckSession` you registered is consulted once for the whole handshake. A refused topic closes the socket with `4403` and a reason naming the topic; `__count` is a subscription like any other, so a refused topic's count is never seen either.

```go
type User struct{ ID, Name string }

func init() {
	borgo.CanSubscribe(func(r *http.Request, topic string) bool {
		if topic == "lobby" {
			return true
		}
		user, ok := borgo.GetSession[User](r)
		return ok && topic == "user:"+user.ID
	})
}
```

Key a per-user topic by an id the app assigns, not by a name the user chose: a topic cannot hold a `,`, is at most 128 characters and loses the whitespace around it, so a chosen name can leave its owner with a channel the relay will not open. `examples/tasks` keys `user:<id>` for this reason.

A socket is judged once, at its handshake, and keeps its topics until it ends: a session revoked or expired afterwards is refused at its next handshake, not cut mid-socket. A check that panics refuses — failing open would hand a private topic to whoever hits the panic — and its stack is logged once per process. `borgo.CanPublish` decides a browser's publish separately, per message, for the topic it names; without one, publishing follows `CanSubscribe` — a socket may publish to what it may hold. A refused message is dropped, the socket stays open, and the refusal is logged once per socket. Go's own `Push` is never asked: it is your code publishing. And a subscriber cannot tell the two apart: a browser's publish reaches the others as the same `{event, data}` a `Push` would, so without a `CanPublish` any socket a topic admits may emit any event name declared for it, typed or not, with whatever data it likes — the type map is a compile-time promise about your code, not a wire check.

Without a `CanSubscribe`, `borgo dev` leaves every topic open to every socket and prints so at startup; `borgo start` refuses every subscription with `4403` and prints so too. A production relay with no rule is a relay with the wrong rule, and the one that fails loud is the one you notice before a visitor does.

## Typed events

`borgo.Push` makes the payload visible to static analysis: called with literal topic and event strings, borgogen records the payload type in a generated `"topic/event"` map, exactly like `borgo.JSON[T]` types a route. The `subscribe` callback for that topic then narrows — checking `event` types `data`, and an event name nobody declared fails `tsc`. `channel.publish` is held to the same map: on a topic with declared events, only a declared event name with its payload type compiles (CI proves both directions with deliberate wrong-payload files). Browser-published events join the map through declaration merging in any `.d.ts` of the app (see `ws-events.d.ts` in the tasks example):

```ts
declare module "borgo-framework" {
  interface WsEvents {
    "live/message": string; // browsers publish this one
  }
}
```

Topics with no declared events keep the untyped `(event: string, data: unknown)` callback.

### Computed topics: //borgo:topic

Every realtime app has per-entity topics — `"channel:"+id`, `"user:"+id` — and a computed name has no literal for borgogen to read. Name its shape on the call instead, and the generator keys the map by the pattern and keeps owning the payload type:

```go no-check
//borgo:topic channel:{id}
borgo.Push("channel:"+id, "message", msg)
```

The directive sits on the line above the call, or at the end of the line the call starts on, and names that one call; literal text and `{name}` placeholders, no `/`, no `,`, no whitespace, at most 128 characters of literal text (counted as the relay counts, in UTF-16 units). It becomes a template-literal key, `\`channel:${string}/message\``, and `subscribe("channel:42", ...)` or `subscribe(\`channel:${id}\`, ...)` narrows `data` exactly as a literal topic does; `channel.publish` is held to it too. A pattern with no placeholder says the topic is exactly that name. Every mistake fails the run and names the line: a directive on a `Push` whose topic is already a literal, one on no `Push` at all, one claimed by two calls, one with a computed event name, a comment that looks like the directive but is not one, a malformed pattern — and a collision, where a literal `Push` names a topic the pattern admits with a payload the pattern does not carry, or two patterns nest with different payloads, since the generated file would then type one event two ways, and `tsc` settles it in silence with no Go line to point at: the literal topic keeps its own payload whatever the pattern says, and two nested patterns type the event `never`, which no handler can read. A typing that silently did not happen is the drift this exists to end. `Push` still accepts a computed topic with no directive — nothing is recorded, the subscriber keeps the untyped callback, and borgogen says nothing about it. Do not hand-write a key for the same pattern in the app's `.d.ts`: that is the same duplicate index signature, and under `skipLibCheck` nothing reports it. The escape hatch is for browser-published events, which have no Go source to read. One consequence on the client: `subscribe(topic)` with a `topic` that is any `string` is untyped, since there is no name to narrow on — it used to see every event of every literal topic at once.

One naming rule: a topic cannot contain `/`, which would make the `"topic/event"` key ambiguous and subscribe the browser to the part before the slash. Such a push still delivers — refusing to generate would break a working app over a typing detail — so borgogen warns, names the file and line, and leaves that event untyped.

### Typing nuances

`Channel.publish` is declared with method syntax on purpose: TypeScript checks method parameters bivariantly, so a typed `Channel<"live">` stays assignable to a plain `Channel` — you can keep a `Channel[]` of mixed topics for cleanup, or pass a typed channel to a helper that only ever calls `close()`. Strict property syntax would reject those assignments; the loosened direction (publishing through the widened reference) is the same escape hatch `borgo.Push` already provides, so nothing new leaks. Wrong payloads through the *typed* reference still fail `tsc`, and CI proves it with deliberate wrong-payload files.

Go stays stdlib-only: the WebSocket server is borgo's own, an RFC 6455 implementation on `net/http` in the process that answers the port. Choose SSE for one-way server→browser feeds; choose WebSocket topics for anything browsers also write to. The `/live` page in `examples/tasks` demos both directions: two-tab chat plus Go pushes, with `api/realtime.go` deciding who may hold the topic.

The relay itself stays dumb by design: it forwards `{event, data}` between subscribers and `Push`. Per-message business logic belongs in Go routes, and in `CanPublish` when the logic is a yes or a no.

## Honest limits

- **The relay is not a message broker.** There is no durability, no replay, no delivery guarantee and no ordering guarantee across topics. A subscriber that was offline missed what happened. If a client must not miss an event, give it a way to re-fetch state on reconnect — which is what the SSE example above does by refetching rather than applying a delta.
- **Authorization is per topic and yours.** `CanSubscribe` is the whole rule: a topic it admits is public to everyone it admits, and a name is not a secret — scope by the session, not by an unguessable id. The check is taken once at the handshake, so a revocation reaches a socket at its next handshake and not before; cut the socket yourself if that is too late.
- **Limits are enforced**: 32 topics per client, 128 characters per topic name, 1 MB per message, and a same-origin check on the upgrade — scheme *and* host, and an absent `Origin` is a refusal, not a pass. That changed in 0.21: skipping the check for a request with no `Origin` meant the one header an attacker can simply omit turned the check off. Browsers always send one, so this costs them nothing; a non-browser client — including bun's own `WebSocket` — is now refused, and `BORGO_WS_ALLOW_NO_ORIGIN=1` is how you take that back, along with every other originless caller (Go reads it since 0.30, with the grammar of every other boolean: `yes` refuses the boot). Behind a proxy that terminates TLS, `X-Forwarded-Proto` supplies the scheme from a peer in `BORGO_TRUSTED_PROXIES`; the nginx config `borgo deploy init` writes already sets it. See [security](security.md#realtime-surface).
- **A topic containing a comma is refused**, on subscribe and on publish alike. The comma separates topics in the relay protocol, so one embedded in a name used to connect, report its subscriber counts, and deliver nothing — the worst shape a defect can take, because everything looks like it is working. `subscribe()` now refuses it before opening a socket, throwing with the topic in the message, so the mistake is a stack trace at the call site rather than a connection that closes. It also refuses an empty topic, one padded with whitespace — which fail the same silent way: the relay trims the name, the client filters on the untrimmed one, and nothing is ever delivered — and one over 128 characters, which the relay would answer `400` to and the client would otherwise redial forever. The server refuses the comma too, and logs it, for anything that reaches `/ws` without going through `subscribe()`; a `borgo.Push` to such a topic returns an error naming it.
- **Reconnection is exponential and capped** at 30 seconds. After a long outage a client can be up to half a minute behind before it even tries; a page that must feel live should refetch on reconnect rather than trusting the gap was empty.
- **SSE holds a connection per subscriber.** That is cheap in Go, but it is not free at the proxy in front of you: make sure it does not buffer, and does not cut idle connections shorter than your ping interval. [`borgo deploy init nginx`](deploy.md#borgo-deploy-init) writes a config that gets both right.
- **borgo's own front is not one of those proxies.** An `/api` event stream is written by the process that answers the public port, so nothing between your handler and the socket buffers it or holds a slot for it.

## Streams and server timeouts

`borgo.Serve` runs a hardened `http.Server`: `ReadHeaderTimeout` (5s) cuts off slow-header clients, `IdleTimeout` (2m) reclaims kept-alive connections. The public port's read and write timeouts (a minute each) are deadlines on *progress*, not on the whole request: every byte read or written moves them, so a slow upload that keeps arriving and a document that keeps streaming are never cut, and a client that stops is. An api served alone leaves both at `0`. Request-body abuse is bounded by `Bind`'s 1 MB cap and `BORGO_MAX_BODY` (see [the typed bridge](typed-bridge.md#typed-request-bodies)). A WebSocket is hijacked from the server at its handshake and keeps deadlines of its own: a ping every 30 seconds, and a socket that says nothing for two minutes is closed. All four knobs have env overrides (`BORGO_READ_HEADER_TIMEOUT` and friends — see the [environment reference](deploy.md#environment-reference)), and if you do set a write timeout, `borgo.SSE` clears the deadlines on its own connection, so event streams outlive it by design.

Nothing sits in front of Go on this path any more: an event stream is written by the process that answered the public port, and the deadline that could cut it (`BORGO_WRITE_TIMEOUT`, a minute on the public port) is cleared by an event stream at its first byte, and `borgo.SSE` then bounds each of its own writes at 10 seconds. The read deadlines bound what a client *sends* and cannot reach a stream — see [security](security.md#request-limits-and-timeouts).

### Declared limitation, through 0.2x: a starved event loop could truncate a silent stream

Under heavy CPU load the Bun front server could cut a live stream, and the client could not tell. It was known, measured, and not fixable within that design, so it was written down rather than chased; what 0.30 changed about it, and what has not been measured since, is below.

**What was measured, on the topology before 0.30.** Twenty-four concurrent SSR renders of a 600,000-row loader payload, against one SSE stream held silent for 45 s, at `BORGO_FRONT_READ_TIMEOUT=5`: **one truncation in the two runs at that load** — a 19,878 ms event-loop stall, the connection closed at 23.71 s with no terminating chunk, after the client had already received `200 OK` and the opening comment. The lighter attack that broke the previous design — twelve concurrent renders of a 400,000-row payload — did not truncate in seven runs across T=3, T=5 and T=30 (stalls 14,994–17,375 ms), where the previous design truncated 2/2 at 17,494 ms and 24,216 ms.

**It is not monotonic in stall length.** A 57,680 ms stall at the same setting did *not* truncate. That is the measurement; the explanation that fits is that a fully blocked event loop freezes bun's timer wheel along with the keep-warm sweep, and a frozen wheel expires nothing — so the total block protects the connection, while what cuts is the partially starved regime in between, where the wheel still fires but the sweep has not been given a turn to re-arm. Nobody has instrumented the wheel, so treat that as the reading and not as fact. The non-monotonicity itself is not in doubt: this is a stochastic interleaving, not a threshold, and there is no stall length above which it happens.

**What 0.30 changed about it.** The stream and the renders that starved it were in one process, and a bun event loop blocked for 19 seconds by a JSON serialization is what truncated the stream. They are now in two: the stream is written by Go, and the render that blocks is a separate process whose stalls cannot reach the socket. The measurement above is kept because it is what the design was chosen against, not because it still reproduces — it has not been re-run on the new topology, and the number that would replace it is owed here before this page claims a limit either way.

**Why no version of that design closed it.** The keep-warm is a JavaScript timer, so an event loop with no turn to give cannot run it. The only alternative — arm a long deadline and lower it when the response ends — is not available, because a `server.timeout` applied after the exchange is over does not take effect at all. Closing this would need a bound bun enforces from outside the loop, which bun does not expose.

**How it presents.** A truncated `200` that `EventSource` silently reconnects from, indistinguishable from a complete response unless you are counting bytes. If you are diagnosing gaps in a feed under load, this is a candidate; the practical mitigation is the ordinary one — keep long CPU-bound renders off the process serving your streams. A heartbeat is worth having regardless, since any byte written re-arms the deadline — but it is written by the same event loop, so it does not help while that loop is the thing being starved.
