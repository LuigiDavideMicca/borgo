import { describe, expect, test } from "bun:test";
import type { Environment } from "../lib/env";
import { bytesCaveat, driftBetweenPasses, reportMarkdown, soleTunings, tunedEnv, type Report, type RunConfig } from "../lib/report";
import type { AppResult, LoadStats, Manifest, ScenarioId } from "../lib/types";

const loadStats = (requestsPerSec: number): LoadStats => ({
  requestsPerSec,
  successRate: 1,
  non2xxRate: 0,
  totalRequests: Math.round(requestsPerSec * 30),
  latencyMs: { p50: 3, p90: 5, p95: 6, p99: 9, p9999: 40 },
  statusCodes: { "200": Math.round(requestsPerSec * 30) },
  errors: {},
});

const manifest = (name: string, over: Partial<Manifest> = {}): Manifest => ({
  name,
  framework: `${name} framework`,
  language: "JavaScript",
  runtime: "node",
  status: "implemented",
  port: 40000,
  readyPath: "/api/hello",
  start: ["node", "server.js"],
  implements: ["hello-json"],
  ...over,
});

function app(
  name: string,
  pass: number,
  orderIndex: number,
  perRun: number[],
  opts: { bytes?: number; manifest?: Manifest; scenario?: ScenarioId; bootRssStable?: boolean } = {},
): AppResult {
  const runs = perRun.map(loadStats);
  const sorted = [...perRun].sort((a, b) => a - b);
  return {
    app: name,
    manifest: opts.manifest ?? manifest(name),
    status: "ok",
    pass,
    orderIndex,
    startup: { timeToFirstResponseMs: 500, bootRssBytes: 80 * 1024 ** 2, bootRssStable: opts.bootRssStable ?? true },
    scenarios: [
      {
        scenario: opts.scenario ?? "hello-json",
        status: "ok",
        sample: { status: 200, contentType: "application/json", bytes: opts.bytes ?? 25 },
        load: {
          runs,
          median: {
            requestsPerSec: sorted[Math.floor(sorted.length / 2)]!,
            successRate: 1,
            non2xxRate: 0,
            totalRequests: runs[0]!.totalRequests,
            latencyMs: runs[0]!.latencyMs,
          },
          totals: { runs: runs.length, requests: 1, statusCodes: { "200": 1 }, errors: {} },
          worst: { successRate: 1, non2xxRate: 0 },
        },
      },
    ],
  };
}

const environment: Environment = {
  capturedAt: "2026-08-01T00:00:00.000Z",
  host: {
    platform: "linux",
    osType: "Linux",
    osRelease: "6.0",
    arch: "x64",
    cpuModel: "test cpu",
    cpuCount: 8,
    cpuMhz: 2800,
    totalMemBytes: 32 * 1024 ** 3,
    freeMemBytesAtStart: 20 * 1024 ** 3,
  },
  versions: { go: "go1.25", bun: "1.3", node: "v24", npm: "11", deno: "not installed" },
  repo: { commit: "abcdef1234567890", dirty: false, borgoVersion: "0.20.1" },
  loadTool: { name: "oha", version: "1.15.0", path: "/tmp/oha" },
  note: "idle laptop on mains",
  idleCheck: { busyRatioAtStart: 0.02, sampleMs: 1000, quietThreshold: 0.1, quiet: true },
};

const config = (over: Partial<RunConfig> = {}): RunConfig => ({
  connections: 64,
  durationSeconds: 30,
  warmupSeconds: 5,
  runs: 3,
  memoryConnections: 1000,
  scenarios: ["hello-json"],
  apps: ["borgo", "nextjs"],
  passes: 2,
  passOrders: [["borgo", "nextjs"], ["nextjs", "borgo"]],
  skipBuild: false,
  skipInstall: false,
  loadArgvTemplate: "-z 30s -c 64 <url>",
  ...over,
});

const render = (results: AppResult[], over: Partial<RunConfig> = {}, env: Environment = environment): string =>
  reportMarkdown({ schema: 2, environment: env, config: config(over), results } as Report);

describe("drift between sweeps", () => {
  test("flags an app whose two sweeps disagree by more than its own run-to-run noise", () => {
    const rows = driftBetweenPasses([
      app("borgo", 1, 1, [19000, 19100, 19050]),
      app("borgo", 2, 2, [14665, 14700, 14680]),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.drifted).toBe(true);
    expect(rows[0]!.spreadPct).toBeGreaterThan(25);
    expect(rows[0]!.noisePct).toBeLessThan(1);
  });

  test("does not flag sweeps that agree to within the noise", () => {
    const rows = driftBetweenPasses([
      app("hono", 1, 1, [9000, 11000, 10000]),
      app("hono", 2, 2, [10100, 9900, 10050]),
    ]);
    expect(rows[0]!.drifted).toBe(false);
  });

  test("a single sweep is never called drift, because nothing was compared", () => {
    expect(driftBetweenPasses([app("hono", 1, 1, [10000, 10100, 10050])])[0]!.drifted).toBe(false);
  });

  test("the report prints the verdict rather than leaving the passes side by side", () => {
    const md = render([app("borgo", 1, 1, [19000, 19100, 19050]), app("borgo", 2, 2, [14665, 14700, 14680])]);
    expect(md).toContain("## Drift between sweeps");
    expect(md).toContain("drifted - not separable from the machine");
    expect(md).toContain("Re-run on a quiet box before quoting them.");
  });

  test("one sweep says so instead of silently skipping the check", () => {
    const md = render([app("borgo", 1, 1, [19000, 19100, 19050])], { passes: 1, passOrders: [["borgo"]] });
    expect(md).toContain("Not checked: only one sweep was run.");
  });
});

describe("bytes on the wire", () => {
  test("the load table carries the response size the check actually saw", () => {
    const md = render([app("borgo", 1, 1, [100, 110, 105], { bytes: 4321 })], { passes: 1, passOrders: [["borgo"]] });
    expect(md).toContain("response bytes");
    expect(md).toContain("4,321 B");
  });

  test("a material difference in body size is called out, not left to the reader", () => {
    const caveat = bytesCaveat([
      { app: "borgo", bytes: 3000 },
      { app: "nextjs", bytes: 40000 },
    ]);
    expect(caveat.join(" ")).toContain("do **not** put the same number of bytes on the wire");
    expect(caveat.join(" ")).toContain("borgo sends 3,000 B");
  });

  test("bodies of the same size produce no caveat", () => {
    expect(bytesCaveat([{ app: "a", bytes: 1000 }, { app: "b", bytes: 1010 }])).toEqual([]);
  });
});

describe("disclosure", () => {
  const tuned = manifest("borgo", {
    env: { PORT: "${PORT}", BUN_CONFIG_MAX_HTTP_REQUESTS: "16384", SESSION_SECRET: "hunter2" },
    notes: "raises a Bun default that would otherwise cap SSE at 255",
  });

  test("runner plumbing is not reported as tuning, and secrets are redacted", () => {
    const keys = tunedEnv({ app: "borgo", manifest: tuned, status: "ok", scenarios: [] });
    expect(keys.map(([k]) => k)).toEqual(["BUN_CONFIG_MAX_HTTP_REQUESTS", "SESSION_SECRET"]);
    expect(Object.fromEntries(keys)["SESSION_SECRET"]).toBe("(redacted)");
  });

  test("a knob only one implementation was given is named", () => {
    const sole = soleTunings([
      app("borgo", 1, 1, [100], { manifest: tuned }),
      app("hono", 1, 2, [100]),
    ]);
    expect(sole.map((s) => s.key)).toContain("BUN_CONFIG_MAX_HTTP_REQUESTS");
    expect(sole.find((s) => s.key === "BUN_CONFIG_MAX_HTTP_REQUESTS")!.app).toBe("borgo");
  });

  test("manifest notes reach the report, which is what CONTRACT.md promises", () => {
    const md = render([app("borgo", 1, 1, [100], { manifest: tuned })], { passes: 1, passOrders: [["borgo"]] });
    expect(md).toContain("raises a Bun default that would otherwise cap SSE at 255");
    expect(md).toContain("Tuning applied to **one** implementation");
    expect(md).not.toContain("hunter2");
    expect(md).toContain("started as");
  });
});

describe("caveats the harness cannot enforce", () => {
  test("an unattested machine is stated above the tables", () => {
    const md = render([app("borgo", 1, 1, [100])], {}, { ...environment, note: "" });
    expect(md).toContain("**Read these before the tables.**");
    expect(md).toContain("No `--note` was given");
  });

  test("a busy machine is stated above the tables", () => {
    const busy: Environment = {
      ...environment,
      idleCheck: { busyRatioAtStart: 0.42, sampleMs: 1000, quietThreshold: 0.1, quiet: false },
    };
    const md = render([app("borgo", 1, 1, [100])], {}, busy);
    expect(md).toContain("42.0% busy before the first app");
    expect(md).toContain("NOT IDLE");
  });

  test("a single run reports its noise as n/a rather than 0.0%", () => {
    const md = render([app("borgo", 1, 1, [12345])], { runs: 1, passes: 1, passOrders: [["borgo"]] });
    expect(md).toContain("| n/a |");
    expect(md).toContain("there is no dispersion to report at all");
  });

  test("a boot RSS read while the runtime was still growing is marked as such", () => {
    const md = render([app("borgo", 1, 1, [100], { bootRssStable: false })], { passes: 1, passOrders: [["borgo"]] });
    expect(md).toContain("still growing when read");
  });

  test("every report states what it does not enforce", () => {
    const md = render([app("borgo", 1, 1, [100])]);
    expect(md).toContain("## What this harness does not enforce");
    expect(md).toContain("implemented as well as its own experts would implement it");
  });

  test("rows are labelled by sweep, so two rows for one app are distinguishable", () => {
    const md = render([app("borgo", 1, 1, [100, 101, 102]), app("borgo", 2, 2, [100, 101, 102])]);
    expect(md).toContain("borgo (pass 1, #1)");
    expect(md).toContain("borgo (pass 2, #2)");
  });
});
