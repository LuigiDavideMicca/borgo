import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { API_RETRIES, makeApiClient } from "./api";
import {
  buildAssets,
  buildReasons,
  compileCss,
  needsBuild,
  readAssetNames,
  readBuildOutputs,
  reportBuildFailure,
} from "./build";
import { banner, c, fmtMs, g, statusColor } from "./colors";
import {
  buildAssetIndex,
  findAsset,
  inHiddenDirectory,
  jsonResponse,
  serveAsset,
  serveIndexed,
  type AssetInfo,
} from "./compress";
import { registerCsrf, registerIslands } from "./internal";
import { createMetrics } from "./metrics";
import { overlayHtml } from "./overlay";
import { matchRoute, safeDecode, type Route } from "./router";
import {
  apiCsrfRejects,
  bodyTooLarge,
  createKeepWarm,
  csrfRejects,
  decodeChanged,
  headResponse,
  isForwarded,
  isUpstream,
  keepWarmSeconds,
  limitRequestBody,
  prepareShell,
  proxyRequest,
  pushAuthorized,
  readTimeout,
  readTimeoutNotice,
  renderPage as renderDocument,
  requestFullyRead,
  resolveSwitches,
  runAction,
  runPropsRequest,
  topicRejection,
  wsOriginAllowed,
  type ActionOptions,
  type PropsOptions,
  type RenderPageOptions,
  type Switches,
} from "./util";

// react from the app, not from this package: with a linked borgo checkout
// the two would be different copies and hooks would break
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

// the path of this machine must not leave it inside a document: a page is
// rendered from source, so `import.meta.url` is a `file://` url and
// `import.meta.dir` an absolute directory, and react's own preload link, an
// attribute, rendered text, `_500.tsx` and a `hydrate = false` page all carry
// it past what `borgo build` refuses. REDACT, NOT REFUSE: the shell's opening
// bytes are already on the wire when a leaking chunk exists, so a 500 is not
// available, and rewriting a byte sequence that IS the root cannot break a
// healthy page. only the unambiguous spellings: the `file://` url, and on
// windows the drive-lettered root with either separator. on linux the root
// (`/app`) is textually a root-relative url, so it is left alone and named as
// a limit; `import.meta.dir` concatenation is refused at build time instead.
// json doubles every backslash, so `C:\\srv\\app` on the wire is the same
// disclosure the native needle cannot see: the escaped form is a needle of its own
const REDACTED = "[redacted]";

export function localPathNeedles(root: string, platform: string = process.platform): string[] {
  if (!root) return [];
  const needles: string[] = [];
  // a drive-lettered root is not a url in either separator spelling; a posix one is
  if (platform === "win32") {
    needles.push(root, root.replaceAll("\\", "/"));
    const json = JSON.stringify(root).slice(1, -1);
    if (json !== root) needles.push(json);
  }
  // the file:// url only when one of those is not already inside it:
  // `file:///C:/x/y` carries `C:/x/y`, and scanning twice is a third of the
  // per-response cost. a root that percent-encodes (a space) is its own needle
  const fileUrl = pathToFileURL(root).href;
  if (!needles.some((n) => fileUrl.includes(n))) needles.push(fileUrl);
  return [...new Set(needles)].filter((n) => n.length > 0);
}

// streaming: a needle can straddle two chunks, so the last bytes of one are
// held back until the next arrives. the healthy path allocates nothing beyond
// a window of twice the longest needle: a chunk with no match is yielded as a
// subarray of what react produced, never a copy
export async function* redactLocalPaths(
  source: AsyncIterable<Uint8Array>,
  needles: readonly string[],
  onFound?: () => void,
): AsyncIterable<Uint8Array> {
  if (!needles.length) {
    yield* source;
    return;
  }
  const patterns = needles.map((n) => Buffer.from(n, "utf8"));
  // a needle plus the byte after it, which decides root or a name that begins like it
  const overlap = Math.max(...patterns.map((p) => p.length));

  // whether the held bytes could begin a needle whose end is in the chunk that
  // just arrived; almost always false, and then nothing is copied. only the
  // positions where the needle's first byte occurs are tried: walking every
  // suffix length with `Buffer.compare` cost 137 us per 4 kB chunk, twenty
  // times the scan it was protecting
  const straddles = (tail: Buffer): boolean => {
    for (const pattern of patterns) {
      for (let at = tail.indexOf(pattern[0]); at !== -1; at = tail.indexOf(pattern[0], at + 1)) {
        const k = Math.min(tail.length - at, pattern.length);
        if (tail.subarray(at, at + k).equals(pattern.subarray(0, k))) return true;
      }
    }
    return false;
  };

  const scrub = (buf: Buffer, atEnd: boolean) => scrubRoots(buf, patterns, atEnd);

  let carry: Buffer | null = null;
  for await (const chunk of source) {
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let work = bytes;
    if (carry) {
      if (straddles(carry)) work = Buffer.concat([carry, bytes]);
      else yield carry;
      carry = null;
    }
    const cleaned = scrub(work, false);
    if (cleaned) {
      onFound?.();
      work = cleaned;
    }
    if (work.length > overlap) {
      yield work.subarray(0, work.length - overlap);
      // copied, not viewed: a view would hold the whole rendered chunk alive for forty bytes
      carry = Buffer.from(work.subarray(work.length - overlap));
    } else {
      carry = Buffer.from(work);
    }
  }
  if (carry?.length) {
    // the end of the document is a name boundary like any separator
    const cleaned = scrub(carry, true);
    if (cleaned) onFound?.();
    yield cleaned ?? carry;
  }
}

// the same needles and the same name boundary as the stream, so a document
// and the json beside it cannot disagree about what the root is. the healthy
// path allocates nothing: a string search per needle
export function redactLocalPathText(
  text: string,
  needles: readonly string[],
  onFound?: () => void,
): string {
  if (!text || !needles.some((n) => text.includes(n))) return text;
  const cleaned = scrubRoots(
    Buffer.from(text, "utf8"),
    needles.map((n) => Buffer.from(n, "utf8")),
    true,
  );
  if (!cleaned) return text;
  onFound?.();
  return cleaned.toString("utf8");
}

// the props and the action envelope leave as json, so the same needles run
// over the serialised text; a clean value is handed back as the same object.
// jsonResponse pays the serialisation again: accepted over teaching compress.ts
// a second entry point
export function redactJsonValue(value: unknown, needles: readonly string[], onFound?: () => void): unknown {
  if (!needles.length) return value;
  let found = false;
  const cleaned = redactLocalPathText(JSON.stringify(value), needles, () => (found = true));
  if (!found) return value;
  onFound?.();
  return JSON.parse(cleaned);
}

const REPLACEMENT = Buffer.from(REDACTED, "utf8");

function scrubRoots(buf: Buffer, patterns: readonly Buffer[], atEnd: boolean): Buffer | null {
  let out: Buffer | null = null;
  for (const pattern of patterns) {
    const subject = out ?? buf;
    if (subject.indexOf(pattern) === -1) continue;
    const replaced = replaceRoots(subject, pattern, REPLACEMENT, atEnd);
    if (replaced) out = replaced;
  }
  return out;
}

// a byte that can continue a file name separates the root from a directory
// that merely begins like it: with the root `C:\srv\borgo\app`, a page showing
// `C:\srv\borgo\application` came out as `[redacted]lication`
const nameByte = (b: number): boolean =>
  (b >= 0x30 && b <= 0x39) || // 0-9
  (b >= 0x41 && b <= 0x5a) || // A-Z
  (b >= 0x61 && b <= 0x7a) || // a-z
  b === 0x2e || // .
  b === 0x5f || // _
  b === 0x2d || // -
  b === 0x25 || // % - a percent-encoded byte continues the name in a file url
  b >= 0x80; // anything non-ascii is a name character somewhere

// Buffer has no split; reached only by a chunk that really carries the root
function replaceRoots(
  buf: Buffer,
  pattern: Buffer,
  glue: Buffer,
  atEnd: boolean,
): Buffer | null {
  const pieces: Buffer[] = [];
  let from = 0;
  let hit = false;
  for (;;) {
    const at = buf.indexOf(pattern, from);
    if (at === -1) break;
    const after = at + pattern.length;
    const bounded = after === buf.length ? atEnd : !nameByte(buf[after]);
    if (!bounded) {
      // copied through untouched, and the search resumes past this one
      pieces.push(buf.subarray(from, after));
      from = after;
      continue;
    }
    hit = true;
    pieces.push(buf.subarray(from, at), glue);
    from = after;
  }
  if (!hit) return null;
  pieces.push(buf.subarray(from));
  return Buffer.concat(pieces);
}

// each topic is a subscription table entry held for the life of the socket
export const MAX_WS_TOPICS = 32;
export const MAX_WS_TOPIC_LENGTH = 128;

// the only words the caller will ever get: a refused handshake carries no
// status and no body to the client (bun: close 1002 "Expected 101 status
// code"; browser: 1006, empty reason), so this sentence and the log line
// beside it are the two places the cause exists. both caps named when both
// hold, or fixing one comes straight back on the other; the topic is
// truncated because it is the client's own string, with its exact length stated
export function wsTopicRefusal(topics: string[]): string | null {
  const refusals: string[] = [];
  const overlong = topics.find((t) => t.length > MAX_WS_TOPIC_LENGTH);
  if (overlong !== undefined) {
    const shown = overlong.slice(0, 40);
    refusals.push(
      `topic ${JSON.stringify(shown)}${overlong.length > shown.length ? "..." : ""} is ` +
        `${overlong.length} characters, over the ${MAX_WS_TOPIC_LENGTH} a topic may have - shorten the name`,
    );
  }
  if (topics.length > MAX_WS_TOPICS) {
    refusals.push(
      `${topics.length} topics on one socket, over the ${MAX_WS_TOPICS} it accepts - ` +
        `subscribe to fewer, or spread them over more sockets`,
    );
  }
  return refusals.length ? refusals.join("; ") : null;
}

// a close frame, not a 403: a 403 on the handshake reaches a bun client as
// 1002 "Expected 101 status code" and a browser as 1006 with an empty reason,
// the same shape as a 400 and as a server that is down, so a misconfigured
// browser redialled every 30s for the life of the tab. a close frame reaches
// the client intact, with a reason naming the origin and the switch; the
// socket exists for one tick. every other refusal on /ws stays a 400: those
// are programming errors subscribe() refuses at the call site before the first
// dial, and the client treats exactly this code as final
export const WS_CLOSE_ORIGIN_REFUSED = 4403;
export function wsOriginRefusal(origin: string | null, host: string): string {
  return origin === null
    ? "no Origin header on the handshake: a non-browser client needs BORGO_WS_ALLOW_NO_ORIGIN=yes (wsAllowNoOrigin)"
    : `origin ${JSON.stringify(origin.slice(0, 80))} is not this server (${host}): /ws accepts the page's own origin only`;
}

// `switches` is resolved by the caller when one can do it earlier (serve-entry,
// above the try whose catch would otherwise serve a refused value from a bound
// port); the default still runs before anything here binds (resolveSwitches in util.ts)
export async function serve({
  dev = false,
  switches = resolveSwitches(process.env, dev),
}: { dev?: boolean; switches?: Switches } = {}) {
  const started = performance.now();
  let chunkMap: Record<string, string> = {};
  // every name the last build recorded: a production build names its outputs
  // after their content, and a tree missing any of them is rebuilt rather
  // than served as a document naming a file that is not there
  let assetNames = readAssetNames();
  if (needsBuild(dev, assetNames)) {
    // dev rebuilds on every boot, where a line per boot is noise
    const announce = !dev;
    if (announce) {
      const why = buildReasons(assetNames);
      console.log(`  ${c.terracotta(g.change)} ${why.join("; ")} ${c.dim("- building before serving")}`);
    }
    const buildStarted = performance.now();
    // serve() is exported: an app importing it never passes through the cli's
    // framing, and reported a raw trace with borgo's own comments quoted in it
    try {
      ({ chunkMap, names: assetNames } = await buildAssets(dev));
    } catch (error) {
      reportBuildFailure(error);
      throw error;
    }
    if (announce) {
      console.log(`  ${c.sage(g.ok)} built in ${c.bold(fmtMs(performance.now() - buildStarted))}`);
    }
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
  // resolved once: a build landing under a running server sweeps the files
  // this document names, so a rebuild needs a restart
  const shell = prepareShell(await Bun.file("index.html").text(), dev, assetNames);

  const port = Number(process.env.PORT || 3000);
  const api = process.env.API_URL || `http://localhost:${process.env.API_PORT || 3501}`;
  const apiUrl = `${api}/api`;

  // dev restarts the api on every .go edit, so a refused connection is routine
  // there; in production it means the api is down, and holding every request
  // piles connections up. ONE NUMBER for both hops: makeApiClient's own 15 meant
  // a loader spent four seconds on a call the proxy beside it had given up on.
  // BORGO_API_TIMEOUT is in ms, 0 disables it
  const apiRetries = dev ? 15 : API_RETRIES;
  const apiTimeout = switches.apiTimeout;
  // both the proxy and form actions buffer. BORGO_MAX_BODY (bytes) raises it,
  // 0 removes it. NOT handed to bun: `maxRequestBodySize: 0` means "no body at
  // all", and a declared body over the socket buffer had its connection dropped
  // with no response, where a 413 borgo writes itself was received in every
  // framing up to 100 MiB (bodyTooLarge in util.ts)
  const maxBody = switches.maxBody;

  // the browser's cookies go to go, so handlers see the session during ssr
  // and actions; set-cookie headers coming back are forwarded to the browser
  const apiFor = (req: Request, onSetCookie?: (cookies: string[]) => void) => {
    const cookie = req.headers.get("cookie");
    return makeApiClient(api, cookie ? { cookie } : {}, onSetCookie, apiRetries);
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

  // defaults and env switches are documented on createSecurity; resolveSwitches
  // owns WHEN they are read, before this function could bind anything
  const security = switches.security;
  const secure = (res: Response) => (security ? security.apply(res) : res);

  // csrf: one double-submit token, a cookie on rendered pages, echoed in a
  // hidden field by a page form action and in X-CSRF-Token by a proxied /api/*
  // call; a cross-site post can read neither. on by default in production, off
  // in dev, BORGO_CSRF decides either way
  const csrfEnforced = switches.csrfEnforced;
  // from the resolved set, not read at its one use below the listen: refusing
  // a value it cannot read has to happen before a port is bound
  const reloading = switches.reloading;
  const csrfCookieAttrs = switches.csrfCookieAttrs;

  // resolved once: a per-request process.cwd() is a syscall on every html
  // response, and the root cannot change under a running server
  const pathNeedles = localPathNeedles(process.cwd());
  // said once per page: a leak is a defect the operator fixes, and a line per visitor buries it
  const namedLeak = new Set<string>();
  const noteLeak = (where: string, how: string) => {
    if (namedLeak.has(where)) return;
    namedLeak.add(where);
    console.error(
      `  ${c.red(g.err)} ${where} ${how} the path of this machine ` +
        `${c.dim(`${g.dot} redacted before it was sent ${g.dot} borgo serves public/: put the file there and name it absolutely`)}`,
    );
  };
  const rendered = (file: string) => () => noteLeak(`pages/${file}`, "rendered into its document");

  const renderOptions: RenderPageOptions = {
    dev,
    shell,
    security,
    csrfCookieAttrs,
    runLoader,
    compose: composeElement,
    // replaced per render below, the only place the page being rendered is known
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
  ) =>
    renderDocument(
      req,
      route,
      params,
      status,
      {
        ...renderOptions,
        renderToStream: async (element, init) =>
          redactLocalPaths(
            (await renderToReadableStream(element, init)) as unknown as AsyncIterable<Uint8Array>,
            pathNeedles,
            rendered(route.file),
          ),
        redactText: (text) => redactLocalPathText(text, pathNeedles, rendered(route.file)),
      },
      extraProps,
      extraCookies,
    );

  // hashed build outputs cache forever, compressible types are served from the
  // .gz/.br siblings `borgo build` emitted; dev has no siblings and serves
  // identity. which names the build hashed is read once and handed to both
  // serving paths, so one url cannot be pinned by one and revalidated by the
  // other; read in dev too, where an unseen chunk name simply revalidates
  const buildOutputs = readBuildOutputs();
  const assetIndex: Map<string, AssetInfo> = dev
    ? new Map()
    : buildAssetIndex("public", undefined, buildOutputs);

  const sendJson = (req: Request, value: unknown, init?: ResponseInit) => {
    const clean = redactJsonValue(value, pathNeedles, () =>
      noteLeak(new URL(req.url).pathname, "answered with json carrying"),
    );
    return dev ? Response.json(clean, init) : jsonResponse(req, clean, init);
  };

  const actionOptions: ActionOptions = {
    dev,
    apiUrl,
    serverError,
    csrfRejects: (req) => csrfRejects(req, { enforced: csrfEnforced }),
    maxBody,
    apiFor,
    runLoader,
    renderPage,
    sendJson,
    renderOverlay: overlayHtml,
  };
  const propsOptions: PropsOptions = { runLoader, sendJson };

  // metrics wants the matched pattern as its label, from the one match a request already does
  type Label = { route: string };

  async function handle(req: Request, url: URL, label: Label): Promise<Response> {
    if (url.pathname.startsWith("/api/")) {
      label.route = "/api/*";
      // before the body is read: a refused request must cost go nothing
      if (apiCsrfRejects(req, { enforced: csrfEnforced })) {
        // borgo's own answer, left unmarked so the security headers land on it below
        return new Response("invalid csrf token", {
          status: 403,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      return proxyRequest(req, {
        target: api + url.pathname + url.search,
        deadlineMs: apiTimeout,
        retries: apiRetries,
        maxBody,
        // the one hop borgo can vouch for, appended to X-Forwarded-For
        clientIp: server.requestIP(req)?.address,
        // the body is entirely in hand by then, so the socket is the server's to
        // keep warm and the upstream gets as long as it needs
        onBodyRead: () => keepWarm.hold(req),
      });
    }

    // decoded form, so files with spaces or unicode resolve and traversal is
    // checked on what will be opened; on windows also ntfs alternate streams
    // (file.css::$DATA) and reserved characters, which alias a file under names
    // the path checks never saw. get/head only: a public/ file must not shadow a post
    if (req.method === "GET" || req.method === "HEAD") {
      const assetPath = safeDecode(url.pathname);
      if (
        assetPath !== "/" &&
        !assetPath.includes("..") &&
        !assetPath.includes("\\") &&
        !assetPath.includes("\0") &&
        !inHiddenDirectory(assetPath) &&
        (process.platform !== "win32" || !/[:*?"<>|]/.test(assetPath))
      ) {
        const indexed = findAsset(assetIndex, assetPath);
        if (indexed) return serveIndexed(req, indexed);
        const path = "public" + assetPath;
        const asset = Bun.file(path);
        if (await asset.exists()) {
          return serveAsset(req, path, asset, { dev, outputs: buildOutputs });
        }
      }
    }

    if (req.method === "POST") {
      const target = matchRoute(url.pathname, routes);
      if (target) label.route = target.route.pattern;
      const answered = await runAction(req, target, actionOptions);
      if (answered) return answered;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      // a post only gets this far when the page has no action
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

  // /healthz always answers, /metrics appears with BORGO_METRICS=1; both stay
  // out of the request log, the metrics and any compression
  const bootTime = Date.now();
  const metrics = switches.metrics ? createMetrics(bootTime) : null;

  // /healthz answers anyone: a flood of probes must not become a flood against
  // the api, so the promise itself is shared for a second, or a concurrent
  // burst would all miss the cache together
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

  // dev channel: a fresh boot after a code change greets browsers with the
  // changed files and the new page -> chunk map
  const devSockets = new Set<import("bun").ServerWebSocket<SocketData>>();
  const bootStamp = Date.now();
  const changed = decodeChanged(process.env.BORGO_CHANGED);
  const broadcast = (msg: Record<string, unknown>) => {
    const data = JSON.stringify(msg);
    for (const ws of devSockets) ws.send(data);
  };

  // a refusal names the value it refused, and states its own type
  const badRequest = (why: string) =>
    new Response(why, { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });

  // "refused" lives for one tick: wsOriginRefusal above says why it is not a 403
  type SocketData =
    | { kind: "dev" }
    | { kind: "app"; topics: string[] }
    | { kind: "refused"; reason: string };
  const wsTopic = (topic: string) => "borgo:ws:" + topic;
  const publishCount = (topic: string) => {
    server.publish(
      wsTopic(topic),
      JSON.stringify({ topic, event: "__count", data: server.subscriberCount(wsTopic(topic)) }),
    );
  };
  // said once: a refused pusher can retry as fast as it likes
  let warnedPushKey = false;
  const warnHalfConfiguredPushKey = () => {
    if (warnedPushKey) return;
    warnedPushKey = true;
    console.error(
      `  ${c.red(g.err)} a push arrived with X-Borgo-Key but BORGO_PUSH_KEY is not set on the front server ` +
        `${c.dim(`${g.dot} refusing rather than falling back to the loopback rule - set it on both halves`)}`,
    );
  };

  // a dev restart can try to bind before the os releases the previous port
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

  // BEFORE Bun.serve: bun is listening the instant it returns, and a request
  // in the gap would reach a `keepWarm` in its temporal dead zone and answer
  // 500; `server` is reached through closures, which run only for a request.
  // keepWarmSeconds returns 0, and this goes inert, when there is no deadline
  // or one too tight for bun's 4s wheel to re-arm
  const keepWarm = createKeepWarm(() => server, keepWarmSeconds(process.env));
  // before the banner: it is about a value the operator set and borgo did not honour verbatim
  const timeoutNotice = readTimeoutNotice(process.env);
  if (timeoutNotice) console.error(`  ${c.red(g.err)} ${timeoutNotice}`);

  const server = await bindRetry(() => Bun.serve<SocketData, never>({
    port,
    // bun's ceiling is out of the way and borgo counts instead: every body read
    // in this process goes through a counter (`runAction`, `proxyRequest`, the
    // `/__borgo/publish` read below), and body-limit.test.ts fails the build
    // if a fourth appears without one. raising this is safe only while that holds
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    // how long bun waits for a *request* to arrive, nothing else: an in-flight
    // response is kept warm by re-arming, never by disarming (readTimeout in
    // util.ts). BORGO_FRONT_READ_TIMEOUT is in seconds, 0 disables it, and is
    // the front server's alone: go reads every other timeout name as a duration
    idleTimeout: readTimeout(process.env),
    // bun's fallback error page embeds a base64 payload that decodes to the
    // absolute path of the file, and `development` is on by default since
    // `borgo start` in a plain shell leaves NODE_ENV unset. this is the net
    // under everything the handler never sees, a body failing mid-stream above all
    development: false,
    error(error) {
      console.error(error);
      return secure(
        new Response("internal server error", {
          status: 500,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }),
      );
    },
    websocket: {
      // websockets have their own deadline and bun pings them itself
      idleTimeout: 120,
      // every message is relayed to every subscriber: bun's 16mb default would
      // make one socket a broadcast amplifier
      maxPayloadLength: 1024 * 1024,
      open(ws) {
        if (ws.data?.kind === "refused") {
          ws.close(WS_CLOSE_ORIGIN_REFUSED, ws.data.reason);
          return;
        }
        if (ws.data?.kind === "app") {
          for (const topic of ws.data.topics) ws.subscribe(wsTopic(topic));
          for (const topic of ws.data.topics) publishCount(topic);
          return;
        }
        devSockets.add(ws);
        if (changed.length) {
          // the whole set: a browser told about one file of a two-file save may
          // be told about the one it is not showing, and applies nothing
          ws.send(
            JSON.stringify({ type: "js", files: changed, chunks: chunkMap, stamp: bootStamp }),
          );
        }
      },
      close(ws) {
        if (ws.data?.kind === "refused") return;
        if (ws.data?.kind === "app") {
          const topics = ws.data.topics;
          setTimeout(() => topics.forEach(publishCount), 0);
          return;
        }
        devSockets.delete(ws);
      },
      // clients may publish to topics they are subscribed to, relayed verbatim
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
      // a request with no body is entirely in hand (bun calls fetch once headers
      // are in), so from here on whatever the response does is the server working.
      // held before any handler runs: a handler slower than the deadline is one
      // of the things protected. HELD, never disarmed: `server.timeout(req, 0)`
      // left the connection with no deadline for life, and a finite ceiling was
      // inherited by the next unfinished request on the same socket (a dribble
      // after one complete GET survived to 256.4s against bun's own 12.0s).
      // readTimeout in util.ts owns the argument
      if (requestFullyRead(req)) keepWarm.hold(req);
      // heads render for real, only the body is dropped and cancelled, or the
      // ssr/gzip pipeline keeps rendering into a stream nobody reads
      const dropBody = (res: Response) => headResponse(req.method, res);

      // browsers attach cookies to ws handshakes from any origin, so a
      // cross-origin page must not join (or publish into) topics
      if (url.pathname === "/ws") {
        // scheme AND host, and no Origin at all is a refusal (wsOriginAllowed in util.ts)
        const allowed = wsOriginAllowed({
          origin: req.headers.get("origin"),
          host: url.host,
          proto: url.protocol.replace(":", ""),
          forwardedProto: req.headers.get("x-forwarded-proto"),
          allowNoOrigin: switches.wsAllowNoOrigin,
        });
        if (!allowed) {
          const why = wsOriginRefusal(req.headers.get("origin"), url.host);
          console.error(`  ${c.red(g.err)} /ws refused: ${why}`);
          if (server.upgrade(req, { data: { kind: "refused", reason: why } })) return undefined as never;
          return secure(new Response("forbidden", { status: 403 }));
        }
        // split on the ENCODED comma: searchParams decodes %2C first, and one
        // topic named "a,b" became two, a socket that upgrades and delivers nothing
        const raw = url.search.slice(1).split("&").find((p) => p.startsWith("topics="))?.slice(7) ?? "";
        const topics: string[] = [];
        for (const part of raw.split(",")) {
          let topic: string;
          try {
            topic = decodeURIComponent(part.replaceAll("+", " ")).trim();
          } catch {
            // the part itself, truncated: WHICH of the topics on the wire would not decode
            const why = `topics is not a decodable query value: ${JSON.stringify(part.slice(0, 40))}`;
            console.error(`  ${c.red(g.err)} /ws refused: ${why}`);
            return secure(badRequest(why));
          }
          if (!topic) continue;
          const rejected = topicRejection(topic);
          if (rejected) {
            // logged: the browser reports "connection closed", which names nothing
            console.error(`  ${c.red(g.err)} /ws refused: ${rejected}`);
            return secure(badRequest(rejected));
          }
          topics.push(topic);
        }
        // logged: a refused handshake reaches the browser as "connection closed"
        // with no status and no body, so a silent 400 is a cause nobody can read
        const refusal = wsTopicRefusal(topics);
        if (refusal) {
          console.error(`  ${c.red(g.err)} /ws refused: ${refusal}`);
          return secure(badRequest(refusal));
        }
        if (server.upgrade(req, { data: { kind: "app", topics } })) return undefined as never;
        return secure(new Response("upgrade required", { status: 426 }));
      }

      // go -> browser push: accepted from loopback (or with the shared key)
      if (req.method === "POST" && url.pathname === "/__borgo/publish") {
        // without a key, loopback-only: behind a local reverse proxy every
        // external request arrives from 127.0.0.1, so a forwarded one is rejected too
        const verdict = pushAuthorized({
          key: process.env.BORGO_PUSH_KEY,
          presented: req.headers.get("x-borgo-key"),
          address: server.requestIP(req)?.address,
          // presence, not the value: `x-forwarded-for ?? forwarded` read an empty
          // X-Forwarded-For as "nothing forwarded this" and swallowed a real Forwarded
          forwarded: isForwarded(req.headers),
        });
        if (verdict === "half-configured") warnHalfConfiguredPushKey();
        if (verdict !== "ok") return secure(new Response("forbidden", { status: 403 }));
        // `req.json()` buffers whatever arrives: an authorized pusher is a process
        // on the box or anything holding the key, neither a reason for an unbounded body
        const limited = await limitRequestBody(req, maxBody);
        if (limited === null) return secure(bodyTooLarge(maxBody));
        const msg = await limited.json().catch(() => null);
        if (!msg || typeof msg.topic !== "string" || typeof msg.event !== "string") {
          return secure(new Response("bad request", { status: 400 }));
        }
        // a topic no subscriber can ever name is a message dropped with a 204 on it
        const rejected = topicRejection(msg.topic);
        if (rejected) {
          console.error(`  ${c.red(g.err)} /__borgo/publish refused: ${rejected}`);
          return secure(badRequest(rejected));
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
        // the client is already gone: building the 500 document (loader, api
        // round trip, render) is work for nobody, and a client that declares a
        // long body and hangs up would buy one per packet. 499 is nginx's
        // "client closed request": nothing ships, the counter stays honest
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
      // authorship, not path: a path test for /api would also exempt every answer
      // borgo wrote on it (the 403 above, the 502, the 504), which went out bare.
      // asked before dropBody, which builds a new response for a HEAD
      const fromApi = isUpstream(response);
      response = dropBody(response);
      if (metrics && !url.pathname.startsWith("/assets/") && url.pathname !== "/favicon.ico") {
        metrics.observe(label.route, response.status, (performance.now() - t0) / 1000);
      }
      if (dev) logRequest(req, url.pathname, response.status, performance.now() - t0);
      return fromApi ? response : secure(response);
    },
  }));

  const ready = performance.now() - started;
  if (reloading) {
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
