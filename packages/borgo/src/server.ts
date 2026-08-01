import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { makeApiClient } from "./api";
import { buildAssets, compileCss } from "./build";
import { banner, c, fmtMs, g, statusColor } from "./colors";
import { buildAssetIndex, jsonResponse, serveAsset, serveIndexed, type AssetInfo } from "./compress";
import { registerCsrf, registerIslands } from "./internal";
import { createMetrics } from "./metrics";
import { overlayHtml } from "./overlay";
import { matchRoute, safeDecode, type Route } from "./router";
import {
  createSecurity,
  csrfRejects,
  decodeChanged,
  envInt,
  headResponse,
  idleTimeout,
  isLongLivedStream,
  keysEqual,
  metricsEnabled,
  prepareShell,
  proxyRequest,
  renderPage as renderDocument,
  runAction,
  runPropsRequest,
  type ActionOptions,
  type PropsOptions,
  type RenderPageOptions,
  sessionSecure,
} from "./util";

// resolve react from the app, not from this package: with a linked borgo
// checkout the two would otherwise be different copies and hooks would break
const appRequire = createRequire(join(process.cwd(), "package.json"));
const React = appRequire("react") as typeof import("react");
const { renderToReadableStream } = appRequire("react-dom/server") as typeof import("react-dom/server");

function composeElement(route: Route, props: Record<string, unknown>) {
  if (typeof route.module.default !== "function") {
    throw new Error(`pages/${route.file} must default-export a react component`);
  }
  let element = React.createElement(route.module.default, props);
  for (let i = route.layouts.length - 1; i >= 0; i--) {
    const layout = route.layouts[i];
    if (typeof layout.default !== "function") {
      throw new Error("every _layout.tsx must default-export a component taking { children }");
    }
    element = React.createElement(layout.default, null, element);
  }
  return element;
}

export async function serve({ dev = false } = {}) {
  const started = performance.now();
  let chunkMap: Record<string, string> = {};
  if (dev || !existsSync(".borgo/routes.gen.tsx") || !existsSync("public/assets/client.js")) {
    ({ chunkMap } = await buildAssets(dev));
  }

  const manifest = pathToFileURL(join(process.cwd(), ".borgo/routes.gen.tsx")).href;
  const { routes, notFound, serverError } = (await import(manifest)) as {
    routes: Route[];
    notFound: Route | null;
    serverError: Route | null;
  };
  const islandsManifest = pathToFileURL(join(process.cwd(), ".borgo/islands.gen.ts")).href;
  const { islands } = (await import(islandsManifest)) as {
    islands: Record<string, import("react").ComponentType<any>>;
  };
  registerIslands(islands, React.createElement);
  registerCsrf({
    createElement: React.createElement,
    createContext: React.createContext,
    useContext: React.useContext,
  });
  const shell = prepareShell(await Bun.file("index.html").text(), dev);

  const port = Number(process.env.PORT || 3000);
  const api = process.env.API_URL || `http://localhost:${process.env.API_PORT || 3501}`;
  const apiUrl = `${api}/api`;

  // outbound limits towards go. dev restarts the api on every .go edit, so a
  // refused connection is routine there and worth waiting out; in production
  // it means the api is down, and holding every request for four seconds only
  // piles connections up. BORGO_API_TIMEOUT is in ms, 0 disables it.
  const apiRetries = dev ? 15 : 3;
  const apiTimeout = envInt(process.env.BORGO_API_TIMEOUT, 30_000);
  // a body nobody bounded is free memory for anyone who can post: both the
  // proxy and form actions buffer. BORGO_MAX_BODY (bytes) raises it.
  const maxRequestBodySize = envInt(process.env.BORGO_MAX_BODY, 32 * 1024 * 1024);

  // the api client forwards the browser's cookies, so go handlers see the
  // session during ssr and in actions; set-cookie headers coming back from
  // go (login, logout) are collected and forwarded to the browser
  const apiFor = (req: Request, onSetCookie?: (cookies: string[]) => void) => {
    const cookie = req.headers.get("cookie");
    return makeApiClient(api, cookie ? { cookie } : {}, onSetCookie);
  };

  const runLoader = (
    req: Request,
    route: Route,
    params: Record<string, string>,
    onSetCookie?: (cookies: string[]) => void,
  ) =>
    route.module.loader
      ? route.module.loader({ request: req, params, api: apiFor(req, onSetCookie), apiUrl })
      : Promise.resolve({});

  // the exact defaults, and the env switches, are documented on createSecurity
  const security = createSecurity(dev, {
    headers: process.env.BORGO_SECURITY_HEADERS,
    csp: process.env.BORGO_CSP,
  });
  const secure = (res: Response) => (security ? security.apply(res) : res);

  // csrf: a double-submit token, issued as a cookie on rendered pages and
  // required from form actions of requests carrying a session - a cross-site
  // post cannot read the cookie to echo it in the form. on by default in
  // production; BORGO_CSRF=1 forces the check in dev, BORGO_CSRF=0 disables.
  const csrfEnforced =
    process.env.BORGO_CSRF === "0" ? false : dev ? process.env.BORGO_CSRF === "1" : true;
  const csrfCookieAttrs = `Path=/; SameSite=Lax${sessionSecure(process.env) ? "; Secure" : ""}`;

  const renderOptions: RenderPageOptions = {
    dev,
    shell,
    security,
    csrfCookieAttrs,
    runLoader,
    compose: composeElement,
    renderToStream: (element, init) =>
      renderToReadableStream(element, init) as unknown as Promise<AsyncIterable<Uint8Array>>,
  };
  const renderPage = (
    req: Request,
    route: Route,
    params: Record<string, string>,
    status: number,
    extraProps?: Record<string, unknown>,
    extraCookies: string[] = [],
  ) => renderDocument(req, route, params, status, renderOptions, extraProps, extraCookies);

  // static files: hashed build outputs cache forever, compressible types are
  // served from the .gz/.br siblings that `borgo build` emitted. dev has no
  // siblings (precompression is skipped) and serves identity.
  const assetIndex: Map<string, AssetInfo> = dev ? new Map() : buildAssetIndex("public");

  const sendJson = (req: Request, value: unknown, init?: ResponseInit) =>
    dev ? Response.json(value, init) : jsonResponse(req, value, init);

  const actionOptions: ActionOptions = {
    dev,
    apiUrl,
    serverError,
    csrfRejects: (req) => csrfRejects(req, { enforced: csrfEnforced }),
    apiFor,
    runLoader,
    renderPage,
    sendJson,
    renderOverlay: overlayHtml,
  };
  const propsOptions: PropsOptions = { runLoader, sendJson };

  // metrics wants the matched pattern as its label: handing it back from the
  // one match a request already does keeps the route table scanned once
  type Label = { route: string };

  async function handle(req: Request, url: URL, label: Label): Promise<Response> {
    if (url.pathname.startsWith("/api/")) {
      label.route = "/api/*";
      return proxyRequest(req, {
        target: api + url.pathname + url.search,
        deadlineMs: apiTimeout,
        retries: apiRetries,
      });
    }

    // decode before serving so files with spaces or unicode names resolve;
    // reject traversal and separator tricks on the decoded form - on windows
    // also ntfs alternate streams (file.css::$DATA) and reserved characters,
    // which alias a file under names the path checks never saw. get/head
    // only: a public/ file must not shadow a page action's post
    if (req.method === "GET" || req.method === "HEAD") {
      const assetPath = safeDecode(url.pathname);
      if (
        assetPath !== "/" &&
        !assetPath.includes("..") &&
        !assetPath.includes("\\") &&
        !assetPath.includes("\0") &&
        (process.platform !== "win32" || !/[:*?"<>|]/.test(assetPath))
      ) {
        const indexed = assetIndex.get(assetPath);
        if (indexed) return serveIndexed(req, indexed);
        const path = "public" + assetPath;
        const asset = Bun.file(path);
        if (await asset.exists()) return serveAsset(req, path, asset, { dev });
      }
    }

    if (req.method === "POST") {
      const target = matchRoute(url.pathname, routes);
      if (target) label.route = target.route.pattern;
      const answered = await runAction(req, target, actionOptions);
      if (answered) return answered;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      // a post only gets this far when the page has no action to run
      return new Response("method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }

    const matched = matchRoute(url.pathname, routes);
    if (matched) label.route = matched.route.pattern;
    const wantsProps = url.searchParams.get("__borgo") === "props";

    if (!matched) {
      if (wantsProps) return sendJson(req, { notFound: true }, { status: 404 });
      if (notFound) return renderPage(req, notFound, {}, 404);
      return new Response("not found", { status: 404 });
    }

    if (wantsProps) {
      return runPropsRequest(req, matched.route, matched.params, propsOptions);
    }

    return renderPage(req, matched.route, matched.params, 200);
  }

  // observability: /healthz always answers (and probes the go api with a
  // short timeout), /metrics appears with BORGO_METRICS=1. both stay out of
  // the request log, the metrics themselves and any compression.
  const bootTime = Date.now();
  const metrics = metricsEnabled(process.env) ? createMetrics(bootTime) : null;

  // /healthz answers anyone: a flood of probes must not become a flood of
  // probes against the api, so the result is shared for a second - the promise
  // itself, or a concurrent burst would all miss the cache together
  let apiProbe: { at: number; state: Promise<string> } | null = null;
  const probeApi = () => {
    const now = Date.now();
    if (apiProbe && now - apiProbe.at < 1_000) return apiProbe.state;
    const state = fetch(`${api}/healthz`, { signal: AbortSignal.timeout(1_500) })
      .then((res) => (res.ok ? "reachable" : "down"))
      .catch(() => "down");
    apiProbe = { at: now, state };
    return state;
  };

  async function healthz(): Promise<Response> {
    const apiState = await probeApi();
    return Response.json({
      status: apiState === "reachable" ? "ok" : "degraded",
      uptime: (Date.now() - bootTime) / 1000,
      api: apiState,
    });
  }

  function logRequest(req: Request, path: string, status: number, ms: number) {
    if (path.startsWith("/assets/") || path === "/favicon.ico") return;
    const method = c.dim(req.method.padEnd(4));
    console.log(`  ${method} ${path.padEnd(24)} ${statusColor(status)(String(status))} ${c.dim(fmtMs(ms))}`);
  }

  // dev channel: browsers connect over ws; a fresh boot after a code change
  // greets them with the changed file and the new page -> chunk map
  const devSockets = new Set<import("bun").ServerWebSocket<SocketData>>();
  const bootStamp = Date.now();
  const changed = decodeChanged(process.env.BORGO_CHANGED);
  const broadcast = (msg: Record<string, unknown>) => {
    const data = JSON.stringify(msg);
    for (const ws of devSockets) ws.send(data);
  };

  type SocketData = { kind: "dev" } | { kind: "app"; topics: string[] };
  const MAX_WS_TOPICS = 32;
  const MAX_WS_TOPIC_LENGTH = 128;
  const wsTopic = (topic: string) => "borgo:ws:" + topic;
  const publishCount = (topic: string) => {
    server.publish(
      wsTopic(topic),
      JSON.stringify({ topic, event: "__count", data: server.subscriberCount(wsTopic(topic)) }),
    );
  };
  const isLoopback = (address: string | undefined) =>
    address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";

  // a dev restart can try to bind before the os releases the previous
  // server's port; dying here would take the dev channel down for good
  const bindRetry = async <T>(start: () => T): Promise<T> => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        return start();
      } catch (error) {
        if (!dev || (error as { code?: string }).code !== "EADDRINUSE" || Date.now() > deadline) {
          throw error;
        }
        await Bun.sleep(150);
      }
    }
  };

  const server = await bindRetry(() => Bun.serve<SocketData, never>({
    port,
    maxRequestBodySize,
    // a real read deadline: this same number bounds how long bun waits for an
    // inbound request's headers and body, so disabling it to protect proxied
    // event streams left every body-reading path with no timeout at all. The
    // streams keep their exemption, granted per response below with
    // server.timeout(req, 0). BORGO_IDLE_TIMEOUT is in seconds, 0 disables it.
    idleTimeout: idleTimeout(process.env.BORGO_IDLE_TIMEOUT),
    websocket: {
      // websockets have their own deadline and bun pings them itself, so the
      // read deadline above never applies to an upgraded socket
      idleTimeout: 120,
      // every message a client sends is relayed to every subscriber: bun's
      // 16mb default would make one socket a broadcast amplifier
      maxPayloadLength: 1024 * 1024,
      open(ws) {
        if (ws.data?.kind === "app") {
          for (const topic of ws.data.topics) ws.subscribe(wsTopic(topic));
          for (const topic of ws.data.topics) publishCount(topic);
          return;
        }
        devSockets.add(ws);
        if (changed.length) {
          // the whole set, not just the first: a browser told about one file
          // of a two-file save may be told about the one it is not showing,
          // and then it applies nothing
          ws.send(
            JSON.stringify({ type: "js", files: changed, chunks: chunkMap, stamp: bootStamp }),
          );
        }
      },
      close(ws) {
        if (ws.data?.kind === "app") {
          const topics = ws.data.topics;
          setTimeout(() => topics.forEach(publishCount), 0);
          return;
        }
        devSockets.delete(ws);
      },
      // clients may publish to topics they are subscribed to; everything is
      // json {topic, event, data}, relayed verbatim to every subscriber
      message(ws, raw) {
        if (ws.data?.kind !== "app") return;
        try {
          const msg = JSON.parse(String(raw));
          if (
            typeof msg.topic === "string" &&
            typeof msg.event === "string" &&
            ws.data.topics.includes(msg.topic)
          ) {
            server.publish(
              wsTopic(msg.topic),
              JSON.stringify({ topic: msg.topic, event: msg.event, data: msg.data }),
            );
          }
        } catch {}
      },
    },
    async fetch(req) {
      const t0 = performance.now();
      const url = new URL(req.url);
      // heads render for real (status and headers must be honest), only the
      // body is dropped - and cancelled, or the ssr/gzip pipeline keeps
      // rendering into a stream nobody reads
      const dropBody = (res: Response) => headResponse(req.method, res);

      // app websockets: /ws?topics=a,b subscribes the browser to topics.
      // browsers attach cookies to ws handshakes from any origin, so a
      // cross-origin page must not be able to join (or publish into) topics
      if (url.pathname === "/ws") {
        const origin = req.headers.get("origin");
        if (origin) {
          let allowed = false;
          try {
            allowed = new URL(origin).host === url.host;
          } catch {}
          if (!allowed) return secure(new Response("forbidden", { status: 403 }));
        }
        const topics = (url.searchParams.get("topics") ?? "")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        // each topic is a subscription table entry held for the life of the
        // socket: unbounded counts or names are cheap resident memory for
        // anyone who can open a socket
        if (topics.length > MAX_WS_TOPICS || topics.some((t) => t.length > MAX_WS_TOPIC_LENGTH)) {
          return secure(new Response("too many topics", { status: 400 }));
        }
        if (server.upgrade(req, { data: { kind: "app", topics } })) return undefined as never;
        return secure(new Response("upgrade required", { status: 426 }));
      }

      // go -> browser push: accepted from loopback (or with the shared key)
      if (req.method === "POST" && url.pathname === "/__borgo/publish") {
        const key = process.env.BORGO_PUSH_KEY;
        // without a key, loopback-only - but behind a local reverse proxy
        // every external request arrives from 127.0.0.1, so anything the
        // proxy forwarded (it stamps forwarding headers) is rejected too
        const forwarded = req.headers.get("x-forwarded-for") || req.headers.get("forwarded");
        const authorized = key
          ? keysEqual(req.headers.get("x-borgo-key") ?? "", key)
          : isLoopback(server.requestIP(req)?.address) && !forwarded;
        if (!authorized) return secure(new Response("forbidden", { status: 403 }));
        const msg = await req.json().catch(() => null);
        if (!msg || typeof msg.topic !== "string" || typeof msg.event !== "string") {
          return secure(new Response("bad request", { status: 400 }));
        }
        server.publish(
          wsTopic(msg.topic),
          JSON.stringify({ topic: msg.topic, event: msg.event, data: msg.data }),
        );
        return secure(new Response(null, { status: 204 }));
      }

      if (dev && url.pathname.startsWith("/__borgo/dev")) {
        if (url.pathname === "/__borgo/dev" && server.upgrade(req, { data: { kind: "dev" } })) {
          return undefined as never;
        }
        if (req.method === "POST" && url.pathname === "/__borgo/dev/css") {
          try {
            await compileCss(true);
          } catch (error) {
            console.error(error instanceof Error ? error.message : error);
            return secure(new Response(null, { status: 500 }));
          }
          broadcast({ type: "css" });
          return secure(new Response(null, { status: 204 }));
        }
        if (req.method === "POST" && url.pathname === "/__borgo/dev/reload") {
          broadcast({ type: "reload" });
          return secure(new Response(null, { status: 204 }));
        }
        return secure(new Response("not found", { status: 404 }));
      }
      if (url.pathname === "/healthz") return secure(dropBody(await healthz()));
      if (metrics && url.pathname === "/metrics") {
        return secure(
          dropBody(
            new Response(metrics.render(), {
              headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
            }),
          ),
        );
      }

      const label: Label = { route: "*" };
      let response: Response;
      try {
        response = await handle(req, url, label);
      } catch (error) {
        // the client is already gone: an abandoned upload aborts the body read
        // and lands here. there is no socket left to write to, so building the
        // 500 document - the error page's loader, its api round trip, a full
        // render - is work for nobody, and a client that declares a long body
        // and hangs up would buy one of those per packet. 499 is nginx's
        // "client closed request": nothing ships, but the counter stays honest.
        if (req.signal.aborted) {
          response = new Response(null, { status: 499 });
        } else {
          console.error(error);
          if (dev) {
            response = new Response(overlayHtml(error), {
              status: 500,
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
          } else if (serverError) {
            try {
              response = await renderPage(req, serverError, {}, 500);
            } catch {
              response = new Response("internal server error", { status: 500 });
            }
          } else {
            response = new Response("internal server error", { status: 500 });
          }
        }
      }
      response = dropBody(response);
      // an event stream is idle between events by design; the read deadline
      // that protects every other path would cut it. lifted only for the
      // connection that actually carries one
      if (isLongLivedStream(response)) server.timeout(req, 0);
      if (metrics && !url.pathname.startsWith("/assets/") && url.pathname !== "/favicon.ico") {
        metrics.observe(label.route, response.status, (performance.now() - t0) / 1000);
      }
      if (dev) logRequest(req, url.pathname, response.status, performance.now() - t0);
      return url.pathname.startsWith("/api/") ? response : secure(response);
    },
  }));

  const ready = performance.now() - started;
  if (process.env.BORGO_RELOAD) {
    console.log(`  ${c.sage(g.ok)} rebuilt in ${fmtMs(ready)}`);
    return;
  }

  const table: Array<[string, string]> = routes.map((r) => [r.pattern, `pages/${r.file}`]);
  if (notFound) table.push(["404", `pages/${notFound.file}`]);
  if (serverError) table.push(["500", `pages/${serverError.file}`]);
  const width = Math.max(...table.map(([pattern]) => pattern.length));

  console.log(`\n  ${banner(dev ? "dev" : "start")}\n`);
  for (const [pattern, file] of table) {
    const colored = pattern.replace(/:(\w+)/g, (m) => c.terracotta(m));
    console.log(`  ${colored}${" ".repeat(width - pattern.length)}  ${c.dim(file)}`);
  }
  console.log(`\n  ${c.sage(g.ok)} ready in ${c.bold(fmtMs(ready))}`);
  console.log(`  ${c.terracotta(g.arrow)} app  ${c.blue(`http://localhost:${port}`)}`);
  console.log(`  ${c.terracotta(g.arrow)} api  ${c.blue(api)} ${c.dim("go, proxied at /api")}\n`);
}
