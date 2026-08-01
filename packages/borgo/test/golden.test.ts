// GOLDEN (snapshot) TESTS
//
// The rest of the suite asserts behaviour one property at a time. These pin
// output *shape*: the whole rendered document, the whole generated .d.ts, the
// whole header set. A refactor that quietly moves where props are injected,
// renames a marker, reorders an interface or drops a Vary keeps every unit
// test green and breaks exactly one of these.
//
// REGENERATING
//
//   UPDATE_GOLDEN=1 bun test packages/borgo/test/golden.test.ts
//
// That rewrites every golden file from the current implementation. It is a
// deliberate act, not a way to make a red test green: regenerating without
// reading the diff first turns a contract into a transcript of whatever the
// code happens to do today, which is the one thing these tests exist to
// prevent. Read the printed diff, decide the change is intended, then update -
// and put the reason in the commit message.
//
// SCRUBBING
//
// A golden may only contain values that are the same on every machine and
// every run. What legitimately varies here is: the per-request csrf token and
// csp nonce (32 random hex), the content hash inside a built chunk name, the
// mtime half of an asset etag, and an http date. Each is replaced by a
// placeholder through a scrubber whose *pattern* is itself the assertion - a
// nonce that stopped being 32 hex characters, or an etag that lost its shape,
// no longer matches, so the placeholder never appears and the golden fails.
// Nothing here is loosened with a regex assertion instead.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAssetIndex, serveIndexed, type AssetInfo } from "../src/compress";
import type { PageModule, Route } from "../src/router";
import { createSecurity, prepareShell, renderPage, type RenderPageOptions } from "../src/util";

const GOLDEN_DIR = join(import.meta.dir, "golden");
const UPDATING = !!process.env.UPDATE_GOLDEN;

// git may check these out with crlf; the comparison is about content
const lf = (s: string) => s.replaceAll("\r\n", "\n");

/** A minimal line diff. Golden files are small, so an LCS table is instant. */
function lineDiff(expected: string, actual: string): string {
  const a = expected.split("\n");
  const b = actual.split("\n");
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const rows: Array<{ mark: string; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) rows.push({ mark: " ", text: a[i++] }), j++;
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) rows.push({ mark: "-", text: a[i++] });
    else rows.push({ mark: "+", text: b[j++] });
  }
  while (i < a.length) rows.push({ mark: "-", text: a[i++] });
  while (j < b.length) rows.push({ mark: "+", text: b[j++] });

  // only the changed hunks, with three lines of context around each
  const keep = new Set<number>();
  rows.forEach((row, at) => {
    if (row.mark === " ") return;
    for (let k = Math.max(0, at - 3); k <= Math.min(rows.length - 1, at + 3); k++) keep.add(k);
  });
  const out: string[] = [];
  let gap = false;
  rows.forEach((row, at) => {
    if (!keep.has(at)) {
      if (!gap) out.push("  ...");
      gap = true;
      return;
    }
    gap = false;
    out.push(`${row.mark} ${row.text}`);
  });
  return out.join("\n");
}

function assertGolden(name: string, actual: string): void {
  const path = join(GOLDEN_DIR, name);
  if (UPDATING) {
    writeFileSync(path, actual);
    return;
  }
  if (!existsSync(path)) {
    throw new Error(
      `golden ${name} does not exist yet.\n\nthe emitted value was:\n${actual}\n\n` +
        `if that is right: UPDATE_GOLDEN=1 bun test packages/borgo/test/golden.test.ts`,
    );
  }
  const expected = lf(readFileSync(path, "utf8"));
  if (expected === actual) return;
  throw new Error(
    `golden mismatch: test/golden/${name}\n` +
      `  ("-" is the committed golden, "+" is what the code produced now)\n\n` +
      lineDiff(expected, actual) +
      `\n\nif this change is intended, read the diff above, then:\n` +
      `  UPDATE_GOLDEN=1 bun test packages/borgo/test/golden.test.ts`,
  );
}

/**
 * Replaces every 32-hex token (csrf token, csp nonce) with a stable
 * placeholder, numbered in order of first appearance. Two occurrences of the
 * same token collapse to the same placeholder, so the golden pins not just
 * "there is a nonce here" but "this is the *same* nonce as the one over
 * there" - the whole point of a nonce that must match its csp. Reusing one
 * scrubber across a response's headers and its body is what pins the csp
 * nonce to the document's.
 */
function tokenScrubber() {
  const seen = new Map<string, string>();
  return (s: string) =>
    s.replace(/\b[0-9a-f]{32}\b/g, (token) => {
      if (!seen.has(token)) seen.set(token, `{{TOKEN${seen.size + 1}}}`);
      return seen.get(token)!;
    });
}

// bun names built chunks [name]-[8 hex].[ext]; the hash moves with content
const scrubHash = (s: string) => s.replace(/-[0-9a-f]{8}\.(js|css)\b/g, "-{{HASH}}.$1");

// -------------------------------------------------------------------------
// 1. SSR HTML
// -------------------------------------------------------------------------

describe("golden: ssr document", () => {
  const SHELL = lf(readFileSync(join(GOLDEN_DIR, "shell.html"), "utf8"));

  const encoder = new TextEncoder();
  const chunks = (...parts: string[]): AsyncIterable<Uint8Array> => ({
    async *[Symbol.asyncIterator]() {
      for (const part of parts) yield encoder.encode(part);
    },
  });

  const route = (module: Partial<PageModule> = {}, extra: Partial<Route> = {}): Route => ({
    pattern: "/notes/:id",
    file: "notes/[id].tsx",
    module: {
      default: () => null,
      head: {
        title: "Note 7",
        meta: [{ name: "description", content: 'a "quoted" <note>' }],
      },
      ...module,
    } as PageModule,
    layouts: [],
    ...extra,
  });

  // props chosen to exercise the wire escaping: a string that would close the
  // inline script, a u2028 that is valid json but not valid js string content,
  // a null, and a nested object
  const PROPS = {
    note: { id: 7, title: "first", body: null },
    injected: "</script><script>alert(1)</script>",
    // a u+2028: valid json, not valid js string content, must travel escaped
    separated: "a\u2028b",
  };

  // stands in for react-dom's stream: the suspense-reveal script react emits
  // inline (which must carry the same nonce as borgo's props script) and a
  // float preload of a hashed chunk
  const REACT_BODY = (nonce?: string) => [
    "<h1>Note 7</h1><!--$?--><template id=\"B:0\"></template>",
    `<script${nonce ? ` nonce="${nonce}"` : ""}>$RC=function(b,c,e){};$RC("B:0","S:0")</script>`,
    '<link rel="preload" as="script" href="/assets/chunk-4d5e6f70.js"/>',
  ];

  const opts = (dev: boolean): RenderPageOptions => ({
    dev,
    shell: prepareShell(SHELL, dev),
    security: createSecurity(dev, {}),
    csrfCookieAttrs: "Path=/; SameSite=Lax; HttpOnly",
    runLoader: async () => PROPS,
    compose: (_route, props) => ({ props }) as never,
    // the real crypto tokens, not injected fakes: the scrubber above is what
    // asserts their shape, and a fake would pin a shape nothing produces
    renderToStream: async (_element, init) => chunks(...REACT_BODY(init.nonce)),
    onError: () => {},
  });

  /** headers + document of one render, scrubbed under one shared token scope */
  async function snapshot(res: Response): Promise<string> {
    const scrub = tokenScrubber();
    const lines: string[] = [`status: ${res.status}`];
    for (const [name, value] of [...res.headers].sort()) {
      if (name === "set-cookie") continue;
      lines.push(`${name}: ${scrub(value)}`);
    }
    for (const cookie of res.headers.getSetCookie()) lines.push(`set-cookie: ${scrub(cookie)}`);
    const body = scrubHash(scrub(lf(await res.text())));
    return `--- headers ---\n${lines.join("\n")}\n--- document ---\n${body}`;
  }

  const render = (o: RenderPageOptions, r: Route) =>
    renderPage(new Request("http://app.test/notes/7"), r, { id: "7" }, 200, o, undefined, []);

  test("a hydrated production page", async () => {
    assertGolden("ssr-hydrated.txt", await snapshot(await render(opts(false), route())));
  });

  test("a zero-js production page", async () => {
    const r = route({ hydrate: false });
    assertGolden("ssr-zero-js.txt", await snapshot(await render(opts(false), r)));
  });

  test("a zero-js page with islands", async () => {
    const r = route({ hydrate: false }, { islands: true });
    assertGolden("ssr-islands.txt", await snapshot(await render(opts(false), r)));
  });

  test("a hydrated dev page", async () => {
    assertGolden("ssr-dev.txt", await snapshot(await render(opts(true), route())));
  });
});

// -------------------------------------------------------------------------
// 2. GENERATED TYPESCRIPT
// -------------------------------------------------------------------------

// cmd/borgogen has its own go-side fixture; this one guards the .d.ts as the
// typescript side consumes it - interface formatting, the `declare module
// "borgo-framework"` augmentation, union ordering, "?" and "| null".
describe("golden: generated api types", () => {
  const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
  const hasGo = Bun.which("go") !== null;
  let work = "";

  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  test.skipIf(!hasGo)("borgogen emits the committed .d.ts for the fixture package", async () => {
    // the fixture is copied into a throwaway module that replaces the borgo
    // import path with this checkout, so borgogen typechecks against the real
    // framework without the fixture ever being part of the repo's go build
    work = mkdtempSync(join(tmpdir(), "borgo-golden-gen-"));
    mkdirSync(join(work, "api"), { recursive: true });
    writeFileSync(
      join(work, "api", "notes.go"),
      readFileSync(join(GOLDEN_DIR, "testdata", "api", "notes.go")),
    );
    writeFileSync(
      join(work, "go.mod"),
      `module borgogolden\n\ngo 1.25.0\n\nrequire github.com/LuigiDavideMicca/borgo v0.0.0\n\n` +
        `replace github.com/LuigiDavideMicca/borgo => ${REPO_ROOT.replaceAll("\\", "/")}\n`,
    );
    // the checkout's own sums cover borgogen's dependencies
    writeFileSync(join(work, "go.sum"), readFileSync(join(REPO_ROOT, "go.sum")));

    const proc = Bun.spawnSync({
      cmd: ["go", "run", "github.com/LuigiDavideMicca/borgo/cmd/borgogen"],
      cwd: work,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      throw new Error(`borgogen failed:\n${proc.stderr.toString()}${proc.stdout.toString()}`);
    }
    // the ".golden" suffix is not decoration: under a .d.ts name tsc would
    // pull the fixture's `declare module "borgo-framework"` into the program
    // and every other test's ApiRoutes would be typed against these routes
    assertGolden(
      "api-types.d.ts.golden",
      lf(readFileSync(join(work, ".borgo", "api-types.d.ts"), "utf8")),
    );
  }, 120_000);

  // on a machine without go the generator test above is skipped; this keeps
  // its two inputs from disappearing unnoticed there
  test("the fixture package and its golden are both committed", () => {
    expect(existsSync(join(GOLDEN_DIR, "testdata", "api", "notes.go"))).toBe(true);
    expect(existsSync(join(GOLDEN_DIR, "api-types.d.ts.golden"))).toBe(true);
  });
});

// -------------------------------------------------------------------------
// 3. ASSET HEADERS
// -------------------------------------------------------------------------

// cache correctness lives entirely in these headers, and it has regressed
// twice: the full set is pinned, not the two headers a bug report mentioned.
describe("golden: asset headers", () => {
  let dir = "";
  let index: Map<string, AssetInfo>;

  // fixed-length bodies, so Content-Length is pinned exactly. the "compressed"
  // siblings are stand-in bytes rather than real gzip/brotli output: what is
  // under test is which variant gets served and with which headers, and real
  // deflate output would make the pinned length track the local zlib version.
  // the actual round trip through gzip/brotli is covered by serve-assets.test.ts.
  // every body has a different length, so a variant served in place of
  // another cannot hide behind a matching Content-Length
  const JS = "export const hello=()=>console.log('golden');"; // 45
  const JS_GZ = "gzip bytes standing in for app.js"; // 33
  const JS_BR = "brotli bytes for app.js"; // 23
  const CSS = "body{color:rebeccapurple}"; // 25
  const CSS_GZ = "gzip bytes for style.css"; // 24
  const SITE_CSS = "main{padding:1rem}"; // 18
  const SW = "self.addEventListener('fetch',()=>{});"; // 38
  const PNG = "PNG bytes, not really"; // 21

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "borgo-golden-assets-"));
    mkdirSync(join(dir, "public", "assets"), { recursive: true });
    const w = (p: string, body: string) => writeFileSync(join(dir, "public", p), body);
    w("assets/app-a1b2c3d4.js", JS);
    w("assets/app-a1b2c3d4.js.gz", JS_GZ);
    w("assets/app-a1b2c3d4.js.br", JS_BR);
    w("assets/style-9f3a1c07.css", CSS);
    w("assets/style-9f3a1c07.css.gz", CSS_GZ);
    w("site.css", SITE_CSS);
    w("sw.js", SW);
    w("logo.png", PNG);
    index = buildAssetIndex(join(dir, "public"));
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const info = (url: string) => {
    const found = index.get(url);
    if (!found) throw new Error(`not indexed: ${url}`);
    return found;
  };

  // the size half of an etag is content length in base36 and is pinned; the
  // mtime half and the http date are per-checkout and are not. the "-br" /
  // "-gzip" suffix is kept: it is what keeps one url's representations from
  // revalidating each other.
  const scrubEtag = (s: string) =>
    s.replace(/"([0-9a-z]+)-[0-9a-z]+(-br|-gzip)?"/g, '"$1-{{MTIME}}$2"');
  const scrubDate = (s: string) =>
    s.replace(/\b[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT\b/g, "{{HTTP_DATE}}");
  const scrub = (s: string) => scrubHash(scrubDate(scrubEtag(s)));

  function shot(label: string, url: string, headers: Record<string, string> = {}): string {
    const res = serveIndexed(new Request(`http://app.test${url}`, { headers }), info(url));
    const lines = [`### ${label}`, `GET ${scrub(url)}`];
    for (const [name, value] of Object.entries(headers)) lines.push(`  ${name}: ${scrub(value)}`);
    lines.push(`--> ${res.status}${res.body === null ? " (no body)" : ""}`);
    for (const [name, value] of [...res.headers].sort()) lines.push(`  ${name}: ${scrub(value)}`);
    return lines.join("\n");
  }

  test("the header set of every asset shape", () => {
    const js = info("/assets/app-a1b2c3d4.js");
    const br = js.variants.find((v) => v.encoding === "br")!;
    const cases = [
      shot("hashed chunk, no accept-encoding", "/assets/app-a1b2c3d4.js"),
      shot("hashed chunk, br and gzip offered", "/assets/app-a1b2c3d4.js", {
        "accept-encoding": "gzip, br",
      }),
      shot("hashed chunk, gzip only", "/assets/app-a1b2c3d4.js", { "accept-encoding": "gzip" }),
      shot("hashed stylesheet, gzip sibling served", "/assets/style-9f3a1c07.css", {
        "accept-encoding": "gzip",
      }),
      // no .br sibling exists: br is negotiated and misses, and the miss is
      // answered with identity rather than with the gzip that does exist
      shot("hashed stylesheet, br negotiated but only a gzip sibling exists", "/assets/style-9f3a1c07.css", {
        "accept-encoding": "br, gzip",
      }),
      shot("unhashed stylesheet, no siblings", "/site.css", { "accept-encoding": "gzip, br" }),
      shot("service worker", "/sw.js"),
      shot("non-compressible file", "/logo.png", { "accept-encoding": "gzip, br" }),
      shot("revalidation on the identity etag", "/assets/app-a1b2c3d4.js", {
        "if-none-match": js.identity.etag,
      }),
      shot("revalidation on the br etag while negotiating br", "/assets/app-a1b2c3d4.js", {
        "accept-encoding": "br",
        "if-none-match": br.etag,
      }),
      shot("the identity etag cannot revalidate the br representation", "/assets/app-a1b2c3d4.js", {
        "accept-encoding": "br",
        "if-none-match": js.identity.etag,
      }),
      shot("revalidation by date", "/assets/app-a1b2c3d4.js", {
        "if-modified-since": js.lastModified,
      }),
    ];
    assertGolden("asset-headers.txt", cases.join("\n\n") + "\n");
  });
});
