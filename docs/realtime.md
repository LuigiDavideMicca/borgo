# Realtime

Live updates in both directions: server-sent events for one-way feeds, WebSocket topics for anything browsers also write to, and typed event payloads generated from the Go source.

## Server-sent events

`borgo.SSE(w, r)` turns any handler into an event stream — it returns the stream, with `Send(event, data)` (data JSON-encoded), `Ping()` to keep idle proxies from closing it, and `Done()` for the client's disconnect:

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
import type { Task } from "../.borgo/api-types";

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

Create a task in one tab, watch it appear in the other. The front server proxies streams without buffering, so a plain `EventSource` works with no client library, and the whole thing is standard library on the Go side.

A publish never blocks on a slow subscriber, and a subscriber that disappears without closing its connection — a laptop lid, a dropped mobile connection — is reaped rather than holding a goroutine and a file descriptor forever: writes carry a rolling deadline, so a stream nobody is reading eventually errors out and unsubscribes itself.

## WebSocket topics

The Bun front server is also a native WebSocket server. Browsers join named topics with the `subscribe` helper; every `{event, data}` published on a topic reaches every subscriber, including the publisher's other tabs:

```tsx
import { subscribe } from "borgo-framework";

const channel = subscribe("live", (event, data) => { /* ... */ });
channel.publish("message", "hello");   // browser -> everyone on the topic
channel.close();
```

The built-in `__count` event reports the topic's subscriber count (presence for free), and the connection reconnects itself. On the Go side, `borgo.Push(topic, event, data)` publishes into the same topics — it POSTs to the front server's internal endpoint, accepted from loopback. When the two halves are on different hosts, set `FRONT_URL` and the same `BORGO_PUSH_KEY` on both: once a key is set it *replaces* the loopback check, so a key on one side only means every push is refused.

```go
borgo.Push("live", "task-created", task.Title)
```

## Typed events

`borgo.Push` makes the payload visible to static analysis: called with literal topic and event strings, borgogen records the payload type in a generated `"topic/event"` map, exactly like `borgo.JSON[T]` types a route. The `subscribe` callback for that topic then narrows — checking `event` types `data`, and an event name nobody declared fails `tsc`. `channel.publish` is held to the same map: on a topic with declared events, only a declared event name with its payload type compiles (CI proves both directions with deliberate wrong-payload files). Browser-published events join the map through declaration merging in any `.d.ts` of the app (see `ws-events.d.ts` in the tasks example):

```ts
declare module "borgo-framework" {
  interface WsEvents {
    "live/message": string; // browsers publish this one
  }
}
```

Topics with no declared events keep the untyped `(event: string, data: unknown)` callback. `Push` also accepts computed topic and event names — there is nothing to record statically, so those calls stay out of the map and their subscribers keep the untyped callback. That is a choice, not a mistake, and borgogen says nothing about it.

One naming rule: a topic cannot contain `/`, which would make the `"topic/event"` key ambiguous and subscribe the browser to the part before the slash. Such a push still delivers — refusing to generate would break a working app over a typing detail — so borgogen warns, names the file and line, and leaves that event untyped.

### Typing nuances

`Channel.publish` is declared with method syntax on purpose: TypeScript checks method parameters bivariantly, so a typed `Channel<"live">` stays assignable to a plain `Channel` — you can keep a `Channel[]` of mixed topics for cleanup, or pass a typed channel to a helper that only ever calls `close()`. Strict property syntax would reject those assignments; the loosened direction (publishing through the widened reference) is the same escape hatch `borgo.Push` already provides, so nothing new leaks. Wrong payloads through the *typed* reference still fail `tsc`, and CI proves it with deliberate wrong-payload files.

Go itself stays stdlib-only — the WebSocket termination lives where Bun already provides it natively. Choose SSE for one-way server→browser feeds; choose WebSocket topics for anything browsers also write to. The `/live` page in `examples/tasks` demos both directions: two-tab chat plus Go pushes.

The relay itself stays dumb by design: the front server forwards `{event, data}` between subscribers and Go; per-message business logic belongs in Go routes.

## Honest limits

- **The relay is not a message broker.** There is no durability, no replay, no delivery guarantee and no ordering guarantee across topics. A subscriber that was offline missed what happened. If a client must not miss an event, give it a way to re-fetch state on reconnect — which is what the SSE example above does by refetching rather than applying a delta.
- **Nothing is authorized per topic.** Any browser that can open the socket can subscribe to any topic name, so treat topic names as public and never put a secret in one. Scope by unguessable id, and keep anything sensitive behind an authenticated API route.
- **Limits are enforced**: 32 topics per client, 128 characters per topic name, 1 MB per message, and a same-origin check on the upgrade. See [security](security.md#realtime-surface).
- **Reconnection is exponential and capped** at 30 seconds. After a long outage a client can be up to half a minute behind before it even tries; a page that must feel live should refetch on reconnect rather than trusting the gap was empty.
- **SSE holds a connection per subscriber.** That is cheap in Go, but it is not free at the proxy in front of you: make sure it does not buffer, and does not cut idle connections shorter than your ping interval. [`borgo deploy init nginx`](deploy.md#borgo-deploy-init) writes a config that gets both right.
- **One of those proxies is borgo's own front server**, and it has a limit worth knowing. Every `/api` request it forwards to Go holds one slot in Bun's outbound fetch pool for its whole life — which for an event stream means hours. That pool defaults to 256, so past roughly 255 concurrent streams new subscribers queue instead of connecting, with nothing logged. `BUN_CONFIG_MAX_HTTP_REQUESTS` sets the pool size; borgo raises it to 16384 in `borgo dev`, in the Dockerfile the templates ship, and in the systemd and compose configs `borgo deploy init` writes. **If you launch the server any other way, set it yourself** — Bun reads it when the process starts, so exporting it later, or assigning `process.env` from inside the app, does nothing.

## Streams and server timeouts

`borgo.Serve` runs a hardened `http.Server`: `ReadHeaderTimeout` (5s) cuts off slow-header clients, `IdleTimeout` (2m) reclaims kept-alive connections. Read and write timeouts stay `0` by choice — they are wall-clock deadlines on the *whole* request, and any value long enough to be safe for an SSE stream or a streamed SSR response is too long to protect anything; request-body abuse is bounded by `Bind`'s 1 MB cap instead (see [the typed bridge](typed-bridge.md#typed-request-bodies)). WebSockets terminate on the Bun server and never touch Go's timeouts. All four knobs have env overrides (`BORGO_READ_HEADER_TIMEOUT` and friends — see the [environment reference](deploy.md#environment-reference)), and if you do set a write timeout, `borgo.SSE` clears the deadlines on its own connection, so event streams outlive it by design.
