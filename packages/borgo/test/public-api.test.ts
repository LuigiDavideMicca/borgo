// THE PUBLIC SURFACE, PINNED.
//
// borgo's root entry is the application-facing api: what an app writes by
// hand, and nothing else. Everything generated code or a sibling module needs
// lives on a subpath whose name says it is not for you. That rule is easy to
// state and easy to break, because breaking it looks like a convenience - one
// re-export so an import path gets shorter - and nothing else in the build
// notices. These tests notice.
//
// Adding a name to the root list below is a stability promise for all of 1.x.
// Removing one is a breaking change. Neither should be possible by accident,
// so the list is exact rather than a set of `toBeDefined` probes.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as internal from "../src/internal";
import * as root from "../src/index";

const PKG_DIR = join(import.meta.dir, "..");

// value exports only: `export type` is erased and cannot be observed at
// runtime. the type surface is held by tsc, which fails the moment a file
// imports a type this entry no longer re-exports.
const ROOT_VALUES = [
  "ApiError",
  "CSRF_COOKIE",
  "CSRF_FIELD",
  "CSRF_HEADER",
  "CsrfField",
  "Island",
  "apiFetch",
  "csrfCookieValue",
  "redirect",
  "registerServiceWorker",
  "subscribe",
].sort();

const INTERNAL_VALUES = [
  "csrfRuntime",
  "islandRegistry",
  "registerCsrf",
  "registerIslands",
  "unsafeMethod",
  "withCsrf",
].sort();

describe("root entry: borgo-framework", () => {
  test("exports exactly the application-facing api", () => {
    expect(Object.keys(root).sort()).toEqual(ROOT_VALUES);
  });

  // the four the 0.21 audit found leaking. named one by one so a failure says
  // which promise was made by accident rather than "the list changed".
  test.each(["registerCsrf", "registerIslands", "withCsrf"])(
    "%s is not on the root entry - it exists only because generated code calls it",
    (name) => {
      expect(root).not.toHaveProperty(name);
    },
  );

  test.each(["filePathToPattern", "matchRoute", "resolveHead"])(
    "%s is not on the root entry - borgo's own code imports it from ./router",
    (name) => {
      expect(root).not.toHaveProperty(name);
    },
  );

  // removed outright at 0.21: it was reachable, undocumented and called by
  // nothing, and its duplicate-tolerant reading was a footgun sitting next to
  // csrfCookieValue's deliberate duplicate-intolerant one
  test("cookieValue is gone entirely, from the root entry and from /internal", () => {
    expect(root).not.toHaveProperty("cookieValue");
    expect(internal).not.toHaveProperty("cookieValue");
  });

  test("the survivors are still there and still callable", () => {
    expect(typeof root.redirect).toBe("function");
    expect(root.redirect("/x").status).toBe(303);
    expect(root.CSRF_COOKIE).toBe("borgo_csrf");
    expect(root.CSRF_FIELD).toBe("__borgo_csrf");
    expect(root.csrfCookieValue("borgo_csrf=tok")).toBe("tok");
  });

  // the api half of the double submit. an app writes these by hand - the
  // header name into a fetch it rolled itself, apiFetch into every browser
  // mutation of an /api route - so both belong on the stable surface
  test("the csrf header name is the one the front server demands", () => {
    expect(root.CSRF_HEADER).toBe("X-CSRF-Token");
    expect(typeof root.apiFetch).toBe("function");
  });
});

describe("internal subpath: borgo-framework/internal", () => {
  test("exports exactly the registries the mechanical callers need", () => {
    expect(Object.keys(internal).sort()).toEqual(INTERNAL_VALUES);
  });

  test("registerCsrf and withCsrf still work through the subpath", () => {
    const seen: unknown[] = [];
    const context = { Provider: "provider" } as never;
    internal.registerCsrf({
      createElement: ((type: unknown, props: unknown, child: unknown) => {
        seen.push({ type, props, child });
        return "element";
      }) as never,
      createContext: (() => context) as never,
      useContext: (() => "") as never,
    });
    expect(internal.withCsrf("tree" as never, "tok3n")).toBe("element" as never);
    expect(seen).toEqual([{ type: "provider", props: { value: "tok3n" }, child: "tree" }]);
    internal.registerCsrf(null);
    // with nothing registered the tree passes through untouched
    expect(internal.withCsrf("tree" as never, "tok3n")).toBe("tree" as never);
  });
});

describe("package.json exports map", () => {
  const pkg = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8")) as {
    exports: Record<string, string>;
  };

  test("declares ./internal, or nothing can import it", () => {
    expect(pkg.exports["./internal"]).toBe("./src/internal.ts");
  });

  test("every declared subpath points at a file that exists", async () => {
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      expect(await Bun.file(join(PKG_DIR, target)).exists()).toBe(true);
      expect(subpath.startsWith(".")).toBe(true);
    }
  });

  // dropped at 0.21. src/server.ts stays exactly where it is - it is the ssr
  // front server - but it was published either as a supported embedding point
  // or by accident, and nothing in the repository ever imported it through the
  // subpath: cli.ts, export.ts and serve-entry.ts all reach it relatively.
  // Removing an entry from `exports` is breaking, so it happens before 1.0 or
  // never. Re-adding one later is additive, which is why this is the safe
  // order: publish nothing you have no consumer for, add it back on demand.
  test("./server is not published - nothing ever imported it", () => {
    expect(Object.keys(pkg.exports)).not.toContain("./server");
  });

  // once a package declares `exports`, every path not listed is blocked,
  // including deep ones - so this really is unreachable, not merely undocumented
  test("the module is not reachable by a deep path either", () => {
    expect(Object.values(pkg.exports)).not.toContain("./src/server.ts");
    expect(pkg.exports["./*"]).toBeUndefined();
    expect(pkg.exports["./src/*"]).toBeUndefined();
  });
});

// the front server is booted by the cli, not imported by an app. these three
// call sites are what keep `borgo dev`, `borgo build`, `borgo start` and
// `borgo export` working after ./server left the exports map - a well-meaning
// "use the public subpath" refactor here would break all four at once.
describe("the framework reaches its own server relatively", () => {
  test.each(["cli.ts", "export.ts", "serve-entry.ts"])("src/%s", (file) => {
    const source = readFileSync(join(PKG_DIR, "src", file), "utf8");
    expect(source).toMatch(/["']\.\/server["']/);
    expect(source).not.toContain("borgo-framework/server");
  });
});

// build.ts writes these specifiers into .borgo/client.tsx and
// .borgo/islands-client.tsx as literal strings. a wrong one typechecks fine
// here and breaks every app at its next build, so the strings are matched
// against the exports map rather than trusted.
describe("the specifiers build.ts emits into generated entries", () => {
  const source = readFileSync(join(PKG_DIR, "src", "build.ts"), "utf8");
  const pkg = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8")) as {
    name: string;
    exports: Record<string, string>;
  };
  const emitted = [...source.matchAll(/from "(borgo-framework[^"]*)"/g)].map((m) => m[1]);

  test("there are some, so a rename cannot make this suite vacuously green", () => {
    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted).toContain("borgo-framework/internal");
  });

  test("each one is a subpath the package actually exports", () => {
    for (const specifier of new Set(emitted)) {
      const subpath = specifier === pkg.name ? "." : `.${specifier.slice(pkg.name.length)}`;
      expect(Object.keys(pkg.exports)).toContain(subpath);
    }
  });

  test("none of them reaches for the registries through the root entry", () => {
    expect(source).not.toContain('registerCsrf, registerIslands } from "borgo-framework"');
  });
});
