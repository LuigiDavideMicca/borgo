// THE ROOT ENTRY IS THE APPLICATION-FACING API.
//
// One rule governs what belongs here: an app writes it by hand. If the only
// caller is generated code, or another borgo module reaching across a file
// boundary, it does not belong on "borgo-framework" - it belongs on a subpath
// whose name says it is not for you ("borgo-framework/internal", ./runtime,
// ./router). Adding a symbol here is a stability promise; adding one there is
// not. That is the whole reason the split exists, so resist the convenience of
// re-exporting an internal from this file because an import path got long.
//
// Everything exported here is also browser-safe: pages import from
// "borgo-framework" and end up in the client bundle. The SSR front server
// (src/server.ts) is not published at all - the cli boots it by relative
// import - so nothing server-only can leak in through this file.
export type {
  ActionContext,
  Head,
  HydrateMode,
  LayoutModule,
  LoaderContext,
  PageModule,
  PrerenderContext,
  Route,
} from "./router";
export { ApiError } from "./api";
export type { ApiClient, ApiOptions, ApiRequest, ApiResponse, ApiRouteKey } from "./api";

// route pattern -> response type, filled in by the generated
// .borgo/api-types.d.ts through declaration merging
export interface ApiRoutes {}

export const redirect = (to: string, status = 303) =>
  new Response(null, { status, headers: { Location: to } });

// websocket channels: the front server relays {topic, event, data} between
// every subscriber of a topic; go pushes into the same topics via borgo.Push.
// the built-in "__count" event reports the topic's subscriber count.
// publish is typed against the same WsEvents map as subscribe: a topic with
// declared events only publishes those, with the matching payload; topics
// without declarations (and non-literal topics) keep the untyped shape.
export type Channel<T extends string = string> = {
  publish(...args: PublishArgs<T>): void;
  close(): void;
};

// onRefused fires once, when the relay closed the handshake with a verdict that
// will not change (the page's origin is not the server's); the channel is over
export type SubscribeOptions = { onRefused?: (reason: string) => void };

// the relay's close code for an origin it does not accept (WS_CLOSE_ORIGIN_REFUSED
// in src/server.ts, pinned by subscribe.test.ts like MAX_TOPIC_LENGTH below).
// The one close the client may treat as final: it is configuration, it is the
// same on every dial, and - measured - it is the only refusal whose code and
// reason arrive at the client intact. Every other close is "the server will be
// back": a 1006, a 1002, a restart are indistinguishable from here
const CLOSE_ORIGIN_REFUSED = 4403;

// "topic/event" -> payload type. borgogen fills this in from borgo.Push
// calls through the generated .borgo/api-types.d.ts; browser-published
// events are declared the same way in any app .d.ts file.
export interface WsEvents {}

type EventsFor<T extends string> = {
  [K in keyof WsEvents & string as K extends `${T}/${infer E}` ? E : never]: WsEvents[K];
};

// a topic with declared events gets a closed, discriminated (event, data)
// pair - checking event narrows data, an undeclared event name fails tsc.
// topics without declarations keep the untyped (string, unknown) shape.
type EventPairs<M> = {
  [E in Extract<keyof M, string>]: [event: E, data: M[E]];
}[Extract<keyof M, string>];

export type TopicEvents<T extends string> = [keyof EventsFor<T>] extends [never]
  ? [event: string, data: unknown]
  : EventPairs<EventsFor<T>> | [event: "__count", data: number];

export type TopicEventName<T extends string> = [keyof EventsFor<T>] extends [never]
  ? string
  : Extract<keyof EventsFor<T>, string> | "__count";

// what a browser may publish: the declared events minus the server-only
// "__count"; same fallback as subscribe when nothing is declared
export type PublishArgs<T extends string> = string extends T
  ? [event: string, data?: unknown]
  : [keyof EventsFor<T>] extends [never]
    ? [event: string, data?: unknown]
    : EventPairs<EventsFor<T>>;

// the relay's cap on one topic name (MAX_WS_TOPIC_LENGTH in src/server.ts).
// Duplicated rather than imported: that file is the server and importing it
// here would drag the whole front server into every page's bundle. The pair is
// pinned instead - subscribe.test.ts reads both sources and fails the build the
// moment the two numbers stop agreeing, which is the drift this copy risks.
const MAX_TOPIC_LENGTH = 128;

// the second overload keeps single-parameter callbacks compiling: tsc does
// not accept them against a rest signature made of a tuple union
export function subscribe<T extends string>(
  topic: T,
  onEvent: (...args: TopicEvents<T>) => void,
  options?: SubscribeOptions,
): Channel<T>;
export function subscribe<T extends string>(
  topic: T,
  onEvent: (event: TopicEventName<T>) => void,
  options?: SubscribeOptions,
): Channel<T>;
export function subscribe(
  topic: string,
  onEvent: (...args: any[]) => void,
  options: SubscribeOptions = {},
): Channel {
  // THE RELAY REFUSES THESE, AND ITS REFUSAL REACHES THE BROWSER AS "connection
  // closed" - a message that names nothing. The name is known here, at the call,
  // so it is said here. /ws?topics=a,b packs topics into one parameter and the
  // server splits on the comma and trims each part: a topic carrying one becomes
  // two subscriptions, and one the trim rewrites becomes a subscription under a
  // name this channel's onmessage filter (msg.topic === topic) will never match.
  // Both open, count, and deliver nothing. Not imported from util.ts, whose
  // topicRejection says the same about the comma: that file is server-only and
  // importing it here would put it in every page's bundle.
  //
  // The length is here for a second reason, on top of naming what "connection
  // closed" would not. A refused handshake reaches onclose, and onclose redials
  // with backoff - so a topic the relay answers 400 to was dialled again every
  // thirty seconds for as long as the tab stayed open, forever, for a refusal
  // that was going to be identical every time. The status is not readable from
  // here to tell the two apart: measured against a live relay with a bun client,
  // a non-101 answer arrives as close code 1002 "Expected 101 status code" and
  // nothing else, and the spec gives a browser 1006 with an empty reason - the
  // same shape a server that is simply down produces. So the one refusal a call
  // can provoke is settled where it IS knowable: before the first dial. The redial is
  // deliberately left alone - it cannot tell a permanent refusal from a server
  // that is restarting, and a channel that stops on the wrong guess is worse
  // than one that retries.
  const unusable = topic.includes(",")
    ? `contains "," which separates topics on the wire (/ws?topics=a,b), so it would subscribe to the parts and receive none of them - rename the topic`
    : !topic.trim()
      ? "is empty, so there is nothing to subscribe to - name the topic"
      : topic !== topic.trim()
        ? `is padded with whitespace the relay strips, so it would subscribe as ${JSON.stringify(topic.trim())} and receive nothing under this name - trim it`
        : topic.length > MAX_TOPIC_LENGTH
          ? `is ${topic.length} characters, over the ${MAX_TOPIC_LENGTH} the relay accepts, so the handshake would be refused and redialled forever - shorten the name`
          : "";
  if (unusable) throw new Error(`subscribe: topic ${JSON.stringify(topic)} ${unusable}`);

  let ws: WebSocket | null = null;
  let closed = false;
  let attempts = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const queue: string[] = [];

  const connect = () => {
    // a close() racing the reconnect timer must win: without this, the timer
    // dials a socket nothing will ever close and onEvent outlives the channel
    if (closed) return;
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${scheme}://${location.host}/ws?topics=${encodeURIComponent(topic)}`);
    ws.onopen = () => {
      attempts = 0;
      for (const pending of queue.splice(0)) ws!.send(pending);
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.topic === topic) onEvent(msg.event, msg.data);
      } catch {}
    };
    ws.onclose = (event) => {
      if (closed) return;
      // the origin verdict is the one close that is final: the relay said so in
      // a frame that arrives intact, and dialling again changes nothing but the
      // server's log. Reported once; a page with no handler still sees it
      if (event.code === CLOSE_ORIGIN_REFUSED) {
        closed = true;
        const reason = event.reason || "the relay refused this page's origin";
        if (options.onRefused) options.onRefused(reason);
        else console.error(`subscribe(${JSON.stringify(topic)}): ${reason}`);
        return;
      }
      // an unreachable server would otherwise be dialled once a second for as
      // long as the tab stays open; backoff resets on the next successful open
      retry = setTimeout(connect, Math.min(30_000, 1_000 * 2 ** attempts++));
    };
  };
  connect();

  return {
    publish(event, data) {
      // a closed channel will never flush its queue: drop instead of growing it
      if (closed) return;
      const msg = JSON.stringify({ topic, event, data });
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg);
      else queue.push(msg);
    },
    close() {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    },
  };
}

// islands: components in islands/*.tsx that hydrate independently, so a
// hydrate=false page can still have interactive parts. the registries the two
// components below read live on borgo-framework/internal, because the only
// things that *fill* them are generated code and the ssr server.
import { csrfRuntime, islandRegistry, unsafeMethod } from "./internal";

// csrf double-submit, in two halves because the two request shapes differ.
// the front server issues one borgo_csrf cookie and, in production, requires
// it echoed back by any request that carries it:
//   - a page form action echoes it in a hidden field (CSRF_FIELD), which
//     CsrfField renders from a react context the server render provides;
//   - a proxied /api/* route echoes it in a header (CSRF_HEADER), because an
//     api body is json and has no field to carry it - and a cross-site
//     *simple* form post, the one shape that needs no preflight, cannot set a
//     custom header at all.
export const CSRF_COOKIE = "borgo_csrf";
export const CSRF_FIELD = "__borgo_csrf";
export const CSRF_HEADER = "X-CSRF-Token";

/**
 * Reads borgo's CSRF token out of a cookie header (or `document.cookie`).
 *
 * An app needs this when it posts with a hand-rolled `fetch` instead of a
 * `<form>`: `<CsrfField />` covers real forms, and nothing else does. Send the
 * value back in the `__borgo_csrf` field of a form-encoded body, or in a
 * `__borgo_csrf` entry of a `FormData`, and the front server's double-submit
 * check passes exactly as it does for a native form post.
 *
 * ```ts
 * await fetch("/tasks", {
 *   method: "POST",
 *   headers: { "content-type": "application/x-www-form-urlencoded" },
 *   body: new URLSearchParams({ [CSRF_FIELD]: csrfCookieValue(document.cookie), title }),
 * });
 * ```
 *
 * Conflicting duplicates read as **absent**, deliberately. Two `borgo_csrf`
 * cookies with different values - a stale `Domain=` copy shadowing the
 * host-only one - are ambiguous, and the browser cannot verify a token to
 * break the tie. Guessing would sometimes echo the cookie the server is not
 * comparing against, which fails the post anyway, and sometimes echo a token
 * an attacker planted. This mirrors the Go side, which treats two valid
 * session cookies as no session for the same reason. Identical duplicates are
 * not a conflict: they are one token seen twice, and read normally.
 *
 * Returns `""` for missing, empty and ambiguous alike - the caller has nothing
 * useful to do with the distinction.
 */
export function csrfCookieValue(header: string | null): string {
  let value: string | null = null;
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1 || part.slice(0, eq).trim() !== CSRF_COOKIE) continue;
    const found = part.slice(eq + 1).trim();
    if (value !== null && value !== found) return "";
    value = found;
  }
  return value ?? "";
}

/**
 * `fetch`, with borgo's CSRF token attached on state-changing methods.
 *
 * Use it for every hand-written browser call to `/api/*` that is not a `GET`
 * or a `HEAD`. The front server requires the `X-CSRF-Token` header from any
 * request that carries a `borgo_csrf` cookie, so a plain `fetch("/api/x", {
 * method: "POST" })` from a hydrated page answers `403`. Loaders and actions
 * need none of this: their `api` client talks to the Go api directly and never
 * crosses the proxy.
 *
 * ```ts
 * await apiFetch("/api/logout", { method: "POST" });
 * ```
 *
 * Safe methods pass straight through, and so does a browser with no token
 * cookie - `fetch` semantics are otherwise untouched, `input` and `init` mean
 * exactly what they mean to `fetch`. An `X-CSRF-Token` the caller set
 * themselves is left alone.
 *
 * Browser-only, like every hand-rolled `fetch` in a page: it reads
 * `document.cookie`, which SSR has none of.
 */
export function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  // built through Request rather than by merging init: the spec's own merge
  // is the only one that gets `apiFetch(new Request(...))` right, where the
  // method and the headers live on the input and not in init at all
  const request = new Request(input as RequestInfo, init);
  if (unsafeMethod(request.method) && !request.headers.has(CSRF_HEADER)) {
    const token = typeof document === "undefined" ? "" : csrfCookieValue(document.cookie);
    if (token) request.headers.set(CSRF_HEADER, token);
  }
  return fetch(request);
}

// <CsrfField /> inside any <form method="post"> - server-rendered with the
// same token the cookie carries, so classic no-js posts pass validation too
export function CsrfField() {
  const runtime = csrfRuntime();
  if (!runtime) {
    throw new Error("csrf runtime not registered - is the app on a current borgo build?");
  }
  const { react, context } = runtime;
  const token = react.useContext(context);
  return react.createElement("input", { type: "hidden", name: CSRF_FIELD, value: token });
}

export type IslandProps = {
  name: string;
  props?: Record<string, unknown>;
  client?: "load" | "visible";
};

export function Island({ name, props = {}, client = "load" }: IslandProps) {
  const registry = islandRegistry();
  if (!registry) {
    throw new Error("no islands registered - <Island> needs a component in islands/");
  }
  const component = registry.components[name];
  if (!component) {
    throw new Error(`unknown island "${name}" - expected islands/${name}.tsx`);
  }
  const h = registry.createElement;
  return h(
    "div",
    {
      "data-borgo-island": name,
      "data-borgo-props": JSON.stringify(props),
      "data-borgo-client": client,
    },
    h(component, props),
  );
}

// registers a service worker in production only: a dev session held by a
// caching sw is the fastest way to debug ghosts. safe to call from any
// hydrated page or island; no-ops server-side and in unsupported browsers.
//
// __BORGO_DEV__ is the dev signal, and it has to be present on every page that
// can run this - which is not the same set as the pages that hydrate. It used
// to be written by the props script alone, so a `hydrate = false` page running
// islands had no flag and installed the worker in development; prepareShell's
// DEV_INLINE_CLIENT now carries it too, which is the half those pages get.
export function registerServiceWorker(path = "/sw.js") {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  if (typeof window !== "undefined" && (window as { __BORGO_DEV__?: number }).__BORGO_DEV__) return;
  const register = () => void navigator.serviceWorker.register(path).catch(() => {});
  if (document.readyState === "complete") register();
  else addEventListener("load", register);
}
