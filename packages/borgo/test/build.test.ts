import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { buildAssetIndex, findAsset, serveAsset, serveIndexed } from "../src/compress";
import { serviceWorker } from "../src/pwa";
import { prepareShell } from "../src/util";

// an app with react installed, so a real bundle can resolve its imports
const APP_HOST = join(import.meta.dir, "../../../examples/tasks");
import {
  assetsBuildMode,
  buildAssets,
  buildLeftUnfinished,
  buildModeFor,
  buildReasons,
  BundleFailed,
  compileCss,
  cssSource,
  emittedStylesheet,
  entryOutputNames,
  generateManifest,
  hashedOutputNames,
  isSweepable,
  missingBuiltAssets,
  nameCarriesHash,
  needsBuild,
  parseHydrate,
  precacheStamp,
  readAssetNames,
  readBuildInventory,
  readBuildMode,
  readBuildOutputs,
  rebuildBeforeServing,
  recordedOutputSizes,
  refreshTransform,
  renameUnsafeChunks,
  reservedRoutes,
  reportBuildFailure,
  scanCode,
  sweepBuildOutput,
  unusableBuiltAssets,
  warnDeadRoutes,
  writeBuildInventory,
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

// the export is read, never executed, so the text is all there is - and the
// text lies. Commenting the line out is the most obvious way to re-enable
// hydration, and it did the opposite: the page kept shipping no JS, kept
// server-rendering, and nothing warned. PROVED against the real parser.
describe("parseHydrate ignores what is not code", () => {
  const page = (head: string) =>
    `${head}\nexport default function P() { return null; }\n`;

  const cases: Array<[string, string, ReturnType<typeof parseHydrate>]> = [
    [
      "a commented-out false above a real true",
      "// export const hydrate = false;\nexport const hydrate = true;",
      "true",
    ],
    [
      "a commented-out false with no other export at all",
      "// export const hydrate = false;",
      "true",
    ],
    [
      "a trailing comment on another line",
      "const x = 1; // export const hydrate = false;\nexport const hydrate = 'visible';",
      '"visible"',
    ],
    [
      "a block comment",
      "/* export const hydrate = false; */\nexport const hydrate = true;",
      "true",
    ],
    [
      "a doc comment",
      "/**\n * export const hydrate = false;\n */\nexport const hydrate = true;",
      "true",
    ],
    [
      "a template string quoting the line",
      "const snippet = `\nexport const hydrate = false;\n`;\nexport const hydrate = true;",
      "true",
    ],
    [
      "a plain string quoting the line",
      'const snippet = "export const hydrate = false;";\nexport const hydrate = true;',
      "true",
    ],
    // and the other direction: a real export must still be found through
    // everything above it
    [
      "a real false under a comment that mentions it",
      "// hydrate is off here: see docs\nexport const hydrate = false;",
      "false",
    ],
    [
      "a real false under a block comment holding a quote",
      "/* it's off: \"why\" is in the docs */\nexport const hydrate = false;",
      "false",
    ],
    [
      "a real false under jsx text holding an apostrophe",
      "const label = <p>don't panic</p>;\nexport const hydrate = false;",
      "false",
    ],
    [
      "a real false under a regex literal full of quotes and slashes",
      "const re = /[\"'\\/]/g;\nexport const hydrate = false;",
      "false",
    ],
  ];

  for (const [name, head, want] of cases) {
    test(name, () => {
      expect(parseHydrate(page(head))).toBe(want);
    });
  }

  test("scanCode blanks comments in place and keeps every offset", () => {
    const source = "const a = 1; // gone\nconst b = 2;\n";
    const { code } = scanCode(source);
    expect(code.length).toBe(source.length);
    expect(code).not.toContain("gone");
    expect(code).toContain("const a = 1;");
    expect(code.split("\n")[1]).toBe("const b = 2;");
  });

  test("scanCode reports the literals a match can hide inside", () => {
    const source = 'const s = "hydrate";\n';
    const { strings } = scanCode(source);
    expect(strings).toHaveLength(1);
    expect(source.slice(strings[0][0], strings[0][1])).toBe('"hydrate"');
  });
});

// a page filtered out of the client manifest ships no js and never hydrates,
// so what parseHydrate decides has to survive the whole generator
describe("a commented-out hydrate export reaches the client manifest", () => {
  test("the page is still a client route", async () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-hydrate-comment-"));
    const cwd = process.cwd();
    try {
      mkdirSync(join(dir, "pages"), { recursive: true });
      writeFileSync(
        join(dir, "pages/index.tsx"),
        "// export const hydrate = false;\nexport const hydrate = true;\nexport default function P() { return null; }\n",
      );
      process.chdir(dir);
      await generateManifest();
      const manifest = readFileSync(join(dir, ".borgo/client-routes.gen.ts"), "utf8");
      expect(manifest).toContain('file: "index.tsx", hydrate: true');
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
    // generateManifest is 20ms idle and 5.9s at 1.5x oversubscription
  }, 30_000);
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
    // the key the wrapper composes, not the "Home" babel emits on its own: with
    // the name half dropped every component in a module registers under one key
    expect(out.match(/register\(type, ([^)]+)\)/)?.[1]).toBe('"pages/index.tsx" + "#" + name');
    // and babel did register the component, so there is a name to scope
    expect(out).toContain('$RefreshReg$(_c, "Home")');
    // save and restore, asserted apart: the declaration alone satisfies a
    // "$borgoPrevReg" substring, and it is the restore that stops the next
    // module registering under this module's id
    expect(out).toContain("var $borgoPrevReg = globalThis.$RefreshReg$");
    expect(out).toContain("globalThis.$RefreshReg$ = $borgoPrevReg;");
    // first call in the file, so it pays the lazy @babel/core and
    // react-refresh/babel imports: ~210ms warm
  }, 30_000);

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
  // ~5ms of file reads idle, 5.5s at 1.5x oversubscription: the budgets below
  // are scheduling headroom, not work
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
  }, 30_000);

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
  }, 30_000);
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

  // The guard `borgo start` hangs on this was `mode === "dev" || mode ===
  // "export"`, so every way of not knowing - no file, an empty one, a
  // truncated one, `DEV` - fell through to serving whatever was in
  // public/assets. Proved on a real tree: a dev build (unminified react, no
  // precompressed siblings) served on a production port, silently, because
  // .borgo/build-mode said something the reader did not recognise.
  test("a stamp that cannot be read rebuilds, it does not serve", () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-mode-guard-"));
    const path = join(dir, "build-mode");
    try {
      // no file at all
      expect(rebuildBeforeServing(readBuildMode(path))).toBe(
        "nothing here records which build public/assets holds",
      );
      const said = (body: string) => {
        writeFileSync(path, body);
        return rebuildBeforeServing(readBuildMode(path));
      };
      // every unreadable stamp names the file, and every one of them rebuilds
      for (const body of ["", "   ", "DEV", "Production", "{}", "dev\nproduction"]) {
        expect(`${JSON.stringify(body)}: ${said(body)}`).toBe(
          `${JSON.stringify(body)}: .borgo/build-mode does not say which build public/assets holds`,
        );
      }
      // and the ones it does read, including the only one that may be served
      expect(said("dev")).toBe("public/assets holds a dev build");
      expect(said("export")).toBe("public/assets holds a static export build");
      expect(said("production\n")).toBeNull();
    } finally {
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
    // 20ms idle, 5.9s at 1.5x oversubscription; a hook that times out skips
    // this whole describe, which reads as a shorter green run
  }, 30_000);

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
  }, 30_000);
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
    // same exposure as the manifest fixture above, same silent skip
  }, 30_000);

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
  const metricsOn = { BORGO_METRICS: "1" };

  test("names the paths the server takes first", () => {
    const dead = reservedRoutes(
      [
        { pattern: "/api/users", file: "api/users.tsx" },
        { pattern: "/api/:id", file: "api/[id].tsx" },
        { pattern: "/ws", file: "ws.tsx" },
        { pattern: "/healthz", file: "healthz.tsx" },
        { pattern: "/metrics", file: "metrics.tsx" },
        { pattern: "/__borgo/dev", file: "__borgo/dev.tsx" },
      ],
      metricsOn,
    );
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

  // the server only claims /metrics with BORGO_METRICS=1 (server.ts asks
  // metricsEnabled). Listing it unconditionally called a page that renders
  // perfectly well "dead code" on every build of every app that never turned
  // metrics on - a red line, on stderr, for nothing.
  test("/metrics is only reserved when the server actually claims it", () => {
    const pages = [{ pattern: "/metrics", file: "metrics.tsx" }];
    expect(reservedRoutes(pages, {})).toEqual([]);
    expect(reservedRoutes(pages, { BORGO_METRICS: "0" })).toEqual([]);
    expect(reservedRoutes(pages, metricsOn).map((d) => d.pattern)).toEqual(["/metrics"]);
    // the unconditional ones do not move
    expect(reservedRoutes([{ pattern: "/healthz", file: "h.tsx" }], {}).map((d) => d.pattern)).toEqual([
      "/healthz",
    ]);
  });

  // the warning used to exist only inside generateManifest, which `borgo
  // start` on a pre-built tree never runs: the startup route table printed the
  // dead route like any other, with nothing to say it could never answer.
  test("warnDeadRoutes says so out loud, and returns what it said", () => {
    const said: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void said.push(args.join(" "));
    try {
      const dead = warnDeadRoutes([
        { pattern: "/healthz", file: "healthz.tsx" },
        { pattern: "/about", file: "about.tsx" },
      ], {});
      expect(dead.map((d) => d.pattern)).toEqual(["/healthz"]);
      expect(said).toHaveLength(1);
      expect(said[0]).toContain("pages/healthz.tsx");
      expect(said[0]).toContain("/healthz");
    } finally {
      console.warn = original;
    }
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
describe("isSweepable", () => {
  const owned = new Set(["client.js", "islands-client.js", "precache.json", "page-abc12345.js"]);

  test("claims what the build recorded, and the stylesheet's siblings", () => {
    for (const f of [
      "client.js",
      "islands-client.js",
      "precache.json",
      "page-abc12345.js",
      "client.js.gz",
      "client.js.br",
      "page-abc12345.js.gz",
      // the stylesheet's siblings are the build's; style.css itself is
      // rewritten by compileCss before the sweep runs and is not swept
      "style.css.gz",
      "style.css.br",
    ]) {
      expect(isSweepable(f, owned)).toBe(true);
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
      "abcd1234.js",
    ]) {
      expect(isSweepable(f, owned)).toBe(false);
    }
  });

  // the sweep used to match a SHAPE - `[^/\\]+-[a-z0-9]{8}\.js` - which is
  // exactly the shape of a hashed analytics bundle. Proved: the comment
  // promised `analytics.js` was safe, and `analytics-9f8e7d6c.js` was deleted
  // on every build while `vendor.js` beside it survived.
  test("a hashed app file is not a chunk just because it looks like one", () => {
    for (const f of ["analytics-9f8e7d6c.js", "widget-0wj4r0a3.js", "sentry-1a2b3c4d.js"]) {
      expect(isSweepable(f, owned)).toBe(false);
      // and the same name IS swept once a build has recorded writing it
      expect(isSweepable(f, new Set([...owned, f]))).toBe(true);
    }
  });

  test("what this build just wrote is never swept, but its stale siblings are", () => {
    const keep = new Set(["client.js"]);
    expect(isSweepable("client.js", owned, keep)).toBe(false);
    expect(isSweepable("client.js.gz", owned, keep)).toBe(true);
  });
});

describe("build inventory", () => {
  test("round-trips the names, sorted and deduplicated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-inventory-"));
    const path = join(dir, "build-output.json");
    try {
      expect(readBuildInventory(path)).toBeNull();
      await writeBuildInventory(["b.js", "a.js", "b.js"], null, path);
      expect(readBuildInventory(path)).toEqual(["a.js", "b.js"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("garbage on disk reads as no inventory, not as a crash", () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-inventory-"));
    const path = join(dir, "build-output.json");
    try {
      writeFileSync(path, "{not json");
      expect(readBuildInventory(path)).toBeNull();
      writeFileSync(path, JSON.stringify({ files: [1, 2] }));
      expect(readBuildInventory(path)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the vouched-for outputs round-trip with their directory and their sizes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-inventory-"));
    const path = join(dir, "build-output.json");
    try {
      await writeBuildInventory(
        ["client.js", "page-a1b2c3d4.js"],
        { dir: "public/assets", sizes: { "page-a1b2c3d4.js": 512 } },
        path,
      );
      expect(readBuildInventory(path)).toEqual(["client.js", "page-a1b2c3d4.js"]);
      const outputs = readBuildOutputs(path);
      // the directory travels with the list, or the server is back to
      // recognising an output by the shape of its path
      expect(outputs.dir).toBe("public/assets");
      expect([...outputs.sizes]).toEqual([["page-a1b2c3d4.js", 512]]);
      // the entry point is emitted by the same build and is emphatically not
      // content-addressed: being in `files` must never imply being vouched for
      expect(outputs.sizes.has("client.js")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("recordedOutputSizes measures the disk, and skips what is not there", () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-sizes-"));
    try {
      writeFileSync(join(dir, "a-a1b2c3d4.js"), "12345");
      writeFileSync(join(dir, "a-a1b2c3d4.js.gz"), "123");
      // a precompressed sibling is measured under its own name, because it is
      // served under the same url and pinned by the same directive
      expect(
        recordedOutputSizes(dir.replaceAll("\\", "/"), [
          "a-a1b2c3d4.js",
          "a-a1b2c3d4.js.gz",
          "gone.js",
        ]),
      ).toEqual({ "a-a1b2c3d4.js": 5, "a-a1b2c3d4.js.gz": 3 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A recorded length of 0 would pin any empty file at that name - every empty
  // file matches it - so the length check would carry no information for
  // exactly the case where a truncated or half-written file is on disk. An
  // empty output that revalidates forever costs a 304 on nothing.
  test("an empty output is never vouched for, on the way in or the way out", () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-empty-"));
    const path = join(dir, "build-output.json");
    try {
      writeFileSync(join(dir, "empty-a1b2c3d4.js"), "");
      expect(recordedOutputSizes(dir.replaceAll("\\", "/"), ["empty-a1b2c3d4.js"])).toEqual({});
      // and a manifest that names one anyway is not believed
      writeFileSync(path, JSON.stringify({ dir: "public/assets", hashed: { "e-a1b2c3d4.js": 0 } }));
      expect(readBuildOutputs(path).sizes.size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // every one of these pins an asset for a year if it reads as "hashed", so
  // each degradation has to land on the empty set rather than on a guess
  test("a missing, old or malformed inventory vouches for nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-inventory-"));
    const path = join(dir, "build-output.json");
    const empty = () => {
      const out = readBuildOutputs(path);
      return out.dir === "" && out.sizes.size === 0;
    };
    try {
      expect(empty()).toBe(true); // no file at all
      for (const body of [
        "{not json",
        "",
        JSON.stringify({ files: ["page-a1b2c3d4.js"] }), // an older borgo
        JSON.stringify({ hashed: { "a.js": 1 } }), // no directory recorded
        JSON.stringify({ dir: "", hashed: { "a.js": 1 } }),
        JSON.stringify({ dir: "public/assets" }), // nothing vouched for
        JSON.stringify({ dir: "public/assets", hashed: ["a.js"] }), // wrong shape
        JSON.stringify({ dir: "public/assets", hashed: "a.js" }),
        JSON.stringify({ dir: 7, hashed: { "a.js": 1 } }),
        // sizes that are not sizes
        JSON.stringify({ dir: "public/assets", hashed: { "a.js": "1" } }),
        JSON.stringify({ dir: "public/assets", hashed: { "a.js": -1 } }),
        JSON.stringify({ dir: "public/assets", hashed: { "a.js": 1.5 } }),
        JSON.stringify({ dir: "public/assets", hashed: { "a.js": null } }),
        // names that are not names in that directory
        JSON.stringify({ dir: "public/assets", hashed: { "../../etc/passwd": 1 } }),
        JSON.stringify({ dir: "public/assets", hashed: { "sub/a.js": 1 } }),
        JSON.stringify({ dir: "public/assets", hashed: { "sub\\a.js": 1 } }),
        JSON.stringify({ dir: "public/assets", hashed: { "": 1 } }),
      ]) {
        writeFileSync(path, body);
        expect(`${body.slice(0, 60)} -> vouches for nothing`).toBe(
          `${body.slice(0, 60)} -> ${empty() ? "vouches for nothing" : "PINNED SOMETHING"}`,
        );
      }
      // a partly-junk map keeps only the entries that are actually usable
      writeFileSync(
        path,
        JSON.stringify({ dir: "public/assets", hashed: { "ok-a1b2c3d4.js": 9, "sub/x.js": 1, "b.js": "x" } }),
      );
      expect([...readBuildOutputs(path).sizes]).toEqual([["ok-a1b2c3d4.js", 9]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The distinction the old rule could not make. Bun reports a content hash for
// every artifact, and a dev build names its entry points "[name].[ext]" - so
// "has a hash" and "says its hash in its name" are different questions, and
// only the second one is a promise to a cache.
describe("nameCarriesHash", () => {
  test("a name is a promise only when it contains that file's own hash", () => {
    expect(nameCarriesHash("page-a1b2c3d4.js", "a1b2c3d4")).toBe(true);
    expect(nameCarriesHash("out/assets/logo-6nnjve26.png", "6nnjve26")).toBe(true);
    // a dev entry: bun computed a hash, the naming block kept it out of the
    // filename, and the url therefore promises nothing
    expect(nameCarriesHash("client.js", "7js0fvsn")).toBe(false);
    // a different build's hash is not this file's hash
    expect(nameCarriesHash("page-a1b2c3d4.js", "ffffffff")).toBe(false);
    expect(nameCarriesHash("client.js", null)).toBe(false);
    expect(nameCarriesHash("client.js", "")).toBe(false);
  });

  test("an eight-letter word is not a hash, however much it looks like one", () => {
    // the exact names measured on the wire under the old shape rule
    for (const word of ["stripe-checkout.js", "vendor-database.css", "hero-carousel.js"]) {
      expect(nameCarriesHash(word, null)).toBe(false);
    }
  });

  test("hashedOutputNames keeps only the names that carry their hash", () => {
    const outputs = [
      { path: "out/assets/client.js", hash: "7js0fvsn" }, // entry: hash not in name
      { path: "out/assets/page-a1b2c3d4.js", hash: "a1b2c3d4" },
      { path: "out/assets/logo-6nnjve26.png", hash: "6nnjve26" },
      { path: "out/assets/vendored.js", hash: null }, // not the bundler's
    ];
    expect(hashedOutputNames(outputs)).toEqual(["page-a1b2c3d4.js", "logo-6nnjve26.png"]);
  });

  // renameUnsafeChunks moves the files bun could not name, and the url a cache
  // asks about is the name on disk - so the rename has to be followed, or the
  // manifest names a file nobody can request
  test("hashedOutputNames follows a renamed chunk to where it landed", () => {
    const outputs = [{ path: "out/assets/[name]-p5d0n9ga.js", hash: "p5d0n9ga" }];
    const renamed = new Map([["out/assets/[name]-p5d0n9ga.js", "out/assets/chunk-p5d0n9ga.js"]]);
    expect(hashedOutputNames(outputs, (p) => renamed.get(p) ?? p)).toEqual(["chunk-p5d0n9ga.js"]);
  });

  // The wiring, end to end: a real build, and the file a running server will
  // actually read. Everything either side of this line is unit-tested, but the
  // line itself is what decides whether the entry bundle gets pinned for a
  // year - which is the exact defect this whole change exists to remove.
  //
  // It runs inside examples/tasks because a real bundle has to resolve react,
  // and skips where that app has no node_modules rather than failing there.
  test.skipIf(!existsSync(join(APP_HOST, "node_modules/react")))(
    "a real build records every output it vouches for, entry included",
    async () => {
      const dir = mkdtempSync(join(APP_HOST, "borgo-build-inventory-"));
      const cwd = process.cwd();
      try {
        mkdirSync(join(dir, "pages"), { recursive: true });
        writeFileSync(join(dir, "pages/index.tsx"), "export default () => <h1>hi</h1>;\n");
        writeFileSync(join(dir, "pages/about.tsx"), "export default () => <p>about</p>;\n");
        process.chdir(dir);
        // a production build, because dev writes no precompressed siblings and
        // the siblings are half of what the manifest has to vouch for
        await buildAssets(false);

        const files = readBuildInventory()!;
        const outputs = readBuildOutputs();
        const entry = readAssetNames()["client.js"];
        expect(entry).toMatch(/^client-[a-z0-9]+\.js$/);
        expect(files).toContain(entry);
        // the point of the whole change: the entry's url names its bytes, so
        // it is vouched for like any chunk
        expect(outputs.sizes.has(entry!)).toBe(true);
        // and the name it used to keep is not on disk to be served stale
        expect(existsSync("public/assets/client.js")).toBe(false);
        expect(outputs.sizes.size).toBeGreaterThan(0);
        // the directory the server will match against, recorded by the build
        expect(outputs.dir).toBe("public/assets");
        // nothing is vouched for that the build did not emit, every recorded
        // length is the length actually on disk - measured after
        // renameUnsafeChunks rewrites imports, which changes byte counts - and
        // nothing empty is recorded at all
        for (const [name, size] of outputs.sizes) {
          // a precompressed sibling is vouched for under its own name; the file
          // it derives from is the one the build emitted
          expect(files).toContain(name.replace(/\.(gz|br)$/, ""));
          expect(statSync(join("public/assets", name)).size).toBe(size);
          expect(size).toBeGreaterThan(0);
        }

        // the precompressed siblings are measured too: they go out under the
        // same url and the same directive, so each is vouched for by name
        const siblings = [...outputs.sizes.keys()].filter((n) => /\.(gz|br)$/.test(n));
        expect(siblings.length).toBeGreaterThan(0);
        for (const sibling of siblings) {
          expect(outputs.sizes.has(sibling.replace(/\.(gz|br)$/, ""))).toBe(true);
        }

        // the payoff, stated where a server would ask it
        const index = buildAssetIndex("public", undefined, outputs);
        expect(index.get(`/assets/${entry}`)!.identity.pinnedSize).toBe(
          outputs.sizes.get(entry!)!,
        );
        const chunk = [...index].find(([url]) => outputs.sizes.has(url.split("/").pop()!))!;
        expect(chunk[1].identity.pinnedSize).toBe(
          outputs.sizes.get(chunk[0].split("/").pop()!) ?? null,
        );
      } finally {
        process.chdir(cwd);
        rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );

  // Against the real bundler, under borgo's own naming block. This is the seam
  // the whole policy rests on: if bun changes how it names chunks or stops
  // hashing imported assets, the manifest silently narrows and every asset
  // quietly loses its year - the failure direction assetCacheControl documents.
  // No react here on purpose, so it runs anywhere a tmpdir does.
  test("bun's own output classifies the way the manifest assumes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-naming-"));
    try {
      writeFileSync(join(dir, "logo.png"), "PNG bytes, not really");
      writeFileSync(join(dir, "inter.woff2"), "WOFF2 bytes, not really");
      writeFileSync(join(dir, "lazy.ts"), "export const lazy = () => 'split out';\n");
      writeFileSync(
        join(dir, "client.ts"),
        [
          "import logo from './logo.png';",
          "import font from './inter.woff2';",
          "export const boot = async () => [logo, font, (await import('./lazy')).lazy()];",
        ].join("\n"),
      );

      const result = await Bun.build({
        entrypoints: [join(dir, "client.ts")],
        outdir: join(dir, "out"),
        splitting: true,
        // the same block a production buildAssets uses: everything it emits is
        // named by content, entry included
        naming: { entry: "[name]-[hash].[ext]", chunk: "[name]-[hash].[ext]" },
        throw: false,
      });
      expect(result.success).toBe(true);

      const classified = result.outputs.map((o) => ({
        file: basename(o.path),
        kind: o.kind,
        hashed: nameCarriesHash(o.path, o.hash),
      }));
      const of = (kind: string) => classified.filter((c) => c.kind === kind);

      // the exact list buildAssets records, against real bundler output: every
      // artifact, with nothing left over
      const recorded = hashedOutputNames(result.outputs);
      expect(recorded.sort()).toEqual(classified.filter((c) => c.hashed).map((c) => c.file).sort());
      expect(recorded.length).toBe(result.outputs.length);

      // the entry: bun puts the hash it computed into the name, and the name
      // is what a cache is asked to trust
      const entry = of("entry-point");
      expect(entry.map((e) => e.file)).toEqual([expect.stringMatching(/^client-[a-z0-9]+\.js$/)]);
      expect(entry.every((e) => e.hashed)).toBe(true);
      expect(entryOutputNames(entry.map((e) => e.file))["client.js"]).toBe(entry[0].file);

      // the split chunk, and the imported image and font - the last two are
      // exactly what the old js/css rule refused to cache
      expect(of("chunk").length).toBeGreaterThan(0);
      expect(of("chunk").every((c) => c.hashed)).toBe(true);
      const assets = of("asset");
      expect(assets.map((a) => a.file.replace(/-[^.]+\./, ".")).sort()).toEqual([
        "inter.woff2",
        "logo.png",
      ]);
      expect(assets.every((a) => a.hashed)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

// The outcome, off the wire, on both paths a borgo server can answer an asset
// on: the boot-time index and the live lookup. Everything above proves a name
// was recorded; this proves the browser is told that name and that the url it
// is told is the one that carries the year.
describe("a served production build", () => {
  const IMMUTABLE = "public, max-age=31536000, immutable";
  // the scaffolded shell, unedited, because the whole design is that an app
  // author never types a hash into their html
  const TEMPLATE_SHELL = join(import.meta.dir, "../../create-borgo/templates/base/index.html");

  test.skipIf(!existsSync(join(APP_HOST, "node_modules/react")))(
    "hands the browser the emitted names, and those urls are pinned for a year",
    async () => {
      const dir = mkdtempSync(join(APP_HOST, "borgo-served-build-"));
      const cwd = process.cwd();
      const running: Array<() => void> = [];
      try {
        mkdirSync(join(dir, "pages"), { recursive: true });
        mkdirSync(join(dir, "public"), { recursive: true });
        writeFileSync(join(dir, "index.html"), readFileSync(TEMPLATE_SHELL, "utf8"));
        writeFileSync(join(dir, "style.scss"), "body { color: rebeccapurple; }\n");
        writeFileSync(join(dir, "pages/index.tsx"), "export default () => <h1>one</h1>;\n");
        writeFileSync(join(dir, "public/sw.js"), serviceWorker());
        process.chdir(dir);

        // what `borgo start` does at boot, and nothing more: read the build's
        // record, resolve the shell once against it, index public/ once
        const boot = () => {
          const outputs = readBuildOutputs();
          const names = readAssetNames();
          const parts = prepareShell(readFileSync("index.html", "utf8"), false, names);
          const doc = parts.start + parts.endProps[0] + parts.endProps[1];
          const index = buildAssetIndex("public", undefined, outputs);
          const answer = (mode: string) => async (req: Request) => {
            const path = new URL(req.url).pathname;
            if (path === "/") return new Response(doc, { headers: { "Content-Type": "text/html" } });
            if (mode === "indexed") {
              const info = findAsset(index, path);
              return info ? serveIndexed(req, info) : new Response("no such asset", { status: 404 });
            }
            const file = "public" + path;
            const asset = Bun.file(file);
            return (await asset.exists())
              ? serveAsset(req, file, asset, { dev: false, outputs })
              : new Response("no such asset", { status: 404 });
          };
          const servers = ["indexed", "live"].map((mode) => {
            const server = Bun.serve({ port: 0, fetch: answer(mode) });
            running.push(() => server.stop(true));
            return { mode, base: `http://localhost:${server.port}` };
          });
          return { names, servers };
        };

        const built = await buildAssets(false);
        const one = boot();
        const entry = one.names["client.js"]!;
        const style = one.names["style.css"]!;
        expect(entry).toMatch(/^client-[a-z0-9]+\.js$/);
        expect(style).toMatch(/^style-[a-z0-9]+\.css$/);
        // the artifact bun called the entry point, not a name that looks like
        // one: splitting also emits a shared chunk named client-<hash>.js, and
        // a document pointed at that one would carry every cache header this
        // test asserts and hydrate nothing
        expect(built.assets.filter((a) => a.kind === "entry-point").map((a) => basename(a.path))).toEqual([
          entry,
        ]);
        // the app's own html still says what it always said
        expect(readFileSync("index.html", "utf8")).toContain('src="/assets/client.js"');

        for (const { mode, base } of one.servers) {
          const html = await (await fetch(`${base}/`)).text();
          const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
          expect(refs).toContain(`/assets/${entry}`);
          expect(refs).toContain(`/assets/${style}`);
          // every asset url in the document, answered by the server that sent it
          for (const url of refs) {
            const res = await fetch(base + url);
            expect(`${mode} ${url}: ${res.status} ${res.headers.get("Cache-Control")}`).toBe(
              `${mode} ${url}: 200 ${IMMUTABLE}`,
            );
          }
        }

        // the worker's precache: every url listed exists, because cache.addAll
        // rejects as a whole and a worker that cannot install never replaces
        // the one already holding the previous deploy
        const precache = JSON.parse(readFileSync("public/assets/precache.json", "utf8"));
        expect(precache.assets).toContain(`/assets/${entry}`);
        expect(precache.assets).toContain(`/assets/${style}`);
        for (const url of precache.assets) {
          expect(`${url} exists: ${existsSync("public" + url)}`).toBe(`${url} exists: true`);
        }
        expect(readFileSync("public/sw.js", "utf8")).toContain(
          `const BUILD = ${JSON.stringify(precache.stamp)};`,
        );

        for (const stop of running.splice(0)) stop();
        writeFileSync(join(dir, "pages/index.tsx"), "export default () => <h1>two</h1>;\n");
        writeFileSync(join(dir, "style.scss"), "body { color: seagreen; }\n");
        await buildAssets(false);
        const two = boot();
        expect(two.names["client.js"]).not.toBe(entry);
        expect(two.names["style.css"]).not.toBe(style);

        for (const { mode, base } of two.servers) {
          const html = await (await fetch(`${base}/`)).text();
          expect(`${mode}: ${html.includes(`/assets/${two.names["client.js"]}`)}`).toBe(
            `${mode}: true`,
          );
          expect(html).not.toContain(`/assets/${entry}`);
          expect(html).not.toContain(`/assets/${style}`);
          for (const url of [`/assets/${two.names["client.js"]}`, `/assets/${two.names["style.css"]}`]) {
            const res = await fetch(base + url);
            expect(`${mode} ${url}: ${res.status} ${res.headers.get("Cache-Control")}`).toBe(
              `${mode} ${url}: 200 ${IMMUTABLE}`,
            );
          }
          // the year is only safe because the previous url left with its bytes
          expect(`${mode}: ${(await fetch(`${base}/assets/${entry}`)).status}`).toBe(`${mode}: 404`);
        }

        const restamped = JSON.parse(readFileSync("public/assets/precache.json", "utf8"));
        expect(restamped.stamp).not.toBe(precache.stamp);
        for (const url of restamped.assets) {
          expect(`${url} exists: ${existsSync("public" + url)}`).toBe(`${url} exists: true`);
        }

        // a partial deploy: .borgo/ from this build, public/assets/ missing one
        // of the files it names. Nothing about that url can be repaired at
        // request time, so the server must refuse to boot on the record alone
        for (const stop of running.splice(0)) stop();
        rmSync(join("public/assets", two.names["style.css"]!));
        expect(missingBuiltAssets()).toEqual([two.names["style.css"]!]);
        await buildAssets(false); // which is what serve() does when it reports one
        expect(missingBuiltAssets()).toEqual([]);
        for (const { mode, base } of boot().servers) {
          const html = await (await fetch(`${base}/`)).text();
          const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
          expect(refs.length).toBeGreaterThan(1);
          for (const url of refs) {
            const res = await fetch(base + url);
            expect(`${mode} ${url}: ${res.status}`).toBe(`${mode} ${url}: 200`);
          }
        }
      } finally {
        for (const stop of running) stop();
        process.chdir(cwd);
        rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );

  // dev names the entry once and keeps it, because the dev server resolves the
  // shell at boot and rebuilds behind it all day. The production build that
  // follows must take that name away with it, which is also the upgrade from
  // any borgo that never hashed an entry at all.
  test.skipIf(!existsSync(join(APP_HOST, "node_modules/react")))(
    "a dev build keeps the plain names, and the next production build removes them",
    async () => {
      const dir = mkdtempSync(join(APP_HOST, "borgo-dev-names-"));
      const cwd = process.cwd();
      try {
        mkdirSync(join(dir, "pages"), { recursive: true });
        writeFileSync(join(dir, "style.scss"), "body { color: rebeccapurple; }\n");
        writeFileSync(join(dir, "pages/index.tsx"), "export default () => <h1>one</h1>;\n");
        process.chdir(dir);

        await buildAssets(true);
        expect(readAssetNames()).toMatchObject({ "client.js": "client.js", "style.css": "style.css" });
        expect(existsSync("public/assets/client.js")).toBe(true);

        await buildAssets(false);
        expect(readAssetNames()["client.js"]).toMatch(/^client-[a-z0-9]+\.js$/);
        for (const stale of ["public/assets/client.js", "public/assets/style.css"]) {
          expect(`${stale} left behind: ${existsSync(stale)}`).toBe(`${stale} left behind: false`);
        }
        // a build that wrote everything it promised takes its mark with it, or
        // every boot after it would rebuild a tree that is perfectly good
        expect(buildLeftUnfinished()).toBe(false);
        expect(buildReasons()).toEqual([]);
      } finally {
        process.chdir(cwd);
        rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

describe("the names a document is written against", () => {
  test("entryOutputNames reads the emitted filename, hashed or not", () => {
    expect(
      entryOutputNames(["client-6j5pq722.js", "islands-client-p5d0n9ga.js", "page-a1b2c3d4.js"]),
    ).toEqual({ "client.js": "client-6j5pq722.js", "islands-client.js": "islands-client-p5d0n9ga.js" });
    // a dev build, where the entries keep their plain names
    expect(entryOutputNames(["client.js", "islands-client.js"])).toEqual({
      "client.js": "client.js",
      "islands-client.js": "islands-client.js",
    });
    // the islands entry is not the client entry with a prefix
    expect(entryOutputNames(["islands-client-abc12345.js"])["client.js"]).toBeUndefined();
  });

  // every degradation here must land on the name the document already carries:
  // that url revalidates and works, where a guessed one is a blank page
  test("a missing, old or malformed record resolves to no name at all", () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-names-"));
    const path = join(dir, "build-output.json");
    try {
      expect(readAssetNames(path)).toEqual({});
      for (const body of [
        "{not json",
        "",
        JSON.stringify({ files: ["client.js"] }), // an older borgo, no entries
        JSON.stringify({ entries: ["client.js"] }),
        JSON.stringify({ entries: { "client.js": 7 } }),
        JSON.stringify({ entries: { "client.js": "" } }),
        // a name that describes some other file is not a name in this directory
        JSON.stringify({ entries: { "client.js": "../../etc/passwd" } }),
        JSON.stringify({ entries: { "client.js": "sub\\client.js" } }),
        // only the urls a shell can hold are honoured
        JSON.stringify({ entries: { "vendor.js": "vendor-a1b2c3d4.js" } }),
      ]) {
        writeFileSync(path, body);
        expect(`${body.slice(0, 45)} -> ${JSON.stringify(readAssetNames(path))}`).toBe(
          `${body.slice(0, 45)} -> {}`,
        );
      }
      writeFileSync(path, JSON.stringify({ entries: { "client.js": "client-6j5pq722.js", "sw.js": "x" } }));
      expect(readAssetNames(path)).toEqual({ "client.js": "client-6j5pq722.js" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // `.borgo/` from one build beside a public/assets/ from another - a partial
  // deploy, a COPY that missed the css - is a record naming files that are not
  // there. Checking only the entry boots a healthy-looking server that serves
  // an unstyled page, or a page with no islands, until someone rebuilds by hand.
  test("every recorded name is checked on disk, not just the entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-present-"));
    const cwd = process.cwd();
    try {
      mkdirSync(join(dir, "public/assets"), { recursive: true });
      process.chdir(dir);
      const names = {
        "client.js": "client-6j5pq722.js",
        "islands-client.js": "islands-client-p5d0n9ga.js",
        "style.css": "style-9f3a1c07.css",
      };
      for (const name of Object.values(names)) writeFileSync(`public/assets/${name}`, "x");
      expect(missingBuiltAssets(names)).toEqual([]);

      for (const gone of Object.values(names)) {
        rmSync(`public/assets/${gone}`);
        expect(missingBuiltAssets(names)).toEqual([gone]);
        writeFileSync(`public/assets/${gone}`, "x");
      }

      // no record at all: the plain entry name stands in, so an app upgrading
      // from a borgo that hashed nothing still has its build recognised
      expect(missingBuiltAssets({})).toEqual(["client.js"]);
      writeFileSync("public/assets/client.js", "x");
      expect(missingBuiltAssets({})).toEqual([]);

      // and the decision the server actually makes on it
      mkdirSync(".borgo", { recursive: true });
      expect(needsBuild(false, names)).toBe(true); // no route manifest yet
      writeFileSync(".borgo/routes.gen.tsx", "");
      expect(needsBuild(false, names)).toBe(false);
      expect(needsBuild(true, names)).toBe(true); // dev always rebuilds
      rmSync(`public/assets/${names["style.css"]}`);
      expect(needsBuild(false, names)).toBe(true);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // existsSync answers a question nobody asked. Measured on a real tree before
  // this looked at anything but the path: an entry truncated to zero bytes
  // booted silently and answered /assets/client-<hash>.js with 204 and an empty
  // body - a success, to every cache and every log - and the page never
  // hydrated. A directory in its place booted silently and 404'd. A chunk the
  // record names, deleted, booted silently: the check only ever looked at the
  // three logical names, and the entry imports the other fourteen.
  describe("a recorded name is checked as a file, not as a path", () => {
    const ENTRY = "client-6j5pq722.js";
    const CHUNK = "page-a1b2c3d4.js";
    const STYLE = "style-9f3a1c07.css";
    const names = { "client.js": ENTRY, "style.css": STYLE };
    const inventory = [ENTRY, CHUNK, STYLE];

    const withTree = (fn: (dir: string, check: () => string[]) => void) => () => {
      const dir = mkdtempSync(join(tmpdir(), "borgo-usable-"));
      try {
        // the entry's length as the build recorded it; the chunk and the
        // stylesheet are on the record's `files` list but not vouched for
        const outputs = { dir, sizes: new Map([[ENTRY, 11]]) };
        writeFileSync(join(dir, ENTRY), "console.log");
        writeFileSync(join(dir, CHUNK), "export{}");
        writeFileSync(join(dir, STYLE), "body{}");
        fn(dir, () =>
          unusableBuiltAssets(names, inventory, outputs, dir).map((p) => `${p.name} ${p.why}`),
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    test(
      "an intact tree is usable",
      withTree((_dir, check) => {
        expect(check()).toEqual([]);
      }),
    );

    test(
      "an entry truncated to nothing is not a build, it is a 204",
      withTree((dir, check) => {
        writeFileSync(join(dir, ENTRY), "");
        expect(check()).toEqual([`${ENTRY} is empty`]);
      }),
    );

    test(
      "a directory standing where the entry should be",
      withTree((dir, check) => {
        rmSync(join(dir, ENTRY));
        mkdirSync(join(dir, ENTRY));
        expect(check()).toEqual([`${ENTRY} is not a file`]);
      }),
    );

    test(
      "a chunk the record names, which is not one of the three logical names",
      withTree((dir, check) => {
        rmSync(join(dir, CHUNK));
        expect(check()).toEqual([`${CHUNK} is missing`]);
      }),
    );

    test(
      "a file that is not the length the build recorded",
      withTree((dir, check) => {
        writeFileSync(join(dir, ENTRY), "cut");
        expect(check()).toEqual([`${ENTRY} is 3 bytes where the build recorded 11`]);
      }),
    );

    // and the one empty file that is not a symptom: a style.scss holding
    // nothing but variables compiles to zero bytes, and a boot that rebuilt for
    // that would rebuild on every boot forever, for a file that is exactly what
    // it was written to be. It is condemned only when the record vouches for a
    // length it no longer has.
    test(
      "an empty stylesheet nothing vouched for is left alone",
      withTree((dir, check) => {
        writeFileSync(join(dir, STYLE), "");
        expect(check()).toEqual([]);
      }),
    );

    test("but an empty one the build measured is not", () => {
      const dir = mkdtempSync(join(tmpdir(), "borgo-usable-css-"));
      try {
        writeFileSync(join(dir, ENTRY), "console.log");
        writeFileSync(join(dir, STYLE), "");
        const outputs = { dir, sizes: new Map([[STYLE, 6]]) };
        expect(unusableBuiltAssets(names, [ENTRY, STYLE], outputs, dir)).toEqual([
          { name: STYLE, why: "is empty" },
        ]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // and the decision a boot makes on all of it
    test("a chunk missing from a real record is a reason to build", () => {
      const dir = mkdtempSync(join(tmpdir(), "borgo-usable-boot-"));
      const cwd = process.cwd();
      try {
        mkdirSync(join(dir, "public/assets"), { recursive: true });
        mkdirSync(join(dir, ".borgo"), { recursive: true });
        process.chdir(dir);
        for (const name of inventory) writeFileSync(`public/assets/${name}`, "x");
        writeFileSync(".borgo/routes.gen.tsx", "");
        writeFileSync(
          ".borgo/build-output.json",
          JSON.stringify({ files: inventory, dir: "public/assets", hashed: {}, entries: names }) + "\n",
        );
        expect(needsBuild(false)).toBe(false);

        rmSync(`public/assets/${CHUNK}`);
        expect(needsBuild(false)).toBe(true);
        expect(buildReasons()).toEqual([`in public/assets, ${CHUNK} is missing`]);
      } finally {
        process.chdir(cwd);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("emittedStylesheet", () => {
    const fixture = (fn: (dir: string) => Promise<void> | void) => async () => {
      const dir = mkdtempSync(join(tmpdir(), "borgo-stylesheet-"));
      try {
        await fn(dir.replaceAll("\\", "/"));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    test(
      "production names it after its bytes, and moves the name when they move",
      fixture(async (dir) => {
        writeFileSync(join(dir, "style.css"), "body{color:red}");
        const first = (await emittedStylesheet(false, undefined, dir))!;
        expect(first).toMatch(/^style-[a-z0-9]{8}\.css$/);
        // renamed, not copied: two files with the same bytes under different
        // names is the state where the sweep deletes the one in use
        expect(existsSync(join(dir, "style.css"))).toBe(false);
        expect(readFileSync(join(dir, first), "utf8")).toBe("body{color:red}");

        // the same bytes recompiled keep the same url, so a redeploy that did
        // not touch the css does not throw away a year of caching
        writeFileSync(join(dir, "style.css"), "body{color:red}");
        expect(await emittedStylesheet(false, first, dir)).toBe(first);

        writeFileSync(join(dir, "style.css"), "body{color:blue}");
        expect(await emittedStylesheet(false, first, dir)).not.toBe(first);
      }),
    );

    test(
      "a build that compiled no css keeps the name the last one emitted",
      fixture(async (dir) => {
        writeFileSync(join(dir, "style-a1b2c3d4.css"), "body{}");
        expect(await emittedStylesheet(false, "style-a1b2c3d4.css", dir)).toBe("style-a1b2c3d4.css");
        // and one whose recorded file is gone reports no stylesheet rather
        // than a name nothing can answer
        expect(await emittedStylesheet(false, "style-deadbeef.css", dir)).toBeNull();
        expect(await emittedStylesheet(false, undefined, dir)).toBeNull();
      }),
    );

    test(
      "dev leaves the plain name, because the shell is resolved once at boot",
      fixture(async (dir) => {
        writeFileSync(join(dir, "style.css"), "body{color:red}");
        expect(await emittedStylesheet(true, undefined, dir)).toBe("style.css");
        expect(existsSync(join(dir, "style.css"))).toBe(true);
      }),
    );
  });
});

describe("sweepBuildOutput", () => {
  test("clears the recorded build and leaves the app's files where they were", () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-sweep-"));
    try {
      const mine = [
        "analytics.js",
        "widget.js",
        "vendor.min.js",
        "logo.svg",
        "data.json",
        "style.css",
        // the one the shape-matching sweep took with it
        "analytics-9f8e7d6c.js",
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

      const removed = sweepBuildOutput(dir, ["page-abc12345.js"]);

      expect(removed.sort()).toEqual([...theirs].sort());
      for (const f of theirs) expect(existsSync(join(dir, f))).toBe(false);
      // the whole point: a file the app put here survives the next build,
      // whatever its name happens to look like
      for (const f of mine) expect(existsSync(join(dir, f))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no inventory sweeps only the names borgo always writes", () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-sweep-legacy-"));
    try {
      for (const f of ["client.js", "page-abc12345.js", "analytics-9f8e7d6c.js"]) {
        writeFileSync(join(dir, f), "x");
      }
      expect(sweepBuildOutput(dir, null)).toEqual(["client.js"]);
      // an unidentifiable chunk is dead weight; a deleted app file is not
      // recoverable, and public/assets is gitignored by every template
      expect(existsSync(join(dir, "analytics-9f8e7d6c.js"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a directory that does not exist yet is not an error", () => {
    expect(sweepBuildOutput(join(tmpdir(), "borgo-no-such-dir-" + Date.now()), [])).toEqual([]);
  });

  // A build that compiles no css keeps the stylesheet the last one emitted, so
  // that name is on the previous inventory *and* in use by the document this
  // build is about to serve. Swept, it is a page with no styles until someone
  // rebuilds - the same shape as the precache pointing at a name that is gone.
  test("an output this build reused is kept, though the last build recorded it", () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-sweep-reuse-"));
    try {
      for (const f of ["style-a1b2c3d4.css", "style-a1b2c3d4.css.gz", "client-old00000.js"]) {
        writeFileSync(join(dir, f), "x");
      }
      const previous = ["style-a1b2c3d4.css", "client-old00000.js"];
      const removed = sweepBuildOutput(dir, previous, ["client-new00000.js", "style-a1b2c3d4.css"]);
      // the precompressed sibling goes, as every sibling does - precompression
      // runs after the sweep and writes it again
      expect(removed.sort()).toEqual(["client-old00000.js", "style-a1b2c3d4.css.gz"]);
      expect(existsSync(join(dir, "style-a1b2c3d4.css"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
      mkdirSync(join(dir, ".borgo"), { recursive: true });
      for (const f of ["style.css", "style.css.gz", "style.css.br"]) {
        writeFileSync(join(dir, "public/assets", f), "body{color:red}");
      }
      // an app file in the same directory is not compileCss's to remove
      writeFileSync(join(dir, "public/assets", "analytics.js"), "// mine");
      // and the record of the build that emitted the stylesheet, which is what
      // makes it borgo's to drop rather than a file of somebody else's
      writeFileSync(
        join(dir, ".borgo/build-output.json"),
        JSON.stringify({ files: ["client.js", "style.css"] }) + "\n",
      );

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

  // the other half of the same rule, and the reason the fixture above needs a
  // record at all: public/assets is gitignored by every template, so a
  // stylesheet borgo cannot prove it wrote is one nothing can restore. The
  // sweep settled this question the same way for chunks - with no record, the
  // file stays - and this used to be the one deletion that ignored it, silently
  // and on exit 0.
  test("a stylesheet no build of borgo's recorded is not compileCss's to delete", async () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-css-unowned-"));
    process.chdir(dir);
    try {
      mkdirSync(join(dir, "public/assets"), { recursive: true });
      // no .borgo/build-output.json at all: an older borgo, a copy step, a
      // hand-placed file - nothing here says this was borgo's output
      for (const f of ["style.css", "style.css.gz"]) {
        writeFileSync(join(dir, "public/assets", f), "body{color:red}");
      }

      expect(await compileCss(false)).toBe(false);

      for (const f of ["style.css", "style.css.gz"]) {
        expect(`${f} kept: ${existsSync(join(dir, "public/assets", f))}`).toBe(`${f} kept: true`);
      }
      expect(readFileSync(join(dir, "public/assets/style.css"), "utf8")).toBe("body{color:red}");
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // and a build that did not write it does not get to rename it into its own
  // output either: adopting the file is the next build's licence to sweep it
  test("a stylesheet this build did not compile is not renamed into its output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-css-adopt-"));
    try {
      writeFileSync(join(dir, "style.css"), "body{color:red}");
      expect(await emittedStylesheet(false, undefined, dir, false)).toBeNull();
      expect(existsSync(join(dir, "style.css"))).toBe(true);
      // the build that did compile it names it after its bytes, as before
      expect(await emittedStylesheet(false, undefined, dir, true)).toMatch(/^style-[a-z0-9]{8}\.css$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // `create-borgo --tailwind` deletes style.scss and makes style.css the
  // entry, but only wired --tailwind into dev/build/start - so `borgo export`
  // (and a bare `borgo build`) ran with BORGO_TAILWIND unset, found no
  // style.scss, and deleted public/assets/style.css, its .gz and its .br. The
  // exported pages still linked it, public/assets is gitignored by all three
  // templates, and the app's only stylesheet was gone for good. Exit 0.
  test("a tailwind app's stylesheet survives a build that forgot the flag", async () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-css-tailwind-"));
    process.chdir(dir);
    const hadFlag = process.env.BORGO_TAILWIND;
    delete process.env.BORGO_TAILWIND;
    try {
      // exactly what the tailwind scaffold leaves behind: a style.css entry in
      // the app root, no style.scss anywhere
      writeFileSync(join(dir, "style.css"), '@import "tailwindcss";\n');
      mkdirSync(join(dir, "public/assets"), { recursive: true });
      for (const f of ["style.css", "style.css.gz", "style.css.br"]) {
        writeFileSync(join(dir, "public/assets", f), "body{color:red}");
      }

      await compileCss(false);

      for (const f of ["style.css", "style.css.gz", "style.css.br"]) {
        expect(existsSync(join(dir, "public/assets", f))).toBe(true);
      }
      expect(readFileSync(join(dir, "public/assets/style.css"), "utf8")).toBe("body{color:red}");
    } finally {
      if (hadFlag === undefined) delete process.env.BORGO_TAILWIND;
      else process.env.BORGO_TAILWIND = hadFlag;
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // the same forgotten flag on a clone that has never been built. There is no
  // "last build" to leave the stylesheet as, and public/assets is gitignored by
  // every template, so what the message described did not exist: the build
  // exited 0 having produced an app whose every page links a stylesheet that is
  // not there, and said so in words that read like everything was fine.
  test("a tailwind app with nothing to keep fails instead of exiting 0 with no stylesheet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-css-clean-clone-"));
    process.chdir(dir);
    const hadFlag = process.env.BORGO_TAILWIND;
    delete process.env.BORGO_TAILWIND;
    try {
      writeFileSync(join(dir, "style.css"), '@import "tailwindcss";\n');
      mkdirSync(join(dir, "public/assets"), { recursive: true });

      expect(compileCss(false)).rejects.toThrow("re-run with --tailwind");
      // and it says so before anything is written, not after
      expect(existsSync(join(dir, "public/assets/style.css"))).toBe(false);
    } finally {
      if (hadFlag === undefined) delete process.env.BORGO_TAILWIND;
      else process.env.BORGO_TAILWIND = hadFlag;
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cssSource names the entry the app actually has", () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-css-source-"));
    try {
      expect(cssSource(dir)).toBeNull();
      writeFileSync(join(dir, "style.css"), "");
      expect(cssSource(dir)).toBe("css");
      writeFileSync(join(dir, "style.scss"), "");
      expect(cssSource(dir)).toBe("scss");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a stylesheet that still exists is compiled, not dropped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-css-live-"));
    process.chdir(dir);
    try {
      // scss a copy would not survive: a variable to substitute and a nested
      // rule to flatten, neither of which is valid css
      writeFileSync(join(dir, "style.scss"), "$brand: #cc3333;\nbody { color: $brand; a { color: $brand; } }\n");
      await compileCss(true);
      const css = readFileSync(join(dir, "public/assets/style.css"), "utf8");
      expect(css).toContain("body a");
      expect(css).toContain("#cc3333");
      expect(css).not.toContain("$brand");
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
    // the only test that reaches sass: importing sass-embedded and spawning
    // its dart compiler measured 6.9s cold, ~310ms warm
  }, 60_000);
});

// BundleFailed had a handler and nothing else did. A sass parse error, an
// EACCES on public/assets, a tailwind plugin throwing - each came out of
// `borgo build` as a raw v8 trace with borgo's own source comments quoted
// inside it, which is the one thing on screen that names no file of the
// operator's, printed instead of the one line that does.
describe("reportBuildFailure", () => {
  const captured = (error: unknown, debug = false) => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void lines.push(args.join(" "));
    try {
      reportBuildFailure(error, debug);
    } finally {
      console.error = original;
    }
    // the colour codes are not what is under test
    return lines.join("\n").replaceAll(/\[[0-9;]*m/g, "");
  };

  test("a bundler failure keeps the framing it always had", () => {
    const out = captured(new BundleFailed(["pages/index.tsx:1:1 - unexpected }"]));
    expect(out).toContain("the client bundle failed to build");
    expect(out).toContain("pages/index.tsx:1:1");
    expect(out).toContain("public/assets still holds the last build that worked");
  });

  test("anything else gets the message, its cause, its path, and the stack behind a flag", () => {
    const error = Object.assign(new Error("EACCES: permission denied, open 'public/assets/style.css'"), {
      path: "public\\assets\\style.css",
      cause: new Error("the directory is read-only"),
    });
    const out = captured(error);
    expect(out).toContain("EACCES: permission denied");
    expect(out).toContain("caused by");
    expect(out).toContain("the directory is read-only");
    expect(out).toContain("public/assets/style.css");
    // the stack is offered, not printed
    expect(out).toContain("run it again with --debug for the stack");
    expect(out).not.toContain("at <anonymous>");
    expect(captured(error, true)).toContain("Error: EACCES");
  });

  test("a thrown non-error is still a message and not a trace", () => {
    expect(captured("go build died")).toContain("go build died");
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

// A BUILD THAT FAILS MUST CHANGE NOTHING.
//
// Bun.build reports failure two ways and borgo used to notice neither: with
// `throw: true` (its default) an AggregateError escapes as a raw trace, and with
// the result checked by hand `result.success` was simply never read. So a failed
// bundle fell through to the sweep and to `.borgo/build-mode = production`, over
// a tree it had just emptied - the sweep ran BEFORE the bundle, so one parse
// error left public/assets holding nothing but style.css: client.js, every
// chunk, precache.json and every precompressed sibling gone, and the last build
// that actually worked gone with them. public/assets is gitignored by every
// template, so there was nothing to restore it from.
//
// The inventory is read before the bundle and swept only after it succeeds.
describe("a failed bundle leaves the last good build alone", () => {
  const originalCwd = process.cwd();
  let dir: string;

  // the previous build's output, as it would be sitting on disk
  const PREVIOUS = {
    "client.js": "// the last build that worked",
    "page-a1b2c3d4.js": "// a hashed chunk of it",
    "precache.json": '{"stamp":"old","assets":[]}',
    "style.css": "body{color:red}",
  };
  // and an app file that lives in the same directory and is nobody's output
  const APP_FILE = ["analytics-9f8e7d6c.js", "// vendored, hashed, and not borgo's"] as const;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "borgo-failed-build-"));
    mkdirSync(join(dir, "pages"), { recursive: true });
    mkdirSync(join(dir, "public/assets"), { recursive: true });
    mkdirSync(join(dir, ".borgo"), { recursive: true });

    // a page that cannot be bundled: the failure has to come from the bundler,
    // not from a missing directory the manifest step would have caught first
    writeFileSync(join(dir, "pages/index.tsx"), "export default function Home() { return ( }\n");
    // the app keeps its stylesheet entry: with none, compileCss drops the
    // emitted style.css as an orphan, which is its job and not what is under test
    writeFileSync(join(dir, "style.css"), "body{color:red}");

    for (const [name, body] of Object.entries(PREVIOUS)) {
      writeFileSync(join(dir, "public/assets", name), body);
    }
    writeFileSync(join(dir, "public/assets", APP_FILE[0]), APP_FILE[1]);
    // what that previous build recorded as its own, and the mode it left
    writeFileSync(
      join(dir, ".borgo/build-output.json"),
      JSON.stringify({ files: ["client.js", "page-a1b2c3d4.js", "precache.json"] }) + "\n",
    );
    writeFileSync(join(dir, ".borgo/build-mode"), "production");
    process.chdir(dir);
  });

  afterAll(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  test("it fails as a BundleFailed, framed rather than thrown raw", async () => {
    let caught: unknown;
    try {
      await buildAssets(true);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BundleFailed);
    expect((caught as BundleFailed).name).toBe("BundleFailed");
    // one detail per bundler message, so the cli can print them as its own lines
    expect((caught as BundleFailed).details.length).toBeGreaterThan(0);
  });

  test("every byte of the previous build is still there", () => {
    for (const [name, body] of Object.entries(PREVIOUS)) {
      const path = join(dir, "public/assets", name);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf8")).toBe(body);
    }
  });

  test("and so is the app's own file, which was never borgo's to sweep", () => {
    expect(readFileSync(join(dir, "public/assets", APP_FILE[0]), "utf8")).toBe(APP_FILE[1]);
  });

  test("the recorded build mode still describes the build that is on disk", () => {
    // the failed run must not claim the tree is a production build: `borgo
    // start` reads this to decide whether to rebuild, and a mode written by a
    // build that emitted nothing is a mode that describes nothing
    expect(assetsBuildMode()).toBe("production");
  });

  test("and the inventory still names what is actually on disk", () => {
    expect(readBuildInventory()).toEqual(["client.js", "page-a1b2c3d4.js", "precache.json"]);
  });

  // AND IT MUST NOT ERASE THE REASON IT WAS NEEDED.
  //
  // generateManifest writes .borgo/routes.gen.tsx before anything downstream
  // can fail, so the first thing this failed build did was to satisfy the one
  // question the next boot asks: manifest present, assets present, nothing to
  // do. The operator read the failure once, restarted, and was told everything
  // was fine - on the previous build's assets, forever, with the error gone.
  test("the mark it left says the last build here did not finish", () => {
    expect(buildLeftUnfinished()).toBe(true);
    expect(buildReasons()).toContain("the last build here did not finish");
    // and the manifest it wrote before dying is exactly why the mark is needed
    expect(existsSync(join(dir, ".borgo/routes.gen.tsx"))).toBe(true);
  });
});
