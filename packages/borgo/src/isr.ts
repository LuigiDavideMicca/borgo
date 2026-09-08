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
