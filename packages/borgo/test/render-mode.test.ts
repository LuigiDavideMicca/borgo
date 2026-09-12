import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isrPolicyTable } from "../src/isr";
import {
  INTERNAL_KEY_HEADER,
  INTERNAL_KEY_MIN_LEN,
  RENDER_PORT_DEFAULT,
  frontTopology,
  goFrontEnv,
  internalKeyRejects,
  renderEnv,
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

// the orchestrator's half: one object both processes are configured from
describe("frontTopology", () => {
  test("off unless BORGO_FRONT says so", () => {
    expect(frontTopology({})).toBeNull();
    expect(frontTopology({ BORGO_FRONT: "0" })).toBeNull();
    expect(() => frontTopology({ BORGO_FRONT: "yes" })).toThrow(/BORGO_FRONT/);
  });

  test("mints a key of the go side's floor and hands both halves the same addresses", () => {
    const t = frontTopology({ BORGO_FRONT: "1", PORT: "8080", API_PORT: "9000", BORGO_RENDER_PORT: "9100" })!;
    expect(t.key.length).toBeGreaterThanOrEqual(INTERNAL_KEY_MIN_LEN);
    expect(t.key).toMatch(/^[0-9a-f]{64}$/);
    expect(goFrontEnv(t)).toEqual({
      BORGO_FRONT: "1",
      PORT: "8080",
      API_PORT: "9000",
      BORGO_INTERNAL_KEY: t.key,
      BORGO_RENDER_URL: "http://127.0.0.1:9100",
    });
    expect(renderEnv(t)).toEqual({
      BORGO_RENDER: "1",
      BORGO_RENDER_PORT: "9100",
      BORGO_INTERNAL_KEY: t.key,
      API_PORT: "9000",
    });
    // and the render half boots on what it was handed
    expect(resolveSwitches({ ...renderEnv(t) }, false).render).toBe(true);
  });

  test("an operator's own key is kept when usable, replaced when not", () => {
    const own = "o".repeat(INTERNAL_KEY_MIN_LEN);
    expect(frontTopology({ BORGO_FRONT: "1", BORGO_INTERNAL_KEY: own })!.key).toBe(own);
    expect(frontTopology({ BORGO_FRONT: "1", BORGO_INTERNAL_KEY: "short" })!.key).not.toBe("short");
  });

  test("defaults: 3000 public, 3501 internal, 3600 render; two boots mint two keys", () => {
    const a = frontTopology({ BORGO_FRONT: "1" })!;
    const b = frontTopology({ BORGO_FRONT: "1" })!;
    expect([a.publicPort, a.apiPort, a.renderPort]).toEqual([3000, 3501, RENDER_PORT_DEFAULT]);
    expect(a.key).not.toBe(b.key);
  });
});

// the three commands hand the two halves their environments from the one
// object, pinned in the source
describe("the orchestrators wire the topology", () => {
  const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8");
  const dev = readFileSync(join(import.meta.dir, "../src/dev.ts"), "utf8");
  const exp = readFileSync(join(import.meta.dir, "../src/export.ts"), "utf8");

  test("borgo start: go gets the front env, this process becomes the renderer", () => {
    expect(cli).toContain("if (topology) Object.assign(process.env, renderEnv(topology));");
    expect(cli).toContain("...(topology ? goFrontEnv(topology) : {}),");
  });

  test("borgo dev: go and the front server each get their half, and the pokes go to the render port with the key", () => {
    expect(dev).toContain("...(topology ? goFrontEnv(topology) : {}),");
    expect(dev).toContain("...(topology ? renderEnv(topology) : {}),");
    expect(dev).toContain("fetch(`${renderBase}/__borgo/dev/${path}`");
    expect(dev).toContain("headers: renderHeaders,");
  });

  test("borgo export: go is started whenever it is the front, and readiness is asked of the public port", () => {
    expect(exp).toContain("if (needApi || topology) {");
    expect(exp).toContain("const probe = topology ? `http://localhost:${frontPort}/healthz` : `http://localhost:${apiPort}/`;");
    expect(exp).toContain("makeApiClient(`http://localhost:${apiPort}`, apiHeaders)");
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
