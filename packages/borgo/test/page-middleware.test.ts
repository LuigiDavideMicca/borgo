// Phase 2, step 4a: the rules of middleware.ts, tested without a server.
import { describe, expect, test } from "bun:test";
import {
  compileMatcher,
  decidePage,
  matcherRefusal,
  next,
  patternsOverlap,
  resolvePageMiddleware,
  rewrite,
  type PageMiddleware,
} from "../src/page-middleware";

describe("the matcher grammar", () => {
  test("paths, parameters and a final wildcard compile", () => {
    for (const entry of ["/", "/app", "/app/:path*", "/w/:slug/:path*", "/tasks/:id", "/:section"]) {
      expect(matcherRefusal(entry)).toBe("");
    }
  });

  test("anything else is refused with its reason", () => {
    const cases: Array<[unknown, string]> = [
      ["", "non-empty"],
      [42, "non-empty"],
      ["app", "must start with /"],
      ["/app/", "must not end with /"],
      ["/app//x", "empty segment"],
      ["/app/*", "only as a final :name* segment"],
      ["/:path*/x", "only last"],
      ["/:1bad", "without a valid name"],
      ["/app?x=1", "without a query"],
      // compared against the decoded path, an encoded entry would never match
      ["/%61dmin", "decoded path"],
      ["/citt%C3%A0", "decoded path"],
    ];
    for (const [entry, reason] of cases) {
      expect(matcherRefusal(entry)).toContain(reason);
    }
  });

  // the one rule of middleware.ts: the api is guarded in go
  test("a matcher naming /api or /__borgo is refused, with the reason", () => {
    for (const entry of ["/api", "/api/:path*", "/api/admin", "/__borgo/:path*"]) {
      expect(matcherRefusal(entry)).toContain("api/middleware.go");
    }
    // a parameter in the first segment is a page matcher: go answers /api
    // before this process could ever be asked about it
    expect(matcherRefusal("/:section")).toBe("");
  });

  test("parameters are captured and decoded", () => {
    const match = compileMatcher("/w/:slug/:path*");
    expect(match("/w/acme/settings/billing")).toEqual({ slug: "acme", path: "settings/billing" });
    expect(match("/w/acme")).toEqual({ slug: "acme", path: "" });
    expect(match("/w/caf%C3%A9/x")).toEqual({ slug: "café", path: "x" });
    expect(match("/w")).toBeNull();
    expect(match("/x/acme")).toBeNull();
    expect(compileMatcher("/app/:path*")("/apple")).toBeNull();
    expect(compileMatcher("/tasks/:id")("/tasks/1/edit")).toBeNull();
  });

  // the router matches a static segment as written or decoded, and a browser
  // sends /città as /citt%C3%A0: a matcher that compared literally rendered
  // the page and never ran the guard (found by the verifier of phase 2)
  test("a static segment matches decoded, as the router matches it", () => {
    expect(compileMatcher("/città")("/citt%C3%A0")).toEqual({});
    expect(compileMatcher("/città")("/città")).toEqual({});
    expect(compileMatcher("/città/:path*")("/citt%C3%A0/menu")).toEqual({ path: "menu" });
    expect(compileMatcher("/città")("/citta")).toBeNull();
  });

  test("the guard runs for the encoded spelling of a guarded page", async () => {
    const mw = resolvePageMiddleware({
      matcher: ["/città"],
      middleware: ((_request, { session }) => (session ? next() : new Response(null, { status: 303, headers: { Location: "/login" } }))) as PageMiddleware,
    })!;
    for (const spelling of ["/citt%C3%A0", "/città"]) {
      const url = new URL(`http://app.test${spelling}`);
      const decision = await decidePage(mw, new Request(url), url, { session: null, locals: {} });
      expect(`${spelling}: ${decision.kind}`).toBe(`${spelling}: respond`);
    }
  });
});

describe("a page that can be reached under the guard", () => {
  test("overlap is conservative: maybe reads as yes", () => {
    const cases: Array<[string, string, boolean]> = [
      ["/posts/:slug", "/posts/secret", true],
      ["/admin", "/admin/:path*", true],
      ["/admin/users", "/admin/:path*", true],
      ["/", "/:path*", true],
      ["/tasks/:id", "/tasks/:id", true],
      // a static page under a parameter of the matcher
      ["/w/acme", "/w/:slug", true],
      ["/posts/:slug", "/admin/:path*", false],
      ["/a/b", "/a", false],
      ["/about", "/app/:path*", false],
    ];
    for (const [route, entry, want] of cases) {
      expect(`${route} under ${entry}: ${patternsOverlap(route, entry)}`).toBe(`${route} under ${entry}: ${want}`);
    }
  });
});

describe("resolvePageMiddleware refuses what would guard nothing", () => {
  test("no middleware.ts is no guard", () => {
    expect(resolvePageMiddleware(null)).toBeNull();
  });

  test("each mistake refuses the boot by name", () => {
    expect(() => resolvePageMiddleware({ matcher: ["/app/:path*"] })).toThrow(/export a function named middleware/);
    expect(() => resolvePageMiddleware({ middleware: () => next(), matcher: "/app" })).toThrow(/array of path strings/);
    expect(() => resolvePageMiddleware({ middleware: () => next(), matcher: [] })).toThrow(/empty matcher guards nothing/);
    expect(() => resolvePageMiddleware({ middleware: () => next(), matcher: ["/api/:path*"] })).toThrow(/api\/middleware.go/);
  });

  test("without a matcher every page is guarded", () => {
    const mw = resolvePageMiddleware({ middleware: () => next() })!;
    expect(mw.covers("/anything")).toEqual({});
    expect(mw.guardsRoute("/posts/:slug")).toBe(true);
  });
});

describe("decidePage", () => {
  const url = (path: string) => new URL(`http://app.example${path}`);
  const facts = { session: { userId: 7 }, locals: { role: "admin" } };
  const resolved = (run: PageMiddleware, matcher = ["/app/:path*"]) => resolvePageMiddleware({ middleware: run, matcher })!;

  test("a path outside the matcher never calls the middleware", async () => {
    let called = false;
    const mw = resolved(() => {
      called = true;
      return next();
    });
    expect(await decidePage(mw, new Request(url("/about")), url("/about"), facts)).toEqual({
      kind: "continue",
      pathname: "/about",
      headers: {},
    });
    expect(called).toBe(false);
  });

  test("the middleware sees the verified facts and its params", async () => {
    let seen: unknown;
    const mw = resolved((_req, ctx) => {
      seen = { params: ctx.params, session: ctx.session, locals: ctx.locals, path: ctx.url.pathname };
      return next({ headers: { "x-role": "admin" } });
    });
    const decision = await decidePage(mw, new Request(url("/app/settings")), url("/app/settings"), facts);
    expect(seen).toEqual({ params: { path: "settings" }, session: { userId: 7 }, locals: { role: "admin" }, path: "/app/settings" });
    expect(decision).toEqual({ kind: "continue", pathname: "/app/settings", headers: { "x-role": "admin" } });
  });

  test("a Response is the answer", async () => {
    const mw = resolved(() => new Response(null, { status: 303, headers: { Location: "/login" } }));
    const decision = await decidePage(mw, new Request(url("/app")), url("/app"), facts);
    expect(decision.kind).toBe("respond");
    expect(decision.kind === "respond" && decision.response.headers.get("Location")).toBe("/login");
  });

  test("a rewrite renders another page of the app, once", async () => {
    const mw = resolved(() => rewrite("/403"));
    expect(await decidePage(mw, new Request(url("/app/x")), url("/app/x"), facts)).toEqual({
      kind: "continue",
      pathname: "/403",
      headers: {},
    });
  });

  test("a rewrite out of the app, to itself, to the api or with a query is refused", async () => {
    for (const [target, reason] of [
      ["https://elsewhere.example/", "inside this app"],
      ["//elsewhere.example/", "inside this app"],
      ["/app/x", "to itself"],
      ["/api/admin", "cannot reach /api"],
      ["/403?why=1", "without a query"],
    ] as const) {
      const mw = resolved(() => rewrite(target));
      await expect(decidePage(mw, new Request(url("/app/x")), url("/app/x"), facts)).rejects.toThrow(reason);
    }
  });

  test("returning nothing is a mistake, not a pass", async () => {
    const mw = resolved((() => undefined) as unknown as PageMiddleware);
    await expect(decidePage(mw, new Request(url("/app")), url("/app"), facts)).rejects.toThrow(/returned nothing/);
  });
});
