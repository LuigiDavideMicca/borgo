import type { ComponentType, ReactNode } from "react";
import type { ApiClient } from "./api";

// api is the typed client for the go routes; apiUrl is the raw base url
// (e.g. http://localhost:3501/api) for anything the client doesn't cover.
// the incoming request's cookies are forwarded on every api call, so go
// handlers see the browser's session during ssr.
export type LoaderContext = {
  request: Request;
  params: Record<string, string>;
  api: ApiClient;
  apiUrl: string;
};
export type ActionContext = {
  request: Request;
  params: Record<string, string>;
  api: ApiClient;
  apiUrl: string;
};

export type Head = { title?: string; meta?: Array<Record<string, string>> };

export type HydrateMode = boolean | "visible";

// context handed to prerenderPaths during `borgo export`: the api is up and
// queryable, exactly like in a loader
export type PrerenderContext = {
  api: ApiClient;
  apiUrl: string;
};

export type PageModule = {
  default: ComponentType<any>;
  loader?: (ctx: LoaderContext) => Promise<Record<string, unknown> | Response>;
  action?: (ctx: ActionContext) => Promise<Response | Record<string, unknown>>;
  head?: Head | ((props: Record<string, unknown>) => Head);
  hydrate?: HydrateMode;
  // static export: a page with a loader opts in with `prerender = true`; a
  // dynamic route lists its param sets with prerenderPaths
  prerender?: boolean;
  prerenderPaths?: (
    ctx: PrerenderContext,
  ) => Array<Record<string, string | number>> | Promise<Array<Record<string, string | number>>>;
};

export type LayoutModule = {
  default: ComponentType<{ children: ReactNode }>;
};

export type Route = {
  pattern: string;
  file: string;
  module: PageModule;
  layouts: LayoutModule[];
  islands?: boolean;
};

// a raw "%" (or any malformed escape) in a url must not take the router
// down; the segment is used as-is instead
export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// pages/index.tsx -> /, pages/about.tsx -> /about, pages/tasks/[id].tsx -> /tasks/:id
export function filePathToPattern(file: string): string {
  const cleaned = file
    .replace(/\.tsx$/, "")
    .replace(/\[(\w+)\]/g, ":$1")
    .replace(/(^|\/)index$/, "");
  return "/" + cleaned.replace(/^\//, "");
}

export function matchRoute<R extends { pattern: string }>(pathname: string, routes: R[]) {
  const path = pathname.replace(/\/+$/, "") || "/";
  for (const route of routes) {
    const params = matchPattern(route.pattern, path);
    if (params) return { route, params };
  }
  return null;
}

export function resolveHead(module: PageModule, props: Record<string, unknown>): Head {
  const head = typeof module.head === "function" ? module.head(props) : module.head;
  return head ?? {};
}

// a head export may be computed from loader data, so attribute names are as
// untrusted as their values: anything but a plain name - and never an event
// handler - would break out of the tag it is written into.
const safeAttrName = (name: string) => /^[a-z][a-z0-9:._-]*$/i.test(name) && !/^on/i.test(name);

// the one filter both halves use, because one head() export must not produce
// one head on the server and a different one on client navigation. the server
// refused these names already; the client's setAttribute filtered nothing, so
// the same meta that rendered as an escaped attribute during ssr either
// installed a live handler (a name starting with `on`) or threw
// InvalidCharacterError on a non-token name - inside navigate(), after
// root.render(), which leaves the page swapped in, the head half-applied and
// the rejection unhandled.
export function safeHeadAttrs(meta: Record<string, unknown>): Array<[string, string]> {
  const attrs: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(meta)) {
    if (safeAttrName(name)) attrs.push([name, String(value)]);
  }
  return attrs;
}

// segments are compared without collapsing empty ones: "//foo" and "/a//b"
// are distinct urls, not aliases of "/foo" - collapsing them would give every
// page a second address (and a "//host" path is a protocol-relative url the
// moment it lands in an href). trailing slashes are stripped by the caller.
function matchPattern(pattern: string, path: string) {
  const patternParts = pattern.split("/");
  const pathParts = path.split("/");
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      // an empty segment ("/a//2") is not a value for a param
      if (!pathParts[i]) return null;
      params[patternParts[i].slice(1)] = safeDecode(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i] && patternParts[i] !== safeDecode(pathParts[i])) {
      // static segments also match percent-encoded, e.g. /città vs /citt%C3%A0
      return null;
    }
  }
  return params;
}
