// the page's gate: the numbers a reader sees are the committed json's, held
// mechanically rather than by eye. three claims: the committed data.gen.ts
// is fresh against results/, the generator reduces the json faithfully, and
// the exported html carries exactly the formatted numbers.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fmtKB, fmtMB, fmtMs, fmtRps, shortCommit } from "../site/lib/format";

const benchDir = join(import.meta.dir, "..");
const siteDir = join(benchDir, "site");
const resultsDir = join(benchDir, "results");
const hasGo = Bun.which("go") !== null;

const newestRun = () => {
  const runs = readdirSync(resultsDir)
    .filter((f) => f.startsWith("run-") && f.endsWith(".json"))
    .sort();
  return JSON.parse(readFileSync(join(resultsDir, runs.at(-1)!), "utf8"));
};

// data.gen.ts is `export const run = <json> as const;` - parsed, not imported,
// so a stale committed copy cannot hide behind bun's module cache
const parseDataGen = () => {
  const text = readFileSync(join(siteDir, "data.gen.ts"), "utf8");
  const start = text.indexOf("export const run = ") + "export const run = ".length;
  const end = text.lastIndexOf(" as const;");
  return JSON.parse(text.slice(start, end));
};

const regenerate = () => {
  const proc = Bun.spawnSync(["bun", "generate.ts"], { cwd: siteDir, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`generate failed:\n${proc.stderr.toString()}`);
};

describe("the benchmark page and its numbers", () => {
  test("the committed data.gen.ts is what the generator writes today", () => {
    const committed = readFileSync(join(siteDir, "data.gen.ts"), "utf8");
    regenerate();
    expect(readFileSync(join(siteDir, "data.gen.ts"), "utf8")).toBe(committed);
  });

  test("the generator reduces the newest json faithfully, value for value", () => {
    regenerate();
    const raw = newestRun();
    const data = parseDataGen();
    expect(data.environment.repo.commit).toBe(raw.environment.repo.commit);
    for (const app of data.apps) {
      const rawApp = raw.results.find((r: { app: string }) => r.app === app.name)!;
      expect(rawApp).toBeTruthy();
      for (const [scenario, load] of Object.entries(app.load) as Array<
        [string, { rps: number; p50: number; p99: number }]
      >) {
        const rawScenario = rawApp.scenarios.find((s: { scenario: string }) => s.scenario === scenario)!;
        expect(load.rps).toBe(rawScenario.load.median.requestsPerSec);
        expect(load.p50).toBe(rawScenario.load.median.latencyMs.p50);
        expect(load.p99).toBe(rawScenario.load.median.latencyMs.p99);
      }
      if (app.memory) {
        const rawMem = rawApp.scenarios.find((s: { scenario: string }) => s.scenario === "memory-conn")!;
        expect(app.memory.idleRssBytes).toBe(rawMem.memory.idleRssBytes);
        expect(app.memory.bytesPerConnection).toBe(rawMem.memory.bytesPerConnection);
      }
    }
  });

  test.skipIf(!hasGo)(
    "the exported page carries exactly the formatted numbers of the committed json",
    () => {
      const proc = Bun.spawnSync(["bun", "run", "export"], {
        cwd: siteDir,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NODE_ENV: "production" },
      });
      expect(`export exit ${proc.exitCode}\n${proc.stderr.toString()}`).toStartWith("export exit 0");
      const html = readFileSync(join(siteDir, "dist", "site", "index.html"), "utf8");
      const data = parseDataGen();

      expect(html).toContain(shortCommit(data.environment.repo.commit));
      // the biases stand above every number
      expect(html.indexOf("The biases, stated first")).toBeGreaterThan(0);
      expect(html.indexOf("The biases, stated first")).toBeLessThan(html.indexOf("req/s"));

      for (const app of data.apps) {
        for (const load of Object.values(app.load) as Array<{ rps: number; p50: number; p99: number }>) {
          expect(html).toContain(fmtRps(load.rps));
          expect(html).toContain(fmtMs(load.p50));
          expect(html).toContain(fmtMs(load.p99));
        }
        if (app.memory) {
          expect(html).toContain(fmtMB(app.memory.idleRssBytes));
          expect(html).toContain(fmtKB(app.memory.bytesPerConnection));
        }
      }
      for (const missing of data.notMeasured) expect(html).toContain(missing.name);
    },
    180_000,
  );

  test("every stub and absent app is named on the page's honesty list", () => {
    regenerate();
    const data = parseDataGen();
    const raw = newestRun();
    for (const dir of readdirSync(join(benchDir, "apps"), { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const manifest = JSON.parse(
        readFileSync(join(benchDir, "apps", dir.name, "bench.manifest.json"), "utf8"),
      );
      const measured = raw.results.some(
        (r: { app: string; status: string }) => r.app === manifest.name && r.status === "ok",
      );
      if (!measured) {
        expect(data.notMeasured.map((m: { name: string }) => m.name)).toContain(manifest.name);
      }
    }
  });
});
