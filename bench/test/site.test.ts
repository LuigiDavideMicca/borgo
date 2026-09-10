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

type RawScenario = {
  scenario: string;
  status: string;
  load?: { median: { requestsPerSec: number; latencyMs: { p50: number; p99: number } } };
  memory?: { idleRssBytes: number; bytesPerConnection: number };
};

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

  // a campaign sweeps the app list more than once, so one app arrives as
  // several raw entries: the page's rule is the WORSE sweep per scenario -
  // conservative for everyone, cherry-picking impossible by construction -
  // and this test holds the reduction to that rule value for value
  test("the generator reduces the newest json faithfully: one app, its worse sweep", () => {
    regenerate();
    const raw = newestRun();
    const data = parseDataGen();
    expect(data.environment.repo.commit).toBe(raw.environment.repo.commit);
    // one entry per app, however many sweeps the campaign ran
    const names = data.apps.map((a: { name: string }) => a.name);
    expect(new Set(names).size).toBe(names.length);
    for (const app of data.apps) {
      const sweeps = raw.results.filter(
        (r: { app: string; status: string }) => r.app === app.name && r.status === "ok",
      );
      expect(sweeps.length).toBeGreaterThan(0);
      expect(data.sweeps).toBeGreaterThanOrEqual(sweeps.length);
      for (const [scenario, load] of Object.entries(app.load) as Array<
        [string, { rps: number; p50: number; p99: number }]
      >) {
        const measured = sweeps
          .flatMap((s: { scenarios: RawScenario[] }) => s.scenarios)
          .filter((s: RawScenario) => s.scenario === scenario && s.status === "ok" && s.load);
        expect(measured.length).toBeGreaterThan(0);
        const worst = measured.reduce((a: (typeof measured)[number], b: (typeof measured)[number]) =>
          b.load!.median.requestsPerSec < a.load!.median.requestsPerSec ? b : a,
        );
        expect(load.rps).toBe(worst.load!.median.requestsPerSec);
        // latency travels with the sweep that owned the worse throughput
        expect(load.p50).toBe(worst.load!.median.latencyMs.p50);
        expect(load.p99).toBe(worst.load!.median.latencyMs.p99);
      }
      if (app.memory) {
        const measured = sweeps
          .flatMap((s: { scenarios: RawScenario[] }) => s.scenarios)
          .filter((s: RawScenario) => s.scenario === "memory-conn" && s.status === "ok" && s.memory);
        const worst = measured.reduce((a: (typeof measured)[number], b: (typeof measured)[number]) =>
          b.memory!.bytesPerConnection > a.memory!.bytesPerConnection ? b : a,
        );
        expect(app.memory.idleRssBytes).toBe(worst.memory!.idleRssBytes);
        expect(app.memory.bytesPerConnection).toBe(worst.memory!.bytesPerConnection);
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
