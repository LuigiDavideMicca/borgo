import { describe, expect, test } from "bun:test";
import { canonicalPath, filePathToPattern, matchRoute, resolveHead, safeHeadAttrs } from "../src/router";
import { headHtml } from "../src/util";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("filePathToPattern", () => {
  const cases: Array<[string, string]> = [
    ["index.tsx", "/"],
    ["about.tsx", "/about"],
    ["tasks/[id].tsx", "/tasks/:id"],
    ["blog/index.tsx", "/blog"],
    ["a/b/[x].tsx", "/a/b/:x"],
    ["[lang]/docs/[slug].tsx", "/:lang/docs/:slug"],
  ];
  for (const [file, pattern] of cases) {
    test(`${file} -> ${pattern}`, () => {
      expect(filePathToPattern(file)).toBe(pattern);
    });
  }
});

describe("matchRoute", () => {
  const routes = [
    { pattern: "/" },
    { pattern: "/tasks" },
    { pattern: "/tasks/new" },
    { pattern: "/tasks/:id" },
    { pattern: "/a/:x/:y" },
  ];

  test("matches exact segments", () => {
    expect(matchRoute("/tasks", routes)?.route.pattern).toBe("/tasks");
  });

  test("root", () => {
    expect(matchRoute("/", routes)?.route.pattern).toBe("/");
  });

  test("static wins over dynamic when listed first", () => {
    expect(matchRoute("/tasks/new", routes)?.route.pattern).toBe("/tasks/new");
  });

  test("extracts params", () => {
    expect(matchRoute("/tasks/42", routes)?.params).toEqual({ id: "42" });
    expect(matchRoute("/a/1/2", routes)?.params).toEqual({ x: "1", y: "2" });
  });

  test("decodes params", () => {
    expect(matchRoute("/tasks/a%20b", routes)?.params).toEqual({ id: "a b" });
  });

  test("malformed percent-encoding falls back to the raw segment, no throw", () => {
    expect(matchRoute("/tasks/100%", routes)?.params).toEqual({ id: "100%" });
    expect(matchRoute("/tasks/%zz", routes)?.params).toEqual({ id: "%zz" });
  });

  test("static unicode segments match their encoded form", () => {
    const unicodeRoutes = [{ pattern: "/città" }, { pattern: "/docs/héllo" }];
    expect(matchRoute("/citt%C3%A0", unicodeRoutes)?.route.pattern).toBe("/città");
    expect(matchRoute("/docs/h%C3%A9llo", unicodeRoutes)?.route.pattern).toBe("/docs/héllo");
    expect(matchRoute("/città", unicodeRoutes)?.route.pattern).toBe("/città");
  });

  test("ignores trailing slashes", () => {
    expect(matchRoute("/tasks/", routes)?.route.pattern).toBe("/tasks");
    expect(matchRoute("/tasks///", routes)?.route.pattern).toBe("/tasks");
  });

  test("doubled slashes are not an alias of the single-slash route", () => {
    expect(matchRoute("//tasks", routes)).toBeNull();
    expect(matchRoute("//tasks/42", routes)).toBeNull();
    expect(matchRoute("/a//2", routes)).toBeNull();
    expect(matchRoute("/tasks//42", routes)).toBeNull();
  });

  test("an empty segment never binds a param", () => {
    expect(matchRoute("/a/1//", routes)).toBeNull();
  });

  test("returns null when nothing matches", () => {
    expect(matchRoute("/nope/nope", routes)).toBeNull();
    expect(matchRoute("/tasks/1/2", routes)).toBeNull();
  });
});

describe("resolveHead", () => {
  const component = () => null;

  test("object head", () => {
    expect(resolveHead({ default: component, head: { title: "x" } }, {})).toEqual({ title: "x" });
  });

  test("function head receives props", () => {
    const module = {
      default: component,
      head: (props: Record<string, unknown>) => ({ title: `t:${props.name}` }),
    };
    expect(resolveHead(module, { name: "n" })).toEqual({ title: "t:n" });
  });

  test("absent head", () => {
    expect(resolveHead({ default: component }, {})).toEqual({});
  });
});

// ONE head() EXPORT, ONE HEAD.
//
// A head export may be computed from loader data, so its attribute NAMES are as
// untrusted as its values. The server rendered through this filter already; the
// browser runtime's applyHead called setAttribute on whatever it was given, so
// the same meta that the server had escaped or dropped behaved differently on a
// client navigation to the very same page. Two ways, both bad:
//
//   - a name starting with `on` installed a live event handler on an element
//     built out of loader data, which is script execution the csp never sees
//     (it is not an inline script, it is a DOM property assignment);
//   - a name that is not an html token made setAttribute throw
//     InvalidCharacterError - from inside navigate(), AFTER root.render(), so
//     the page was already swapped in, the head half-applied, and the rejection
//     unhandled. Every meta after the bad one was silently lost.
//
// The filter lives in router.ts precisely so both halves import the same one.
describe("safeHeadAttrs: the filter both halves render through", () => {
  test("ordinary meta attributes pass through as strings", () => {
    expect(safeHeadAttrs({ name: "description", content: "hello" })).toEqual([
      ["name", "description"],
      ["content", "hello"],
    ]);
    // values are stringified, never handed on as-is
    expect(safeHeadAttrs({ content: 42 })).toEqual([["content", "42"]]);
    // the og:/twitter: family, and data-/aria- names, are all legal tokens
    expect(safeHeadAttrs({ property: "og:title", "data-x": "1", "aria-label": "a" })).toEqual([
      ["property", "og:title"],
      ["data-x", "1"],
      ["aria-label", "a"],
    ]);
  });

  test("an event-handler name never becomes an attribute, in any casing", () => {
    for (const name of ["onclick", "onClick", "ONERROR", "onmouseover", "onload"]) {
      expect(safeHeadAttrs({ [name]: "alert(1)" })).toEqual([]);
    }
  });

  test("a name setAttribute would throw on is dropped, not passed to the dom", () => {
    for (const name of ["a b", "a=b", '"', "<script>", "", "1abc", "a\nb", "a/b"]) {
      expect(safeHeadAttrs({ [name]: "x" })).toEqual([]);
    }
  });

  test("a refused name does not take the attributes after it with it", () => {
    expect(safeHeadAttrs({ onclick: "alert(1)", name: "description", content: "kept" })).toEqual([
      ["name", "description"],
      ["content", "kept"],
    ]);
  });

  // the point of the shared filter: what the server wrote into the document and
  // what applyHead builds on a client navigation have to be the same set
  test("the server's rendered head agrees with it, name for name", () => {
    const meta = { name: "description", onclick: "alert(1)", "bad name": "x", content: "hello" };
    const html = headHtml({ meta: [meta] });
    for (const [name, value] of safeHeadAttrs(meta)) {
      expect(html).toContain(`${name}="${value}"`);
    }
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("bad name");
  });

  // applyHead is inside mount()'s closure and cannot be imported; this is the
  // wiring assertion that it goes through the filter rather than Object.entries
  test("the browser runtime applies a head through it, not through Object.entries", () => {
    const src = readFileSync(join(import.meta.dir, "../src/runtime.ts"), "utf8");
    const applyHead = src.slice(src.indexOf("function applyHead"), src.indexOf("const propsTtl"));
    expect(applyHead).toContain("safeHeadAttrs(meta)");
    expect(applyHead).not.toContain("Object.entries(meta)");
    // and every meta it appends is marked, so the next navigation removes it
    expect(applyHead).toContain('setAttribute("data-borgo-head", "")');
    expect(applyHead).toContain('querySelectorAll("[data-borgo-head]")');
  });
});

describe("canonicalPath", () => {
  // rfc 3986: a percent-encoding of an unreserved character is an alias of
  // the plain spelling, and every alias the server accepted became its own
  // isr cache key - measured as unbounded stored renders for one page
  test("percent-aliases of unreserved characters collapse to the plain spelling", () => {
    expect(canonicalPath("/ne%77s")).toBe("/news");
    expect(canonicalPath("/%6eews")).toBe("/news");
    expect(canonicalPath("/n%65%77s")).toBe("/news");
    expect(canonicalPath("/%2D%2E%5F%7E")).toBe("/-._~");
  });

  test("a canonical path is already itself", () => {
    expect(canonicalPath("/news")).toBe("/news");
    expect(canonicalPath("/")).toBe("/");
    expect(canonicalPath("/tasks/42")).toBe("/tasks/42");
  });

  // %2F is not an alias of "/": decoding it would change how the path
  // splits, so reserved octets keep their triplet - with canonical hex case
  test("reserved octets stay encoded, and their hex goes uppercase", () => {
    expect(canonicalPath("/a%2Fb")).toBe("/a%2Fb");
    expect(canonicalPath("/a%2fb")).toBe("/a%2Fb");
    expect(canonicalPath("/q%3Fx")).toBe("/q%3Fx");
    expect(canonicalPath("/s%20p")).toBe("/s%20p");
  });

  test("malformed escapes and non-ascii pass through untouched", () => {
    expect(canonicalPath("/x%GGy")).toBe("/x%GGy");
    expect(canonicalPath("/x%2")).toBe("/x%2");
    expect(canonicalPath("/100%")).toBe("/100%");
    expect(canonicalPath("/caf\u00e9")).toBe("/caf\u00e9");
    expect(canonicalPath("/%C3%A9")).toBe("/%C3%A9");
  });
});
