// reads the newest run in ../results and every app manifest, and writes
// data.gen.ts - the one module the page imports. build-time, so the page
// itself ships zero javascript and the numbers a reader sees are the
// committed json's by construction; bench/test/site.test.ts holds that
// equality mechanically.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const resultsDir = join(import.meta.dir, "..", "results");
const appsDir = join(import.meta.dir, "..", "apps");

type RawRun = {
  environment: {
    capturedAt: string;
    host: {
      platform: string;
      osType: string;
      osRelease: string;
      cpuModel: string;
      cpuCount: number;
      totalMemBytes: number;
    };
    versions: Record<string, string>;
    repo: { commit: string; dirty: boolean; borgoVersion: string };
    loadTool: { name: string; version: string };
    note?: string;
    // schema 2: the run's own idle check, before the first app and after
    // the last kill - the contamination evidence rides with the numbers
    idleCheck?: { busyRatioAtStart: number; quietThreshold: number; quiet: boolean };
    close?: { busyRatioAtEnd: number };
  };
  config: {
    connections: number;
    durationSeconds: number;
    warmupSeconds: number;
    runs: number;
    memoryConnections: number;
  };
  results: Array<{
    app: string;
    manifest: { framework: string; language: string; runtime: string; notes?: string };
    status: string;
    error?: string;
    scenarios: Array<{
      scenario: string;
      status: string;
      load?: {
        median: {
          requestsPerSec: number;
          successRate: number;
          latencyMs: { p50: number; p99: number };
        };
      };
      memory?: {
        idleRssBytes: number;
        deltaBytes: number;
        bytesPerConnection: number;
        reliable: boolean;
      };
    }>;
  }>;
};

const runs = readdirSync(resultsDir)
  .filter((f) => f.startsWith("run-") && f.endsWith(".json"))
  .sort();
if (runs.length === 0) throw new Error("no run-*.json in bench/results - run the harness first");
const newest = runs.at(-1)!;
const raw = JSON.parse(readFileSync(join(resultsDir, newest), "utf8")) as RawRun;

// the honesty list: apps that exist but were not measured, with their reason
const notMeasured: Array<{ name: string; reason: string }> = [];
for (const dir of readdirSync(appsDir, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const manifest = JSON.parse(
    readFileSync(join(appsDir, dir.name, "bench.manifest.json"), "utf8"),
  ) as { name: string; status: string; todo?: string };
  if (manifest.status === "stub") {
    notMeasured.push({ name: manifest.name, reason: `stub: ${manifest.todo ?? "not implemented"}` });
  } else if (!raw.results.some((r) => r.app === manifest.name)) {
    notMeasured.push({ name: manifest.name, reason: "not part of this run" });
  }
}
for (const r of raw.results) {
  // a two-sweep campaign lists every app twice; one reason per name
  if (r.status !== "ok" && !notMeasured.some((n) => n.name === r.app)) {
    notMeasured.push({ name: r.app, reason: r.error ?? r.status });
  }
}
// readdir order is platform-dependent (alphabetical on windows, inode order on
// linux), and the freshness test byte-compares this file against a regeneration
notMeasured.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

// a campaign measures every app once per sweep (the run order table in the
// committed report shows both), so the same app arrives here twice. the page
// draws ONE bar per app, and it draws the WORSE of the two sweeps - the
// conservative reading of a shared machine, immune to cherry-picking by
// construction, and it applies to borgo exactly as it applies to everyone.
// worse means: lower req/s for a load scenario (p50/p99 travel with the
// sweep that owned that number), higher bytes-per-connection and higher
// idle rss for memory
type OkResult = RawRun["results"][number];
const byApp = new Map<string, OkResult[]>();
for (const r of raw.results) {
  if (r.status !== "ok") continue;
  const list = byApp.get(r.app) ?? [];
  list.push(r);
  byApp.set(r.app, list);
}
const mergedResults = [...byApp.values()].map((sweeps) => {
  const first = sweeps[0]!;
  const scenarios = new Map<string, OkResult["scenarios"][number]>();
  for (const sweep of sweeps) {
    for (const s of sweep.scenarios) {
      if (s.status !== "ok") continue;
      const held = scenarios.get(s.scenario);
      if (!held) {
        scenarios.set(s.scenario, s);
      } else if (s.load && held.load) {
        if (s.load.median.requestsPerSec < held.load.median.requestsPerSec) scenarios.set(s.scenario, s);
      } else if (s.memory && held.memory) {
        if (s.memory.bytesPerConnection > held.memory.bytesPerConnection) scenarios.set(s.scenario, s);
      }
    }
  }
  return { ...first, scenarios: [...scenarios.values()] };
});

const data = {
  file: newest,
  environment: {
    capturedAt: raw.environment.capturedAt,
    host: raw.environment.host,
    versions: raw.environment.versions,
    repo: raw.environment.repo,
    loadTool: raw.environment.loadTool,
    note: raw.environment.note ?? null,
    // the run's own verdict on its machine: rendered as a banner when the
    // idle check failed, because a caveat the report prints and the page
    // hides is a caveat the reader who matters never sees
    idle: raw.environment.idleCheck
      ? {
          busyAtStart: raw.environment.idleCheck.busyRatioAtStart,
          busyAtEnd: raw.environment.close?.busyRatioAtEnd ?? null,
          threshold: raw.environment.idleCheck.quietThreshold,
          quiet: raw.environment.idleCheck.quiet,
        }
      : null,
  },
  config: raw.config,
  // how many times the campaign swept the app list: rendered beside the
  // worse-of-sweeps rule so the reader knows what "worse" is worse OF
  sweeps: Math.max(1, ...[...byApp.values()].map((s) => s.length)),
  apps: mergedResults
    .map((r) => ({
      name: r.app,
      framework: r.manifest.framework,
      language: r.manifest.language,
      runtime: r.manifest.runtime,
      notes: r.manifest.notes ?? null,
      load: Object.fromEntries(
        r.scenarios
          .filter((s) => s.status === "ok" && s.load)
          .map((s) => [
            s.scenario,
            {
              rps: s.load!.median.requestsPerSec,
              p50: s.load!.median.latencyMs.p50,
              p99: s.load!.median.latencyMs.p99,
              successRate: s.load!.median.successRate,
            },
          ]),
      ),
      memory:
        r.scenarios.find((s) => s.scenario === "memory-conn" && s.status === "ok" && s.memory)
          ?.memory ?? null,
    })),
  notMeasured,
};

writeFileSync(
  join(import.meta.dir, "data.gen.ts"),
  `// generated by generate.ts from bench/results/${newest} - do not edit\n` +
    `export const run = ${JSON.stringify(data, null, 2)} as const;\n`,
);
console.log(`data.gen.ts <- ${newest} (${data.apps.length} apps, ${notMeasured.length} not measured)`);
