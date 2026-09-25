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
import { appEnvMetas, envRefusal } from "./env-app";
import { RENDER_ERRORED_HEADER, isrPolicyTable } from "./isr";
import { overlayHtml } from "./overlay";
import { answerForDoor, decidePage, resolvePageMiddleware } from "./page-middleware";
import { canonicalPath, matchRoute, safeDecode, type Route } from "./router";
import {
  csrfRejects,
  decodeChanged,
  headResponse,
  prepareShell,
  renderPage as renderDocument,
  resolveSwitches,
  INTERNAL_KEY_HEADER,
  internalKeyRejects,
  SHARED_RENDER_HEADER,
  BOOT_HEADER,
  ROUTES_PATH,
  sessionFrom,
  localsFrom,
  runAction,
  runPropsRequest,
  type ActionOptions,
  type PropsOptions,
  type RenderPageOptions,
  type Switches,
} from "./util";

// react's cjs entry chooses its build by NODE_ENV at the moment of require,
// and `borgo start` in a plain shell leaves NODE_ENV unset - which loaded the
// DEVELOPMENT react-dom into a production server. the default is NOT applied
// here: assigning process.env from module code is too late for the jsx
// transform bun may already have chosen for a page, and the mismatch is a
// render crash (`dispatcher.getOwner is not a function`: a jsxDEV-compiled
// layout meeting the production react-dom - measured, not theorised). only
// the LAUNCH environment is early enough, so `borgo start` re-execs with
// NODE_ENV=production when unset, in cli.ts, the same way it already does
// for BUN_CONFIG_MAX_HTTP_REQUESTS. an embedder calling serve() directly
// with a bare environment gets development react everywhere: slower, never
// incoherent.
//
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

// pathToFileURL reads the platform this process is running on unless told:
// asked bare, on linux a windows root comes back resolved against the cwd,
// `file:///home/you/app/C:%5Csrv%5Capp`, which matches nothing. The `windows`
// option answers for the platform the caller is reasoning about - honoured
// since bun 1.4, which is the floor; 1.3 ignored it, and this function used
// to build the other platform's shape by hand
function platformFileUrl(root: string, platform: string): string {
  return pathToFileURL(root, { windows: platform === "win32" }).href;
}

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
  const fileUrl = platformFileUrl(root, platform);
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

// `switches` is resolved by the caller when one can do it earlier (serve-entry,
// above the try whose catch would otherwise serve a refused value from a bound
// port); the default still runs before anything here binds (resolveSwitches in util.ts)
export async function serve({
  dev = false,
  switches = resolveSwitches(process.env, dev),
}: { dev?: boolean; switches?: Switches } = {}) {
  const started = performance.now();
  // the app's declared environment is checked before anything binds: a
  // missing or malformed variable refuses the boot naming every failure at
  // once, instead of surfacing at whichever request reads it first
  const refusal = envRefusal((await appEnvMetas()).metas);
  if (refusal) throw new Error(`borgo: ${refusal}`);
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
  const { routes, notFound, serverError, pageMiddleware } = (await import(manifest)) as {
    routes: Route[];
    notFound: Route | null;
    serverError: Route | null;
    // middleware.ts, or null; a manifest written before 0.30 has no such export
    pageMiddleware?: unknown;
  };
  // checked once, here: a middleware.ts that would guard nothing refuses the boot
  const pageMw = resolvePageMiddleware(pageMiddleware ?? null);
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

  // render mode: the public port is the go front's, this process binds
  // loopback and the api is the front's own loopback listener - written as
  // 127.0.0.1, not localhost, because a resolver that prefers ::1 would be
  // refused by a listener bound to the v4 address
  const render = switches.render;
  const port = render ? switches.renderPort : Number(process.env.PORT || 3000);
  const hostname = render ? "127.0.0.1" : undefined;
  const api =
    process.env.API_URL ||
    `http://${render ? "127.0.0.1" : "localhost"}:${process.env.API_PORT || 3501}`;
  const apiUrl = `${api}/api`;
  // what every call to the api carries besides the browser's cookies
  const apiDefaults: Record<string, string> = render ? { [INTERNAL_KEY_HEADER]: switches.internalKey } : {};

  // dev restarts the api on every .go edit, so a refused connection is routine
  // there; in production it means the api is down, and holding every request
  // piles connections up. This client's own 15 meant a loader spent four
  // seconds on a call that should have failed at once, on every request
  const apiRetries = dev ? 15 : API_RETRIES;
  // form actions buffer. BORGO_MAX_BODY (bytes) raises it,
  // 0 removes it. NOT handed to bun: `maxRequestBodySize: 0` means "no body at
  // all", and a declared body over the socket buffer had its connection dropped
  // with no response, where a 413 borgo writes itself was received in every
  // framing up to 100 MiB (bodyTooLarge in util.ts)
  const maxBody = switches.maxBody;

  // the browser's cookies go to go, so handlers see the session during ssr
  // and actions; set-cookie headers coming back are forwarded to the browser
  const apiFor = (req: Request, onSetCookie?: (cookies: string[]) => void) => {
    const cookie = req.headers.get("cookie");
    return makeApiClient(api, cookie ? { ...apiDefaults, cookie } : apiDefaults, onSetCookie, apiRetries);
  };

  const runLoader = (
    req: Request,
    route: Route,
    params: Record<string, string>,
    onSetCookie?: (cookies: string[]) => void,
  ) =>
    route.module.loader
      ? route.module.loader({
          request: req,
          params,
          api: apiFor(req, onSetCookie),
          apiUrl,
          session: sessionFrom(req, render),
          locals: localsFrom(req, render),
        })
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
    shared = false,
    // set when react's streaming onError fires: the caller that stores
    // shared copies must know the 200 it drained completed as a fallback
    failed?: { errored: boolean },
  ) =>
    renderDocument(
      req,
      route,
      params,
      status,
      {
        ...renderOptions,
        sharedRender: shared,
        ...(failed
          ? {
              onError: (error: unknown) => {
                failed.errored = true;
                (renderOptions.onError ?? console.error)(error);
              },
            }
          : {}),
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

  // production only, like the asset index: dev rebuilds under stable names
  // and a cached page would fight the reload the dev channel just asked for.
  // pages opt in with `export const revalidate`; everything else cannot tell
  // this exists. the build id keying the persisted copies is the hashed
  // output inventory: a new build writes new names, and every copy the old
  // one rendered is swept at boot rather than served against a new tree
  // the page policies the front reads once per boot of this process: which
  // pages it may share, for how long, under which tags. An invalid opt-in is
  // named here, once, in the process that imports the page module
  const policyTable = isrPolicyTable(
    routes,
    (line) => console.error(`  ${c.red(g.err)} ${line}`),
    (pattern) => pageMw?.guardsRoute(pattern) ?? false,
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
    sessionFor: (req) => sessionFrom(req, render),
    localsFor: (req) => localsFrom(req, render),
    runLoader,
    renderPage,
    sendJson,
    renderOverlay: overlayHtml,
  };
  const propsOptions: PropsOptions = { runLoader, sendJson };

  // the api is the go front's, in its own process: what reaches this one is
  // a page, a page's props, an action, an asset it still owns, or the dev
  // channel. /api arriving here at all would be the front forwarding what it
  // answers itself
  // what middleware.ts added with next({ headers }), applied in fetch to
  // whatever the page's door answered
  const middlewareHeaders = new WeakMap<Request, Record<string, string>>();

  async function handle(req: Request, url: URL): Promise<Response> {
    // decoded form, so files with spaces or unicode resolve and traversal is
    // checked on what will be opened; on windows also ntfs alternate streams
    // (file.css::$DATA) and reserved characters, which alias a file under names
    // the path checks never saw. get/head only: a public/ file must not shadow a post
    let probeLate: string | null = null;
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
        // a path with an extension is a file's name and keeps the probe here,
        // so /tasks/readme.txt beats the dynamic route it sits under - but an
        // extension-less path is almost always a page, and the disk stat it
        // paid on EVERY page request was 4.6% of the ssr profile. those probe
        // only after the router comes up empty, which also means a route now
        // beats an extension-less file of the same name (decided 9/9: the
        // shadowing was an operator mistake wearing a feature's clothes)
        if (/\.[^/]+$/.test(assetPath)) {
          const path = "public" + assetPath;
          const asset = Bun.file(path);
          if (await asset.exists()) {
            return serveAsset(req, path, asset, { dev, outputs: buildOutputs });
          }
        } else {
          probeLate = assetPath;
        }
      }
    }

    // middleware.ts, in front of all three doors a page has - the action
    // below, the props a client navigation fetches, the document - and of the
    // shared render the go front's cache asks for. A guard on two doors of
    // three is not a guard
    let pathname = url.pathname;
    if (pageMw) {
      const decision = await decidePage(pageMw, req, url, {
        session: sessionFrom(req, render),
        locals: localsFrom(req, render),
      });
      if (decision.kind === "respond") return answerForDoor(req, url, decision.response, sendJson);
      pathname = decision.pathname;
      if (Object.keys(decision.headers).length > 0) middlewareHeaders.set(req, decision.headers);
    }

    if (req.method === "POST") {
      const target = matchRoute(pathname, routes);
      const answered = await runAction(req, target, actionOptions);
      if (answered) return answered;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      // a post only gets this far when the page has no action
      return new Response("method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }

    const matched = matchRoute(pathname, routes);
    const wantsProps = url.searchParams.get("__borgo") === "props";

    if (!matched) {
      // the router came up empty: NOW the extension-less disk probe runs, so
      // a plain file in public/ that collides with no route is still served
      if (probeLate) {
        const path = "public" + probeLate;
        const asset = Bun.file(path);
        if (await asset.exists()) {
          return serveAsset(req, path, asset, { dev, outputs: buildOutputs });
        }
      }
      if (wantsProps) return sendJson(req, { notFound: true }, { status: 404 });
      if (notFound) return renderPage(req, notFound, {}, 404);
      return new Response("not found", { status: 404 });
    }

    if (wantsProps) {
      return runPropsRequest(req, matched.route, matched.params, propsOptions);
    }

    // the go front's cache asking for the copy it may share: the request
    // arrived anonymised, the render mints no csrf token, and the stream is
    // drained here so a suspense boundary that errored - which react
    // completes as a 200 serving its fallback - is marked before the front
    // asks its storability questions
    if (render && req.headers.get(SHARED_RENDER_HEADER) === "1") {
      const failed = { errored: false };
      const res = await renderPage(req, matched.route, matched.params, 200, undefined, [], true, failed);
      const html = await res.text();
      const headers = new Headers(res.headers);
      if (failed.errored) {
        headers.set(RENDER_ERRORED_HEADER, "a suspense boundary threw during the shared render");
      }
      return new Response(html, { status: res.status, headers });
    }

    return renderPage(req, matched.route, matched.params, 200);
  }

  // the go front asks this to report the render service as reachable; it
  // stays out of the request log, as it always did
  const bootTime = Date.now();
  const healthz = () => Response.json({ status: "ok", uptime: (Date.now() - bootTime) / 1000 });

  function logRequest(req: Request, path: string, status: number, ms: number) {
    if (path.startsWith("/assets/") || path === "/favicon.ico") return;
    const method = c.dim(req.method.padEnd(4));
    console.log(`  ${method} ${path.padEnd(24)} ${statusColor(status)(String(status))} ${c.dim(fmtMs(ms))}`);
  }

  const bootStamp = Date.now();
  // the dev channel is the go front's (dev_channel.go): a fresh boot after a
  // code change tells it the changed files and the new page -> chunk map,
  // and it greets every browser with them, the ones reconnecting included
  const changed = decodeChanged(process.env.BORGO_CHANGED);

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

  await bindRetry(() => Bun.serve({
    port,
    ...(hostname ? { hostname } : {}),
    // bun's ceiling is out of the way and borgo counts instead: every body
    // read in this process goes through a counter (`runAction`), and
    // body-limit.test.ts fails the build if another appears without one.
    // raising this is safe only while that holds
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    // no deadline: the only client of this process is the go front on
    // loopback, which has its own - a header deadline on the render and the
    // public server's read and write timeouts on the browser. The knob this
    // replaces covered the response write too, so a render that streamed
    // longer than it had to be re-armed by hand (createKeepWarm, deleted)
    idleTimeout: 0,
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
    async fetch(req) {
      const t0 = performance.now();
      const url = new URL(req.url);
      // render mode: before the path is even looked at. a request without
      // this boot's key did not come through the front, and a loopback
      // listener is reachable by every process on the box
      if (render && internalKeyRejects(req, switches.internalKey)) {
        return new Response("forbidden", { status: 403 });
      }
      // one spelling per path, before anything routes or caches on it: a
      // percent-alias of an unreserved character (/ne%77s for /news) was a
      // distinct isr cache key, and a flood of spellings stored a render
      // pair each. 308 keeps the method and body across the redirect
      const canonical = canonicalPath(url.pathname);
      if (canonical !== url.pathname) {
        return new Response(null, { status: 308, headers: { location: canonical + url.search } });
      }
      // heads render for real, only the body is dropped and cancelled, or the
      // ssr/gzip pipeline keeps rendering into a stream nobody reads
      const dropBody = (res: Response) => headResponse(req.method, res);

      // the orchestrator's one poke here: compile the css in place. Telling
      // the browsers is the go front's, through its dev channel, poked next
      if (dev && url.pathname.startsWith("/__borgo/dev")) {
        if (req.method === "POST" && url.pathname === "/__borgo/dev/css") {
          try {
            await compileCss(true);
          } catch (error) {
            console.error(error instanceof Error ? error.message : error);
            return secure(new Response(null, { status: 500 }));
          }
          return secure(new Response(null, { status: 204 }));
        }
        return secure(new Response("not found", { status: 404 }));
      }
      // what the go front's page cache needs to know once per boot of this
      // process: which pages may be shared, for how long, under which tags
      if (render && url.pathname === ROUTES_PATH) {
        return Response.json({ boot: bootStamp, routes: policyTable });
      }
      if (url.pathname === "/healthz") return secure(dropBody(healthz()));
      let response: Response;
      try {
        response = await handle(req, url);
        const added = middlewareHeaders.get(req);
        if (added) {
          response = new Response(response.body, response);
          for (const [name, value] of Object.entries(added)) response.headers.set(name, value);
        }
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
      response = dropBody(response);
      if (dev) logRequest(req, url.pathname, response.status, performance.now() - t0);
      // the front reloads the policy table when this changes
      if (render) response.headers.set(BOOT_HEADER, String(bootStamp));
      return secure(response);
    },
  }));

  // bound, so what the browsers fetch on hearing this is answered: the go
  // front's dev channel greets them with the changed files and the chunk
  // map, this boot's and every later browser's (dev_channel.go). The whole
  // set: a browser told about one file of a two-file save may be told about
  // the one it is not showing, and applies nothing
  if (dev && render && changed.length) {
    fetch(`${api}/__borgo/dev/js`, {
      method: "POST",
      headers: { ...apiDefaults, "Content-Type": "application/json" },
      body: JSON.stringify({ files: changed, chunks: chunkMap, stamp: bootStamp }),
      signal: AbortSignal.timeout(2_000),
    }).catch((error) => console.error(`  the go front was not told about this build: ${error instanceof Error ? error.message : error}`));
  }

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
  if (render) {
    // the public address is the go front's to print; this one is the cable
    console.log(`  ${c.terracotta(g.arrow)} render  ${c.blue(`http://127.0.0.1:${port}`)} ${c.dim("loopback, behind the go front")}`);
    console.log(`  ${c.terracotta(g.arrow)} api     ${c.blue(api)} ${c.dim("the front's internal listener")}\n`);
    return;
  }
  console.log(`  ${c.terracotta(g.arrow)} app  ${c.blue(`http://localhost:${port}`)}`);
  console.log(`  ${c.terracotta(g.arrow)} api  ${c.blue(api)} ${c.dim("go, proxied at /api")}\n`);
}
