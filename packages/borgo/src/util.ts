import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { c, g } from "./colors";
import { documentStream, gzipStream, pickEncoding } from "./compress";
import { CSRF_COOKIE, CSRF_FIELD, csrfCookieValue } from "./index";
import { withCsrf } from "./internal";
import { resolveHead, type ActionContext, type Head, type Route } from "./router";

// constant-time on the value, honest about the length: a comparison that
// leaks how many prefix bytes matched is a comparison an attacker can walk
export const keysEqual = (given: string, expected: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

// attribute values are always double-quoted, so this is the complete set
export const escapeHtml = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

// a head export may be computed from loader data, so attribute names are as
// untrusted as their values: anything but a plain name - and never an event
// handler - would break out of the tag it is written into
const safeAttrName = (name: string) => /^[a-z][a-z0-9:._-]*$/i.test(name) && !/^on/i.test(name);

export function headHtml(head: Head): string {
  let html = "";
  if (head.title) html += `<title>${escapeHtml(String(head.title))}</title>`;
  for (const meta of head.meta ?? []) {
    let attrs = "";
    for (const [name, value] of Object.entries(meta)) {
      if (safeAttrName(name)) attrs += ` ${name}="${escapeHtml(String(value))}"`;
    }
    html += `<meta${attrs} data-borgo-head>`;
  }
  return html;
}

// security headers, applied to every response borgo builds itself (the /api
// proxy hands go's own headers through untouched). the defaults are:
//   X-Content-Type-Options: nosniff
//   Referrer-Policy: strict-origin-when-cross-origin
//   X-Frame-Options: DENY
//   Content-Security-Policy: default-src 'self'; base-uri 'none';
//     object-src 'none'; frame-ancestors 'none'; form-action 'self';
//     img-src 'self' data: blob:; font-src 'self' data:;
//     style-src 'self' 'unsafe-inline'; connect-src 'self';
//     script-src 'self' 'nonce-<per request>'
// the csp rides on documents and on svg (which runs its own scripts when
// navigated to directly), not on every asset. the ssr inline script carrying
// window.__PROPS__ is allowed by that per-request nonce, never by
// 'unsafe-inline'; a hydrate=false page has no inline script and is served
// the same policy without one. style-src keeps 'unsafe-inline' because react
// renders style={{}} as a style attribute, which no nonce can cover, and
// connect-src 'self' covers same-origin ws:// per csp level 3. dev swaps the
// nonce for 'unsafe-inline': the error overlay and the zero-js reload client
// are inline scripts built outside the render.
// BORGO_SECURITY_HEADERS=0 drops all of it; BORGO_CSP=0 drops the csp alone
// and BORGO_CSP=<policy> replaces it, with {nonce} substituted per request.
export const CSP_DEFAULT =
  "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; " +
  "form-action 'self'; img-src 'self' data: blob:; font-src 'self' data:; " +
  "style-src 'self' 'unsafe-inline'; connect-src 'self'; script-src 'self'";

const STATIC_SECURITY = [
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
  ["X-Frame-Options", "DENY"],
] as const;

export type Security = {
  needsNonce: boolean;
  cspFor: (nonce: string) => string;
  apply: (res: Response) => Response;
};

export function createSecurity(
  dev: boolean,
  env: { headers?: string; csp?: string } = {},
): Security | null {
  if (env.headers === "0") return null;
  const enabled = env.csp !== "0";
  const template =
    env.csp && enabled ? env.csp : CSP_DEFAULT + (dev ? " 'unsafe-inline'" : "{nonce}");
  const withoutNonce = template.replaceAll("{nonce}", "");
  return {
    needsNonce: enabled && template.includes("{nonce}"),
    cspFor: (nonce) => template.replaceAll("{nonce}", ` 'nonce-${nonce}'`),
    apply(res) {
      const headers = res.headers;
      for (const [name, value] of STATIC_SECURITY) {
        if (!headers.has(name)) headers.set(name, value);
      }
      if (enabled && !headers.has("Content-Security-Policy")) {
        // rfc 9110 §8.3.1: type and subtype are case-insensitive. every
        // content-type borgo writes itself is already lowercase, but an
        // action or a loader guard may hand back a response typed by
        // whoever built it - and a document whose type reads TEXT/HTML is
        // still a document the csp has to cover
        const type = (headers.get("Content-Type") ?? "").toLowerCase();
        if (type.startsWith("text/html") || type.startsWith("image/svg+xml")) {
          headers.set("Content-Security-Policy", withoutNonce);
        }
      }
      return res;
    },
  };
}

// json destined for an inline <script>: escaping "<" neutralizes </script>
// and <!-- inside the block, u+2028/u+2029 are valid json but not valid js
// string content for every parser, so they travel escaped too. chained
// replaceAll beats a one-pass regex with a callback by ~20% in jsc.
export const scriptJson = (value: unknown) =>
  JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");

// an action that logs in (or out) changes the jar mid-request: the loader that
// runs right after must be handed the cookies as they are now, not as the
// browser sent them. rebuilding that header means resolving duplicates, and
// every layer that resolves them differently is a way to swap a session - go
// rejects same-name cookies that disagree as ambiguous, so a jar rebuilt with
// a last-wins winner would hand go a single unambiguous cookie it would
// otherwise have refused. duplicates that disagree are dropped here too;
// identical ones are one cookie, and a Set-Cookie the api just issued settles
// the name whatever came in.
export function freshCookieHeader(cookieHeader: string | null, setCookies: string[]): string {
  const AMBIGUOUS = null;
  const jar = new Map<string, string | null>();
  for (const part of (cookieHeader ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (jar.has(name)) {
      if (jar.get(name) !== value) jar.set(name, AMBIGUOUS);
    } else {
      jar.set(name, value);
    }
  }
  for (const sc of setCookies) {
    const pair = sc.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    // go writes Max-Age=0 for any non-positive MaxAge, so this covers the
    // ClearSession(-1) that a logout action sends
    if (/;\s*max-age=0\b/i.test(sc)) jar.delete(name);
    else jar.set(name, pair.slice(eq + 1).trim());
  }
  const out: string[] = [];
  for (const [name, value] of jar) {
    if (value !== AMBIGUOUS) out.push(`${name}=${value}`);
  }
  return out.join("; ");
}

// "did we ever issue this browser a cookie of this name", regardless of what
// the value reads as. a check that switches itself off when the value is
// unusable is a check an attacker can switch off by making it unusable.
export function hasCookie(header: string | null, name: string): boolean {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return true;
  }
  return false;
}

export type CsrfOptions = {
  // on by default in production; BORGO_CSRF=1 forces the check in dev,
  // BORGO_CSRF=0 disables - serve() resolves the env once and passes this
  enforced: boolean;
};

// csrf: a double-submit token, issued as a cookie on rendered pages and
// required from form actions of requests carrying a session - a cross-site
// post cannot read the cookie to echo it in the form.
export async function csrfRejects(req: Request, { enforced }: CsrfOptions): Promise<boolean> {
  if (!enforced) return false;
  const cookies = req.headers.get("cookie");
  // enforced for any browser that has been issued a token, not only for
  // live sessions: otherwise a cross-site post can log the victim into
  // the attacker's account (login csrf). cookie-less clients (curl, api
  // consumers) are unaffected. presence, not value: a token shadowed by a
  // tossed duplicate reads as absent, and a browser that can be made to
  // look token-less is a browser the check no longer runs for.
  if (!hasCookie(cookies, "borgo_session") && !hasCookie(cookies, CSRF_COOKIE)) return false;
  // a sibling subdomain can drop a second borgo_csrf into the victim's jar;
  // whichever of the two a first-wins read picked, the attacker could make
  // it theirs and then echo it from a cross-site form. duplicates that
  // disagree are no token at all - the same call the browser runtime makes
  const expected = csrfCookieValue(cookies);
  // no token to compare against: reject without buffering and parsing the
  // body, which the action below would parse a second time anyway
  if (!expected) return true;
  // the clone looks like it buffers the body a second time, ahead of the
  // action's own formData(). it does not: bun's clone shares the body
  // store, and holding two clones of a 40mb request costs the same 40mb as
  // holding one (measured). what a single-parse rewrite would cost instead
  // is +40mb per 40mb request - arrayBuffer() materialises one copy and
  // every Request built over that buffer copies it again - plus the action
  // losing the real request's abort signal. the parse itself is the only
  // extra, and it is transient. read the token the same way the action
  // will: one parser, one answer. a cheaper hand-rolled scan of the raw
  // bytes would be a second parser disagreeing with the first about
  // percent-encoding, in the middle of a security check.
  let given = "";
  try {
    const form = await req.clone().formData();
    given = String(form.get(CSRF_FIELD) ?? "");
  } catch {}
  return !given || !keysEqual(given, expected);
}

// env knobs are limits: a typo must fall back to the default, never become
// NaN and silently disable the limit it was meant to tune
export function envInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * Whether /metrics is exposed.
 *
 * The name is prefixed for a reason: a bare `METRICS` is the single most
 * collidable variable borgo ever read, and a neighbouring process in the same
 * environment has every right to its own. It was `METRICS` before 0.21 and the
 * old name is not honoured - an alias kept for compatibility is an alias that
 * keeps the collision alive.
 */
export function metricsEnabled(env: Record<string, string | undefined>): boolean {
  return env.BORGO_METRICS === "1";
}

export const goBinName = () => "api" + (process.platform === "win32" ? ".exe" : "");

// rfc 9110 §7.6.1: these govern one connection and are meaningless - or
// actively harmful - on the next hop. the browser -> borgo connection is not
// the borgo -> go connection, so forwarding them verbatim hands the client
// control of a hop that is not theirs:
//   Connection also *names* further headers as hop-scoped, so `Connection:
//     X-Api-Key` is a header-stripping primitive aimed at whatever go trusts;
//   Upgrade invites go to answer 101 on a pooled keep-alive socket bun will
//     reuse for the next /api request, desynchronised (the 101 guard in the
//     proxy saves the client, not the socket);
//   Proxy-Authorization / Proxy-Connection leak credentials meant for a
//     forward proxy into application-visible headers;
//   Transfer-Encoding is the client's framing of *its* request. bun frames the
//     outbound request itself - chunked for a stream, content-length for a
//     buffer, both derived from the bytes it actually writes - so passing the
//     inbound framing on can only disagree with what goes on the wire.
// measured on a 16-header browser request: ~0.9us, 0.1-0.5% of the proxy
// handler's cpu under concurrency (2.5% of a 75us handler when fully serial).
export const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
] as const;

// tchar, rfc 9110 §5.6.2. the Connection value is the client's, and not every
// comma-separated piece of it is a field name: `keep-alive,` leaves an empty
// token, `,` leaves two, a quoted string leaves quotes. Headers.delete throws
// on any of them - and it throws from *outside* proxyRequest's try, so the 502
// the proxy answers its own failures with never runs. the request lands in
// serve()'s catch instead and /api answers a rendered 500 document: html on an
// api path, a fresh csrf cookie, a full ssr render bought with one malformed
// header. tokens are judged one at a time, so a junk token cannot smuggle a
// real one - `Connection: X-Api-Key, "junk"` still strips X-Api-Key.
const TCHAR = /^[!#$%&'*+.^_`|~\w-]+$/;

// content-length is deliberately kept: bun recomputes it for a buffered body
// and the streamed path only ever carries the length bun's own server already
// framed the request with, so go still sees an honest r.ContentLength.
export function forwardableHeaders(headers: Headers): Headers {
  const out = new Headers(headers);
  // read Connection before deleting it; a single token carries no comma, so
  // this cannot be shortcut on one
  const connection = out.get("connection");
  if (connection) {
    for (const token of connection.split(",")) {
      const name = token.trim();
      if (TCHAR.test(name)) out.delete(name);
    }
  }
  for (const name of HOP_BY_HOP) out.delete(name);
  return out;
}

// the /api proxy buffers request bodies so a refused connection (api mid-
// restart) can be retried; only bodies of known, modest size qualify - a
// large upload or a chunked stream passes through once, without retry
export const PROXY_RETRY_MAX_BODY = 10 * 1024 * 1024;

// rfc 9112 §6.3 allows a request to repeat Content-Length as long as every
// value agrees, and bun.serve accepts one: `Headers` then joins the repeats
// into "5, 5". Number() reads that as NaN, which used to mean "unbuffered" -
// so a five byte body lost its retry, and the comma-joined header went on to
// go verbatim. parse the list instead, and require the values to agree.
// Number() is the wrong reader for a header value in general: it also takes
// "", "0x10", "1e3" and " 5 " as numbers a length may never be.
function parseContentLength(value: string): number | null {
  let length: number | null = null;
  for (const part of value.split(",")) {
    const token = part.trim();
    if (!/^\d+$/.test(token)) return null;
    const n = Number(token);
    if (length !== null && n !== length) return null;
    length = n;
  }
  return length;
}

export function shouldBufferBody(method: string, contentLength: string | null): boolean {
  if (method === "GET" || method === "HEAD") return false;
  if (contentLength === null) return false;
  const length = parseContentLength(contentLength);
  return length !== null && length <= PROXY_RETRY_MAX_BODY;
}

// a head renders for real - status and headers must be what a get would have
// said - and only the body is dropped. cancelled, too: without that the
// ssr/gzip pipeline behind it keeps rendering into a stream nobody reads.
//
// a null body is itself a claim: bun frames one as Content-Length: 0. so every
// response that never measured its own length - the streamed document,
// /healthz, /metrics, a props payload, a plain text 404 - used to answer a head
// by declaring itself empty, for a resource a get returns in full. that is the
// same lie the asset paths set an explicit length to avoid, arriving from the
// other side. a length that is known still rides (the assets state theirs, and
// go states its own through the proxy); where none is, an already-closed
// stream leaves bun framing the head as it framed the get. rfc 9110 §9.3.2
// allows omitting a field "determined only while generating the content" -
// it does not allow getting it wrong.
export function headResponse(method: string, res: Response): Response {
  if (method !== "HEAD" || !res.body) return res;
  const measured = res.headers.has("Content-Length");
  const headless = new Response(measured ? null : emptyStream(), {
    status: res.status,
    headers: res.headers,
  });
  void res.body.cancel().catch(() => {});
  return headless;
}

const emptyStream = () =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });

// set-cookie headers collected from the api ride out on whatever response the
// request ends with; a response that gathered none passes through untouched
export function withCookies(res: Response, cookies: string[]): Response {
  if (!cookies.length) return res;
  const headers = new Headers(res.headers);
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(res.body, { status: res.status, headers });
}

// in dev a tiny inline client keeps a zero-js page live: css swaps in
// place, anything else is a full reload
export const DEV_INLINE_CLIENT =
  "<script>(()=>{const c=()=>{const w=new WebSocket(`ws://${location.host}/__borgo/dev`);" +
  'w.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.type==="css"){for(const l of document.querySelectorAll(\'link[rel="stylesheet"]\'))l.href=l.href.split("?")[0]+"?t="+Date.now();}' +
  'else if(!m.stamp||(m.stamp>performance.timeOrigin&&Number(sessionStorage.getItem("borgo:devstamp")||0)<m.stamp)){if(m.stamp)sessionStorage.setItem("borgo:devstamp",String(m.stamp));location.reload();}};' +
  "w.onclose=()=>setTimeout(c,300);};c();})()</script>";

export type ShellParts = {
  // everything before <!--app-->, untouched
  start: string;
  // start split at </head>, with and without its <title>
  head: [string, string];
  headNoTitle: [string, string];
  // everything after <!--app-->, split at the props slot
  endProps: [string, string];
  // the tail of a hydrate=false page: no props, no client script - or the
  // islands entry, which hydrates only those
  zeroJsEnd: { plain: string; islands: string };
  // closes the props script: the shell title for the client-side router,
  // and the dev flag
  stateTail: string;
};

// the shell is scanned once at boot so a render only concatenates strings:
// injecting <head> content is a per-request rewrite of the whole shell head,
// and the props slot and client script tag are resolved here, not per page
export function prepareShell(shell: string, dev: boolean): ShellParts {
  const [start, end = ""] = shell.split("<!--app-->");
  const title = shell.match(/<title>(.*?)<\/title>/s)?.[1] ?? "";
  const splitAtHead = (html: string): [string, string] => {
    const at = html.indexOf("</head>");
    return at === -1 ? [html, ""] : [html.slice(0, at), html.slice(at)];
  };
  const PROPS_SLOT = "<!--props-->";
  const splitAtProps = (html: string): [string, string] => {
    const at = html.indexOf(PROPS_SLOT);
    return at === -1 ? [html, ""] : [html.slice(0, at), html.slice(at + PROPS_SLOT.length)];
  };
  // tolerate any attribute order/extras on the client script tag; a shell
  // where it cannot be found would otherwise hydrate the wrong page over a
  // zero-js document
  const clientScriptRe = /[ \t]*<script\b[^>]*src="\/assets\/client\.js"[^>]*><\/script>\r?\n?/;
  const zeroJsTail = (islands: boolean) =>
    end
      .replace(PROPS_SLOT, dev ? DEV_INLINE_CLIENT : "")
      .replace(
        clientScriptRe,
        islands ? '<script type="module" src="/assets/islands-client.js"></script>' : "",
      );
  return {
    start,
    head: splitAtHead(start),
    headNoTitle: splitAtHead(start.replace(/<title>.*?<\/title>/s, "")),
    endProps: splitAtProps(end),
    zeroJsEnd: { plain: zeroJsTail(false), islands: zeroJsTail(true) },
    stateTail: `;window.__BORGO_TITLE__=${scriptJson(title)}${dev ? ";window.__BORGO_DEV__=1" : ""}</script>`,
  };
}

export type LoaderResult = Record<string, unknown> | Response;

export type RenderPageOptions = {
  dev: boolean;
  shell: ShellParts;
  security: Security | null;
  // attributes minted onto a fresh csrf cookie (path, samesite, secure)
  csrfCookieAttrs: string;
  // the page's loader wired to the api client; collects set-cookie headers
  runLoader: (
    req: Request,
    route: Route,
    params: Record<string, string>,
    onSetCookie: (cookies: string[]) => void,
  ) => Promise<LoaderResult>;
  // the page component wrapped in its layouts - serve() owns react
  compose: (route: Route, props: Record<string, unknown>) => import("react").ReactNode;
  // react-dom's renderToReadableStream, narrowed to what the render asks
  renderToStream: (
    element: import("react").ReactNode,
    init: { nonce?: string; onError: (error: unknown) => void },
  ) => Promise<AsyncIterable<Uint8Array>>;
  // injectable for tests; production passes none of these
  randomToken?: () => string;
  onError?: (value: unknown) => void;
};

export async function renderPage(
  req: Request,
  route: Route,
  params: Record<string, string>,
  status: number,
  options: RenderPageOptions,
  extraProps?: Record<string, unknown>,
  extraCookies: string[] = [],
): Promise<Response> {
  const {
    dev,
    shell,
    security,
    csrfCookieAttrs,
    runLoader,
    compose,
    renderToStream,
    randomToken = () => crypto.randomUUID().replaceAll("-", ""),
    onError = console.error,
  } = options;

  const apiCookies = [...extraCookies];
  const loaded = await runLoader(req, route, params, (c) => apiCookies.push(...c));
  // a loader may short-circuit with a response, e.g. redirect() as a guard
  if (loaded instanceof Response) return withCookies(loaded, apiCookies);
  const props = extraProps ? { ...loaded, ...extraProps } : loaded;

  // the same token rides in the cookie and in every <CsrfField />; a
  // browser without one gets it minted alongside this page
  const cookieToken = csrfCookieValue(req.headers.get("cookie"));
  const csrfToken = cookieToken || randomToken();
  if (!cookieToken) apiCookies.push(`${CSRF_COOKIE}=${csrfToken}; ${csrfCookieAttrs}`);

  // react emits inline scripts of its own to reveal streamed suspense
  // boundaries: they need the same nonce as the props script, so it is
  // minted before the render and not when the document tail is built
  const nonce = security?.needsNonce ? randomToken() : "";

  // props are serialized before the render, not while the document tail is
  // built: a loader that hands back something json cannot carry (a bigint, a
  // cycle, a toJSON that throws) makes this throw, and a render already in
  // flight would then be abandoned unread - react has no consumer to end it
  // through, so the whole component tree is walked for a document that can
  // never ship, and the request object stays resident. failing first costs
  // nothing and keeps the waste at zero.
  const propsJson = route.module.hydrate === false ? "" : scriptJson(props);

  const head = resolveHead(route.module, props);
  const stream = await renderToStream(withCsrf(compose(route, props), csrfToken), {
    nonce: nonce || undefined,
    onError(error) {
      onError(error);
    },
  });

  let start = shell.start;
  const injected = headHtml(head);
  if (injected) {
    const [before, after] = head.title ? shell.headNoTitle : shell.head;
    start = before + injected + after;
  }

  let end: string;
  if (route.module.hydrate === false) {
    // the page opted out of hydration: ship no props and no client script.
    // pages with islands get the islands entry, which hydrates only those.
    end = route.islands ? shell.zeroJsEnd.islands : shell.zeroJsEnd.plain;
  } else {
    const tag = nonce ? `<script nonce="${nonce}">` : "<script>";
    end = `${shell.endProps[0]}${tag}window.__PROPS__=${propsJson}${shell.stateTail}${shell.endProps[1]}`;
  }

  // react-dom's bun build misbehaves under a manual reader pump; async
  // iteration is the reliable way to drain it
  const body = documentStream(start, stream, end);

  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "private, no-store",
    Vary: "Accept-Encoding",
  });
  if (nonce) headers.set("Content-Security-Policy", security!.cspFor(nonce));
  for (const c of apiCookies) headers.append("Set-Cookie", c);
  // gzip only: brotli is too slow for dynamic responses. no size threshold
  // here - a rendered document is virtually always past it, and the length
  // of a stream is unknown up front. the per-chunk sync flush in gzipStream
  // keeps streamed suspense content progressive.
  if (!dev && pickEncoding(req.headers.get("accept-encoding"), ["gzip"])) {
    headers.set("Content-Encoding", "gzip");
    return new Response(gzipStream(body), { status, headers });
  }
  return new Response(body, { status, headers });
}

// a response built by an action or a loader guard may carry headers of its
// own (set-cookie above all); they must survive the translation to json.
// location, set-cookie and the content-* family are excluded from the plain
// copy: the first two are re-stated by the envelope and the cookie append
// below, and the content-* of the original body would describe a body this
// response no longer carries.
export function carryHeaders(from: Response, json: Response): Response {
  const headers = new Headers(json.headers);
  from.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (k === "location" || k === "set-cookie" || k.startsWith("content-")) return;
    headers.set(key, value);
  });
  for (const c of from.headers.getSetCookie()) headers.append("Set-Cookie", c);
  return new Response(json.body, { status: json.status, headers });
}

// an action that logs in (or out) changes the cookie jar mid-request: the
// loader that runs right after must see the new session, not the one the
// browser sent before the action. freshCookieHeader owns the duplicate
// semantics, which have to match what go would have made of the same jar
export function freshCookieRequest(req: Request, setCookies: string[]): Request {
  if (!setCookies.length) return req;
  const headers = new Headers(req.headers);
  const cookie = freshCookieHeader(req.headers.get("cookie"), setCookies);
  if (cookie) headers.set("cookie", cookie);
  else headers.delete("cookie");
  return new Request(req.url, { method: req.method, headers });
}

// the one match a request already does, handed on rather than repeated
export type RouteMatch = { route: Route; params: Record<string, string> };

export type RunLoaderFn = (
  req: Request,
  route: Route,
  params: Record<string, string>,
  onSetCookie?: (cookies: string[]) => void,
) => Promise<LoaderResult>;

export type RenderPageFn = (
  req: Request,
  route: Route,
  params: Record<string, string>,
  status: number,
  extraProps?: Record<string, unknown>,
  extraCookies?: string[],
) => Promise<Response>;

// dev answers with Response.json, production with the compressing jsonResponse
export type SendJsonFn = (req: Request, value: unknown, init?: ResponseInit) => Response;

export type ActionOptions = {
  dev: boolean;
  // raw base url handed to the action, for anything the typed client misses
  apiUrl: string;
  // the _500 page, rendered when an enhanced action throws in production
  serverError: Route | null;
  // serve() has already resolved the enforced flag from the environment
  csrfRejects: (req: Request) => Promise<boolean>;
  // the api client bound to this request's cookies, collecting set-cookie
  apiFor: (req: Request, onSetCookie?: (cookies: string[]) => void) => ActionContext["api"];
  runLoader: RunLoaderFn;
  renderPage: RenderPageFn;
  sendJson: SendJsonFn;
  // overlayHtml in dev; never called in production
  renderOverlay: (error: unknown) => string;
  // injectable for tests; production passes none of these
  onError?: (value: unknown) => void;
};

// a POST landing on the page routes. answers, or hands back null for "not
// mine" - a post to a path with no page, or to a page with no action, which
// the caller turns into the 405 a native form gets.
//
// the client runtime submits enhanced forms with X-Borgo-Action: 1 and gets
// json back (props + actionData, or a redirect) instead of a document, so the
// page re-renders in place without losing the scroll position. classic no-js
// posts get the full html render. every enhanced answer is marked X-Borgo
// (action = json envelope, raw = a full document to swap in) so the runtime
// never has to guess; anything left unmarked is a custom response it reloads
// on, which is the documented escape hatch.
export async function runAction(
  req: Request,
  target: RouteMatch | null,
  options: ActionOptions,
): Promise<Response | null> {
  const {
    dev,
    apiUrl,
    serverError,
    csrfRejects: rejectsCsrf,
    apiFor,
    runLoader,
    renderPage,
    sendJson,
    renderOverlay,
    onError = console.error,
  } = options;

  const action = target?.route.module.action;
  const wantsJson = req.headers.get("x-borgo-action") === "1";
  const actionJson = (value: unknown, init: ResponseInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("X-Borgo", "action");
    headers.set("Cache-Control", "private, no-store");
    return sendJson(req, value, { ...init, headers });
  };
  const rawDocument = (doc: Response) => {
    const headers = new Headers(doc.headers);
    headers.set("X-Borgo", "raw");
    return new Response(doc.body, { status: doc.status, headers });
  };

  if (target && action) {
    if (typeof action !== "function") {
      throw new Error(`the action export of pages/${target.route.file} must be a function`);
    }
    if (await rejectsCsrf(req)) {
      if (wantsJson) return actionJson({ csrf: true }, { status: 403 });
      return new Response("invalid csrf token", { status: 403 });
    }
    const apiCookies: string[] = [];
    try {
      const result = await action({
        request: req,
        params: target.params,
        api: apiFor(req, (c) => apiCookies.push(...c)),
        apiUrl,
      });
      if (result instanceof Response) {
        const location = result.headers.get("Location");
        if (wantsJson && location) {
          return withCookies(carryHeaders(result, actionJson({ redirect: location })), apiCookies);
        }
        // case-insensitively, for the same reason the csp check is: the
        // action owns this content-type, and a document the marker misses
        // is a document the runtime reloads over instead of swapping in
        if (wantsJson && (result.headers.get("content-type") ?? "").toLowerCase().includes("text/html")) {
          return withCookies(rawDocument(result), apiCookies);
        }
        return withCookies(result, apiCookies);
      }
      const freshReq = freshCookieRequest(req, apiCookies);
      if (wantsJson) {
        const loaded = await runLoader(freshReq, target.route, target.params, (c) =>
          apiCookies.push(...c),
        );
        if (loaded instanceof Response) {
          const location = loaded.headers.get("Location");
          if (location) {
            return withCookies(carryHeaders(loaded, actionJson({ redirect: location })), apiCookies);
          }
          return withCookies(loaded, apiCookies);
        }
        return withCookies(actionJson({ props: loaded, actionData: result }), apiCookies);
      }
      return renderPage(freshReq, target.route, target.params, 200, { actionData: result }, apiCookies);
    } catch (error) {
      if (!wantsJson) throw error;
      // the native flow would show the overlay or the 500 page; the
      // enhanced flow must deliver that same document, not vanish the
      // failure behind a silent reload
      onError(error);
      if (dev) {
        return rawDocument(
          new Response(renderOverlay(error), {
            status: 500,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          }),
        );
      }
      if (serverError) {
        try {
          return rawDocument(await renderPage(req, serverError, {}, 500));
        } catch {}
      }
      return rawDocument(new Response("internal server error", { status: 500 }));
    }
  }
  if (wantsJson && target) {
    // a post to a page without an action: tell the runtime to go native
    return actionJson({ unsupported: true }, { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  return null;
}

export type PropsOptions = {
  runLoader: RunLoaderFn;
  sendJson: SendJsonFn;
};

// ?__borgo=props: the client router asks for the next page's loader data
// alone, and renders the component it already has. never cached - it carries
// session-shaped data and the cookies the loader's api calls issued.
export async function runPropsRequest(
  req: Request,
  route: Route,
  params: Record<string, string>,
  { runLoader, sendJson }: PropsOptions,
): Promise<Response> {
  const apiCookies: string[] = [];
  const props = await runLoader(req, route, params, (c) => apiCookies.push(...c));
  const noStore = { headers: { "Cache-Control": "private, no-store" } };
  if (props instanceof Response) {
    // surface loader redirects as data, so the client runtime can follow
    const location = props.headers.get("Location");
    if (location) {
      return withCookies(carryHeaders(props, sendJson(req, { redirect: location }, noStore)), apiCookies);
    }
    return withCookies(props, apiCookies);
  }
  return withCookies(sendJson(req, { props }, noStore), apiCookies);
}

// the seam, narrowed to what the proxy actually asks of fetch: a target and
// an init in, a response out. the global satisfies it and so does a stub.
export type ProxyFetch = (target: string, init: RequestInit) => Promise<Response>;

export type ProxyOptions = {
  // absolute upstream url, query included
  target: string;
  // how long to wait for response *headers*; 0 disables the deadline
  deadlineMs: number;
  // connection-refused retries (the api restarting), 0 to never retry
  retries: number;
  retryDelayMs?: number;
  // injectable for tests; production passes none of these
  fetchImpl?: ProxyFetch;
  sleep?: (ms: number) => Promise<void>;
  onError?: (value: unknown) => void;
};

export const isConnRefused = (err: unknown) => {
  const e = err as { code?: string; message?: string };
  return e?.code === "ConnectionRefused" || e?.code === "ECONNREFUSED" || /unable to connect|refused/i.test(e?.message ?? "");
};

// the /api hop, borgo -> go. the go api restarts on every .go edit in dev: a
// refused connection never reached it, so retrying briefly is safe even for
// mutations. small bodies are buffered once so the request can be re-sent;
// large or unsized bodies stream through, at the price of no retry.
export async function proxyRequest(req: Request, options: ProxyOptions): Promise<Response> {
  const {
    target,
    deadlineMs,
    retries,
    retryDelayMs = 250,
    fetchImpl = fetch,
    sleep = Bun.sleep,
    onError = console.error,
  } = options;

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const buffered = shouldBufferBody(req.method, req.headers.get("content-length"));
  // may throw when the client hangs up mid-upload; the caller owns that (it
  // is the one holding the request that would answer 499)
  const body = hasBody ? (buffered ? await req.arrayBuffer() : req.body) : undefined;
  // hop-by-hop headers belong to the browser -> borgo connection, not to
  // this one; built once, outside the retry loop
  const headers = forwardableHeaders(req.headers);
  // Host is the same kind of thing: it addresses borgo, not go. forwarded
  // verbatim it makes go's r.Host whatever the client typed into the header,
  // and r.Host is the field go reaches for implicitly - http.Redirect's
  // absolute Location, a password-reset link, anything built from "the site's
  // own name". dropping it lets bun write the target's authority, so r.Host
  // is the api borgo actually dialled and nothing else. the browser's value
  // is not lost, it is moved to the header that declares itself untrusted -
  // and only when no front proxy already set one, because a proxy that
  // rewrote Host (nginx's default proxy_set_header Host $proxy_host) knows
  // the public name better than the Host reaching us does.
  const inboundHost = headers.get("host");
  headers.delete("host");
  if (inboundHost && !headers.has("x-forwarded-host")) headers.set("x-forwarded-host", inboundHost);
  // resendable unless a real body streamed through unbuffered - a
  // body-less delete/post (body null) is as safe to retry as a get
  const retriable = !hasBody || buffered || body == null;

  for (let attempt = 0; ; attempt++) {
    // an api that accepts the connection and then never answers would
    // otherwise pin this request forever: the deadline covers the wait for
    // response headers only and is dropped once they arrive, so a stream
    // (sse) still runs for as long as it wants
    const abort = deadlineMs > 0 ? new AbortController() : null;
    let timedOut = false;
    const deadline = abort
      ? setTimeout(() => {
          timedOut = true;
          abort.abort();
        }, deadlineMs)
      : undefined;
    try {
      // decompress: false passes go's response through untouched, encoding
      // included; bun would otherwise inflate it and resend identity
      const upstream = await fetchImpl(target, {
        method: req.method,
        headers,
        ...(hasBody ? { body } : {}),
        decompress: false,
        signal: abort?.signal,
      } as RequestInit);
      // the deadline can fire while these headers are still in flight:
      // the abort has already torn the connection down, but fetch still
      // resolves, with a body that ends at zero bytes. returning it would
      // hand the browser a 200 it cannot tell from a genuinely empty
      // answer - and, on sse, a stream that is dead on arrival. the
      // timeout already decided; say so.
      if (timedOut) {
        void upstream.body?.cancel().catch(() => {});
        return new Response("api timeout", { status: 504 });
      }
      // an upgrade is hop-by-hop and this proxy has no tunnel to hand
      // over: relaying the 101 would leave the client speaking a switched
      // protocol into a socket that is still framing http, and every byte
      // after it desynchronised. app sockets belong on /ws.
      if (upstream.status === 101) {
        void upstream.body?.cancel().catch(() => {});
        onError(`${new URL(target).pathname} answered 101; /api cannot tunnel an upgrade`);
        return new Response("api upgrade not supported", { status: 502 });
      }
      // handed back untouched, body included. Worth knowing before you are
      // tempted to wrap it: Bun.serve withholds a response's headers until its
      // body produces a byte, so an upstream that opens a stream and then
      // stays quiet leaves the client waiting on fetch(). The fix belongs
      // upstream, and borgo.SSE does it - it opens with an SSE comment, so the
      // headers go out at once. Re-wrapping the body here to inject that
      // comment was tried and reverted: reading the native body through a
      // JS ReadableStream and cancelling it when the client hangs up
      // segfaults bun 1.3.14, which takes the whole front server with it.
      return upstream;
    } catch (err) {
      if (timedOut) return new Response("api timeout", { status: 504 });
      if (retriable && attempt < retries && isConnRefused(err)) {
        await sleep(retryDelayMs);
        continue;
      }
      // an api endpoint must fail as an api: a bad gateway status, not
      // the rendered 500 page (or the dev overlay) meant for documents
      onError(err);
      return new Response("api unreachable", { status: 502 });
    } finally {
      clearTimeout(deadline);
    }
  }
}

// regenerate .borgo/api-types.d.ts (and the route mounting) from the go api.
// the tool is wired through the app's go.mod `tool` directive. returns
// success so build and export can refuse to ship stale generated files;
// dev ignores it and keeps serving
export async function runBorgogen(): Promise<boolean> {
  if (!existsSync("api")) return true;
  const proc = Bun.spawn(["go", "tool", "borgogen"], { stdout: "ignore", stderr: "pipe" });
  if ((await proc.exited) !== 0) {
    const stderr = await new Response(proc.stderr).text();
    console.error(stderr.trimEnd());
    console.error(
      `  ${c.red(g.err)} borgogen failed - api types are stale ${c.dim("(is `tool github.com/LuigiDavideMicca/borgo/cmd/borgogen` in go.mod?)")}`,
    );
    return false;
  }
  return true;
}
