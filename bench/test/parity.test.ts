import { describe, expect, test } from "bun:test";
import { listApps } from "../lib/manifest";
import { ALL_SCENARIO_IDS, scenarioById } from "../lib/scenarios";
import { benchRoot } from "../lib/paths";

const apps = listApps();
const implemented = apps.filter((a) => a.manifest.status === "implemented");

/**
 * A launcher in a start argv is not free: the runner charges RSS over the whole
 * process tree, so `bun x next start` bills Next.js for a bunx process that no
 * deployment runs. borgo's manifest already avoids exactly this and says so.
 * The rule has to hold for everyone or the memory and startup tables compare
 * process shapes rather than frameworks.
 */
const LAUNCHERS = new Set(["npx", "bunx", "pnpx", "yarn", "pnpm", "npm"]);
const SUBCOMMAND_LAUNCHERS = new Set(["x", "run", "exec", "dlx"]);

describe("every implementation is started the same way", () => {
  test("there is something to compare", () => {
    expect(implemented.length).toBeGreaterThan(1);
  });

  for (const app of implemented) {
    test(`${app.manifest.name} starts its server without a launcher process`, () => {
      const [binary, second] = app.manifest.start;
      expect(binary).toBeDefined();
      expect(LAUNCHERS.has(binary!)).toBe(false);
      if (binary === "bun" || binary === "node") {
        // `bun run start` and `bun x next` both interpose a process; `deno run`
        // is deno's own subcommand and interposes nothing, so the rule is
        // scoped to the runtimes where it is a launcher
        expect(SUBCOMMAND_LAUNCHERS.has(second ?? "")).toBe(false);
      }
    });
  }
});

describe("manifests agree with the harness", () => {
  test("no two implementations want the same port", () => {
    const ports = apps.map((a) => a.manifest.port);
    expect(new Set(ports).size).toBe(ports.length);
  });

  test("every claimed scenario exists", () => {
    for (const app of apps) {
      for (const id of app.manifest.implements) expect(ALL_SCENARIO_IDS).toContain(id);
    }
  });

  test("a stub claims no scenarios and says what is missing", () => {
    for (const app of apps.filter((a) => a.manifest.status === "stub")) {
      expect(app.manifest.implements).toEqual([]);
      expect(app.manifest.todo ?? "").not.toBe("");
    }
  });
});

describe("the static asset is pinned to the committed file", () => {
  test("the scenario's sha256 and length are the ones on disk", async () => {
    const bytes = new Uint8Array(await Bun.file(`${benchRoot()}/shared/payload.json`).arrayBuffer());
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(bytes);
    const scenario = scenarioById("static-asset");
    expect(scenario.expect.exactBytes).toBe(bytes.byteLength);
    expect(scenario.expect.sha256).toBe(hasher.digest("hex"));
  });

  test("every implementation ships that exact file, so nobody serves different bytes", async () => {
    const canonical = await Bun.file(`${benchRoot()}/shared/payload.json`).text();
    let checked = 0;
    for (const app of implemented) {
      for (const dir of ["public/static", "static/static"]) {
        const file = Bun.file(`${app.dir}/${dir}/payload.json`);
        if (!(await file.exists())) continue;
        expect(await file.text()).toBe(canonical);
        checked++;
      }
    }
    expect(checked).toBe(implemented.length);
  });
});

describe("the scenarios enforce what CONTRACT.md pins", () => {
  test("the JSON scenarios check values, not only the presence of keys", () => {
    expect(scenarioById("hello-json").expect.body).toEqual({ kind: "hello" });
    expect(scenarioById("api-list").expect.body).toEqual({ kind: "item-list", n: 100 });
  });

  test("the static asset is pinned exactly, not with a floor", () => {
    expect(scenarioById("static-asset").expect.minBytes).toBeUndefined();
    expect(scenarioById("static-asset").expect.exactBytes).toBeDefined();
  });
});
