// middleware.ts: the pages' middleware, at the root of the app, alla Next.
//
//   export const matcher = ["/app/:path*", "/w/:slug/:path*"];
//   export async function middleware(request, { session, params, locals, url }) {
//     if (!session) return redirect(`/login?next=${url.pathname}`);
//     return next();
//   }
//
// It runs in the render service before any loader or action the matcher
// covers, with the session go already verified and the values
// api/middleware.go forwarded. Everything here is pure, so the rules are
// tested without a server; serve() wires the decision into all three doors a
// page has - the document, the props a client navigation fetches, and the
// POST of an action. A guard on two doors of three is not a guard.
//
// It never runs on /api: go answers the api itself, and asking this process
// for permission on every api call would put back the hop the go front
// removed. A matcher that names /api or /__borgo is refused, not ignored.
import type { Locals, Session } from "./router";

export type MiddlewareResult = {
  readonly __borgoMiddleware: "next" | "rewrite";
  readonly path?: string;
  readonly headers: Record<string, string>;
};

/** Go on to the page; `headers` are added to its response. */
export const next = (init: { headers?: Record<string, string> } = {}): MiddlewareResult => ({
  __borgoMiddleware: "next",
  headers: { ...init.headers },
});

/**
 * Render another page of this app for this request, once - the browser's URL
 * does not change. `headers` are added to the response.
 */
export const rewrite = (path: string, init: { headers?: Record<string, string> } = {}): MiddlewareResult => ({
  __borgoMiddleware: "rewrite",
  path,
  headers: { ...init.headers },
});

export type PageMiddlewareContext = {
  url: URL;
  // what the matcher entry captured: /w/:slug/:path* gives { slug, path }
  params: Record<string, string>;
  session: Session | null;
  locals: Locals;
};

export type PageMiddleware = (
  request: Request,
  ctx: PageMiddlewareContext,
) => MiddlewareResult | Response | Promise<MiddlewareResult | Response>;

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// the reason an entry is refused, or "" when it is a matcher
export function matcherRefusal(entry: unknown): string {
  if (typeof entry !== "string" || entry === "") return "must be a non-empty path string";
  if (!entry.startsWith("/")) return "must start with /";
  if (/[?#]/.test(entry)) return "is matched against the path alone, without a query or a fragment";
  if (/%[0-9A-Fa-f]{2}/.test(entry)) {
    return "is matched against the decoded path: write the characters themselves, /città and not /citt%C3%A0";
  }
  if (entry !== "/" && entry.endsWith("/")) return "must not end with /: a page has one spelling, and the go front redirects every other";
  const segments = entry === "/" ? [] : entry.slice(1).split("/");
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    if (segment === "") return "has an empty segment";
    if (segment.startsWith(":")) {
      const wildcard = segment.endsWith("*");
      const name = segment.slice(1, wildcard ? -1 : undefined);
      if (!PARAM_NAME.test(name)) return `has a parameter ${JSON.stringify(segment)} without a valid name`;
      if (wildcard && i !== segments.length - 1) return "may use a :name* segment only last";
    } else if (segment.includes("*") || segment.includes(":")) {
      return "may use * only as a final :name* segment, and : only to start a parameter";
    }
  }
  const first = segments[0];
  if (first === "api" || first === "__borgo") {
    return `names /${first}: pages are guarded here and the api in api/middleware.go, because asking this process for permission on every api call would put back the hop the go front removed`;
  }
  return "";
}

const decodeSegment = (segment: string) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

export function compileMatcher(entry: string): (pathname: string) => Record<string, string> | null {
  const reason = matcherRefusal(entry);
  if (reason) throw new Error(`middleware.ts: matcher ${JSON.stringify(entry)} ${reason}`);
  const segments = entry === "/" ? [] : entry.slice(1).split("/");
  return (pathname) => {
    const parts = pathname === "/" ? [] : pathname.replace(/^\//, "").split("/");
    const params: Record<string, string> = {};
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!;
      if (segment.startsWith(":") && segment.endsWith("*")) {
        params[segment.slice(1, -1)] = parts.slice(i).map(decodeSegment).join("/");
        return params;
      }
      const part = parts[i];
      if (part === undefined || part === "") return null;
      if (segment.startsWith(":")) {
        params[segment.slice(1)] = decodeSegment(part);
      } else if (segment !== part && segment !== decodeSegment(part)) {
        // the router's own rule (matchRoute): a static segment matches as
        // written or decoded. Compared literally, /citt%C3%A0 - the only
        // spelling a browser sends for /città - rendered the page and never
        // met the guard (found by the verifier of phase 2)
        return null;
      }
    }
    return parts.length === segments.length ? params : null;
  };
}

// whether some path is both a page of this route pattern and covered by this
// matcher entry. Conservative on purpose: it answers for a page whose cached
// copy would be served without the guard, so "maybe" has to read as "yes"
export function patternsOverlap(routePattern: string, entry: string): boolean {
  const route = routePattern === "/" ? [] : routePattern.slice(1).split("/");
  const matcher = entry === "/" ? [] : entry.slice(1).split("/");
  for (let i = 0; i < matcher.length; i++) {
    const m = matcher[i]!;
    if (m.startsWith(":") && m.endsWith("*")) return true;
    const r = route[i];
    if (r === undefined) return false;
    if (r.startsWith(":") || m.startsWith(":")) continue;
    if (r !== m) return false;
  }
  return route.length === matcher.length;
}

export type ResolvedPageMiddleware = {
  run: PageMiddleware;
  // the params of the first entry covering the path, or null when none does
  covers: (pathname: string) => Record<string, string> | null;
  // whether a page of this route pattern can be reached under the guard
  guardsRoute: (routePattern: string) => boolean;
};

// the module middleware.ts compiled to, checked once at boot: every mistake
// refuses the boot with its name, because a middleware that silently guards
// nothing is an authorization that silently does not happen
export function resolvePageMiddleware(module: unknown): ResolvedPageMiddleware | null {
  if (module === null || module === undefined) return null;
  const m = module as { middleware?: unknown; matcher?: unknown };
  if (typeof m.middleware !== "function") {
    throw new Error("middleware.ts must export a function named middleware: without it the file guards nothing");
  }
  let compiled: Array<{ entry: string; match: (pathname: string) => Record<string, string> | null }> | null = null;
  if (m.matcher !== undefined) {
    if (!Array.isArray(m.matcher)) throw new Error("middleware.ts: matcher must be an array of path strings");
    if (m.matcher.length === 0) {
      throw new Error("middleware.ts: an empty matcher guards nothing - remove it to guard every page, or name the paths");
    }
    compiled = m.matcher.map((entry: unknown) => {
      const reason = matcherRefusal(entry);
      if (reason) throw new Error(`middleware.ts: matcher ${JSON.stringify(entry)} ${reason}`);
      return { entry: entry as string, match: compileMatcher(entry as string) };
    });
  }
  return {
    run: m.middleware as PageMiddleware,
    covers: (pathname) => {
      if (!compiled) return {};
      for (const c of compiled) {
        const params = c.match(pathname);
        if (params) return params;
      }
      return null;
    },
    guardsRoute: (routePattern) => !compiled || compiled.some((c) => patternsOverlap(routePattern, c.entry)),
  };
}

export type MiddlewareDecision =
  | { kind: "continue"; pathname: string; headers: Record<string, string> }
  | { kind: "respond"; response: Response };

function rewriteRefusal(path: string, current: string): string {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) return "must be a path inside this app";
  if (/[?#]/.test(path)) return "takes a path, without a query or a fragment";
  if (path === current) return "rewrites the page to itself";
  const first = path.split("/")[1];
  if (first === "api" || first === "__borgo") return `cannot reach /${first}: a rewrite renders a page`;
  return "";
}

// what middleware.ts decided for this request. A path the matcher does not
// cover never calls it.
export async function decidePage(
  mw: ResolvedPageMiddleware,
  request: Request,
  url: URL,
  facts: { session: Session | null; locals: Locals },
): Promise<MiddlewareDecision> {
  const params = mw.covers(url.pathname);
  if (!params) return { kind: "continue", pathname: url.pathname, headers: {} };
  const result: unknown = await mw.run(request, { url, params, session: facts.session, locals: facts.locals });
  if (result instanceof Response) return { kind: "respond", response: result };
  if (result !== null && typeof result === "object" && "__borgoMiddleware" in result) {
    const r = result as MiddlewareResult;
    if (r.__borgoMiddleware === "next") return { kind: "continue", pathname: url.pathname, headers: r.headers };
    const why = rewriteRefusal(r.path ?? "", url.pathname);
    if (why) throw new Error(`middleware.ts: rewrite(${JSON.stringify(r.path)}) ${why}`);
    return { kind: "continue", pathname: r.path!, headers: r.headers };
  }
  throw new Error(
    `middleware.ts: middleware must return next(), rewrite(), redirect() or a Response, and returned ${result === undefined ? "nothing" : typeof result}`,
  );
}

// A middleware answer, shaped for the door that asked. A document takes the
// redirect as it is. The props endpoint and an enhanced action are read by
// the client runtime, which follows { redirect } and would otherwise receive
// a 303 it cannot turn into a navigation - the guard would hold, and the user
// would be left on a page that silently stopped working.
export function answerForDoor(
  request: Request,
  url: URL,
  response: Response,
  sendJson: (request: Request, value: unknown, init?: ResponseInit) => Response,
): Response {
  const location = response.headers.get("Location");
  if (!location || response.status < 300 || response.status >= 400) return response;
  if (url.searchParams.get("__borgo") === "props") {
    return sendJson(request, { redirect: location }, { headers: { "Cache-Control": "private, no-store" } });
  }
  if (request.method === "POST" && request.headers.get("x-borgo-action") === "1") {
    return sendJson(
      request,
      { redirect: location },
      { headers: { "X-Borgo": "action", "Cache-Control": "private, no-store" } },
    );
  }
  return response;
}
