// The page policies the render service declares to the go front, which
// owns the shared html cache (isr.go). What a page exports about being
// shareable is read here, in the process that imports the page module;
// keying, storing, replaying, invalidating and persisting are the front's.
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
  // trimmed AND unicode-normalized, symmetrically with normalizeTag on the
  // invalidation side: a page tagged " news " was stored under "news" and
  // RevalidateTag(" news ") - the spelling its author sees in their own
  // source - dropped 0, silently; NFD "café" against NFC "café" the same
  return { seconds, tags: tags.map((t: string) => normalizeTag(t)) };
}

// the one spelling of a tag, on both sides of the bridge: what the page
// declares and what Go sends must meet on equal bytes, whatever the editor's
// whitespace or unicode normal form did to either
export const normalizeTag = (tag: string): string => tag.trim().normalize("NFC");

// a page as this file needs to see it: its url pattern and the module it
// was imported from
type RouteLike = { pattern: string; module: { revalidate?: unknown; tags?: unknown } };

// what the render service declares to the go front, which owns the page
// cache in the new topology: every route's policy, read once. an invalid
// opt-in is reported by name here as it would have been by policyFor, and
// travels as "not cacheable" - the typo must not be hidden by a cache it
// never entered
export type IsrPolicyEntry = { pattern: string; seconds: number | "manual" | null; tags: string[] };

export function isrPolicyTable(
  routes: ReadonlyArray<RouteLike>,
  warn: (line: string) => void = (line) => console.error(line),
  // whether middleware.ts guards a page of this pattern. The go front answers
  // a cached copy without asking this process anything - that is the cache's
  // whole point - so a shared copy of a guarded page would be served past the
  // guard. Such a page is never shared: the failure direction is "served
  // fresh", never "served to somebody the guard would have refused"
  guarded: (pattern: string) => boolean = () => false,
): IsrPolicyEntry[] {
  return routes.map((route) => {
    const read = readIsrPolicy(route.module);
    if (typeof read === "string") {
      warn(`${route.pattern}: ${read} - served fresh, never cached`);
      return { pattern: route.pattern, seconds: null, tags: [] };
    }
    if (read === null) return { pattern: route.pattern, seconds: null, tags: [] };
    if (guarded(route.pattern)) {
      warn(
        `${route.pattern}: exports revalidate but middleware.ts guards it - served fresh, never cached, because the go front's cache would serve a copy without running the guard (a guard in api/middleware.go runs before the cache)`,
      );
      return { pattern: route.pattern, seconds: null, tags: [] };
    }
    return { pattern: route.pattern, seconds: read.seconds, tags: read.tags };
  });
}

// set on a shared render whose suspense onError fired: react completes such
// a render as a 200 serving its fallback, and the front's storability guard
// cannot see that from the bytes. It travels as a header, so the front can
// refuse a degraded document rather than share it (isr.go, unstorable)
export const RENDER_ERRORED_HEADER = "X-Borgo-Render-Errored";
