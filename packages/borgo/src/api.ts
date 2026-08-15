// the typed api client handed to loaders and actions. borgogen augments the
// ApiRoutes interface (declared in index.ts so `declare module "borgo-framework"`
// merges with it) with one entry per go route pattern.
import type { ApiRoutes } from "./index";

const isConnRefused = (err: unknown) => {
  const e = err as { code?: string; message?: string };
  return e?.code === "ConnectionRefused" || e?.code === "ECONNREFUSED" || /unable to connect|refused/i.test(e?.message ?? "");
};

type Registered = keyof ApiRoutes & string;
export type ApiRouteKey = [Registered] extends [never] ? string : Registered;

type Entry<K extends string> = K extends keyof ApiRoutes ? ApiRoutes[K] : unknown;
export type ApiResponse<K extends string> = Entry<K> extends { response: infer R } ? R : Entry<K>;
export type ApiRequest<K extends string> = Entry<K> extends { request: infer B } ? B : never;

type ParamNames<S extends string> = S extends `${string}{${infer P}}${infer Rest}`
  ? P | ParamNames<Rest>
  : never;

export type ApiOptions<K extends string> = {
  query?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
  // milliseconds until the call is abandoned. off by default: a handler that
  // streams (sse, long poll, big export) must not be cut mid-response, and
  // only the caller knows which routes those are. a loader calling a plain
  // crud route wants this set - a hung go handler otherwise holds the ssr
  // render (and the browser tab) open forever
  timeout?: number;
} & ([ApiRequest<K>] extends [never] ? { body?: unknown } : { body: ApiRequest<K> }) &
  ([ParamNames<K>] extends [never]
    ? { params?: Record<string, string | number> }
    : { params: Record<ParamNames<K>, string | number> });

type OptsRequired<K extends string> = [ParamNames<K>] extends [never]
  ? [ApiRequest<K>] extends [never]
    ? false
    : true
  : true;

export type ApiClient = <K extends ApiRouteKey>(
  route: K,
  ...opts: OptsRequired<K> extends true ? [ApiOptions<K>] : [ApiOptions<K>?]
) => Promise<ApiResponse<K>>;

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: string,
    route: string,
  ) {
    super(`api ${route} responded ${status}`);
    this.name = "ApiError";
  }
}

// an api that fails can answer with megabytes (a go panic dump, an html error
// page from a proxy) and ApiError.body tends to be logged whole: read only the
// useful head off the stream, then drop the rest instead of buffering it
async function errorBody(res: Response, max = 2048): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < max) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      parts.push(value);
      size += value.length;
    }
  } catch {}
  reader.cancel().catch(() => {});
  const joined = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return new TextDecoder().decode(joined).slice(0, max);
}

// THE SAME NUMBER AS THE PROXY, BECAUSE IT IS THE SAME GO PROCESS.
//
// This client and the /api proxy both dial the api the front server was started
// beside, and both retry a refused connection because a refused connection never
// reached it. The proxy takes 3 in production and says why on its read in
// server.ts: in production a refused connection means the api is down, and
// holding every request open while it is retried only piles connections up. This
// side took 15 - 16 attempts, at 250ms apart, so a call that should have failed
// at once hung for about four seconds, per loader, on every request. In a
// container that is longer than a readiness probe's own deadline, so the front
// server fails the probe for a reason the probe cannot see.
//
// The value is the caller's, and the caller is the one that knows whether the
// api is mid-restart (dev) or down (production). The default is the production
// number: whoever wants to wait has to say so.
export const API_RETRIES = 3;

// onSetCookie receives every Set-Cookie header an api response carries, so
// the front server can forward go's cookies (login, logout) to the browser
export function makeApiClient(
  base: string,
  defaults: Record<string, string> = {},
  onSetCookie?: (cookies: string[]) => void,
  retries: number = API_RETRIES,
): ApiClient {
  return (async (route: string, opts: ApiOptions<string> = {}) => {
    const space = route.indexOf(" ");
    // without this, slice(0, -1) silently mangles the key into nonsense
    if (space === -1) throw new Error(`api route "${route}": expected "METHOD /path"`);
    const method = route.slice(0, space);
    const path = route.slice(space + 1).replace(/\{(\w+)\}/g, (_, name) => {
      const value = opts.params?.[name];
      if (value === undefined) throw new Error(`api ${route}: missing param "${name}"`);
      return encodeURIComponent(String(value));
    });

    const url = new URL(base + path);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      // an optional filter that came out undefined must be absent, not the
      // literal string "undefined" the api would then try to parse
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }

    const init = {
      method,
      headers: {
        ...defaults,
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    };
    // loaders and actions run while the go api may be mid-restart in dev; a
    // refused connection never reached it, so a short retry is always safe.
    // how many is API_RETRIES' argument, above
    // an explicit controller instead of AbortSignal.timeout: the timer is
    // cleared once the body is consumed, so a fast call leaves nothing behind
    const abort = opts.timeout ? new AbortController() : null;
    const deadline = abort
      ? setTimeout(
          () => abort.abort(new DOMException(`timed out after ${opts.timeout}ms`, "TimeoutError")),
          opts.timeout,
        )
      : undefined;
    const timedOut = (err: unknown) =>
      (err as Error)?.name === "TimeoutError" || abort?.signal.aborted === true;
    try {
      let res: Response;
      for (let attempt = 0; ; attempt++) {
        try {
          res = await fetch(url, abort ? { ...init, signal: abort.signal } : init);
          break;
        } catch (err) {
          if (timedOut(err)) throw new Error(`api ${route}: no response within ${opts.timeout}ms`);
          if (attempt >= retries || !isConnRefused(err)) throw err;
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      const setCookies = res.headers.getSetCookie?.() ?? [];
      if (setCookies.length) onSetCookie?.(setCookies);
      if (!res.ok) throw new ApiError(res.status, await errorBody(res), route);
      // a handler that answered with headers only: json() would throw on ""
      if (res.status === 204 || res.headers.get("content-length") === "0") return undefined;
      try {
        return await res.json();
      } catch (err) {
        // the deadline can also land mid-body: a stalled stream is a timeout,
        // not a malformed payload
        if (timedOut(err)) throw new Error(`api ${route}: no response within ${opts.timeout}ms`);
        // without the route the caller only sees "Unexpected end of JSON input"
        throw new ApiError(res.status, "response body is not json", route);
      }
    } finally {
      clearTimeout(deadline);
    }
  }) as ApiClient;
}
