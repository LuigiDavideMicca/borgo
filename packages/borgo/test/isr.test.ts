import { describe, expect, test } from "bun:test";
import {
  MAX_CACHED_PAGES,
  PageCache,
  readIsrPolicy,
  unstorable,
  type CachedPage,
} from "../src/isr";
import { CSRF_FIELD } from "../src/index";

const page = (over: Partial<CachedPage> = {}): CachedPage => ({
  body: new TextEncoder().encode("<html>ok</html>"),
  status: 200,
  headers: [["Content-Type", "text/html; charset=utf-8"]],
  storedAt: 1_000_000,
  tags: [],
  ...over,
});

describe("readIsrPolicy", () => {
  test("no revalidate export is an opt-out, not an error", () => {
    expect(readIsrPolicy({})).toBeNull();
    expect(readIsrPolicy({ tags: ["posts"] })).toBeNull();
  });

  test("seconds and manual are the two shapes", () => {
    expect(readIsrPolicy({ revalidate: 300 })).toEqual({ seconds: 300, tags: [] });
    expect(readIsrPolicy({ revalidate: "manual" })).toEqual({ seconds: "manual", tags: [] });
  });

  test("tags ride along, trimmed", () => {
    expect(readIsrPolicy({ revalidate: 60, tags: [" posts ", "home"] })).toEqual({
      seconds: 60,
      tags: ["posts", "home"],
    });
  });

  // serving would hide the typo forever: the wrong opt-in is named, not guessed at
  test("a wrong opt-in is named, never guessed at", () => {
    for (const bad of [0, -1, NaN, Infinity, "300", true, null]) {
      const got = readIsrPolicy({ revalidate: bad });
      expect(typeof got).toBe("string");
      expect(got as string).toContain("revalidate");
    }
    const badTags = readIsrPolicy({ revalidate: 60, tags: ["ok", ""] });
    expect(typeof badTags).toBe("string");
    expect(badTags as string).toContain("tags");
  });
});

describe("unstorable", () => {
  const html = "<html><body><h1>hello</h1></body></html>";

  test("a clean 200 is storable", () => {
    expect(unstorable(200, new Headers({ "Content-Type": "text/html" }), html)).toBeNull();
  });

  test("any non-200 is refused by status", () => {
    for (const status of [301, 302, 404, 500]) {
      expect(unstorable(status, new Headers(), html)?.reason).toContain(String(status));
    }
  });

  test("a set-cookie under any spelling refuses the copy", () => {
    for (const key of ["Set-Cookie", "set-cookie", "SET-COOKIE"]) {
      const h = new Headers();
      h.append(key, "session=abc; Path=/");
      expect(unstorable(200, h, html)?.reason).toContain("cookie");
    }
  });

  // the same residue the exporter refuses: a per-request token frozen into a
  // shared copy is a broken form that looks like a working one
  test("a csrf field in the bytes refuses the copy, wherever it came from", () => {
    const withField = `<html><form><input type="hidden" name="${CSRF_FIELD}" value="tok"></form></html>`;
    const got = unstorable(200, new Headers(), withField);
    expect(got?.reason).toContain("CsrfField");
  });

  test("a nonce in the bytes refuses the copy", () => {
    const withNonce = '<html><script nonce="abc123">x()</script></html>';
    expect(unstorable(200, new Headers(), withNonce)?.reason).toContain("per-request");
  });

  // react escapes < in text and scriptJson escapes it in props: only a real
  // tag can match, so a page ABOUT csrf is not refused for naming it
  test("the field name as text is not a field", () => {
    const asText = `<html><p>use ${CSRF_FIELD} in your form</p></html>`;
    expect(unstorable(200, new Headers(), asText)).toBeNull();
  });
});

describe("PageCache", () => {
  test("fresh answers by clock against the policy, and manual never expires", () => {
    const cache = new PageCache();
    const entry = page({ storedAt: 1000 });
    expect(cache.fresh(entry, { seconds: 60, tags: [] }, 1000 + 59_999)).toBe(true);
    expect(cache.fresh(entry, { seconds: 60, tags: [] }, 1000 + 60_000)).toBe(false);
    expect(cache.fresh(entry, { seconds: "manual", tags: [] }, Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  test("an exact path invalidation drops the page and its query variants", () => {
    const cache = new PageCache();
    cache.store("/blog/a", page());
    cache.store("/blog/a?page=2", page());
    cache.store("/blog/ab", page());
    expect(cache.invalidatePath("/blog/a")).toBe(2);
    expect(cache.get("/blog/a")).toBeUndefined();
    expect(cache.get("/blog/a?page=2")).toBeUndefined();
    // /blog/ab is a different page, not a query variant
    expect(cache.get("/blog/ab")).toBeDefined();
  });

  test("a trailing star drops the prefix, and the count says what matched", () => {
    const cache = new PageCache();
    cache.store("/blog/a", page());
    cache.store("/blog/b", page());
    cache.store("/docs/c", page());
    expect(cache.invalidatePath("/blog/*")).toBe(2);
    expect(cache.invalidatePath("/blog/*")).toBe(0);
    expect(cache.get("/docs/c")).toBeDefined();
  });

  test("a tag drops every page that declared it, and only those", () => {
    const cache = new PageCache();
    cache.store("/a", page({ tags: ["posts"] }));
    cache.store("/b", page({ tags: ["posts", "home"] }));
    cache.store("/c", page({ tags: ["home"] }));
    expect(cache.invalidateTag("posts")).toBe(2);
    expect(cache.get("/a")).toBeUndefined();
    expect(cache.get("/b")).toBeUndefined();
    expect(cache.get("/c")).toBeDefined();
    // /b is gone: its other tag must not resurrect it later
    expect(cache.invalidateTag("home")).toBe(1);
  });

  // an attacker who can vary a query must not grow the cache without limit,
  // and must not be able to pin it full of junk either - eviction is by use
  test("the cache is bounded, and eviction is least-recently-used", () => {
    const cache = new PageCache();
    for (let i = 0; i < MAX_CACHED_PAGES; i++) cache.store(`/p${i}`, page());
    expect(cache.size).toBe(MAX_CACHED_PAGES);
    // touch the oldest so it becomes the newest
    expect(cache.get("/p0")).toBeDefined();
    cache.store("/one-more", page());
    expect(cache.size).toBe(MAX_CACHED_PAGES);
    // /p1 was the least recently used, not /p0
    expect(cache.get("/p0")).toBeDefined();
    expect(cache.get("/p1")).toBeUndefined();
  });

  test("eviction cleans the tag index with the page", () => {
    const cache = new PageCache();
    for (let i = 0; i < MAX_CACHED_PAGES + 1; i++) cache.store(`/p${i}`, page({ tags: ["t"] }));
    // /p0 was evicted; the tag drop must count only the survivors
    expect(cache.invalidateTag("t")).toBe(MAX_CACHED_PAGES);
  });
});
