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

/**
 * THE PATH OF THIS MACHINE MUST NOT LEAVE IT INSIDE A DOCUMENT.
 *
 * A page is rendered from source, so `import.meta.url` in it is a `file://` url
 * and `import.meta.dir` an absolute directory. Measured against a real
 * production build (`dev: false`) and borgo's own front server, one page
 * carrying `new URL("./probe.png", import.meta.url).href` and
 * `import.meta.dir + "/probe.png"` served this to anyone who asked:
 *
 *   <link rel="preload" as="image" href="file:///C:/Users/.../pages/probe.png"/>
 *   <img id="a" src="file:///C:/Users/.../pages/probe.png"/>
 *   <img id="b" src="C:\Users\...\pages/probe.png"/>
 *   <p id="d">file:///C:/Users/.../pages/index.tsx</p>
 *
 * - four routes into one document: an attribute, react's own auto-emitted
 * preload link, rendered text, and the same again on `_500.tsx` and on a
 * `hydrate = false` page, neither of which is in any emitted bundle. In a
 * container that string is the image's layout instead.
 *
 * `borgo build` refuses this channel now, and that is the repair; this is the
 * net under the cases a build cannot read - a page that never enters the client
 * bundle, a helper module, a path a component computes at runtime.
 *
 * REDACT, NOT REFUSE, AND THE DIRECTION IS THE REASON. This sits on every html
 * response in production. By the time a leaking chunk exists the shell's opening
 * bytes are already on the wire, so a 500 is not available - and turning a page
 * that is visible today into one that is not, over a string, is the wrong way
 * for a guard on this path to be wrong. Rewriting a byte sequence that IS the
 * server's own root path cannot break a healthy page: nothing else can contain
 * it.
 *
 * WHICH SPELLINGS, AND WHY NOT ALL OF THEM. Only the unambiguous ones: the
 * `file://` url of the root, and - on windows only - the root with native
 * separators and with forward ones, both of which start with a drive letter and
 * a colon and so can never be a url path. On linux the root is a bare absolute
 * path like `/app`, which is textually a perfectly good root-relative url:
 * redacting that would rewrite legitimate links, so it is left alone and named
 * as a limit. What produces it there - `import.meta.dir` concatenation - is
 * refused at build time instead.
 *
 * AND THE JSON SPELLING, WHICH IS WHERE THE PROPS GO. A loader's return travels
 * as json - window.__PROPS__, the ?__borgo=props answer, the action envelope,
 * an island's data-borgo-props attribute - and json doubles every backslash, so
 * `C:\\srv\\borgo\\app` on the wire is the same disclosure and the native needle
 * cannot see it. Measured on a served page: __PROPS__ carried the root in both
 * spellings while the stream around it was redacted. The escaped form is a
 * needle of its own, and the same text scan runs on the props json, on the
 * head a page computes from them, and on every json answer.
 */
const REDACTED = "[redacted]";

export function localPathNeedles(root: string, platform: string = process.platform): string[] {
  if (!root) return [];
  const needles: string[] = [];
  // a drive-lettered root is not a url in either separator spelling; a posix
  // one is, so it contributes nothing here
  if (platform === "win32") {
    needles.push(root, root.replaceAll("\\", "/"));
    const json = JSON.stringify(root).slice(1, -1);
    if (json !== root) needles.push(json);
  }
  // and the file:// url only when it is not already spelled by one of those:
  // `file:///C:/x/y` carries `C:/x/y` inside it, so scanning for it twice is a
  // third of the per-response cost spent on nothing. A root that percent-encodes
  // (a space in the path) is not carried, and then it is its own needle.
  const fileUrl = pathToFileURL(root).href;
  if (!needles.some((n) => fileUrl.includes(n))) needles.push(fileUrl);
  return [...new Set(needles)].filter((n) => n.length > 0);
}

/**
 * The rendered markup with every occurrence of those needles replaced.
 *
 * Streaming, so a needle can straddle two chunks and the last bytes of one are
 * held back until the next arrives. The healthy path allocates nothing beyond a
 * window of twice the longest needle: a chunk with no match is yielded as a
 * subarray of the bytes react produced, never a copy, and only a chunk that
 * really carries the path is rebuilt.
 */
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
  // a needle plus the byte after it, which decides whether the match is the
  // root or only a name that begins like it
  const overlap = Math.max(...patterns.map((p) => p.length));

  // whether the bytes held back could be the beginning of a needle whose end is
  // in the chunk that just arrived. Almost always false, and while it is false
  // nothing is copied: the held bytes go out as they are and the new chunk is
  // scanned where react wrote it.
  //
  // Only the positions where the needle's first byte actually occurs are
  // tried. The first shape of this walked every suffix length with
  // `Buffer.compare`'s five-argument form and cost 137 us per 4 kB chunk -
  // twenty times the scan it was protecting.
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
      // copied, not viewed: a view would hold the whole rendered chunk alive
      // for the sake of forty bytes
      carry = Buffer.from(work.subarray(work.length - overlap));
    } else {
      carry = Buffer.from(work);
    }
  }
  if (carry?.length) {
    // the end of the document is a name boundary like any separator, and this
    // is the only place that can know it has been reached
    const cleaned = scrub(carry, true);
    if (cleaned) onFound?.();
    yield cleaned ?? carry;
  }
}

/**
 * The same redaction on a string that is whole before it is sent: the props
 * json, the head computed from the props, a json answer. One criterion for
 * both halves - the same needles, the same name boundary, through the same
 * replaceRoots - so a document and the json beside it cannot disagree about
 * what the root is.
 *
 * The healthy path allocates nothing: a string search per needle, and only a
 * text that really carries one is copied into bytes and rebuilt.
 */
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

/**
 * The props and the action envelope leave as json, outside the render's
 * stream, so the same needles run over the serialised text. A clean value is
 * handed back as the very same object; only one that really carries the root
 * is re-read from its redacted text. That serialisation is the healthy path's
 * whole cost, and jsonResponse pays it again: measured, and accepted over
 * teaching compress.ts a second entry point.
 */
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

/**
 * A BYTE THAT CAN CONTINUE A FILE NAME, WHICH IS WHAT SEPARATES THE ROOT FROM A
 * DIRECTORY THAT MERELY BEGINS LIKE IT.
 *
 * Found by the healthy-page test and not by reasoning: with the root
 * `C:\srv\borgo\app`, a documentation page showing `C:\srv\borgo\application`
 * came out as `[redacted]lication`. A guard on the path of every html response
 * that mangles a page about paths is exactly the failure this whole design is
 * arranged to avoid, so a match counts only when what follows it cannot be more
 * of the same name.
 */
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

/**
 * A DOT-DIRECTORY ANYWHERE ABOVE THE FILE, WHICH compress.ts CANNOT SEE.
 *
 * isHiddenAsset refuses a hidden last segment and declares the other half:
 * public/.git/config stayed servable, because a directory can only be judged
 * against the url's root, and the root is known here. Measured on borgo's own
 * front server before this: /.git/config and /.svn/entries answered 200 on
 * both roads, the boot index and the live fallback.
 *
 * .well-known is exempt as the FIRST segment only. rfc 8615 defines a
 * well-known uri as one whose path begins with /.well-known/, so a nested one
 * is not the standard's; and it is exact, not folded, because the rfc's paths
 * are case-sensitive and every acme client writes it lower-case. The renewal
 * that fails is an expired certificate, which is the worse direction, so the
 * root tree is asserted to pass before anything is asserted to fail.
 */
export function inHiddenDirectory(assetPath: string): boolean {
  const segments = assetPath.split("/");
  for (let i = 1; i < segments.length - 1; i++) {
    const s = segments[i];
    if (s.startsWith(".") && !(i === 1 && s === ".well-known")) return true;
  }
  return false;
}

// each topic is a subscription table entry held for the life of the socket:
// unbounded counts or names are cheap resident memory for anyone who can open
// one.
export const MAX_WS_TOPICS = 32;
export const MAX_WS_TOPIC_LENGTH = 128;

/**
 * WHY THE UPGRADE IS REFUSED, IN THE ONLY WORDS THE CALLER WILL EVER GET.
 *
 * Both caps used to be refused under one sentence - "too many topics" - which
 * was false for the length one: a single 129-character topic was blamed for a
 * count the request did not have. Neither said anything to the log, unlike the
 * comma refusal beside it. A refused handshake does not carry its status to the
 * client that asked for it: measured against this server with a bun client, a
 * non-101 answer arrives as close code 1002 "Expected 101 status code" and
 * nothing else - no status, no body - and the spec gives a browser 1006 with an
 * empty reason for the same shape. So this sentence and the log line beside it
 * are the only two places the cause exists at all.
 *
 * Both are named when both hold: fixing the length alone would come straight
 * back on the count, and the second round trip is the whole cost of one bad
 * sentence. The topic is truncated because it is the client's own string - a
 * megabyte of it goes into a log line otherwise - and the exact length is
 * stated beside it, which is the number the caller has to measure against.
 */
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

// `switches` is resolved by whoever called us when there is a caller that can
// resolve it earlier - serve-entry does, above the try whose catch would
// otherwise serve a refused value from a bound port. The default is for the
// entry points with no fallback (`borgo start`, `borgo export`); it still runs
// before anything here binds, and resolveSwitches in util.ts carries the
// argument for why "before a port is bound" has to mean every switch.
export async function serve({
  dev = false,
  switches = resolveSwitches(process.env, dev),
}: { dev?: boolean; switches?: Switches } = {}) {
  const started = performance.now();
  let chunkMap: Record<string, string> = {};
  // every name the last build recorded, not a fixed one: a production build
  // names its outputs after their content, and a tree missing any of them is
  // rebuilt rather than served as a document naming a file that is not there
  let assetNames = readAssetNames();
  if (needsBuild(dev, assetNames)) {
    // fails towards saying too much and towards the cause it verified. dev
    // rebuilds on every boot, where a line per boot is noise the ready time
    // already accounts for
    const announce = !dev;
    if (announce) {
      const why = buildReasons(assetNames);
      console.log(`  ${c.terracotta(g.change)} ${why.join("; ")} ${c.dim("- building before serving")}`);
    }
    const buildStarted = performance.now();
    // the cli frames a build failure, but serve() is exported and an app that
    // imports it never passes through that wrapper - so it reported the same
    // failure as a raw trace with borgo's own comments quoted in it
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
  // resolved once: a build landing under a running server leaves this document
  // naming files that build has already swept, so a rebuild needs a restart
  const shell = prepareShell(await Bun.file("index.html").text(), dev, assetNames);

  const port = Number(process.env.PORT || 3000);
  const api = process.env.API_URL || `http://localhost:${process.env.API_PORT || 3501}`;
  const apiUrl = `${api}/api`;

  // outbound limits towards go. dev restarts the api on every .go edit, so a
  // refused connection is routine there and worth waiting out; in production
  // it means the api is down, and holding every request for four seconds only
  // piles connections up. ONE NUMBER for both hops - the proxy and the typed
  // client dial the same process, and makeApiClient's own 15 meant a loader
  // spent four seconds on a call the proxy beside it had already given up on.
  // BORGO_API_TIMEOUT is in ms, 0 disables it.
  const apiRetries = dev ? 15 : API_RETRIES;
  const apiTimeout = switches.apiTimeout;
  // a body nobody bounded is free memory for anyone who can post: both the
  // proxy and form actions buffer. BORGO_MAX_BODY (bytes) raises it, 0 removes
  // it. It is NOT handed to bun any more - `limitRequestBody` and the proxy's
  // counting pass-through enforce it, and the doc comment on bodyTooLarge in
  // util.ts carries the measurements for why a cap on a *declared* length was
  // never one. Two of those measurements matter here in particular: bun reads
  // `maxRequestBodySize: 0` as "no body at all" rather than "no limit", so the
  // documented way to disable the limit disabled every POST instead; and a
  // declared body large enough to overflow the socket buffer had its
  // connection dropped with no response written, where a 413 borgo writes
  // itself was received in every framing up to 100 MiB.
  const maxBody = switches.maxBody;

  // the api client forwards the browser's cookies, so go handlers see the
  // session during ssr and in actions; set-cookie headers coming back from
  // go (login, logout) are collected and forwarded to the browser
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

  // the exact defaults, and the env switches, are documented on createSecurity;
  // resolveSwitches in util.ts owns WHEN they are read, which is before this
  // function - and before serve-entry's try - could bind anything
  const security = switches.security;
  const secure = (res: Response) => (security ? security.apply(res) : res);

  // csrf: one double-submit token, issued as a cookie on rendered pages and
  // required back on both unsafe paths - echoed in a hidden field by a page
  // form action, in the X-CSRF-Token header by a proxied /api/* call. a
  // cross-site post can read neither the cookie nor set the header. one flag
  // governs both: on by default in production, off by default in dev, and
  // BORGO_CSRF decides either way.
  const csrfEnforced = switches.csrfEnforced;
  // taken from the resolved set rather than read at its one use below the
  // listen: it is only the shape of the banner, but refusing a value it cannot
  // read has to happen before a port is bound, or the refusal arrives from a
  // server already serving. That was true of this one variable and false of the
  // other five, which is the defect resolveSwitches closes.
  const reloading = switches.reloading;
  const csrfCookieAttrs = switches.csrfCookieAttrs;

  // the needles are this process's own root, resolved once: a per-request
  // process.cwd() would be a syscall on the path of every html response, and
  // the root cannot change under a running server
  const pathNeedles = localPathNeedles(process.cwd());
  // said once per page, not once per request: a leak is a defect the operator
  // fixes, and a line per visitor buries it
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
    // replaced per render below, which is the only place the page being
    // rendered is known - the log line is worthless without it
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

  // static files: hashed build outputs cache forever, compressible types are
  // served from the .gz/.br siblings that `borgo build` emitted. dev has no
  // siblings (precompression is skipped) and serves identity.
  //
  // which of those names the build hashed is read once, here, and handed to
  // both serving paths - the boot index and the live lookup - so one url
  // cannot be pinned by one and revalidated by the other. Read in dev too: the
  // policy belongs to the url, not to the environment. A dev rebuild that
  // emits a chunk name this set has never seen simply revalidates it, which is
  // the harmless direction.
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

  // metrics wants the matched pattern as its label: handing it back from the
  // one match a request already does keeps the route table scanned once
  type Label = { route: string };

  async function handle(req: Request, url: URL, label: Label): Promise<Response> {
    if (url.pathname.startsWith("/api/")) {
      label.route = "/api/*";
      // before the body is read and before anything is proxied: a refused
      // request must cost go nothing and must not have been half-delivered
      if (apiCsrfRejects(req, { enforced: csrfEnforced })) {
        // borgo's own answer, not go's: it is left unmarked, so the security
        // headers land on it below, and it states its type rather than leaving
        // the framing to whatever default happens to be in effect
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
        // the body is entirely in hand by then - streamed or buffered - so
        // the socket is the server's to keep warm and the upstream gets as
        // long as it needs. nothing is disarmed and nothing is raised
        onBodyRead: () => keepWarm.hold(req),
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
  const metrics = switches.metrics ? createMetrics(bootTime) : null;

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

  // a refusal is only useful if it says which value was refused, and it states
  // its own type so nothing downstream has to guess at the framing
  const badRequest = (why: string) =>
    new Response(why, { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });

  type SocketData = { kind: "dev" } | { kind: "app"; topics: string[] };
  const wsTopic = (topic: string) => "borgo:ws:" + topic;
  const publishCount = (topic: string) => {
    server.publish(
      wsTopic(topic),
      JSON.stringify({ topic, event: "__count", data: server.subscriberCount(wsTopic(topic)) }),
    );
  };
  // said once, not per push: a refused pusher can retry as fast as it likes,
  // and the operator needs the line, not a flood of it
  let warnedPushKey = false;
  const warnHalfConfiguredPushKey = () => {
    if (warnedPushKey) return;
    warnedPushKey = true;
    console.error(
      `  ${c.red(g.err)} a push arrived with X-Borgo-Key but BORGO_PUSH_KEY is not set on the front server ` +
        `${c.dim(`${g.dot} refusing rather than falling back to the loopback rule - set it on both halves`)}`,
    );
  };

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

  // BEFORE Bun.serve, not after: bun is listening the instant it returns, and a
  // request that arrived in the gap would reach a `keepWarm` still in its
  // temporal dead zone and answer 500. The host reaches `server` through
  // closures instead, which only run once there is a request to run them for.
  // keepWarmSeconds returns 0 - and this whole thing goes inert - when there is
  // no deadline to keep warm against, or when the operator asked for one too
  // tight for bun's 4s wheel to re-arm.
  const keepWarm = createKeepWarm(() => server, keepWarmSeconds(process.env));
  // before the banner and before the first request, because it is about a value
  // the operator set and borgo did not honour verbatim
  const timeoutNotice = readTimeoutNotice(process.env);
  if (timeoutNotice) console.error(`  ${c.red(g.err)} ${timeoutNotice}`);

  const server = await bindRetry(() => Bun.serve<SocketData, never>({
    port,
    // bun's ceiling is out of the way and borgo counts instead. Every path in
    // this process that reads a request body goes through a counter -
    // `runAction`, `proxyRequest`, and the `/__borgo/publish` read below - and
    // `every request body borgo reads is counted` in body-limit.test.ts fails
    // the build if a fourth appears without one. That test is this line's
    // safety: raising bun's ceiling is only safe while that stays true.
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    // the inbound read deadline, and nothing else - how long bun waits for a
    // *request* to arrive. How long a *response* may live is a different clock
    // that this one is never disarmed for: an in-flight response is kept warm
    // by re-arming it, not by removing it. readTimeout in util.ts owns both
    // halves of that argument.
    // BORGO_FRONT_READ_TIMEOUT is in seconds, 0 disables it - and it is the
    // front server's alone, because go reads every other timeout name as a
    // duration and panics on what this side takes.
    idleTimeout: readTimeout(process.env),
    // bun's fallback error page embeds a base64 payload that decodes to the
    // absolute path of the file on the server, and it appears whenever
    // `development` is on - which it is by default, since `borgo start` in a
    // plain shell leaves NODE_ENV unset. borgo renders its own 500 (and its own
    // dev overlay) from the handler; this is the net under everything the
    // handler never sees, a body that fails mid-stream above all.
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
      // a request that carries no body and declared none is entirely in hand -
      // bun calls fetch only once the request line and headers are in - so from
      // here on nothing is left for a client to dribble at us, and whatever the
      // response does is the server working rather than a client holding a
      // socket. Held before any handler runs, because a handler slower than the
      // deadline is one of the things being protected.
      //
      // HELD, not lifted and not raised. The deadline is never disarmed: the
      // keep-warm re-arms a short one while the response is in flight and stops
      // when it is over. Both earlier designs bought this by weakening clock 1
      // for the whole connection - `server.timeout(req, 0)` left it with no
      // deadline at all for the rest of its life, and a finite ceiling was
      // inherited by the next unfinished request on the same socket (measured
      // at BORGO_FRONT_READ_TIMEOUT=8: a dribble after one complete GET
      // survived to 256.4s against bun's own 12.0s). readTimeout in util.ts
      // owns the argument; nothing here is touched for a request that ends
      // before the first sweep.
      if (requestFullyRead(req)) keepWarm.hold(req);
      // heads render for real (status and headers must be honest), only the
      // body is dropped - and cancelled, or the ssr/gzip pipeline keeps
      // rendering into a stream nobody reads
      const dropBody = (res: Response) => headResponse(req.method, res);

      // app websockets: /ws?topics=a,b subscribes the browser to topics.
      // browsers attach cookies to ws handshakes from any origin, so a
      // cross-origin page must not be able to join (or publish into) topics
      if (url.pathname === "/ws") {
        // scheme AND host, and no Origin at all is a refusal: wsOriginAllowed in
        // util.ts has the measurements for both halves
        const allowed = wsOriginAllowed({
          origin: req.headers.get("origin"),
          host: url.host,
          proto: url.protocol.replace(":", ""),
          forwardedProto: req.headers.get("x-forwarded-proto"),
          allowNoOrigin: switches.wsAllowNoOrigin,
        });
        if (!allowed) return secure(new Response("forbidden", { status: 403 }));
        // split on the ENCODED comma. searchParams decodes %2C first, and the
        // split then turned one topic named "a,b" into the two topics "a" and
        // "b" - a socket that upgrades, reports counts, and delivers nothing.
        // topicRejection in util.ts carries the measurement
        const raw = url.search.slice(1).split("&").find((p) => p.startsWith("topics="))?.slice(7) ?? "";
        const topics: string[] = [];
        for (const part of raw.split(",")) {
          let topic: string;
          try {
            topic = decodeURIComponent(part.replaceAll("+", " ")).trim();
          } catch {
            // the part itself, truncated: the sentence alone says nothing about
            // WHICH of the topics on the wire would not decode
            const why = `topics is not a decodable query value: ${JSON.stringify(part.slice(0, 40))}`;
            console.error(`  ${c.red(g.err)} /ws refused: ${why}`);
            return secure(badRequest(why));
          }
          if (!topic) continue;
          const rejected = topicRejection(topic);
          if (rejected) {
            // and said out loud: the handshake failure a browser reports is
            // "connection closed", which names nothing. The operator needs the
            // topic, once, here
            console.error(`  ${c.red(g.err)} /ws refused: ${rejected}`);
            return secure(badRequest(rejected));
          }
          topics.push(topic);
        }
        // the caps, said out loud and by their true cause - wsTopicRefusal
        // above carries the account. Logged like the comma refusal: a refused
        // handshake reaches the browser as "connection closed" with no status
        // and no body, so a silent 400 here is a cause nobody can read from
        // either end
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
        // without a key, loopback-only - but behind a local reverse proxy
        // every external request arrives from 127.0.0.1, so anything the
        // proxy forwarded (it stamps forwarding headers) is rejected too
        const verdict = pushAuthorized({
          key: process.env.BORGO_PUSH_KEY,
          presented: req.headers.get("x-borgo-key"),
          address: server.requestIP(req)?.address,
          // PRESENCE, not the value: `x-forwarded-for ?? forwarded` read an
          // empty X-Forwarded-For as "nothing forwarded this" AND swallowed a
          // real Forwarded behind it. isForwarded in util.ts has the three
          // measured spellings that turned a 403 into a 204
          forwarded: isForwarded(req.headers),
        });
        if (verdict === "half-configured") warnHalfConfiguredPushKey();
        if (verdict !== "ok") return secure(new Response("forbidden", { status: 403 }));
        // the third body read in this process, and the one bun's ceiling used
        // to be the only bound on: `req.json()` buffers whatever arrives, and
        // an authorized pusher is a process on the box or anything holding the
        // key - neither of which is a reason to accept an unbounded body
        const limited = await limitRequestBody(req, maxBody);
        if (limited === null) return secure(bodyTooLarge(maxBody));
        const msg = await limited.json().catch(() => null);
        if (!msg || typeof msg.topic !== "string" || typeof msg.event !== "string") {
          return secure(new Response("bad request", { status: 400 }));
        }
        // a topic no subscriber can ever name is not a push, it is a message
        // dropped with a 204 on it. refused where the pusher can still read why
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
      // AUTHORSHIP, NOT PATH. Asked before dropBody, which builds a new
      // response object for a HEAD and would otherwise lose the answer. The
      // /api exemption is "go stated its own headers"; written as a path test it
      // also exempted every answer BORGO produced on that path - the 403 above,
      // the 504 when go does not answer, the 502 when it cannot be reached -
      // and those went out bare (measured). isUpstream in util.ts carries the
      // account; the direction is that a response borgo wrote always carries
      // borgo's headers, wherever it was written.
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
