import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isrPolicyTable } from "../src/isr";
import {
  INTERNAL_KEY_HEADER,
  INTERNAL_KEY_MIN_LEN,
  RENDER_PORT_DEFAULT,
  internalKeyRejects,
  resolveSwitches,
} from "../src/util";

// the render half of the 0.30 topology: behind the go front, this process
// binds loopback and answers only requests carrying the key the front
// minted for this boot (front.go)

const key = "k".repeat(INTERNAL_KEY_MIN_LEN);

describe("render mode switches", () => {
  test("off by default, and off means the public front server as before", () => {
    const s = resolveSwitches({}, false);
    expect(s.render).toBe(false);
    expect(s.renderPort).toBe(RENDER_PORT_DEFAULT);
  });

  test("on with a key of the session secret's floor", () => {
    const s = resolveSwitches({ BORGO_RENDER: "1", BORGO_INTERNAL_KEY: key, BORGO_RENDER_PORT: "3700" }, false);
    expect(s.render).toBe(true);
    expect(s.internalKey).toBe(key);
    expect(s.renderPort).toBe(3700);
  });

  // a render service without a usable key is a loopback listener anyone on
  // the box can drive: it refuses to boot, naming the variable
  test("render mode without a usable key refuses the boot by name", () => {
    expect(() => resolveSwitches({ BORGO_RENDER: "1" }, false)).toThrow(/BORGO_INTERNAL_KEY/);
    expect(() => resolveSwitches({ BORGO_RENDER: "true", BORGO_INTERNAL_KEY: "short" }, false)).toThrow(
      /at least 32 bytes/,
    );
  });

  test("the switch keeps the ParseBool grammar every other switch has", () => {
    expect(() => resolveSwitches({ BORGO_RENDER: "yes" }, false)).toThrow(/BORGO_RENDER/);
    expect(resolveSwitches({ BORGO_RENDER: "0", BORGO_INTERNAL_KEY: "" }, false).render).toBe(false);
  });
});

// the two lines render mode stands on, pinned in the source: a process-level
// test arrives with borgo dev/start orchestrating render mode (phase 1,
// step 5); until then the verifier's mutations of exactly these lines
// survived every functional test, and a pin is what closes that
describe("render mode is wired where it must be", () => {
  const server = readFileSync(join(import.meta.dir, "../src/server.ts"), "utf8");
  const util = readFileSync(join(import.meta.dir, "../src/util.ts"), "utf8");

  test("the key is checked at the top of fetch, before the path is looked at", () => {
    const check = server.indexOf("if (render && internalKeyRejects(req, switches.internalKey))");
    const canonical = server.indexOf("const canonical = canonicalPath(url.pathname);");
    expect(check).toBeGreaterThan(-1);
    expect(canonical).toBeGreaterThan(check);
    expect(server.slice(check, check + 200)).toContain("status: 403");
  });

  test("render mode binds loopback, not every interface", () => {
    expect(server).toContain('const hostname = render ? "127.0.0.1" : undefined;');
    expect(server).toContain("...(hostname ? { hostname } : {}),");
  });

  test("a shared render is answered before bun's own cache, which is off in render mode", () => {
    const shared = server.indexOf('req.headers.get(SHARED_RENDER_HEADER) === "1"');
    const isr = server.indexOf("if (isr) {");
    expect(shared).toBeGreaterThan(-1);
    expect(isr).toBeGreaterThan(shared);
    expect(server).toContain("const isr = dev || render");
    // the errored-render mark travels as a header only because the stream
    // was drained first: the front judges a finished document
    expect(server.slice(shared, isr)).toContain("const html = await res.text();");
    expect(server.slice(shared, isr)).toContain("RENDER_ERRORED_HEADER");
  });

  test("the key compare is constant time", () => {
    const fn = util.slice(util.indexOf("export function internalKeyRejects"));
    expect(fn.slice(0, fn.indexOf("}"))).toContain("keysEqual(presented, key)");
  });
});

// what the render service declares to the go front's page cache
describe("isrPolicyTable", () => {
  test("every route, its policy or null, invalid opt-ins named once and not cached", () => {
    const warned: string[] = [];
    const table = isrPolicyTable(
      [
        { pattern: "/", module: {} },
        { pattern: "/news", module: { revalidate: 300, tags: [" news ", "posts"] } },
        { pattern: "/docs", module: { revalidate: "manual" } },
        { pattern: "/bad", module: { revalidate: -1 } },
        { pattern: "/worse", module: { revalidate: 10, tags: ["", "x"] } },
      ],
      (line) => warned.push(line),
    );
    expect(table).toEqual([
      { pattern: "/", seconds: null, tags: [] },
      { pattern: "/news", seconds: 300, tags: ["news", "posts"] },
      { pattern: "/docs", seconds: "manual", tags: [] },
      { pattern: "/bad", seconds: null, tags: [] },
      { pattern: "/worse", seconds: null, tags: [] },
    ]);
    expect(warned).toHaveLength(2);
    expect(warned[0]).toContain("/bad");
    expect(warned[1]).toContain("/worse");
  });
});

describe("internalKeyRejects", () => {
  const req = (presented?: string) =>
    new Request("http://127.0.0.1:3600/about", presented === undefined ? {} : { headers: { [INTERNAL_KEY_HEADER]: presented } });

  test("this boot's key passes, anything else is a stranger", () => {
    expect(internalKeyRejects(req(key), key)).toBe(false);
    expect(internalKeyRejects(req(), key)).toBe(true);
    expect(internalKeyRejects(req(""), key)).toBe(true);
    expect(internalKeyRejects(req(key.slice(0, -1)), key)).toBe(true);
    expect(internalKeyRejects(req(key + "k"), key)).toBe(true);
  });
});
