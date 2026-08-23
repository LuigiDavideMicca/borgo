import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// server.ts requires react through `createRequire(process.cwd()/package.json)`
// at module scope, so it only imports from a directory that can resolve it.
// Restored immediately: the cwd is process-wide and other test files read it.
const cwd = process.cwd();
process.chdir(join(import.meta.dir, ".."));
const { localPathNeedles, redactLocalPaths } = await import("../src/server");
process.chdir(cwd);

// built from pieces so the fixture cannot lie: a "\\" inside a template is one
// backslash, and a path written inline is a string with `\U` and `\t` in it
const BS = String.fromCharCode(92);
const win = (...parts: string[]) => parts.join(BS);

const ROOT_WIN = win("C:", "srv", "borgo", "app");
const ROOT_POSIX = "/srv/borgo/app";

const enc = new TextEncoder();
const dec = new TextDecoder();

const stream = (...parts: string[]): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    for (const part of parts) yield enc.encode(part);
  },
});

const collect = async (it: AsyncIterable<Uint8Array>): Promise<string> => {
  const parts: Uint8Array[] = [];
  for await (const chunk of it) parts.push(chunk);
  return dec.decode(Buffer.concat(parts.map((p) => Buffer.from(p))));
};

const through = (needles: string[], ...parts: string[]) =>
  collect(redactLocalPaths(stream(...parts), needles));

describe("localPathNeedles", () => {
  test("a windows root is both separator spellings and the json one, and the file url is not a fourth", () => {
    const needles = localPathNeedles(ROOT_WIN, "win32");
    expect(needles).toEqual([ROOT_WIN, "C:/srv/borgo/app", win("C:", "", "srv", "", "borgo", "", "app")]);
  });

  // the json spelling is what window.__PROPS__ and ?__borgo=props carry: every
  // backslash doubled, so neither of the other two can find it there
  test("the json spelling is exactly what JSON.stringify would write", () => {
    const needles = localPathNeedles(ROOT_WIN, "win32");
    expect(needles).toContain(JSON.stringify(ROOT_WIN).slice(1, -1));
  });

  // the saving is a third of the per-response cost: `file:///C:/srv/borgo/app`
  // carries `C:/srv/borgo/app` inside it, so the second scan finds nothing the
  // first did not - unless the root percent-encodes, and then it is its own
  test("a root that percent-encodes keeps its file url as a needle of its own", () => {
    const needles = localPathNeedles(win("C:", "My Apps", "site"), "win32");
    expect(needles).toContain(win("C:", "My Apps", "site"));
    expect(needles).toContain("C:/My Apps/site");
    expect(needles).toContain("file:///C:/My%20Apps/site");
  });

  // the declared limit: on linux the root is a bare absolute path, textually a
  // root-relative url, so only the file:// url is a needle there
  test("a posix root is only its file url, never the bare path", () => {
    const needles = localPathNeedles(ROOT_POSIX, "linux");
    expect(needles).toEqual(["file:///srv/borgo/app"]);
    expect(needles).not.toContain(ROOT_POSIX);
  });

  test("no root, no needles", () => {
    expect(localPathNeedles("", "win32")).toEqual([]);
  });
});

describe("redactLocalPaths", () => {
  const NEEDLES = localPathNeedles(ROOT_WIN, "win32");

  // the test that decides whether this guard may exist at all: it sits on
  // every html response, so it must never rewrite a document merely ABOUT
  // paths. every shape a wider rule would misread, byte for byte: another
  // machine's path, an https url with a double slash, the bare text "drive C:"
  // and "file://", a root-relative asset url, a path sharing a long prefix
  // with the root, the root's own trailing segment alone
  const HEALTHY =
    "<main><h1>installing</h1>" +
    `<pre>cd ${win("C:", "Users", "alice", "projects", "site")}\nborgo dev</pre>` +
    `<p>on windows the cache lives under ${win("C:", "ProgramData", "borgo")}</p>` +
    '<a href="https://example.com//docs/app">docs</a>' +
    "<p>drive C: is fine, and a bare file:// mention is not a path</p>" +
    '<img src="/logo.svg"/>' +
    `<code>${win("C:", "srv", "borgo", "application")}</code>` +
    "<span>app</span></main>";

  test("a realistic healthy document comes back byte for byte", async () => {
    expect(await through(NEEDLES, HEALTHY)).toBe(HEALTHY);
  });

  test("and it stays byte for byte however the stream is cut", async () => {
    for (const size of [1, 2, 7, 16, 41, 44, 45, 46, 97, HEALTHY.length]) {
      const parts: string[] = [];
      for (let i = 0; i < HEALTHY.length; i += size) parts.push(HEALTHY.slice(i, i + size));
      expect(await through(NEEDLES, ...parts)).toBe(HEALTHY);
    }
  });

  test("a healthy document never calls back", async () => {
    let calls = 0;
    await collect(redactLocalPaths(stream(HEALTHY), NEEDLES, () => calls++));
    expect(calls).toBe(0);
  });

  // the exact bytes measured on the wire from a real production server
  test("the file url react renders leaves as a redaction, tail intact", async () => {
    const doc = '<img src="file:///C:/srv/borgo/app/pages/probe.png"/>';
    expect(await through(NEEDLES, doc)).toBe('<img src="file:///[redacted]/pages/probe.png"/>');
  });

  test("the native spelling import.meta.dir renders leaves too", async () => {
    const doc = `<p>${win("C:", "srv", "borgo", "app", "pages")}</p>`;
    expect(await through(NEEDLES, doc)).toBe(`<p>[redacted]${BS}pages</p>`);
  });

  test("every occurrence in a chunk, not the first", async () => {
    const doc = "a C:/srv/borgo/app/x b C:/srv/borgo/app/y c";
    expect(await through(NEEDLES, doc)).toBe("a [redacted]/x b [redacted]/y c");
  });

  // the boundary is the whole reason this holds bytes back
  test("a needle split across two chunks is still redacted", async () => {
    const whole = "<img src=\"C:/srv/borgo/app/x.png\"/>";
    for (let cut = 1; cut < whole.length; cut++) {
      expect(await through(NEEDLES, whole.slice(0, cut), whole.slice(cut))).toBe(
        '<img src="[redacted]/x.png"/>',
      );
    }
  });

  test("a needle split across three chunks, one of them a single byte", async () => {
    expect(await through(NEEDLES, "<p>C:/srv/bor", "g", 'o/app/x</p>')).toBe("<p>[redacted]/x</p>");
  });

  test("it says so, once for the chunk that carried it", async () => {
    let calls = 0;
    await collect(
      redactLocalPaths(stream('<img src="C:/srv/borgo/app/x.png"/>'), NEEDLES, () => calls++),
    );
    expect(calls).toBe(1);
  });

  // found by the healthy page above: a bare prefix match turned
  // C:\srv\borgo\application into [redacted]lication
  test("a directory that only begins like the root is left alone", async () => {
    for (const near of ["application", "apps", "app2", "app-old", "app.bak"]) {
      const doc = `<code>C:/srv/borgo/${near}/x</code>`;
      expect(await through(NEEDLES, doc)).toBe(doc);
    }
  });

  // found by a mutation: `replaceRoots` copies an unbounded match through
  // untouched and goes on looking, and a near miss on its own never reaches
  // that code, so only a near miss AND a real root at once can tell
  test("a near miss and a real root in one document, both handled", async () => {
    const doc = "<code>C:/srv/borgo/application/x</code><img src=\"C:/srv/borgo/app/y.png\"/>";
    expect(await through(NEEDLES, doc)).toBe(
      '<code>C:/srv/borgo/application/x</code><img src="[redacted]/y.png"/>',
    );
  });

  test("a real root before a near miss, same document", async () => {
    const doc = "<p>C:/srv/borgo/app/a</p><p>C:/srv/borgo/apps/b</p>";
    expect(await through(NEEDLES, doc)).toBe("<p>[redacted]/a</p><p>C:/srv/borgo/apps/b</p>");
  });

  test("the root followed by anything that cannot continue a name is the root", async () => {
    for (const after of ['"', "<", " ", "?", ")", "/", BS]) {
      expect(await through(NEEDLES, `[C:/srv/borgo/app${after}]`)).toBe(`[[redacted]${after}]`);
    }
  });

  // the end of the document is a boundary too, and it is the only one no chunk
  // can show: it is known once the stream is over
  test("the root at the very end of the document is redacted", async () => {
    expect(await through(NEEDLES, "<p>C:/srv/borgo/app")).toBe("<p>[redacted]");
    expect(await through(NEEDLES, "<p>C:/srv/borgo/", "app")).toBe("<p>[redacted]");
  });

  test("and a near miss at the very end is not", async () => {
    expect(await through(NEEDLES, "<p>C:/srv/borgo/application")).toBe("<p>C:/srv/borgo/application");
  });

  test("no needles at all is a pass-through", async () => {
    const doc = `<p>${ROOT_WIN}</p>`;
    expect(await through([], doc)).toBe(doc);
  });

  // a stream that ends inside the held-back tail still delivers every byte
  test("a document shorter than the needle is delivered whole", async () => {
    expect(await through(NEEDLES, "<p>hi</p>")).toBe("<p>hi</p>");
    expect(await through(NEEDLES, "")).toBe("");
  });

  test("multi-byte characters are not cut in half by the held-back tail", async () => {
    const doc = "<p>caffè è più però — perché</p>".repeat(4);
    expect(await through(NEEDLES, doc)).toBe(doc);
    // the string-level split above can never land inside a character: cut the
    // bytes at every offset, so every multi-byte sequence is halved at least once
    const bytes = enc.encode(doc);
    expect(bytes.length).toBeGreaterThan(doc.length);
    for (let cut = 1; cut < bytes.length; cut++) {
      const halves = [bytes.subarray(0, cut), bytes.subarray(cut)];
      const it: AsyncIterable<Uint8Array> = {
        async *[Symbol.asyncIterator]() {
          yield* halves;
        },
      };
      expect(await collect(redactLocalPaths(it, NEEDLES))).toBe(doc);
    }
  });
});

// regression guard, not a proof: whether the guard is on the render path was
// measured by hand against a live server, and nothing here boots one. a
// mutation that unhooked redactLocalPaths from renderToStream reddened nothing
describe("the guard is wired into the render path", () => {
  test("renderToStream hands its stream through redactLocalPaths, per page", async () => {
    const source = await Bun.file(join(import.meta.dir, "../src/server.ts")).text();
    const wired = source.slice(source.indexOf("const renderPage = ("));
    expect(wired).toContain("redactLocalPaths(");
    expect(wired).toContain("renderToReadableStream(element, init)");
    expect(wired).toContain("pathNeedles");
    // the page is named in the line the operator reads, so the wrapper has to
    // be built per render rather than shared
    expect(wired).toContain("rendered(route.file)");
    // the props json and the head are built outside that stream, and get the
    // same needles through the text form
    expect(wired).toContain("redactText: (text) => redactLocalPathText(text, pathNeedles");
  });

  test("the needles are resolved once, not per request", async () => {
    const source = await Bun.file(join(import.meta.dir, "../src/server.ts")).text();
    const resolved = source.indexOf("const pathNeedles = localPathNeedles(process.cwd());");
    const handler = source.indexOf("async fetch(req)");
    expect(resolved).toBeGreaterThan(0);
    expect(handler).toBeGreaterThan(resolved);
  });
});
