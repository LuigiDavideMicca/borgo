import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  anonymised,
  CACHE_STATE_HEADER,
  Isr,
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

  test("a nonce without the header that minted it refuses the copy", () => {
    const withNonce = '<html><script nonce="abc123">x()</script></html>';
    expect(unstorable(200, new Headers(), withNonce)?.reason).toContain("per-request");
  });

  // the exporter refuses a nonce because a file cannot change; a live cache
  // re-mints it per replay, so the render's own nonce is storable
  test("a nonce the render itself minted is storable", () => {
    const h = new Headers({ "Content-Security-Policy": "script-src 'self' 'nonce-abc123'" });
    const withNonce = '<html><script nonce="abc123">x()</script></html>';
    expect(unstorable(200, h, withNonce)).toBeNull();
  });

  test("a nonce that is not the header's refuses the copy - not ours to re-mint", () => {
    const h = new Headers({ "Content-Security-Policy": "script-src 'self' 'nonce-abc123'" });
    const foreign =
      '<html><script nonce="abc123">x()</script><script nonce="other">y()</script></html>';
    expect(unstorable(200, h, foreign)?.reason).toContain("per-request");
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

describe("the orchestrator", () => {
  const routeOf = (module: Record<string, unknown>, pattern = "/p") => ({ pattern, module });
  const reqFor = (url: string, headers: Record<string, string> = {}) =>
    new Request(`http://x${url}`, { headers });

  function harness(over: { now?: () => number; body?: () => string; log?: string[]; persist?: { dir: string; buildId: string } } = {}) {
    const log = over.log ?? [];
    const renders: Request[] = [];
    let body = over.body ?? (() => "<html>v1</html>");
    const isr = new Isr({ log: (line) => log.push(line), now: over.now ?? (() => 1_000_000), persist: over.persist });
    const render = async (req: Request) => {
      renders.push(req);
      return new Response(body(), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    };
    return { isr, render, renders, log, setBody: (fn: () => string) => (body = fn) };
  }

  test("no opt-in is none of isr's business", async () => {
    const { isr, render, renders } = harness();
    expect(await isr.handle(reqFor("/p"), routeOf({}), render)).toBeNull();
    expect(renders.length).toBe(0);
  });

  test("an invalid opt-in is warned once by name and served fresh", async () => {
    const { isr, render, log } = harness();
    const route = routeOf({ revalidate: "soon" });
    expect(await isr.handle(reqFor("/p"), route, render)).toBeNull();
    expect(await isr.handle(reqFor("/p"), route, render)).toBeNull();
    expect(log.filter((l) => l.includes("revalidate")).length).toBe(1);
    expect(log[0]).toContain("/p");
  });

  test("a miss renders once as nobody, then hits without rendering", async () => {
    const { isr, render, renders } = harness();
    const route = routeOf({ revalidate: 60 });
    const first = await isr.handle(reqFor("/p", { cookie: "session=abc" }), route, render);
    expect(first!.headers.get(CACHE_STATE_HEADER)).toBe("miss");
    expect(await first!.text()).toBe("<html>v1</html>");
    // the render never saw the visitor's cookie: shared by construction
    expect(renders[0].headers.get("cookie")).toBeNull();

    const second = await isr.handle(reqFor("/p", { cookie: "session=other" }), route, render);
    expect(second!.headers.get(CACHE_STATE_HEADER)).toBe("hit");
    expect(await second!.text()).toBe("<html>v1</html>");
    expect(renders.length).toBe(1);
  });

  test("a burst of misses is one render", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const renders: Request[] = [];
    const isr = new Isr({ log: () => {} });
    const render = async (req: Request) => {
      renders.push(req);
      await gate;
      return new Response("<html>once</html>", {
        headers: { "Content-Type": "text/html" },
      });
    };
    const route = routeOf({ revalidate: 60 });
    const burst = Promise.all(
      Array.from({ length: 8 }, () => isr.handle(reqFor("/p"), route, render)),
    );
    release();
    const responses = await burst;
    expect(renders.length).toBe(1);
    for (const res of responses) expect(await res!.text()).toBe("<html>once</html>");
  });

  test("stale serves the old copy now and swaps in the new one behind", async () => {
    let t = 1_000_000;
    const { isr, render, renders, setBody } = harness({ now: () => t });
    const route = routeOf({ revalidate: 60 });
    await isr.handle(reqFor("/p"), route, render);
    setBody(() => "<html>v2</html>");
    t += 61_000;
    const stale = await isr.handle(reqFor("/p"), route, render);
    expect(stale!.headers.get(CACHE_STATE_HEADER)).toBe("stale");
    expect(await stale!.text()).toBe("<html>v1</html>");
    // the background regeneration ran exactly once
    await Bun.sleep(0);
    expect(renders.length).toBe(2);
    const after = await isr.handle(reqFor("/p"), route, render);
    expect(after!.headers.get(CACHE_STATE_HEADER)).toBe("hit");
    expect(await after!.text()).toBe("<html>v2</html>");
  });

  test("a failed regeneration keeps serving the last good copy, said once", async () => {
    let t = 1_000_000;
    let fail = false;
    const log: string[] = [];
    const isr = new Isr({ log: (line) => log.push(line), now: () => t });
    const render = async () => {
      if (fail) throw new Error("api down");
      return new Response("<html>good</html>", { headers: { "Content-Type": "text/html" } });
    };
    const route = routeOf({ revalidate: 60 });
    await isr.handle(reqFor("/p"), route, render);
    fail = true;
    t += 61_000;
    for (let i = 0; i < 3; i++) {
      const res = await isr.handle(reqFor("/p"), route, render);
      expect(await res!.text()).toBe("<html>good</html>");
      await Bun.sleep(0);
    }
    expect(log.filter((l) => l.includes("last good copy")).length).toBe(1);
    // recovery clears the note, so a later failure is news again
    fail = false;
    t += 61_000;
    await isr.handle(reqFor("/p"), route, render);
    await Bun.sleep(0);
  });

  test("a response that sets a cookie is bypassed, warned once, and never shared", async () => {
    const log: string[] = [];
    const renders: Request[] = [];
    const isr = new Isr({ log: (line) => log.push(line) });
    const render = async (req: Request) => {
      renders.push(req);
      const headers = new Headers({ "Content-Type": "text/html" });
      headers.append("Set-Cookie", "session=abc");
      return new Response("<html>personal</html>", { headers });
    };
    const route = routeOf({ revalidate: 60 });
    const first = await isr.handle(reqFor("/p"), route, render);
    expect(first!.headers.get(CACHE_STATE_HEADER)).toBe("bypass");
    const second = await isr.handle(reqFor("/p"), route, render);
    expect(second!.headers.get(CACHE_STATE_HEADER)).toBe("bypass");
    // fresh every time - a bypass must never become a shared copy
    expect(renders.length).toBe(2);
    expect(log.filter((l) => l.includes("cookie")).length).toBe(1);
  });

  test("a csrf field in the copy is bypassed like the exporter refuses it", async () => {
    const { isr, render, log, setBody } = harness();
    setBody(() => `<html><input name="${CSRF_FIELD}"></html>`);
    const route = routeOf({ revalidate: 60 });
    const res = await isr.handle(reqFor("/p"), route, render);
    expect(res!.headers.get(CACHE_STATE_HEADER)).toBe("bypass");
    expect(log.some((l) => l.includes("CsrfField"))).toBe(true);
  });

  test("path and tag invalidation force the next request to render again", async () => {
    const { isr, render, renders, setBody } = harness();
    const posts = routeOf({ revalidate: "manual", tags: ["posts"] }, "/blog");
    await isr.handle(reqFor("/blog"), posts, render);
    setBody(() => "<html>v2</html>");
    expect(isr.invalidatePath("/blog")).toBe(1);
    const after = await isr.handle(reqFor("/blog"), posts, render);
    expect(await after!.text()).toBe("<html>v2</html>");
    expect(renders.length).toBe(2);

    expect(isr.invalidateTag("posts")).toBe(1);
    await isr.handle(reqFor("/blog"), posts, render);
    expect(renders.length).toBe(3);
  });

  test("anonymised strips what personalises, and the coding too", () => {
    const req = new Request("http://x/p?q=1", {
      method: "GET",
      headers: {
        cookie: "s=1",
        authorization: "Bearer t",
        "accept-language": "it",
        "accept-encoding": "gzip, br",
      },
    });
    const anon = anonymised(req);
    expect(anon.headers.get("cookie")).toBeNull();
    expect(anon.headers.get("authorization")).toBeNull();
    // identity on purpose: renderPage gzips for whoever accepts it, and a
    // coded copy would be bytes the residue check cannot read
    expect(anon.headers.get("accept-encoding")).toBeNull();
    expect(anon.headers.get("accept-language")).toBe("it");
    expect(anon.url).toBe("http://x/p?q=1");
  });

  // defence in depth: if the render path ever hands the cache a coded body,
  // the guard refuses it rather than inspecting bytes it cannot read
  test("a coded body is refused before any inspection", () => {
    const h = new Headers({ "Content-Encoding": "gzip" });
    expect(unstorable(200, h, "garbage-that-hides-anything")?.reason).toContain("gzip");
  });

  test("the replay negotiates its own coding: gzip to who accepts it, identity to who does not", async () => {
    const { isr, render } = harnessNegotiation();
    const route = { pattern: "/p", module: { revalidate: 60 } };
    await isr.handle(reqFor("/p"), route, render);

    const gz = await isr.handle(reqFor("/p", { "accept-encoding": "gzip" }), route, render);
    expect(gz!.headers.get("Content-Encoding")).toBe("gzip");
    const raw = new Uint8Array(await gz!.arrayBuffer());
    expect(new TextDecoder().decode(Bun.gunzipSync(raw))).toBe("<html>v1</html>");

    const id = await isr.handle(reqFor("/p"), route, render);
    expect(id!.headers.get("Content-Encoding")).toBeNull();
    expect(await id!.text()).toBe("<html>v1</html>");
  });

  function harnessNegotiation() {
    const isr = new Isr({ log: () => {} });
    const render = async () =>
      new Response("<html>v1</html>", { headers: { "Content-Type": "text/html; charset=utf-8" } });
    return { isr, render };
  }
});

// production pages carry a csp nonce on every inline script; a copy that
// froze one nonce for everyone would let whoever reads the page inject
// against it. so the stored copy keeps its render's nonce as a substitution
// key - a key that never ships, even the miss response is re-minted - and
// every replay swaps in a fresh value, body and header in agreement
describe("nonce re-minting", () => {
  const route = { pattern: "/p", module: { revalidate: 60 } };
  const noncedRender = async () =>
    new Response(
      '<html><script nonce="orig">x()</script><script nonce="orig">window.__PROPS__={}</script></html>',
      {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "script-src 'self' 'nonce-orig'",
        },
      },
    );

  test("every response carries its own fresh nonce, the render's never ships", async () => {
    const mints = ["m1", "m2", "m3"];
    const isr = new Isr({ log: () => {}, mint: () => mints.shift()! });

    const miss = await isr.handle(new Request("http://x/p"), route, noncedRender);
    expect(miss!.headers.get(CACHE_STATE_HEADER)).toBe("miss");
    const missHtml = await miss!.text();
    expect(missHtml).not.toContain("orig");
    expect(missHtml.match(/nonce="m1"/g)?.length).toBe(2);
    expect(miss!.headers.get("content-security-policy")).toBe("script-src 'self' 'nonce-m1'");

    const hit = await isr.handle(new Request("http://x/p"), route, noncedRender);
    expect(hit!.headers.get(CACHE_STATE_HEADER)).toBe("hit");
    const hitHtml = await hit!.text();
    expect(hitHtml.match(/nonce="m2"/g)?.length).toBe(2);
    expect(hitHtml).not.toContain("m1");
    expect(hit!.headers.get("content-security-policy")).toBe("script-src 'self' 'nonce-m2'");
  });

  test("a re-minted replay still negotiates gzip, nonce and coding coherent", async () => {
    const isr = new Isr({ log: () => {}, mint: () => "fresh" });
    await isr.handle(new Request("http://x/p"), route, noncedRender);
    const hit = await isr.handle(
      new Request("http://x/p", { headers: { "accept-encoding": "gzip" } }),
      route,
      noncedRender,
    );
    expect(hit!.headers.get(CACHE_STATE_HEADER)).toBe("hit");
    expect(hit!.headers.get("Content-Encoding")).toBe("gzip");
    const html = new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await hit!.arrayBuffer())));
    expect(html).toContain('nonce="fresh"');
    expect(html).not.toContain("orig");
  });

  test("a nonced copy survives a restart and re-mints from disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-isr-"));
    const persist = { dir, buildId: "b1" };
    const first = new Isr({ log: () => {}, persist, mint: () => "n1" });
    await first.handle(new Request("http://x/p"), route, noncedRender);
    await Bun.sleep(20);

    const failingRender = async () => {
      throw new Error("a warm restart must not render");
    };
    const second = new Isr({ log: () => {}, persist, mint: () => "n2" });
    const res = await second.handle(new Request("http://x/p"), route, failingRender);
    expect(res!.headers.get(CACHE_STATE_HEADER)).toBe("hit");
    const html = await res!.text();
    expect(html.match(/nonce="n2"/g)?.length).toBe(2);
    expect(html).not.toContain("orig");
    expect(html).not.toContain("n1");
    expect(res!.headers.get("content-security-policy")).toBe("script-src 'self' 'nonce-n2'");
  });
});

describe("persistence", () => {
  const routeOf = (module: Record<string, unknown>, pattern = "/p") => ({ pattern, module });
  const reqFor = (url: string) => new Request(`http://x${url}`);
  const tmp = () => mkdtempSync(join(tmpdir(), "borgo-isr-"));
  const route = routeOf({ revalidate: 60 });
  const renderOnce = (renders: number[]) => async () => {
    renders.push(1);
    return new Response("<html>saved</html>", {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  };

  test("a restart serves from disk without rendering, gzip recomputed", async () => {
    const dir = tmp();
    const renders: number[] = [];
    const first = new Isr({ log: () => {}, persist: { dir, buildId: "b1" } });
    await first.handle(reqFor("/p"), route, renderOnce(renders));
    // the write is fire-and-forget: give it the tick it needs
    await Bun.sleep(20);

    const second = new Isr({ log: () => {}, persist: { dir, buildId: "b1" } });
    const res = await second.handle(reqFor("/p"), route, renderOnce(renders));
    expect(res!.headers.get(CACHE_STATE_HEADER)).toBe("hit");
    expect(await res!.text()).toBe("<html>saved</html>");
    expect(renders.length).toBe(1);

    const gz = await second.handle(
      new Request("http://x/p", { headers: { "accept-encoding": "gzip" } }),
      route,
      renderOnce(renders),
    );
    expect(gz!.headers.get("Content-Encoding")).toBe("gzip");
  });

  // a copy from another build renders another tree: swept at boot, not served
  test("another build's copies are swept, and the sweep leaves no files", async () => {
    const dir = tmp();
    const renders: number[] = [];
    const first = new Isr({ log: () => {}, persist: { dir, buildId: "b1" } });
    await first.handle(reqFor("/p"), route, renderOnce(renders));
    await Bun.sleep(20);

    const second = new Isr({ log: () => {}, persist: { dir, buildId: "b2" } });
    const res = await second.handle(reqFor("/p"), route, renderOnce(renders));
    expect(res!.headers.get(CACHE_STATE_HEADER)).toBe("miss");
    expect(renders.length).toBe(2);
    await Bun.sleep(20);
    // only the new build's pair remains on disk
    expect(readdirSync(dir).length).toBe(2);
  });

  test("a corrupt meta is swept, never served", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "deadbeef.json"), "{not json");
    writeFileSync(join(dir, "deadbeef.html"), "<html>junk</html>");
    const renders: number[] = [];
    const isr = new Isr({ log: () => {}, persist: { dir, buildId: "b1" } });
    const res = await isr.handle(reqFor("/p"), route, renderOnce(renders));
    expect(res!.headers.get(CACHE_STATE_HEADER)).toBe("miss");
    expect(readdirSync(dir)).not.toContain("deadbeef.json");
  });

  test("invalidation removes the files with the entry", async () => {
    const dir = tmp();
    const renders: number[] = [];
    const isr = new Isr({ log: () => {}, persist: { dir, buildId: "b1" } });
    await isr.handle(reqFor("/p"), route, renderOnce(renders));
    await Bun.sleep(20);
    expect(readdirSync(dir).length).toBe(2);
    expect(isr.invalidatePath("/p")).toBe(1);
    await Bun.sleep(20);
    expect(readdirSync(dir).length).toBe(0);
  });
});
