// isr: a shared html cache for pages that declare themselves shareable.
//
// the property that must never fail is the guard, so it is built first and
// everything else sits behind it: a page enters the cache only if it was
// rendered from an anonymised request, came back 200, set no cookie under
// any spelling, and its bytes carry no per-request residue - the same
// requestResidue() the exporter asks, one implementation, no drift. a page
// that fails the guard is served fresh every time and says so once in the
// log; the failure direction is always "no caching", never "shared what was
// personal".
//
// production only, like the asset index: dev rebuilds under stable names and
// a cached page would fight the reload the dev channel just asked for.
import { pickEncoding } from "./compress";
import { requestResidue, type Residue } from "./export";

// the grammar mirrors prerender's: a flag on the page module, read at serve
// time, never involving borgogen. `revalidate` is seconds - how long a copy
// is fresh - or "manual": never stale by clock, dropped only by
// borgo.Revalidate / borgo.RevalidateTag. `tags` names the data the page
// depends on, so one RevalidateTag("posts") drops every page that declared it.
export type IsrPolicy = { seconds: number | "manual"; tags: string[] };

// null: the page opted out (no revalidate export). a string: the page opted
// in wrongly, and the reason is named - serving would hide the typo forever
export function readIsrPolicy(module: {
  revalidate?: unknown;
  tags?: unknown;
}): IsrPolicy | string | null {
  const { revalidate, tags } = module;
  if (revalidate === undefined) return null;
  let seconds: number | "manual";
  if (revalidate === "manual") {
    seconds = "manual";
  } else if (typeof revalidate === "number" && Number.isFinite(revalidate) && revalidate > 0) {
    seconds = revalidate;
  } else {
    return `revalidate must be a positive number of seconds or "manual", got ${JSON.stringify(revalidate)}`;
  }
  if (tags === undefined) return { seconds, tags: [] };
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string" || t.trim() === "")) {
    return `tags must be an array of non-empty strings, got ${JSON.stringify(tags)}`;
  }
  return { seconds, tags: tags.map((t: string) => t.trim()) };
}

export type CachedPage = {
  body: Uint8Array;
  // compressed once at store time, served to whoever negotiates it: the cpu
  // cost sits on the regeneration, never on the hit
  gzip?: Uint8Array;
  status: number;
  // replayed on every hit; Set-Cookie can never be here, the guard refused it
  headers: Array<[string, string]>;
  storedAt: number;
  tags: string[];
};

// why a copy was refused, for the once-per-page log line
export type Unstorable = { reason: string };

// the storability question, asked of the finished response: status, cookies
// under any spelling (Headers folds them, getSetCookie sees every one), and
// the same per-request residue the exporter refuses. pure, so the tests can
// interrogate it without a server.
export function unstorable(
  status: number,
  headers: Headers,
  html: string,
): Unstorable | null {
  if (status !== 200) return { reason: `status ${status}` };
  // defence in depth: the shared render asks for identity, so a coded body
  // here means the render path changed under this cache - and coded bytes
  // are bytes the residue check below cannot honestly read. refused, loudly,
  // rather than inspected wrongly and shared
  if (headers.get("content-encoding")) {
    return { reason: `the body is ${headers.get("content-encoding")}-coded and cannot be inspected` };
  }
  const cookies = headers.getSetCookie();
  if (cookies.length > 0) {
    return { reason: "the response sets a cookie, and a shared copy would hand it to everyone" };
  }
  const residue: Residue[] = requestResidue(html);
  if (residue.length > 0) {
    return {
      reason: `the page carries ${residue.map((r) => r.what).join(" and ")} - per-request, like the exporter refuses`,
    };
  }
  return null;
}

// bounded: the key includes the query string, and an attacker who can vary a
// query must not be able to grow the cache without limit. least-recently-used
// because the honest alternative - refusing new entries - would let the same
// attacker pin the cache full of junk and starve the real pages.
export const MAX_CACHED_PAGES = 512;

export class PageCache {
  private pages = new Map<string, CachedPage>();
  private byTag = new Map<string, Set<string>>();

  get(key: string): CachedPage | undefined {
    const entry = this.pages.get(key);
    if (entry) {
      // Map iteration order is insertion order: re-inserting is the LRU touch
      this.pages.delete(key);
      this.pages.set(key, entry);
    }
    return entry;
  }

  fresh(entry: CachedPage, policy: IsrPolicy, now: number): boolean {
    if (policy.seconds === "manual") return true;
    return now - entry.storedAt < policy.seconds * 1000;
  }

  store(key: string, entry: CachedPage): void {
    this.pages.delete(key);
    this.pages.set(key, entry);
    for (const tag of entry.tags) {
      let keys = this.byTag.get(tag);
      if (!keys) this.byTag.set(tag, (keys = new Set()));
      keys.add(key);
    }
    while (this.pages.size > MAX_CACHED_PAGES) {
      const oldest = this.pages.keys().next().value as string;
      this.drop(oldest);
    }
  }

  private drop(key: string): void {
    const entry = this.pages.get(key);
    if (!entry) return;
    this.pages.delete(key);
    for (const tag of entry.tags) {
      const keys = this.byTag.get(tag);
      if (keys) {
        keys.delete(key);
        if (keys.size === 0) this.byTag.delete(tag);
      }
    }
  }

  // exact path, or every key under a trailing-star prefix: Revalidate("/blog/*")
  // drops /blog and everything below it. returns how many copies went, so the
  // caller can log an invalidation that matched nothing - usually a typo
  invalidatePath(path: string): number {
    let dropped = 0;
    if (path.endsWith("*")) {
      const prefix = path.slice(0, -1);
      for (const key of [...this.pages.keys()]) {
        if (key.startsWith(prefix)) {
          this.drop(key);
          dropped++;
        }
      }
      return dropped;
    }
    for (const key of [...this.pages.keys()]) {
      // the key carries the query string; an exact-path invalidation drops
      // every query variant of that path
      if (key === path || key.startsWith(path + "?")) {
        this.drop(key);
        dropped++;
      }
    }
    return dropped;
  }

  invalidateTag(tag: string): number {
    const keys = this.byTag.get(tag);
    if (!keys) return 0;
    let dropped = 0;
    for (const key of [...keys]) {
      this.drop(key);
      dropped++;
    }
    return dropped;
  }

  get size(): number {
    return this.pages.size;
  }
}

// the copy is rendered as nobody: no cookies, no authorization, plain GET -
// whatever the loader personalises from is simply not there, so the shared
// property holds by construction instead of by trust in every loader. and
// as an identity client: renderPage gzips for whoever accepts it, and a
// coded copy would be bytes the residue check cannot read and a body served
// to clients that never asked for that coding. one canonical representation
// is stored; the coding is negotiated again at every replay
export function anonymised(req: Request): Request {
  const headers = new Headers(req.headers);
  headers.delete("cookie");
  headers.delete("authorization");
  headers.delete("accept-encoding");
  return new Request(req.url, { method: "GET", headers });
}

// what the server hands the orchestrator: a shared-mode render of one route
export type SharedRender = (req: Request) => Promise<Response>;

type RouteLike = { pattern: string; module: { revalidate?: unknown; tags?: unknown } };

export const CACHE_STATE_HEADER = "X-Borgo-Cache";

// one orchestrator per server, production only. handle() answers null for
// "not mine" - wrong method, no opt-in, invalid opt-in (warned once by
// name) - and the caller renders exactly as before, so a tree with no
// revalidate export cannot tell isr exists.
export class Isr {
  private cache = new PageCache();
  private inflight = new Map<string, Promise<CachedPage | Response>>();
  private policies = new Map<string, IsrPolicy | null>();
  private noted = new Set<string>();
  constructor(
    private log: (line: string) => void = (line) => console.error(line),
    private now: () => number = Date.now,
  ) {}

  private note(key: string, line: string): void {
    if (this.noted.has(key)) return;
    this.noted.add(key);
    this.log(line);
  }

  private policyFor(route: RouteLike): IsrPolicy | null {
    const known = this.policies.get(route.pattern);
    if (known !== undefined) return known;
    const read = readIsrPolicy(route.module);
    if (typeof read === "string") {
      this.note(`policy:${route.pattern}`, `${route.pattern}: ${read} - served fresh, never cached`);
      this.policies.set(route.pattern, null);
      return null;
    }
    this.policies.set(route.pattern, read);
    return read;
  }

  async handle(req: Request, route: RouteLike, render: SharedRender): Promise<Response | null> {
    if (req.method !== "GET" && req.method !== "HEAD") return null;
    const policy = this.policyFor(route);
    if (!policy) return null;

    const url = new URL(req.url);
    const key = url.pathname + url.search;
    const entry = this.cache.get(key);
    if (entry && this.cache.fresh(entry, policy, this.now())) {
      return this.respond(req, entry, "hit");
    }
    if (entry) {
      // stale is still a page: served now, replaced in the background, one
      // regeneration however wide the burst - and a regeneration that fails
      // leaves the last good copy serving, said once
      void this.regenerate(key, req, route, policy, render).catch((error) => {
        this.note(
          `regen:${key}`,
          `${key}: regeneration failed, serving the last good copy (${error instanceof Error ? error.message : error})`,
        );
      });
      return this.respond(req, entry, "stale");
    }
    const made = await this.regenerate(key, req, route, policy, render);
    if (made instanceof Response) return made;
    return this.respond(req, made, "miss");
  }

  // single-flight: every concurrent miss on one key awaits the same render.
  // the entry is keyed before the await so a burst arriving mid-render joins
  // instead of rendering again
  private regenerate(
    key: string,
    req: Request,
    route: RouteLike,
    policy: IsrPolicy,
    render: SharedRender,
  ): Promise<CachedPage | Response> {
    const running = this.inflight.get(key);
    if (running) return running;
    const flight = (async (): Promise<CachedPage | Response> => {
      const rendered = await render(anonymised(req));
      const html = await rendered.text();
      const refusal = unstorable(rendered.status, rendered.headers, html);
      if (refusal) {
        this.note(
          `store:${key}`,
          `${key}: declares revalidate but ${refusal.reason} - served fresh, never cached`,
        );
        // the body was consumed to ask the question: rebuilt, with the state named
        const headers = new Headers(rendered.headers);
        headers.set(CACHE_STATE_HEADER, "bypass");
        return new Response(html, { status: rendered.status, headers });
      }
      const body = new TextEncoder().encode(html);
      const entry: CachedPage = {
        body,
        gzip: Bun.gzipSync(body),
        status: rendered.status,
        headers: [...rendered.headers.entries()],
        storedAt: this.now(),
        tags: policy.tags,
      };
      this.cache.store(key, entry);
      this.noted.delete(`regen:${key}`);
      return entry;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, flight);
    return flight;
  }

  // the stored copy is identity; the coding is negotiated per replay, like
  // renderPage negotiates per render. Vary: Accept-Encoding is already in
  // the stored headers, renderPage put it there
  private respond(req: Request, entry: CachedPage, state: "hit" | "stale" | "miss"): Response {
    const headers = new Headers(entry.headers);
    headers.set(CACHE_STATE_HEADER, state);
    const gzip = entry.gzip && pickEncoding(req.headers.get("accept-encoding"), ["gzip"]);
    const body = gzip ? entry.gzip! : entry.body;
    if (gzip) headers.set("Content-Encoding", "gzip");
    headers.set("Content-Length", String(body.byteLength));
    return new Response(body.slice(), { status: entry.status, headers });
  }

  invalidatePath(path: string): number {
    const dropped = this.cache.invalidatePath(path);
    this.log(`revalidate ${path}: ${dropped} cached ${dropped === 1 ? "copy" : "copies"} dropped`);
    return dropped;
  }

  invalidateTag(tag: string): number {
    const dropped = this.cache.invalidateTag(tag);
    this.log(`revalidate tag ${tag}: ${dropped} cached ${dropped === 1 ? "copy" : "copies"} dropped`);
    return dropped;
  }
}

// the internal topic borgo.Revalidate rides on __borgo/publish: intercepted
// server-side before topic validation and never fanned out. the "$" prefix
// keeps it out of the namespace client topics are allowed to use
export const REVALIDATE_TOPIC = "$borgo/revalidate";
