import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { registerCsrf } from "../src/internal";
import type { PageModule, Route } from "../src/router";
import { createSecurity, prepareShell, renderPage, runPropsRequest, type RenderPageOptions } from "../src/util";

// server.ts resolves react from process.cwd() at module scope: same dance as
// local-path.test.ts, restored at once
const cwd = process.cwd();
process.chdir(join(import.meta.dir, ".."));
const { localPathNeedles, redactLocalPaths, redactLocalPathText, redactJsonValue } = await import("../src/server");
process.chdir(cwd);

// a "\\" in a template literal is one backslash; built from pieces so the
// fixture is a windows path and not a string with `\U` in it
const BS = String.fromCharCode(92);
const win = (...parts: string[]) => parts.join(BS);
const ROOT = win("C:", "srv", "borgo", "app");
const NEEDLES = localPathNeedles(ROOT, "win32");

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

// a healthy loader's props, with every shape a wider rule would misread:
// another machine's path with the backslashes json doubles, "drive C:", an
// https url with a double slash, a path sharing the root's prefix, the root's
// trailing segment alone, a file:// mention. all of it comes back as the same string
const HEALTHY_PROPS = {
  install: win("C:", "Users", "alice", "projects", "site"),
  cache: win("C:", "ProgramData", "borgo"),
  drive: "drive C:",
  docs: "https://example.com//docs/app",
  near: win("C:", "srv", "borgo", "application"),
  sibling: ROOT + "-old",
  segment: "app",
  mention: "a bare file:// mention",
  forward: "C:/srv/borgo/apple",
  nested: { list: [1, null, { deep: "C:/Users/alice" }] },
};
const HEALTHY_JSON = JSON.stringify(HEALTHY_PROPS);

// what a loader written with import.meta.dir / import.meta.url returns, as it
// was read from a served window.__PROPS__ on 2026-08-17
const LEAKY_PROPS = {
  dir: ROOT + win("", "pages"),
  url: "file:///C:/srv/borgo/app/pages/index.tsx",
  forward: "C:/srv/borgo/app/pages",
  bare: ROOT,
  nested: { list: [ROOT, 1, null, { deep: ROOT + win("", "x") }] },
  [ROOT]: "as a key",
};

describe("redactLocalPathText on json", () => {
  test("healthy props are the same string, not a copy", () => {
    let calls = 0;
    const out = redactLocalPathText(HEALTHY_JSON, NEEDLES, () => calls++);
    expect(out).toBe(HEALTHY_JSON);
    expect(calls).toBe(0);
  });

  test("the json spelling of the root is found where the native needle cannot see it", () => {
    const json = JSON.stringify({ dir: ROOT + win("", "pages") });
    // the fixture really is the doubled form
    expect(json).toContain(win("C:", "", "srv"));
    expect(json).not.toContain(ROOT);
    const out = redactLocalPathText(json, NEEDLES);
    expect(out).not.toContain("srv");
    expect(JSON.parse(out)).toEqual({ dir: "[redacted]" + win("", "pages") });
  });

  test("every spelling in one payload, and what comes out still parses to the same shape", () => {
    let calls = 0;
    const out = redactLocalPathText(JSON.stringify(LEAKY_PROPS), NEEDLES, () => calls++);
    expect(calls).toBe(1);
    expect(out).not.toContain("srv");
    expect(out).not.toContain("borgo");
    const back = JSON.parse(out) as Record<string, unknown>;
    expect(back).toEqual({
      dir: "[redacted]" + win("", "pages"),
      url: "file:///[redacted]/pages/index.tsx",
      forward: "[redacted]/pages",
      bare: "[redacted]",
      nested: { list: ["[redacted]", 1, null, { deep: "[redacted]" + win("", "x") }] },
      "[redacted]": "as a key",
    });
  });

  test("the near miss inside json is left alone: the name boundary is the same one", () => {
    const json = JSON.stringify({ a: win("C:", "srv", "borgo", "application"), b: "C:/srv/borgo/apple" });
    expect(redactLocalPathText(json, NEEDLES)).toBe(json);
  });

  test("the root at the very end of the text is the root", () => {
    const text = "prefix " + ROOT;
    expect(redactLocalPathText(text, NEEDLES)).toBe("prefix [redacted]");
  });

  test("no needles, no work: the same string back", () => {
    const json = JSON.stringify(LEAKY_PROPS);
    expect(redactLocalPathText(json, [])).toBe(json);
  });

  test("head html computed from the props: title and meta content", () => {
    const html = `<title>${ROOT + win("", "pages")}</title><meta name="p" content="file:///C:/srv/borgo/app/pages/i.tsx" data-borgo-head>`;
    expect(redactLocalPathText(html, NEEDLES)).toBe(
      `<title>[redacted]${win("", "pages")}</title><meta name="p" content="file:///[redacted]/pages/i.tsx" data-borgo-head>`,
    );
  });

  // ONE CRITERION, TWO HALVES: whatever the stream makes of a text, the text
  // form makes of it too - however the stream is cut
  test("the stream and the text form agree byte for byte", async () => {
    const samples = [HEALTHY_JSON, JSON.stringify(LEAKY_PROPS), `<title>${ROOT}</title>`, ROOT + "lication", ROOT];
    for (const sample of samples) {
      const viaText = redactLocalPathText(sample, NEEDLES);
      for (const size of [1, 3, 8, 17, sample.length]) {
        const parts: string[] = [];
        for (let i = 0; i < sample.length; i += size) parts.push(sample.slice(i, i + size));
        expect(await collect(redactLocalPaths(stream(...parts), NEEDLES))).toBe(viaText);
      }
    }
  });
});

describe("redactJsonValue", () => {
  test("a clean value is the very same object", () => {
    let calls = 0;
    expect(redactJsonValue(HEALTHY_PROPS, NEEDLES, () => calls++)).toBe(HEALTHY_PROPS);
    expect(calls).toBe(0);
  });

  test("a leaking value is re-read from its redacted text, and says so once", () => {
    let calls = 0;
    const out = redactJsonValue({ props: LEAKY_PROPS }, NEEDLES, () => calls++) as { props: Record<string, unknown> };
    expect(calls).toBe(1);
    expect(out).not.toBe(LEAKY_PROPS);
    expect(out.props.bare).toBe("[redacted]");
    expect(JSON.stringify(out)).not.toContain("srv");
  });

  test("a value json cannot carry still throws, before anything is sent", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => redactJsonValue(cyclic, NEEDLES)).toThrow();
  });

  test("no needles: the same object, no serialisation", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(redactJsonValue(cyclic, [])).toBe(cyclic);
  });
});

// the roads through renderPage and runPropsRequest, with the redactor
// injected the way serve() injects it
const SHELL =
  "<!doctype html><html><head><title>Shell</title></head>" +
  '<body><div id="root"><!--app--></div><!--props-->' +
  '<script type="module" src="/assets/client.js"></script></body></html>';
const chunks = (...parts: string[]): AsyncIterable<Uint8Array> => stream(...parts);
const route = (module: Partial<PageModule> = {}): Route => ({
  pattern: "/x",
  file: "x.tsx",
  module: { default: () => null, ...module } as PageModule,
  layouts: [],
});
const opts = (over: Partial<RenderPageOptions> = {}): RenderPageOptions => ({
  dev: false,
  shell: prepareShell(SHELL, false),
  security: createSecurity(false, {}),
  csrfCookieAttrs: "Path=/; SameSite=Lax",
  runLoader: async () => ({}),
  compose: () => ({}) as never,
  renderToStream: async () => chunks("<h1>page</h1>"),
  randomToken: () => "t",
  onError: () => {},
  ...over,
});
registerCsrf({
  createElement: () => null as never,
  createContext: () => ({}) as never,
  useContext: () => ({}) as never,
});
const redactText = (text: string) => redactLocalPathText(text, NEEDLES);

describe("the roads through renderPage", () => {
  test("window.__PROPS__ carries the loader's data redacted, and the head with it", async () => {
    const res = await renderPage(
      new Request("http://app.test/x"),
      route({
        head: (p) => ({ title: String(p.dir), meta: [{ name: "u", content: String(p.url) }] }),
      }),
      {},
      200,
      opts({ runLoader: async () => LEAKY_PROPS, redactText }),
    );
    const body = await res.text();
    expect(body).not.toContain("srv");
    expect(body).toContain('window.__PROPS__={"dir":"[redacted]' + win("", "", "pages") + '"');
    expect(body).toContain("<title>[redacted]" + win("", "pages") + "</title>");
    expect(body).toContain('content="file:///[redacted]/pages/index.tsx"');
  });

  test("healthy props leave byte for byte, and so does the head", async () => {
    const res = await renderPage(
      new Request("http://app.test/x"),
      route({ head: (p) => ({ title: String(p.near) }) }),
      {},
      200,
      opts({ runLoader: async () => HEALTHY_PROPS, redactText }),
    );
    const body = await res.text();
    expect(body).toContain("window.__PROPS__=" + HEALTHY_JSON);
    expect(body).toContain(`<title>${HEALTHY_PROPS.near}</title>`);
  });

  test("actionData travels through the same redaction", async () => {
    const res = await renderPage(
      new Request("http://app.test/x"),
      route(),
      {},
      200,
      opts({ redactText }),
      { actionData: { where: ROOT } },
    );
    expect(await res.text()).toContain('window.__PROPS__={"actionData":{"where":"[redacted]"}}');
  });

  test("without a redactor nothing changes - production is the one that passes it", async () => {
    const res = await renderPage(new Request("http://app.test/x"), route(), {}, 200, opts({ runLoader: async () => ({ bare: ROOT }) }));
    expect(await res.text()).toContain("window.__PROPS__=" + JSON.stringify({ bare: ROOT }));
  });

  test("?__borgo=props through a sendJson built like serve()'s", async () => {
    const sendJson = (_req: Request, value: unknown, init?: ResponseInit) =>
      Response.json(redactJsonValue(value, NEEDLES), init);
    const res = await runPropsRequest(new Request("http://app.test/x?__borgo=props"), route(), {}, {
      runLoader: async () => LEAKY_PROPS,
      sendJson,
    });
    const text = await res.text();
    expect(text).not.toContain("srv");
    expect((JSON.parse(text) as { props: { bare: string } }).props.bare).toBe("[redacted]");
  });
});

// serve() is not booted here (nothing in this suite binds a port); the wiring
// is read from the source so it cannot be unhooked in silence
describe("the wiring in serve()", () => {
  test("sendJson redacts before it serialises, in dev and in production", async () => {
    const source = await Bun.file(join(import.meta.dir, "../src/server.ts")).text();
    const at = source.indexOf("const sendJson = (req: Request, value: unknown, init?: ResponseInit) =>");
    expect(at).toBeGreaterThan(0);
    const body = source.slice(at, source.indexOf("};", at));
    expect(body).toContain("redactJsonValue(value, pathNeedles");
    expect(body).toContain("Response.json(clean, init)");
    expect(body).toContain("jsonResponse(req, clean, init)");
  });
});
