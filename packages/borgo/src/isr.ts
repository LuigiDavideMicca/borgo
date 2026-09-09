// isr: a shared html cache for pages that declare themselves shareable.
//
// the property that must never fail is the guard, so it is built first and
// everything else sits behind it: a page enters the cache only if it was
// rendered from an anonymised request, came back 200, set no cookie under
// any spelling, and its bytes carry no per-request residue - the same
// requestResidue() the exporter asks, one implementation, no drift. the one
// exception is the csp nonce: a file cannot change, so the exporter refuses
// it, but a live server re-mints it on every replay instead. a page
// that fails the guard is served fresh every time and says so once in the
// log; the failure direction is always "no caching", never "shared what was
// personal".
//
// production only, like the asset index: dev rebuilds under stable names and
// a cached page would fight the reload the dev channel just asked for.
import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { pickEncoding } from "./compress";
import { NONCE_RESIDUE, requestResidue, type Residue } from "./export";

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

// the exporter must refuse a nonce - a file cannot change - but a live cache
// can re-mint one per replay, and only then is the page storable: the stored
// copy keeps its render's nonce as the substitution key, and every replay
// swaps it for a fresh one in body and csp header alike. safe because the key
// was minted during the render itself: content that wants to smuggle a
// nonce="..." past the swap would have to contain a value that did not exist
// when the content was written. the guard still requires every nonce
// attribute in the html to equal the header's - a page nonced by anything
// other than this render is not ours to re-mint.
export function remintableNonce(headers: Headers, html: string): string | null {
  const csp = headers.get("content-security-policy");
  const minted = csp && /'nonce-([^']+)'/.exec(csp);
  if (!minted) return null;
  for (const attr of html.matchAll(/<[^>]*\snonce="([^"]*)"/g)) {
    if (attr[1] !== minted[1]) return null;
  }
  return minted[1];
}

export type CachedPage = {
  body: Uint8Array;
  // compressed once at store time, served to whoever negotiates it: the cpu
  // cost sits on the regeneration, never on the hit. absent when the page
  // carries a nonce - those bodies differ per replay and compress per replay
  gzip?: Uint8Array;
  // the substitution key for the per-replay nonce swap; unset for pages
  // rendered without one
  nonce?: string;
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
  // a nonce this render minted is not residue here: replays re-mint it. any
  // other nonce - and every other kind of residue - still refuses the page
  const residue: Residue[] = requestResidue(html).filter(
    (r) => !(r.what === NONCE_RESIDUE && remintableNonce(headers, html) !== null),
  );
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
  // every removal funnels through drop(), so one callback covers invalidation
  // and eviction alike - the persistence layer must never learn of a removal late
  constructor(private onDrop?: (key: string) => void) {}

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
    this.onDrop?.(key);
  }

  // exact path, or every key under a trailing-star prefix: Revalidate("/blog/*")
  // drops /blog and everything below it. returns how many copies went, so the
  // caller can log an invalidation that matched nothing - usually a typo
  invalidatePath(path: string): number {
    let dropped = 0;
    for (const key of [...this.pages.keys()]) {
      if (pathMatchesKey(path, key)) {
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

  // one exact key, quietly: the refusal path drops the copy it just found
  // unshareable without the invalidation log line an operator asked for
  dropKey(key: string): void {
    this.drop(key);
  }

  get size(): number {
    return this.pages.size;
  }
}

// the same matching invalidatePath applies to cached keys, asked of one key:
// exact, a query variant, or under a trailing-star prefix
export function pathMatchesKey(path: string, key: string): boolean {
  if (path.endsWith("*")) return key.startsWith(path.slice(0, -1));
  return key === path || key.startsWith(path + "?");
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
// what survives a restart: the identity body and a meta file per entry, in
// .borgo/cache/html, valid only for the build that rendered it - the build
// id in the meta is the whole invalidation story across deploys, the same
// way hashed asset names are. gzip is recomputed at load: cheap, once, and
// one representation on disk means no way for the pair to disagree
export type IsrPersist = { dir: string; buildId: string };

export type IsrOptions = {
  log?: (line: string) => void;
  now?: () => number;
  persist?: IsrPersist;
  // the per-replay nonce mint, injectable for tests; the default matches
  // renderPage's own token
  mint?: () => string;
};

export class Isr {
  private cache: PageCache;
  private inflight = new Map<string, Promise<CachedPage | "refused">>();
  private policies = new Map<string, IsrPolicy | null>();
  private noted = new Set<string>();
  // keys whose shared render was refused (a cookie, a csrf field): remembered
  // so the wasted anonymised render happens once per window, not per request,
  // with the policy's own tags kept so RevalidateTag can lift the mark. same
  // bound as the cache, same reason: the key carries the query string
  private refused = new Map<string, { at: number; tags: string[] }>();
  // what an invalidation must be able to reach about a render still in
  // flight: found hunting - RevalidateTag during a regeneration was lost,
  // the pre-invalidation copy was stored AFTER the drop and rose again, and
  // under "manual" it lived forever (persisted, too). a doomed flight's
  // result is served once to its waiters and never stored
  private flightMeta = new Map<string, { doomed: boolean; tags: string[] }>();
  private log: (line: string) => void;
  private now: () => number;
  private persist?: IsrPersist;
  private mint: () => string;

  constructor(options: IsrOptions = {}) {
    this.log = options.log ?? ((line) => console.error(line));
    this.now = options.now ?? Date.now;
    this.persist = options.persist;
    this.mint = options.mint ?? (() => crypto.randomUUID().replaceAll("-", ""));
    this.cache = new PageCache((key) => this.removeSaved(key));
    if (this.persist) this.loadSaved(this.persist);
  }

  private fileFor(key: string): string {
    const hash = new Bun.CryptoHasher("sha256").update(key).digest("hex").slice(0, 32);
    return `${this.persist!.dir}/${hash}`;
  }

  private saveEntry(key: string, entry: CachedPage): void {
    if (!this.persist) return;
    const base = this.fileFor(key);
    const meta = {
      key,
      status: entry.status,
      headers: entry.headers,
      storedAt: entry.storedAt,
      tags: entry.tags,
      nonce: entry.nonce,
      buildId: this.persist.buildId,
    };
    // fire and forget: a disk that stopped taking writes must not slow a
    // response down, and the cache keeps working from memory - said once
    void Promise.all([
      Bun.write(`${base}.html`, entry.body.slice()),
      Bun.write(`${base}.json`, JSON.stringify(meta)),
    ]).catch((error) => {
      this.note("persist", `isr cache not persisted (${error instanceof Error ? error.message : error}) - serving from memory only`);
    });
  }

  private removeSaved(key: string): void {
    if (!this.persist) return;
    const base = this.fileFor(key);
    void Bun.file(`${base}.html`).delete().catch(() => {});
    void Bun.file(`${base}.json`).delete().catch(() => {});
  }

  private loadSaved(persist: IsrPersist): void {
    let names: string[];
    try {
      names = readdirSync(persist.dir);
    } catch {
      return; // first boot: nothing saved yet
    }
    const loaded: Array<{ key: string; entry: CachedPage }> = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const base = `${persist.dir}/${name.slice(0, -5)}`;
      try {
        const meta = JSON.parse(readFileSync(`${base}.json`, "utf8")) as {
          key: string;
          status: number;
          headers: Array<[string, string]>;
          storedAt: number;
          tags: string[];
          nonce?: string;
          buildId: string;
        };
        // a copy from another build renders another tree: swept, not served
        if (meta.buildId !== persist.buildId) throw new Error("stale build");
        const body = new Uint8Array(readFileSync(`${base}.html`));
        loaded.push({
          key: meta.key,
          entry: {
            body,
            gzip: meta.nonce ? undefined : Bun.gzipSync(body),
            nonce: meta.nonce,
            status: meta.status,
            headers: meta.headers,
            storedAt: meta.storedAt,
            tags: meta.tags,
          },
        });
      } catch {
        // unreadable or from another build: the pair goes, silently - a boot
        // sweep is housekeeping, not news
        try {
          unlinkSync(`${base}.json`);
        } catch {}
        try {
          unlinkSync(`${base}.html`);
        } catch {}
      }
    }
    // oldest first, so the lru order after a restart matches the one before it
    loaded.sort((a, b) => a.entry.storedAt - b.entry.storedAt);
    for (const { key, entry } of loaded) this.cache.store(key, entry);
  }

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

  // "unstorable": the page opted in but its render cannot be shared (a
  // cookie, a csrf field, a guard's redirect) - the caller must render the
  // REAL request instead, tokens minted and guards honoured. serving the
  // anonymised render to a real visitor was measured as a form broken for
  // everyone and a logged-in visitor bounced to /login.
  async handle(
    req: Request,
    route: RouteLike,
    render: SharedRender,
  ): Promise<Response | "unstorable" | null> {
    if (req.method !== "GET" && req.method !== "HEAD") return null;
    const policy = this.policyFor(route);
    if (!policy) return null;

    const url = new URL(req.url);
    const key = url.pathname + url.search;
    // a remembered refusal answers without the wasted anonymised render:
    // once per window ("manual": once until an invalidation lifts it), not
    // once per request
    const refusal = this.refused.get(key);
    if (refusal) {
      if (policy.seconds === "manual" || this.now() - refusal.at < policy.seconds * 1000) {
        return "unstorable";
      }
      this.refused.delete(key);
    }
    const entry = this.cache.get(key);
    if (entry && this.cache.fresh(entry, policy, this.now())) {
      return this.respond(req, entry, "hit");
    }
    if (entry) {
      // stale is still a page: served now, replaced in the background, one
      // regeneration however wide the burst - and a regeneration that THROWS
      // leaves the last good copy serving, said once. a regeneration that
      // comes back unshareable instead drops the copy and marks the key, so
      // the next request renders for its own visitor
      void this.regenerate(key, req, route, policy, render).catch((error) => {
        this.note(
          `regen:${key}`,
          `${key}: regeneration failed, serving the last good copy (${error instanceof Error ? error.message : error})`,
        );
      });
      return this.respond(req, entry, "stale");
    }
    const made = await this.regenerate(key, req, route, policy, render);
    if (made === "refused") return "unstorable";
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
  ): Promise<CachedPage | "refused"> {
    const running = this.inflight.get(key);
    if (running) return running;
    // registered before the render starts: an invalidation arriving while
    // the render is in flight dooms it, or the copy it read from the old
    // data would be stored after the drop and rise again
    const meta = { doomed: false, tags: policy.tags };
    this.flightMeta.set(key, meta);
    const flight = (async (): Promise<CachedPage | "refused"> => {
      const rendered = await render(anonymised(req));
      const html = await rendered.text();
      const refusal = unstorable(rendered.status, rendered.headers, html);
      if (refusal) {
        this.note(
          `store:${key}`,
          `${key}: declares revalidate but ${refusal.reason} - served fresh, never cached`,
        );
        // a doomed refusal marks nothing: the data changed under it, and the
        // mark it would leave was lifted by that very invalidation
        if (meta.doomed) return "refused";
        // remembered with the policy's tags, so RevalidateTag can lift the
        // mark; a copy stored before the page turned personal is dropped -
        // replaying it would freeze content the render no longer stands by
        this.refused.set(key, { at: this.now(), tags: policy.tags });
        while (this.refused.size > MAX_CACHED_PAGES) {
          this.refused.delete(this.refused.keys().next().value as string);
        }
        this.cache.dropKey(key);
        return "refused";
      }
      const body = new TextEncoder().encode(html);
      const nonce = remintableNonce(rendered.headers, html) ?? undefined;
      const entry: CachedPage = {
        body,
        gzip: nonce ? undefined : Bun.gzipSync(body),
        nonce,
        status: rendered.status,
        headers: [...rendered.headers.entries()],
        storedAt: this.now(),
        tags: policy.tags,
      };
      // doomed: served once to this flight's waiters - a page rendered a
      // moment before the invalidation would have been just as old - but
      // never stored and never persisted; the next request reads fresh data
      if (!meta.doomed) {
        this.cache.store(key, entry);
        this.saveEntry(key, entry);
      }
      this.noted.delete(`regen:${key}`);
      return entry;
    })().finally(() => {
      this.inflight.delete(key);
      this.flightMeta.delete(key);
    });
    this.inflight.set(key, flight);
    return flight;
  }

  // the stored copy is identity; the coding is negotiated per replay, like
  // renderPage negotiates per render. Vary: Accept-Encoding is already in
  // the stored headers, renderPage put it there
  private respond(req: Request, entry: CachedPage, state: "hit" | "stale" | "miss"): Response {
    const headers = new Headers(entry.headers);
    headers.set(CACHE_STATE_HEADER, state);
    const wantsGzip = !!pickEncoding(req.headers.get("accept-encoding"), ["gzip"]);
    let body: Uint8Array;
    if (entry.nonce) {
      // the swap that makes a nonced page cacheable at all: fresh value, same
      // everywhere the render put the old one - body and csp header agree
      const fresh = this.mint();
      const html = new TextDecoder().decode(entry.body).replaceAll(entry.nonce, fresh);
      const csp = headers.get("content-security-policy");
      if (csp) headers.set("content-security-policy", csp.replaceAll(entry.nonce, fresh));
      body = wantsGzip ? Bun.gzipSync(html) : new TextEncoder().encode(html);
    } else {
      body = entry.gzip && wantsGzip ? entry.gzip : entry.body;
    }
    const coded = entry.nonce ? wantsGzip : !!(entry.gzip && wantsGzip);
    if (coded) headers.set("Content-Encoding", "gzip");
    headers.set("Content-Length", String(body.byteLength));
    return new Response(body.slice(), { status: entry.status, headers });
  }

  invalidatePath(path: string): number {
    const dropped = this.cache.invalidatePath(path);
    // a refusal is state about the data too: the operator saying "this
    // changed" is the escape hatch that lets a page turned personal be tried
    // as shareable again
    for (const key of [...this.refused.keys()]) {
      if (pathMatchesKey(path, key)) this.refused.delete(key);
    }
    for (const [key, meta] of this.flightMeta) {
      if (pathMatchesKey(path, key)) meta.doomed = true;
    }
    this.log(`revalidate ${path}: ${dropped} cached ${dropped === 1 ? "copy" : "copies"} dropped`);
    return dropped;
  }

  invalidateTag(tag: string): number {
    const dropped = this.cache.invalidateTag(tag);
    for (const [key, refusal] of [...this.refused]) {
      if (refusal.tags.includes(tag)) this.refused.delete(key);
    }
    for (const meta of this.flightMeta.values()) {
      if (meta.tags.includes(tag)) meta.doomed = true;
    }
    this.log(`revalidate tag ${tag}: ${dropped} cached ${dropped === 1 ? "copy" : "copies"} dropped`);
    return dropped;
  }
}

// the internal topic borgo.Revalidate rides on __borgo/publish: intercepted
// server-side before topic validation and never fanned out. the "$" prefix
// keeps it out of the namespace client topics are allowed to use
export const REVALIDATE_TOPIC = "$borgo/revalidate";
