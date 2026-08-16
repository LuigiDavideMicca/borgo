import { describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  removeScratchBin,
  requestResidue,
  unsafeParamReason,
} from "../src/export";
import { CSRF_FIELD } from "../src/index";
import { createSecurity } from "../src/util";
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

// EVERY DOCUMENT BELOW IS A REAL ONE, copied out of a dist/site produced by
// `borgo export` against a scratch app - which is where the defect was read in
// the first place: six files, six different nonces, and a __borgo_csrf value
// sitting in a form whose cookie no static host will ever set.
describe("requestResidue", () => {
  const doc = (body: string, tail = "<script>window.__PROPS__={}</script>") =>
    `<!DOCTYPE html>\n<html lang="en">\n<head><title>t</title></head>\n<body>\n<div id="root">${body}</div>\n${tail}\n</body>\n</html>\n`;

  test("a page with no form is publishable", () => {
    expect(requestResidue(doc("<h1>no form here</h1>"))).toEqual([]);
  });

  test("a form without a CsrfField is publishable", () => {
    const body = `<form action="https://example.com/collect" method="post"><input name="q"/><button>search</button></form>`;
    expect(requestResidue(doc(body))).toEqual([]);
  });

  test("a form with a CsrfField is refused, naming the cookie that is missing", () => {
    const body = `<form method="post"><input type="hidden" name="${CSRF_FIELD}" value="4c9a31f601a942679a32ea71f873d9d9"/><button>go</button></form>`;
    const [found, ...rest] = requestResidue(doc(body));
    expect(rest).toEqual([]);
    expect(found.what).toContain("CsrfField");
    // and the advice says what to do, not only what is wrong
    expect(found.why.join(" ")).toContain("borgo_csrf");
    expect(found.why.join(" ")).toContain("borgo start");
  });

  // an empty token is not the safe case: the field is still there, still
  // checked against nothing, and the form is still dead
  test("an empty CsrfField value is refused too", () => {
    const body = `<form method="post"><input type="hidden" name="${CSRF_FIELD}" value=""/></form>`;
    expect(requestResidue(doc(body))).toHaveLength(1);
  });

  // react writes props in whatever order the component passed them, and a
  // future react could reorder attributes; the check must not depend on it
  test("the field is caught whatever the attribute order", () => {
    for (const input of [
      `<input name="${CSRF_FIELD}" type="hidden" value="a"/>`,
      `<input value="a" type="hidden" name="${CSRF_FIELD}"/>`,
      `<input\n  type="hidden"\n  name="${CSRF_FIELD}"\n/>`,
    ]) {
      expect(requestResidue(doc(`<form method="post">${input}</form>`))).toHaveLength(1);
    }
  });

  test("a nonce on any inline script or style is refused", () => {
    const nonced = `<script nonce="2e92acefe362452dabdc8a2e74c3f227">window.__PROPS__={}</script>`;
    const [found] = requestResidue(doc("<h1>hi</h1>", nonced));
    expect(found.what).toContain("nonce");
    expect(found.why.join(" ")).toContain("static host");
    expect(requestResidue(doc(`<style nonce="abc">.a{}</style>`))).toHaveLength(1);
  });

  // an inline script the page wrote itself is fine - it is the nonce that is
  // the per-request value, not the script
  test("an inline script without a nonce is publishable", () => {
    const body = `<div><script>window.__probe = 1;</script><p>inline script above</p></div>`;
    expect(requestResidue(doc(body))).toEqual([]);
  });

  test("both residues are reported, not just the first", () => {
    const body = `<form method="post"><input type="hidden" name="${CSRF_FIELD}" value="x"/></form>`;
    expect(requestResidue(doc(body, `<script nonce="x">1</script>`))).toHaveLength(2);
  });

  // a page ABOUT csrf, or a loader that returns the words, must export: react
  // escapes "<" in text and scriptJson escapes it in props, so a tag pattern
  // can only ever match a real tag. This is why the checks are anchored on the
  // tag and not on the bare field name.
  test("page content that merely talks about csrf still exports", () => {
    const prose = doc(
      `<p>write &lt;input type="hidden" name="${CSRF_FIELD}" value="..."/&gt; by hand and set nonce="x" on it</p>`,
      `<script>window.__PROPS__={"post":"\\u003cscript nonce=\\"x\\"\\u003e and \\u003cinput name=\\"${CSRF_FIELD}\\"\\u003e"}</script>`,
    );
    expect(requestResidue(prose)).toEqual([]);
  });

  // the export renders through the same server as ssr, so a route that opts out
  // of hydration produces a document with no inline script at all
  test("a zero-js document has nothing to strip", () => {
    expect(requestResidue(doc("<p>static</p>", ""))).toEqual([]);
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

// THE PROOF IS ON THE BYTES OF THE EXPORTED FILE, not on what a function
// returned. requestResidue above is asked of strings a test wrote; this asks
// the real command, against a real app, and then reads what is on disk - which
// is the only artifact a visitor ever sees.
//
// What was on disk before this: every document carried `nonce="<32 hex>"` on
// its props script, a different one per page and per run, referring to a
// Content-Security-Policy header that a static host does not send and cannot
// reproduce. And a page with <CsrfField /> carried a hidden __borgo_csrf value
// that was the same for every visitor forever, checked against a borgo_csrf
// cookie that nothing on a static site sets. Both are the same mistake: a value
// that meant something to ONE request, published as a file.
describe("an exported page carries nothing per-request", () => {
  const APP_HOST = join(import.meta.dir, "../../../examples/tasks");
  const CLI = join(import.meta.dir, "../src/cli.ts");

  test.skipIf(!existsSync(join(APP_HOST, "node_modules/react")))(
    "no nonce, no csrf token, and the page that would need one is refused by name",
    async () => {
      const dir = mkdtempSync(join(APP_HOST, "borgo-residue-"));
      const run = (env: Record<string, string> = {}) =>
        Bun.spawnSync([process.execPath, CLI, "export"], {
          cwd: dir,
          env: { ...process.env, BORGO_RELOAD: "1", ...env },
          stdout: "pipe",
          stderr: "pipe",
        });
      const site = join(dir, "dist/site");
      const htmlFiles = () =>
        [...new Bun.Glob("**/*.html").scanSync(site)].map((f) => f.replaceAll("\\", "/")).sort();
      const read = (f: string) => readFileSync(join(site, f), "utf8");
      try {
        mkdirSync(join(dir, "pages"), { recursive: true });
        cpSync(join(APP_HOST, "index.html"), join(dir, "index.html"));
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "residue-scratch", private: true }));
        writeFileSync(join(dir, "style.scss"), "body { color: #3d2f24; }\n");
        writeFileSync(join(dir, "pages/index.tsx"), "export default () => <h1>no form here</h1>;\n");
        // a form that posts somewhere else needs no csrf token and must export
        writeFileSync(
          join(dir, "pages/search.tsx"),
          `export default () => <form method="post" action="https://example.com/collect"><input name="q" /></form>;\n`,
        );
        // an inline script is fine; it is the nonce that is per-request
        writeFileSync(
          join(dir, "pages/inline.tsx"),
          `export default () => <script dangerouslySetInnerHTML={{ __html: "window.__probe = 1;" }} />;\n`,
        );
        writeFileSync(join(dir, "pages/_404.tsx"), "export default () => <p>nothing here</p>;\n");

        // the operator asks for a csp on purpose: it still cannot ship in a
        // file, so it must not leave a nonce behind pretending it did
        expect(run({ BORGO_CSP: "default-src 'self'; script-src 'self'{nonce}" }).exitCode).toBe(0);
        const whole = htmlFiles();
        expect(whole).toEqual(["404.html", "index.html", "inline/index.html", "search/index.html"]);

        for (const f of whole) {
          const html = read(f);
          expect(html).not.toContain("nonce=");
          expect(html).not.toContain(CSRF_FIELD);
        }
        // and the pages are otherwise whole: the props script is still there
        // without its nonce, and the page's own inline script is untouched
        expect(read("index.html")).toContain("<script>window.__PROPS__=");
        expect(read("inline/index.html")).toContain("window.__probe = 1;");
        expect(read("search/index.html")).toContain('action="https://example.com/collect"');
        expect(read("404.html")).toContain("nothing here");

        const first = whole.map(read);

        // now the page that cannot be static
        writeFileSync(
          join(dir, "pages/login.tsx"),
          `import { CsrfField } from "borgo-framework";\n` +
            `export default () => <form method="post"><CsrfField /><input name="u" /></form>;\n`,
        );
        const refused = run();
        expect(refused.exitCode).toBe(1);
        const said = refused.stdout.toString() + refused.stderr.toString();
        // it names the page, says what the value is, and says what to do
        expect(said).toContain("/login");
        expect(said).toContain("CsrfField");
        expect(said).toContain("borgo start");
        expect(said).toContain("not published");
        // nothing partial reached the published tree, and the login page is
        // nowhere in it - the export stopped rather than shipping a dead form
        expect(htmlFiles()).toEqual(whole);
        expect(whole.map(read)).toEqual(first);
        expect(existsSync(join(site, "login/index.html"))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    300_000,
  );
});

// a static host has no ?__borgo=props endpoint: it answers that url with the
// page's own html document and a 200, so res.ok passes, res.json() throws, and
// the navigation ends in the full reload the catch does anyway - having paid
// for a second whole document per link, and one more for every link a pointer
// crossed, since prefetch caches that doomed promise on hover. The flag is set
// before the bundle is built and reaches the runtime through the define map.
// A PARTIAL EXPORT IS NOT A SITE.
//
// `borgo export` deleted dist/site and then rendered into it, counting the
// pages that failed. So a run that died on page four published the three it had
// managed - with a valid index.html at the top, the assets beside it, and a
// hole where the rest of the site used to be. Exit was 1, which a CI step that
// uploads dist/ after the build does not necessarily read, and nothing about
// the published tree says it is incomplete.
//
// Run as a child process against a real app: the whole point is the order in
// which the real command touches the real directory.
describe("a partial export publishes nothing", () => {
  const APP_HOST = join(import.meta.dir, "../../../examples/tasks");
  const CLI = join(import.meta.dir, "../src/cli.ts");

  test.skipIf(!existsSync(join(APP_HOST, "node_modules/react")))(
    "a page that fails to render leaves the last whole export standing",
    async () => {
      // inside the example app, which is where a real bundle finds react
      const dir = mkdtempSync(join(APP_HOST, "borgo-export-"));
      const run = () =>
        Bun.spawnSync([process.execPath, CLI, "export"], {
          cwd: dir,
          env: { ...process.env, BORGO_RELOAD: "1" },
          stdout: "pipe",
          stderr: "pipe",
        });
      const published = () =>
        [...new Bun.Glob("**/*.html").scanSync(join(dir, "dist/site"))].map((f) => f.replaceAll("\\", "/")).sort();
      try {
        mkdirSync(join(dir, "pages"), { recursive: true });
        cpSync(join(APP_HOST, "index.html"), join(dir, "index.html"));
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "export-scratch", private: true }));
        writeFileSync(join(dir, "style.scss"), "body { color: #3d2f24; }\n");
        writeFileSync(join(dir, "pages/index.tsx"), "export default () => <h1>the first export</h1>;\n");
        writeFileSync(join(dir, "pages/about.tsx"), "export default () => <p>about</p>;\n");

        expect(run().exitCode).toBe(0);
        const whole = published();
        expect(whole).toEqual(["about/index.html", "index.html"]);
        const home = readFileSync(join(dir, "dist/site/index.html"), "utf8");
        expect(home).toContain("the first export");

        // the next export changes a page that renders fine and adds one that
        // throws where it renders - which is every reason a page fails at
        // export time: the server answers 500 and the run counts it
        writeFileSync(join(dir, "pages/index.tsx"), "export default () => <h1>the second export</h1>;\n");
        writeFileSync(
          join(dir, "pages/boom.tsx"),
          "export default function Boom() { throw new Error('this page cannot render'); }\n",
        );
        const second = run();
        expect(second.exitCode).toBe(1);
        const said = second.stdout.toString() + second.stderr.toString();
        expect(said).toContain("/boom");
        expect(said).toContain("not published");

        // what is on disk is still the export that rendered whole, byte for
        // byte: not one page of the run that failed reached it
        expect(published()).toEqual(whole);
        const onDisk = readFileSync(join(dir, "dist/site/index.html"), "utf8");
        expect(onDisk).toContain("the first export");
        expect(onDisk).not.toContain("the second export");
        expect(onDisk).toBe(home);
        // and no half-rendered tree was left beside it
        expect(readdirSync(join(dir, "dist"))).toEqual(["site"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});

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

  // the nonce is not stripped from the html afterwards, it is never minted:
  // one lever, read by the same resolveSwitches the export's own front server
  // reads, and it has to survive an operator who asked for a policy - because
  // their policy cannot ship with a file either
  test("markStaticExport turns the csp off, so no render mints a nonce", () => {
    const production = createSecurity(false, {});
    expect(production!.needsNonce).toBe(true);

    for (const asked of [undefined, "1", "true", "default-src 'self'; script-src 'self'{nonce}"]) {
      const env: NodeJS.ProcessEnv = asked === undefined ? {} : { BORGO_CSP: asked };
      markStaticExport(env);
      const security = createSecurity(false, { csp: env.BORGO_CSP });
      expect(security!.needsNonce).toBe(false);
      // and the header itself is gone: a policy that reaches no browser must
      // not sit in the response looking like one
      const res = security!.apply(new Response("<html></html>", { headers: { "Content-Type": "text/html" } }));
      expect(res.headers.get("Content-Security-Policy")).toBeNull();
      // the rest of the security headers are not collateral
      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    }
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

// EVERY EXPORT LEFT 21 MB BEHIND.
//
// The scratch api binary was built into .borgo/export-api.exe, spawned, killed
// - and removed by nobody. Measured on examples/tasks: export-api.exe,
// 21,217,280 bytes, dated two weeks before the run that found it. Reproduced in
// a scratch copy of that app on both paths, which is the whole point: a failed
// export (exit 1, one page refused) and a whole one (exit 0, 7 pages published)
// each left 21,276,160 bytes in .borgo/.
//
// So the removal belongs in the finally beside the kill, not at the end of the
// happy path - and the name has to exist before `go build` runs, because
// `go build -o` writes that file whether or not it finishes.
describe("the scratch binary an export builds to work", () => {
  const scratch = () => mkdtempSync(join(tmpdir(), "borgo-scratchbin-"));

  test("is removed, and a missing one is not an error", async () => {
    const dir = scratch();
    try {
      const bin = join(dir, "export-api.exe");
      writeFileSync(bin, "x");
      expect(await removeScratchBin(bin)).toBe(true);
      expect(existsSync(bin)).toBe(false);
      // a `go build` that wrote nothing at all leaves the finally with a name
      // and no file, which is not a thing to report
      expect(await removeScratchBin(bin)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // it runs from a finally: throwing here would replace the export's own
  // outcome with an EPERM on a file the operator never asked about
  test("says so rather than throwing when it cannot remove one", async () => {
    const dir = scratch();
    try {
      // rmSync without `recursive` refuses a non-empty directory on every
      // platform, which is the refusal windows produces for a locked image
      const bin = join(dir, "export-api.exe");
      mkdirSync(bin);
      writeFileSync(join(bin, "held"), "x");
      const said: string[] = [];
      expect(await removeScratchBin(bin, 2, 1, (line) => said.push(line))).toBe(false);
      expect(said.join("\n")).toContain(bin);
      expect(existsSync(bin)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // the structural guard, because the defect was never in removeScratchBin -
  // it was in where the call sat. A removal at the end of the happy path is
  // indistinguishable from this one until an export fails.
  test("is removed from the finally, and named before the build", () => {
    const source = readFileSync(join(import.meta.dir, "../src/export.ts"), "utf8");
    const closing = source.lastIndexOf("} finally {");
    expect(closing).toBeGreaterThan(-1);
    expect(source.slice(closing)).toContain("removeScratchBin(apiBin)");
    const named = source.indexOf("apiBin = `.borgo/export-");
    const built = source.indexOf('"go", "build"');
    expect(named).toBeGreaterThan(-1);
    expect(built).toBeGreaterThan(named);
  });
});
