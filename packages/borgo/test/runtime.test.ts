import { describe, expect, test } from "bun:test";

// runtime.ts reads location.origin at call time; the pure helpers it exports
// are testable with a stub, the rest of the file needs a real dom (e2e)
(globalThis as { location?: unknown }).location = { origin: "https://app.test" };

const { asProps, devUpdatePlan, redirectUrl } = await import("../src/runtime");

describe("redirectUrl", () => {
  test("resolves relative and absolute same-origin targets", () => {
    expect(redirectUrl("/tasks")?.href).toBe("https://app.test/tasks");
    expect(redirectUrl("https://app.test/a?b=1")?.href).toBe("https://app.test/a?b=1");
  });

  test("keeps cross-origin http targets, the caller decides", () => {
    expect(redirectUrl("https://other.test/x")?.origin).toBe("https://other.test");
  });

  test("rejects script-bearing schemes: location.assign would run them", () => {
    expect(redirectUrl("javascript:alert(1)")).toBeNull();
    expect(redirectUrl("JavaScript:alert(1)")).toBeNull();
    expect(redirectUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(redirectUrl("blob:https://app.test/abc")).toBeNull();
    expect(redirectUrl("vbscript:msgbox")).toBeNull();
  });

  test("rejects malformed values instead of throwing", () => {
    expect(redirectUrl("http://")).toBeNull();
    expect(redirectUrl("")).not.toBeNull(); // empty resolves to the origin root
  });
});

describe("asProps", () => {
  test("passes objects through", () => {
    const props = { a: 1 };
    expect(asProps(props)).toBe(props);
  });

  test("replaces anything createElement cannot spread", () => {
    expect(asProps("nope")).toEqual({});
    expect(asProps([1, 2])).toEqual({});
    expect(asProps(null)).toEqual({});
    expect(asProps(undefined)).toEqual({});
    expect(asProps(7)).toEqual({});
  });
});

// decided on the whole set: two files 20 ms apart in one rebuild, while on `/`,
// must apply even when the one that survived the debounce is the other
describe("devUpdatePlan", () => {
  test("the page on screen refreshes", () => {
    expect(devUpdatePlan(["pages/index.tsx"], "index.tsx")).toBe("apply");
  });

  test("a save that also touched another page still refreshes this one", () => {
    // THE bug: about.tsx alone would (correctly) skip, but it must not veto
    // index.tsx riding the same rebuild
    expect(devUpdatePlan(["pages/about.tsx", "pages/index.tsx"], "index.tsx")).toBe("apply");
    expect(devUpdatePlan(["pages/index.tsx", "pages/about.tsx"], "index.tsx")).toBe("apply");
  });

  test("a save confined to other pages is still a no-op", () => {
    expect(devUpdatePlan(["pages/about.tsx"], "index.tsx")).toBe("skip");
    expect(devUpdatePlan(["pages/about.tsx", "pages/contact.tsx"], "index.tsx")).toBe("skip");
  });

  test("a module outside pages/ may be under any page, so it applies", () => {
    expect(devUpdatePlan(["components/Nav.tsx"], "index.tsx")).toBe("apply");
    expect(devUpdatePlan(["lib/use-counter.ts"], "about.tsx")).toBe("apply");
    expect(devUpdatePlan(["lib/use-counter.ts", "pages/about.tsx"], "index.tsx")).toBe("apply");
  });

  test("anything fast refresh cannot express reloads, even in company", () => {
    // layouts and the error pages re-render the tree above the page
    expect(devUpdatePlan(["pages/_layout.tsx"], "index.tsx")).toBe("reload");
    expect(devUpdatePlan(["pages/blog/_layout.tsx"], "index.tsx")).toBe("reload");
    expect(devUpdatePlan(["pages/_404.tsx"], "index.tsx")).toBe("reload");
    expect(devUpdatePlan(["pages/_500.tsx"], "index.tsx")).toBe("reload");
    // the shell, and the sentinel for a watcher whose buffer overflowed
    expect(devUpdatePlan(["index.html"], "index.tsx")).toBe("reload");
    expect(devUpdatePlan(["__borgo_unknown__"], "index.tsx")).toBe("reload");
    // one unrefreshable file in the set decides for the whole set
    expect(devUpdatePlan(["pages/index.tsx", "pages/_layout.tsx"], "index.tsx")).toBe("reload");
  });

  test("a page named like a layout is a page, not a layout", () => {
    // the same trap build.ts fell into: _layout must be a whole basename
    expect(devUpdatePlan(["pages/post_layout.tsx"], "post_layout.tsx")).toBe("apply");
    expect(devUpdatePlan(["pages/post_layout.tsx"], "index.tsx")).toBe("skip");
  });

  test("nothing rendered yet means a reload, and nothing changed means nothing", () => {
    expect(devUpdatePlan(["pages/index.tsx"], null)).toBe("reload");
    expect(devUpdatePlan([], "index.tsx")).toBe("skip");
    expect(devUpdatePlan([], null)).toBe("skip");
  });
});
