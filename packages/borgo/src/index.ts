// the application-facing api: only what an app writes by hand, and only what
// is browser-safe (pages import this into the client bundle). Anything whose
// caller is generated code belongs on "borgo-framework/internal", not here.
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

// filled in by the generated .borgo/api-types.d.ts through declaration merging
export interface ApiRoutes {}

export const redirect = (to: string, status = 303) =>
  new Response(null, { status, headers: { Location: to } });

// the front server relays {topic, event, data} between subscribers of a topic;
// go pushes into the same topics via borgo.Push. "__count" is built in.
export type Channel<T extends string = string> = {
  publish(...args: PublishArgs<T>): void;
  close(): void;
};

// onRefused fires once, for the one verdict that will not change; the channel is over
export type SubscribeOptions = { onRefused?: (reason: string) => void };

// WS_CLOSE_ORIGIN_REFUSED in src/server.ts, pinned by subscribe.test.ts. The one
// close that may be treated as final: the only refusal whose code and reason
// reach the client intact - a 400 arrives as 1002/1006, same as a server down
const CLOSE_ORIGIN_REFUSED = 4403;

// "topic/event" -> payload. borgogen fills this in from borgo.Push calls;
// browser-published events are declared the same way in any app .d.ts
export interface WsEvents {}

type EventsFor<T extends string> = {
  [K in keyof WsEvents & string as K extends `${T}/${infer E}` ? E : never]: WsEvents[K];
};

type EventPairs<M> = {
  [E in Extract<keyof M, string>]: [event: E, data: M[E]];
}[Extract<keyof M, string>];

export type TopicEvents<T extends string> = [keyof EventsFor<T>] extends [never]
  ? [event: string, data: unknown]
  : EventPairs<EventsFor<T>> | [event: "__count", data: number];

export type TopicEventName<T extends string> = [keyof EventsFor<T>] extends [never]
  ? string
  : Extract<keyof EventsFor<T>, string> | "__count";

// the declared events minus the server-only "__count"
export type PublishArgs<T extends string> = string extends T
  ? [event: string, data?: unknown]
  : [keyof EventsFor<T>] extends [never]
    ? [event: string, data?: unknown]
    : EventPairs<EventsFor<T>>;

// MAX_WS_TOPIC_LENGTH in src/server.ts, duplicated not imported (that file is
// the whole front server); subscribe.test.ts pins the pair
const MAX_TOPIC_LENGTH = 128;

// second overload: tsc rejects a single-parameter callback against a rest
// signature made of a tuple union
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
  // refused before the first dial: the relay's refusal reaches the browser as a
  // bare "connection closed" (a 400 is indistinguishable from a server down),
  // and onclose would redial it forever. Not imported from util.ts, which is
  // server-only. The redial itself stays: it cannot tell a permanent refusal
  // from a restart, and stopping on the wrong guess is worse than retrying.
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
    // a close() racing the reconnect timer must win, or onEvent outlives the channel
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
      // reported once; a page with no handler still sees it
      if (event.code === CLOSE_ORIGIN_REFUSED) {
        closed = true;
        const reason = event.reason || "the relay refused this page's origin";
        if (options.onRefused) options.onRefused(reason);
        else console.error(`subscribe(${JSON.stringify(topic)}): ${reason}`);
        return;
      }
      retry = setTimeout(connect, Math.min(30_000, 1_000 * 2 ** attempts++));
    };
  };
  connect();

  return {
    publish(event, data) {
      // a closed channel never flushes its queue
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

import { csrfRuntime, islandRegistry, unsafeMethod } from "./internal";

// double-submit in two halves: a form action echoes the cookie in a hidden
// field, a proxied /api/* route in a header - the one thing a cross-site
// simple form post (no preflight) cannot set
export const CSRF_COOKIE = "borgo_csrf";
export const CSRF_FIELD = "__borgo_csrf";
export const CSRF_HEADER = "X-CSRF-Token";

/**
 * Reads borgo's CSRF token out of a cookie header (or `document.cookie`), for
 * a hand-rolled `fetch` that posts a form body: send it as `CSRF_FIELD`.
 *
 * Conflicting duplicates read as `""`, like the Go side with two session
 * cookies: the browser cannot verify a token to break the tie, and guessing
 * may echo one an attacker planted. Identical duplicates read normally.
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
 * `fetch` with borgo's CSRF header attached on unsafe methods: a plain
 * `fetch("/api/x", { method: "POST" })` from a hydrated page answers 403.
 * Loaders and actions need none of this, their `api` client never crosses the
 * proxy. Browser-only: it reads `document.cookie`.
 */
export function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  // through Request, not a merge of init: for `apiFetch(new Request(...))` the
  // method and headers live on the input, not in init
  const request = new Request(input as RequestInfo, init);
  if (unsafeMethod(request.method) && !request.headers.has(CSRF_HEADER)) {
    const token = typeof document === "undefined" ? "" : csrfCookieValue(document.cookie);
    if (token) request.headers.set(CSRF_HEADER, token);
  }
  return fetch(request);
}

// server-rendered with the cookie's token, so no-js posts pass too
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

// production only: a dev session held by a caching sw is how ghosts get
// debugged. __BORGO_DEV__ must reach every page that can run this, hydrate =
// false pages with islands included: DEV_INLINE_CLIENT carries it for those
export function registerServiceWorker(path = "/sw.js") {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  if (typeof window !== "undefined" && (window as { __BORGO_DEV__?: number }).__BORGO_DEV__) return;
  const register = () => void navigator.serviceWorker.register(path).catch(() => {});
  if (document.readyState === "complete") register();
  else addEventListener("load", register);
}
