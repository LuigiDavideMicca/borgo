import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countAssets,
  exportSummary,
  fillPattern,
  freePorts,
  markStaticExport,
  outputPath,
  planExport,
  unsafeParamReason,
} from "../src/export";
import { buildDefine } from "../src/build";
import type { Route } from "../src/router";
import { propsPathEnabled } from "../src/runtime";

const route = (pattern: string, module: Record<string, unknown>, islands = false): Route =>
  ({ pattern, file: pattern + ".tsx", module, layouts: [], islands }) as unknown as Route;

const page = () => null;

describe("planExport", () => {
  test("plain pages without loaders export", () => {
    const { plans, skipped, needApi } = planExport([route("/about", { default: page })]);
    expect(plans.map((p) => p.route.pattern)).toEqual(["/about"]);
    expect(skipped).toEqual([]);
    expect(needApi).toBe(false);
  });

  test("a loader without prerender skips with the reason", () => {
    const { plans, skipped } = planExport([route("/", { default: page, loader: async () => ({}) })]);
    expect(plans).toEqual([]);
    expect(skipped[0].reason).toContain("export const prerender = true");
  });

  test("a loader with prerender exports and needs the api", () => {
    const { plans, needApi } = planExport([
      route("/", { default: page, loader: async () => ({}), prerender: true }),
    ]);
    expect(plans).toHaveLength(1);
    expect(needApi).toBe(true);
  });

  test("dynamic routes need prerenderPaths", () => {
    const { plans, skipped } = planExport([route("/tasks/:id", { default: page })]);
    expect(plans).toEqual([]);
    expect(skipped[0].reason).toContain("prerenderPaths");
  });

  test("dynamic routes with prerenderPaths export dynamically", () => {
    const { plans, needApi } = planExport([
      route("/tasks/:id", { default: page, prerenderPaths: () => [{ id: 1 }] }),
    ]);
    expect(plans[0].dynamic).toBe(true);
    expect(needApi).toBe(true);
  });

  test("a _404 without a loader exports", () => {
    const { export404, needApi } = planExport([route("/about", { default: page })], route("*", { default: page }));
    expect(export404).toBe(true);
    expect(needApi).toBe(false);
  });

  test("a _404 with a loader needs prerender and then the api", () => {
    const plain = planExport([], route("*", { default: page, loader: async () => ({}) }));
    expect(plain.export404).toBe(false);
    expect(plain.skipped[0]).toEqual({ pattern: "404", reason: "has a loader without `export const prerender = true`" });

    const opted = planExport([], route("*", { default: page, loader: async () => ({}), prerender: true }));
    expect(opted.export404).toBe(true);
    expect(opted.needApi).toBe(true);
  });

  test("zero exportable pages still export an exportable _404", () => {
    const { plans, export404 } = planExport(
      [route("/", { default: page, loader: async () => ({}) })],
      route("*", { default: page }),
    );
    expect(plans).toEqual([]);
    expect(export404).toBe(true);
  });
});

describe("countAssets", () => {
  test("precompressed siblings fold into their base asset", () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-assets-"));
    try {
      mkdirSync(join(dir, "assets"));
      for (const f of ["assets/client.js", "assets/client.js.gz", "assets/client.js.br", "assets/style.css", "assets/style.css.gz", "logo.svg", "orphan.gz"]) {
        writeFileSync(join(dir, f), "x");
      }
      expect(countAssets(dir)).toEqual({ assets: 4, precompressed: 3 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("exportSummary", () => {
  test("404.html is its own line item and variants are mentioned once", () => {
    expect(exportSummary(5, true, 3, 6)).toBe("exported 5 pages + 404.html + 3 assets (with 6 precompressed variants)");
    expect(exportSummary(2, false, 1, 0)).toBe("exported 2 pages + 1 assets");
    expect(exportSummary(0, true, 0, 0)).toBe("exported 0 pages + 404.html + 0 assets");
  });
});

describe("fillPattern", () => {
  test("fills and encodes params", () => {
    expect(fillPattern("/tasks/:id", { id: 7 })).toBe("/tasks/7");
    expect(fillPattern("/a/:x/b/:y", { x: "one", y: "two three" })).toBe("/a/one/b/two%20three");
  });

  test("missing params throw with the pattern named", () => {
    expect(() => fillPattern("/tasks/:id", {})).toThrow("/tasks/:id");
  });

  test("params with path separators throw", () => {
    expect(() => fillPattern("/posts/:slug", { slug: "a/b" })).toThrow("path separator");
    expect(() => fillPattern("/posts/:slug", { slug: "a\\b" })).toThrow("path separator");
  });

  // each segment becomes a directory under dist/site, so ".." would write the
  // page a level above the export root instead of inside it
  test("dot segments throw instead of climbing out of the output dir", () => {
    expect(() => fillPattern("/posts/:slug", { slug: ".." })).toThrow("dot segment");
    expect(() => fillPattern("/posts/:slug", { slug: "." })).toThrow("dot segment");
    expect(() => fillPattern("/a/:x/:y", { x: "..", y: ".." })).toThrow("dot segment");
    // a run of dots is not the dot segment, but windows strips trailing dots
    // from a path component: mkdir("....") asks for a directory with no name
    expect(() => fillPattern("/posts/:slug", { slug: "...." })).toThrow("windows");
    expect(fillPattern("/posts/:slug", { slug: "a.b" })).toBe("/posts/a.b");
  });

  // fillPattern percent-encodes and outputPath decodes each segment straight
  // back to build the disk path, so every one of these is a url a static host
  // serves happily and a directory windows refuses to create. Left unchecked,
  // an app whose prerenderPaths return timestamps exported on linux and died
  // with EINVAL on windows - and only on windows.
  test("params windows cannot make a directory out of are rejected up front", () => {
    const rejected: Array<[string, string]> = [
      ["2024-01-01T00:00:00Z", "timestamps carry a colon"],
      ["a?b", "a question mark"],
      ["a*b", "a star"],
      ['a"b', "a quote"],
      ["a<b", "a less-than"],
      ["a>b", "a greater-than"],
      ["a|b", "a pipe"],
      ["a\u0001b", "a control character"],
      ["CON", "a reserved device name"],
      ["nul.txt", "a reserved device name with an extension"],
      ["lpt1", "a reserved device name, lowercased"],
      ["trailing ", "a trailing space"],
    ];
    for (const [value, why] of rejected) {
      expect(() => fillPattern("/posts/:slug", { slug: value })).toThrow(
        // the message has to name the route and the param, or the app author
        // is left guessing which of a hundred prerenderPaths entries it was
        /prerenderPaths for \/posts\/:slug: param "slug"/,
      );
      expect(why).toBeTruthy();
    }
  });

  test("what windows does allow still goes through, encoded", () => {
    expect(fillPattern("/posts/:slug", { slug: "hello-world" })).toBe("/posts/hello-world");
    expect(fillPattern("/posts/:slug", { slug: "città" })).toBe("/posts/citt%C3%A0");
    expect(fillPattern("/posts/:slug", { slug: "a b" })).toBe("/posts/a%20b");
    expect(fillPattern("/posts/:slug", { slug: "console" })).toBe("/posts/console");
    expect(fillPattern("/posts/:id", { id: 42 })).toBe("/posts/42");
  });

  // the round trip is the whole point: whatever fillPattern lets through must
  // survive outputPath's decode and still be a legal directory name
  test("everything that survives fillPattern survives outputPath", () => {
    for (const slug of ["hello-world", "città", "a b", "console", "a.b"]) {
      const disk = outputPath(fillPattern("/posts/:slug", { slug }));
      expect(disk).toBe(`posts/${slug}/index.html`);
      expect(unsafeParamReason(slug)).toBeNull();
    }
  });
});

describe("freePorts", () => {
  test("returns distinct usable ports", async () => {
    const ports = await freePorts(2);
    expect(ports).toHaveLength(2);
    expect(ports[0]).not.toBe(ports[1]);
    for (const port of ports) expect(port).toBeGreaterThan(0);
  });
});

describe("outputPath", () => {
  test("directory-style html files", () => {
    expect(outputPath("/")).toBe("index.html");
    expect(outputPath("/about")).toBe("about/index.html");
    expect(outputPath("/tasks/7")).toBe("tasks/7/index.html");
    expect(outputPath("/trailing/")).toBe("trailing/index.html");
  });

  test("url-encoded segments decode to real characters on disk", () => {
    expect(outputPath("/posts/citt%C3%A0")).toBe("posts/città/index.html");
    expect(outputPath("/a%20b")).toBe("a b/index.html");
    expect(outputPath("/100%")).toBe("100%/index.html");
  });
});

// a static host has no ?__borgo=props endpoint: it answers that url with the
// page's own html document and a 200, so res.ok passes, res.json() throws, and
// the navigation ends in the full reload the catch does anyway - having paid
// for a second whole document per link, and one more for every link a pointer
// crossed, since prefetch caches that doomed promise on hover. The flag is set
// before the bundle is built and reaches the runtime through the define map.
describe("static export flag", () => {
  test("markStaticExport reaches the bundle through buildDefine", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(buildDefine(false, env)["process.env.BORGO_STATIC"]).toBe('"0"');
    markStaticExport(env);
    expect(env.BORGO_STATIC).toBe("1");
    expect(buildDefine(false, env)["process.env.BORGO_STATIC"]).toBe('"1"');
    // NODE_ENV is still the thing that decides dev vs production
    expect(buildDefine(true, env)["process.env.NODE_ENV"]).toBe('"development"');
  });

  test("the runtime reads that exact key, and defaults to the props path", () => {
    const saved = process.env.BORGO_STATIC;
    try {
      delete process.env.BORGO_STATIC;
      expect(propsPathEnabled()).toBe(true);
      // anything but the literal the define substitutes leaves it on
      process.env.BORGO_STATIC = "0";
      expect(propsPathEnabled()).toBe(true);
      process.env.BORGO_STATIC = "1";
      expect(propsPathEnabled()).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.BORGO_STATIC;
      else process.env.BORGO_STATIC = saved;
    }
  });
});
