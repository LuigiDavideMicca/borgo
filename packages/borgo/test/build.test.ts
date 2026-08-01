import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assetsBuildMode,
  compileCss,
  generateManifest,
  isBuildOutput,
  parseHydrate,
  precacheStamp,
  refreshTransform,
  renameUnsafeChunks,
  reservedRoutes,
  sweepBuildOutput,
} from "../src/build";

describe("parseHydrate", () => {
  const cases: Array<[string, string, ReturnType<typeof parseHydrate>]> = [
    ["no export", "export default function P() {}", "true"],
    ["false", "export const hydrate = false;", "false"],
    ["true", "export const hydrate = true;", "true"],
    ["visible double quotes", 'export const hydrate = "visible";', '"visible"'],
    ["visible single quotes", "export const hydrate = 'visible';", '"visible"'],
    ["typed export", "export const hydrate: HydrateMode = false;", "false"],
  ];
  for (const [name, source, want] of cases) {
    test(name, () => {
      expect(parseHydrate(source)).toBe(want);
    });
  }
});

describe("refreshTransform", () => {
  test("registers components and scopes ids to the module", async () => {
    const js = [
      'import { useState } from "react";',
      "export default function Home() { const [n] = useState(0); return n; }",
      "function helper() { return 1; }",
    ].join("\n");
    const out = await refreshTransform(js, "pages/index.tsx");
    expect(out).toContain("$RefreshReg$");
    expect(out).toContain('"pages/index.tsx"');
    expect(out).toContain('"Home"');
    expect(out).toContain("$borgoPrevReg");
  });

  test("emits hook signatures so hook edits remount instead of corrupting state", async () => {
    const withState = await refreshTransform(
      'import { useState } from "react";\nexport default function P() { const [a] = useState(1); return a; }',
      "pages/p.tsx",
    );
    const withTwo = await refreshTransform(
      'import { useState } from "react";\nexport default function P() { const [a] = useState(1); const [b] = useState(2); return a + b; }',
      "pages/p.tsx",
    );
    expect(withState).toContain("$RefreshSig$");
    expect(withTwo).toContain("$RefreshSig$");
    const sigOf = (code: string) => code.match(/_s\d*\(P, "([^"]+)"/)?.[1];
    expect(sigOf(withState)).toBeTruthy();
    expect(sigOf(withTwo)).toBeTruthy();
    expect(sigOf(withState)).not.toBe(sigOf(withTwo));
  });

  test("instruments custom hooks with signatures", async () => {
    const out = await refreshTransform(
      'import { useState } from "react";\nexport function useCounter() { const [n, setN] = useState(0); return [n, setN]; }',
      "lib/use-counter.ts",
    );
    expect(out).toContain("$RefreshSig$");
    expect(out).toContain("useCounter");
  });

  test("passes plain modules through untouched", async () => {
    const js = "export const x = 1;\n";
    expect(await refreshTransform(js, "lib/util.ts")).toBe(js);
  });
});

describe("precacheStamp", () => {
  const listed = ["/assets/client.js", "/assets/page-abc123.js", "/assets/style.css"];

  const fixture = () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-precache-"));
    writeFileSync(join(dir, "client.js"), "entry v1");
    writeFileSync(join(dir, "page-abc123.js"), "chunk");
    writeFileSync(join(dir, "style.css"), "body{}");
    return dir;
  };

  test("moves when a stable-named entry changes, not just when a hashed name does", async () => {
    const dir = fixture();
    try {
      const before = await precacheStamp(dir, listed);
      expect(await precacheStamp(dir, listed)).toBe(before);
      // client.js keeps its name across builds; only its bytes change
      writeFileSync(join(dir, "client.js"), "entry v2");
      expect(await precacheStamp(dir, listed)).not.toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("moves when the stylesheet or the chunk list changes", async () => {
    const dir = fixture();
    try {
      const before = await precacheStamp(dir, listed);
      writeFileSync(join(dir, "style.css"), "body{color:red}");
      const restyled = await precacheStamp(dir, listed);
      expect(restyled).not.toBe(before);
      writeFileSync(join(dir, "page-def456.js"), "chunk");
      expect(await precacheStamp(dir, [...listed, "/assets/page-def456.js"])).not.toBe(restyled);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("assetsBuildMode", () => {
  test("reads the stamp, null when missing or unknown", () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-mode-"));
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      expect(assetsBuildMode()).toBeNull();
      mkdirSync(".borgo");
      for (const [stamp, want] of [["dev", "dev"], ["production", "production"], ["garbage", null]] as const) {
        writeFileSync(".borgo/build-mode", stamp);
        expect(assetsBuildMode()).toBe(want);
      }
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("generateManifest", () => {
  test("a missing pages/ dir throws a framework message, not a bare ENOENT", async () => {
    const empty = mkdtempSync(join(tmpdir(), "borgo-no-pages-"));
    const cwd = process.cwd();
    process.chdir(empty);
    try {
      expect(generateManifest()).rejects.toThrow("pages/");
    } finally {
      process.chdir(cwd);
      rmSync(empty, { recursive: true, force: true });
    }
  });

  const originalCwd = process.cwd();
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "borgo-manifest-"));
    const write = (path: string, content: string) => {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      return Bun.write(join(dir, path), content);
    };
    await write("pages/_layout.tsx", "export default function L({ children }) { return children; }");
    await write("pages/index.tsx", "export default function Home() { return null; }");
    await write(
      "pages/about.tsx",
      'import { Island } from "borgo-framework";\nexport const hydrate = false;\nexport default function About() { return <Island name="Counter" />; }',
    );
    await write(
      "pages/deep/lazy.tsx",
      'export const hydrate = "visible";\nexport default function Lazy() { return null; }',
    );
    await write("pages/_404.tsx", "export default function NotFound() { return null; }");
    await write("islands/Counter.tsx", "export default function Counter() { return null; }");
    process.chdir(dir);
    await generateManifest();
  });

  afterAll(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  test("server manifest has every page with layouts and islands flags", async () => {
    const manifest = await Bun.file(join(dir, ".borgo/routes.gen.tsx")).text();
    expect(manifest).toContain('{ pattern: "/", file: "index.tsx", module: page0, layouts: [layout0], islands: false }');
    expect(manifest).toContain('{ pattern: "/about", file: "about.tsx", module: page1, layouts: [layout0], islands: true }');
    expect(manifest).toContain('pattern: "/deep/lazy"');
    expect(manifest).toContain("export const notFound: Route | null = { pattern");
    expect(manifest).toContain("export const serverError: Route | null = null;");
  });

  test("client manifest excludes hydrate=false pages and keeps hydrate modes", async () => {
    const manifest = await Bun.file(join(dir, ".borgo/client-routes.gen.ts")).text();
    expect(manifest).not.toContain('"about.tsx"');
    expect(manifest).toContain('file: "index.tsx", hydrate: true');
    expect(manifest).toContain('file: "deep/lazy.tsx", hydrate: "visible"');
    expect(manifest).toContain("export const notFound: ClientRoute | null =");
  });

  test("islands manifest registers islands by file name", async () => {
    const manifest = await Bun.file(join(dir, ".borgo/islands.gen.ts")).text();
    expect(manifest).toContain('import island0 from "../islands/Counter";');
    expect(manifest).toContain('"Counter": island0,');
  });

  // these two files are the only consumers of the registries, and their import
  // lines are literal strings in build.ts: nothing typechecks them, so a wrong
  // specifier here would surface as a broken build in every app rather than as
  // a red test. the registries moved off the root entry at 0.21.
  test.each([".borgo/client.tsx", ".borgo/islands-client.tsx"])(
    "%s takes the registries from borgo-framework/internal, not the root entry",
    async (file) => {
      const entry = await Bun.file(join(dir, file)).text();
      expect(entry).toContain('import { registerCsrf, registerIslands } from "borgo-framework/internal";');
      expect(entry).not.toContain('from "borgo-framework";');
      // the calls must still be there: a correct import of nothing is worse
      expect(entry).toContain("registerIslands(islands, createElement);");
      expect(entry).toContain("registerCsrf({ createElement, createContext, useContext });");
    },
  );

  test("the runtime subpath is untouched by the move", async () => {
    const entry = await Bun.file(join(dir, ".borgo/client.tsx")).text();
    expect(entry).toContain('import { mount } from "borgo-framework/runtime";');
    const islandsEntry = await Bun.file(join(dir, ".borgo/islands-client.tsx")).text();
    expect(islandsEntry).toContain('import { mountIslands } from "borgo-framework/runtime";');
  });

  test("dynamic segments sort after static ones", async () => {
    await Bun.write(
      join(dir, "pages/deep/[id].tsx"),
      "export default function D() { return null; }",
    );
    await Bun.write(join(dir, "pages/deep/static.tsx"), "export default function S() { return null; }");
    await generateManifest();
    const manifest = await Bun.file(join(dir, ".borgo/routes.gen.tsx")).text();
    const staticIdx = manifest.indexOf('pattern: "/deep/static"');
    const dynamicIdx = manifest.indexOf('pattern: "/deep/:id"');
    expect(staticIdx).toBeGreaterThan(-1);
    expect(dynamicIdx).toBeGreaterThan(staticIdx);
  });
});

// `_layout.tsx` used to be matched with endsWith, which is also true of every
// page whose name merely ends in those characters. pages/post_layout.tsx became
// a route AND a layout for a directory "post/" - so the manifest imported
// "../pages/post/_layout", which resolves to nothing, and dev, build and export
// all died on it. PROVED against a real generateManifest.
describe("a page named like a layout is a page", () => {
  const originalCwd = process.cwd();
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "borgo-layoutish-"));
    const write = (path: string, content: string) => {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      return Bun.write(join(dir, path), content);
    };
    await write("pages/index.tsx", "export default function Home() { return null; }");
    // no pages/post/ directory anywhere: this is a plain page
    await write("pages/post_layout.tsx", "export default function PostLayout() { return null; }");
    // and one with a real sibling directory, whose pages must not inherit a
    // layout chain nobody wrote
    await write("pages/blog_layout.tsx", "export default function BlogLayout() { return null; }");
    await write("pages/blog/entry.tsx", "export default function Entry() { return null; }");
    // the genuine article, to prove the narrowing did not throw layouts out
    await write("pages/blog/_layout.tsx", "export default function L({ children }) { return children; }");
    process.chdir(dir);
    await generateManifest();
  });

  afterAll(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  test("no phantom layout import is emitted for it", async () => {
    const manifest = await Bun.file(join(dir, ".borgo/routes.gen.tsx")).text();
    expect(manifest).not.toContain('"../pages/post/_layout"');
    expect(manifest).not.toContain('"../pages/blog_layout/_layout"');
    // every import the manifest makes must resolve to a file that exists
    for (const [, spec] of manifest.matchAll(/from "\.\.\/(pages\/[^"]+)"/g)) {
      expect(existsSync(join(dir, `${spec}.tsx`))).toBe(true);
    }
  });

  test("it is routed as an ordinary page, with no layouts of its own", async () => {
    const manifest = await Bun.file(join(dir, ".borgo/routes.gen.tsx")).text();
    expect(manifest).toContain('pattern: "/post_layout", file: "post_layout.tsx"');
    expect(manifest).toMatch(/file: "post_layout\.tsx"[^\n]*layouts: \[\]/);
  });

  test("a real _layout.tsx still wraps the pages beside it", async () => {
    const manifest = await Bun.file(join(dir, ".borgo/routes.gen.tsx")).text();
    expect(manifest).toContain('import * as layout0 from "../pages/blog/_layout";');
    expect(manifest).toMatch(/file: "blog\/entry\.tsx"[^\n]*layouts: \[layout0\]/);
    // and the page named after that directory is not dragged into its chain
    expect(manifest).toMatch(/file: "blog_layout\.tsx"[^\n]*layouts: \[\]/);
  });
});

// the front server answers these before the route table is ever consulted, so
// a page generated for one of them can never render - while the startup route
// table prints it as though it works
describe("reservedRoutes", () => {
  test("names the paths the server takes first", () => {
    const dead = reservedRoutes([
      { pattern: "/api/users", file: "api/users.tsx" },
      { pattern: "/api/:id", file: "api/[id].tsx" },
      { pattern: "/ws", file: "ws.tsx" },
      { pattern: "/healthz", file: "healthz.tsx" },
      { pattern: "/metrics", file: "metrics.tsx" },
      { pattern: "/__borgo/dev", file: "__borgo/dev.tsx" },
    ]);
    expect(dead.map((d) => d.pattern)).toEqual([
      "/api/users",
      "/api/:id",
      "/ws",
      "/healthz",
      "/metrics",
      "/__borgo/dev",
    ]);
    expect(dead[0].owner).toContain("go api");
    expect(dead[0].file).toBe("api/users.tsx");
  });

  test("leaves reachable routes alone, prefixes included", () => {
    // "/api" has no trailing slash: server.ts proxies startsWith("/api/"), so
    // this one really does reach the router
    expect(
      reservedRoutes([
        { pattern: "/", file: "index.tsx" },
        { pattern: "/api", file: "api.tsx" },
        { pattern: "/apidocs", file: "apidocs.tsx" },
        { pattern: "/websocket", file: "websocket.tsx" },
        { pattern: "/health", file: "health.tsx" },
        { pattern: "/:slug", file: "[slug].tsx" },
      ]),
    ).toEqual([]);
  });
});

// the pre-build sweep of public/assets. it used to take every .js in there,
// which includes the analytics snippet or vendored widget an app dropped next
// to the build output - deleted on the next build, with no warning.
describe("isBuildOutput", () => {
  test("claims what the build wrote", () => {
    for (const f of [
      "client.js",
      "islands-client.js",
      "precache.json",
      "page-abc12345.js",
      "chunk-0wj4r0a3.js",
      "client.js.gz",
      "client.js.br",
      "page-abc12345.js.gz",
      // the stylesheet's siblings are the build's; style.css itself is
      // rewritten by compileCss before the sweep runs and is not swept
      "style.css.gz",
      "style.css.br",
    ]) {
      expect(isBuildOutput(f)).toBe(true);
    }
  });

  test("leaves the app's own files in place", () => {
    for (const f of [
      "analytics.js",
      "widget.js",
      "vendor.min.js",
      "style.css",
      "logo.svg",
      "data.json",
      "analytics.js.gz",
      // eight characters, but no dash before them
      "abcd1234.js",
    ]) {
      expect(isBuildOutput(f)).toBe(false);
    }
  });
});

describe("sweepBuildOutput", () => {
  test("clears the last build and leaves the app's files where they were", () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-sweep-"));
    try {
      const mine = [
        "analytics.js",
        "widget.js",
        "vendor.min.js",
        "logo.svg",
        "data.json",
        "style.css",
      ];
      const theirs = [
        "client.js",
        "client.js.gz",
        "client.js.br",
        "islands-client.js",
        "page-abc12345.js",
        "page-abc12345.js.gz",
        "precache.json",
        "style.css.gz",
        "style.css.br",
      ];
      for (const f of [...mine, ...theirs]) writeFileSync(join(dir, f), "x");

      const removed = sweepBuildOutput(dir);

      expect(removed.sort()).toEqual([...theirs].sort());
      for (const f of theirs) expect(existsSync(join(dir, f))).toBe(false);
      // the whole point: a file the app put here survives the next build
      for (const f of mine) expect(existsSync(join(dir, f))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a directory that does not exist yet is not an error", () => {
    expect(sweepBuildOutput(join(tmpdir(), "borgo-no-such-dir-" + Date.now()))).toEqual([]);
  });
});

describe("compileCss", () => {
  const originalCwd = process.cwd();

  // compileCss returned early when style.scss was gone, so the css it emitted
  // for the previous build stayed in public/assets: still served, still
  // recompressed, still listed in precache.json, forever. Same on a rename,
  // and same on the scss -> tailwind switch.
  test("a deleted stylesheet takes its output and precompressed siblings with it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-css-"));
    process.chdir(dir);
    try {
      mkdirSync(join(dir, "public/assets"), { recursive: true });
      for (const f of ["style.css", "style.css.gz", "style.css.br"]) {
        writeFileSync(join(dir, "public/assets", f), "body{color:red}");
      }
      // an app file in the same directory is not compileCss's to remove
      writeFileSync(join(dir, "public/assets", "analytics.js"), "// mine");

      expect(existsSync(join(dir, "public/assets/style.css"))).toBe(true);
      await compileCss(false); // no style.scss here: the source is gone

      for (const f of ["style.css", "style.css.gz", "style.css.br"]) {
        expect(existsSync(join(dir, "public/assets", f))).toBe(false);
      }
      expect(existsSync(join(dir, "public/assets/analytics.js"))).toBe(true);
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a stylesheet that still exists is compiled, not dropped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-css-live-"));
    process.chdir(dir);
    try {
      writeFileSync(join(dir, "style.scss"), "body { color: red; }");
      await compileCss(true);
      expect(readFileSync(join(dir, "public/assets/style.css"), "utf8")).toContain("color");
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("renameUnsafeChunks", () => {
  test("a chunk bun could not name loses its brackets, and its importers follow", async () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-chunks-"));
    const odd = join(dir, "[name]-abc123.js");
    const entry = join(dir, "client.js");
    writeFileSync(odd, "export const x = 1;\n");
    writeFileSync(entry, 'import { x } from "./[name]-abc123.js";\nexport default x;\n');

    const renamed = await renameUnsafeChunks([odd, entry]);

    expect(existsSync(join(dir, "chunk-abc123.js"))).toBe(true);
    expect(existsSync(odd)).toBe(false);
    expect(renamed.get(odd)).toBe(join(dir, "chunk-abc123.js"));
    // a rename that leaves the import pointing at the old name is worse than
    // the bracket: the chunk 404s and hydration dies
    expect(readFileSync(entry, "utf8")).toContain("./chunk-abc123.js");
    expect(readFileSync(entry, "utf8")).not.toContain("[name]");
    rmSync(dir, { recursive: true, force: true });
  });

  test("normal names are left alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-chunks-"));
    const file = join(dir, "live-0wj4r0a3.js");
    writeFileSync(file, "export const x = 1;\n");
    const renamed = await renameUnsafeChunks([file]);
    expect(renamed.size).toBe(0);
    expect(existsSync(file)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
