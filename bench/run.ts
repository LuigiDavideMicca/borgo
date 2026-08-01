#!/usr/bin/env bun
/**
 * borgo benchmark runner.
 *
 * Design rules, in case a future edit is tempted:
 *   1. Nothing is reported that was not verified correct first (see `verify`).
 *   2. The median of N runs is reported. The best run is never reported.
 *   3. Every process spawned is killed as a tree; a crashed runner leaves a
 *      pidfile that `--cleanup` drains.
 *   4. An implementation we could not run is reported as "not implemented",
 *      never as a zero and never omitted.
 *
 * Usage: bun bench/run.ts --help
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { captureEnvironment } from "./lib/env";
import { loadArgv, resolveLoadTool, runLoad, summarise, type LoadTool } from "./lib/load";
import { listApps, resolveArgv, resolveEnv, type App } from "./lib/manifest";
import { measureMemory, settledRss, sseHandshake } from "./lib/memory";
import { resultsDir } from "./lib/paths";
import { cleanupStale, installCleanupHooks, killAll, portInUse, run, spawnServer, waitPortFree, type Spawned } from "./lib/proc";
import { reportMarkdown, type Report, type RunConfig } from "./lib/report";
import { ALL_SCENARIO_IDS, SCENARIOS, scenarioById } from "./lib/scenarios";
import type { AppResult, ScenarioId, ScenarioResult } from "./lib/types";

// ---------------------------------------------------------------- arguments

interface Options {
  apps: string[] | null;
  scenarios: ScenarioId[];
  connections: number;
  durationSeconds: number;
  warmupSeconds: number;
  runs: number;
  memoryConnections: number;
  apiPort: number;
  note: string;
  out: string;
  label: string;
  skipBuild: boolean;
  loadToolPath?: string;
  noDownload: boolean;
}

function parseArgs(argv: string[]): Options | "help" | "list" | "cleanup" {
  if (argv.includes("--help") || argv.includes("-h")) return "help";
  if (argv.includes("--list")) return "list";
  if (argv.includes("--cleanup")) return "cleanup";

  const value = (flag: string, fallback: string): string => {
    const index = argv.indexOf(flag);
    if (index === -1) return fallback;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
    return next;
  };
  const list = (flag: string): string[] | null => {
    const raw = value(flag, "");
    return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : null;
  };

  const scenarios = (list("--scenarios") ?? ALL_SCENARIO_IDS) as ScenarioId[];
  for (const id of scenarios) {
    if (!ALL_SCENARIO_IDS.includes(id)) throw new Error(`unknown scenario "${id}" - known: ${ALL_SCENARIO_IDS.join(", ")}`);
  }

  return {
    apps: list("--apps"),
    scenarios,
    connections: Number(value("--connections", "64")),
    durationSeconds: Number(value("--duration", "30")),
    warmupSeconds: Number(value("--warmup", "5")),
    runs: Number(value("--runs", "3")),
    memoryConnections: Number(value("--conn-mem", "1000")),
    apiPort: Number(value("--api-port", "43501")),
    note: value("--note", ""),
    out: value("--out", resultsDir()),
    label: value("--label", ""),
    skipBuild: argv.includes("--skip-build"),
    loadToolPath: value("--load-tool", "") || undefined,
    noDownload: argv.includes("--no-download"),
  };
}

const HELP = `
borgo benchmark runner

  bun bench/run.ts [options]

Options
  --apps a,b            only these implementations (default: every non-stub app)
  --scenarios a,b       only these scenarios (default: all)
                        known: ${ALL_SCENARIO_IDS.join(", ")}
  --connections N       concurrent connections for the load scenarios (default 64)
  --duration N          seconds per measured run (default 30)
  --warmup N            seconds of discarded warmup before the runs (default 5)
  --runs N              measured runs per scenario; the MEDIAN is reported (default 3)
  --conn-mem N          open SSE connections for the memory probe (default 1000)
  --api-port N          port handed to implementations that need a second one (default 43501)
  --note "..."          free text recorded in the environment block: say whether the
                        machine was idle, on mains, thermally throttled, ...
  --label name          suffix for the output filenames
  --out DIR             where to write results (default bench/results)
  --skip-build          reuse whatever is already built (faster, less honest)
  --load-tool PATH      use this oha/wrk binary
  --no-download         never fetch a pinned oha; fail instead
  --list                list implementations and scenarios, run nothing
  --cleanup             kill servers left behind by a crashed run, then exit
  --help                this
`;

// ------------------------------------------------------------------ helpers

interface Ports {
  port: number;
  apiPort: number;
}

const log = (msg: string) => console.log(msg);
const step = (msg: string) => console.log(`  ${msg}`);

async function waitReady(url: string, timeoutMs: number, proc: Spawned): Promise<number> {
  const start = performance.now();
  const deadline = start + timeoutMs;
  let lastError = "";
  while (performance.now() < deadline) {
    if (proc.proc.exitCode !== null) {
      throw new Error(`server exited with ${proc.proc.exitCode} before answering\n${proc.output().slice(-2000)}`);
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) {
        await res.arrayBuffer();
        return performance.now() - start;
      }
      lastError = `status ${res.status}`;
      await res.arrayBuffer();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(100);
  }
  throw new Error(`server never answered ${url} within ${timeoutMs}ms (last: ${lastError})\n${proc.output().slice(-2000)}`);
}

/**
 * A fast wrong answer is not a result. Every scenario is checked against the
 * contract before it is loaded, and a failed check fails the scenario loudly
 * rather than producing a very impressive number for a 404.
 */
async function verify(base: string, id: ScenarioId): Promise<void> {
  const scenario = scenarioById(id);

  if (scenario.kind === "memory") {
    // raw socket, not fetch: see the comment on sseHandshake
    const shake = await sseHandshake(base + scenario.path);
    if (shake.status !== scenario.expect.status) {
      throw new Error(`GET ${scenario.path} answered "${shake.statusLine}", contract says ${scenario.expect.status}`);
    }
    const streamType = shake.headers["content-type"] ?? "";
    if (scenario.expect.contentType && !streamType.includes(scenario.expect.contentType)) {
      throw new Error(`GET ${scenario.path} content-type "${streamType}" does not include "${scenario.expect.contentType}"`);
    }
    return;
  }

  const res = await fetch(base + scenario.path, { signal: AbortSignal.timeout(15_000) });
  if (res.status !== scenario.expect.status) {
    throw new Error(`GET ${scenario.path} answered ${res.status}, contract says ${scenario.expect.status}`);
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (scenario.expect.contentType && !contentType.includes(scenario.expect.contentType)) {
    throw new Error(`GET ${scenario.path} content-type "${contentType}" does not include "${scenario.expect.contentType}"`);
  }
  const body = await res.text();
  for (const needle of scenario.expect.contains ?? []) {
    if (!body.includes(needle)) {
      throw new Error(`GET ${scenario.path} body does not contain ${JSON.stringify(needle)} - the contract is not met`);
    }
  }
}

async function buildApp(app: App, env: Record<string, string>, skip: boolean, ports: Ports): Promise<void> {
  const steps: string[][] = [];
  if (app.manifest.install) steps.push(app.manifest.install);
  if (!skip) steps.push(...(app.manifest.build ?? []));
  for (const raw of steps) {
    const argv = resolveArgv(raw, ports);
    step(`build: ${argv.join(" ")}`);
    const res = await run(argv, { cwd: app.dir, env });
    if (res.code !== 0) {
      throw new Error(`\`${argv.join(" ")}\` exited ${res.code}\n${(res.stdout + res.stderr).slice(-3000)}`);
    }
  }
}

// --------------------------------------------------------------------- main

async function benchmarkApp(app: App, opts: Options, tool: LoadTool): Promise<AppResult> {
  const base = `http://127.0.0.1:${app.manifest.port}`;
  const result: AppResult = { app: app.manifest.name, manifest: app.manifest, status: "ok", scenarios: [] };

  if (app.manifest.status === "stub") {
    return { ...result, status: "stub", reason: app.manifest.todo };
  }

  const ports: Ports = { port: app.manifest.port, apiPort: opts.apiPort };
  const env = resolveEnv(app.manifest, ports);

  if (await portInUse(app.manifest.port)) {
    return { ...result, status: "failed", reason: `port ${app.manifest.port} is already in use - refusing to measure someone else's server` };
  }

  try {
    await buildApp(app, env, opts.skipBuild, ports);
  } catch (error) {
    return { ...result, status: "failed", reason: `build failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  let server: Spawned | null = null;
  try {
    const start = resolveArgv(app.manifest.start, ports);
    step(`start: ${start.join(" ")}`);
    server = spawnServer(start, { cwd: app.dir, env });
    const ttfr = await waitReady(base + app.manifest.readyPath, 120_000, server);
    const boot = await settledRss(server.pid, { samples: 3, intervalMs: 300 });
    result.startup = { timeToFirstResponseMs: ttfr, bootRssBytes: boot.rss };
    step(`ready in ${ttfr.toFixed(0)} ms, ${(boot.rss / 1024 ** 2).toFixed(1)} MiB RSS`);

    // memory first, always. Its baseline is "this server at rest", and a server
    // that has just absorbed thirty seconds of load at full concurrency is not
    // at rest - its allocator is still handing pages back, which drags the
    // baseline down under the measurement and can even make the delta negative.
    const ordered = [...opts.scenarios].sort(
      (a, b) => Number(scenarioById(b).kind === "memory") - Number(scenarioById(a).kind === "memory"),
    );

    for (const id of ordered) {
      const scenario = scenarioById(id);
      if (!app.manifest.implements.includes(id)) {
        result.scenarios.push({ scenario: id, status: "skipped", reason: "the manifest does not claim this scenario" });
        continue;
      }
      const outcome = await runScenario(id, base, opts, tool, server.pid);
      // a failed scenario is usually a dead or unhappy server: hand over what it
      // said and whether it is still running, so the reason does not have to be
      // guessed at from "unable to connect"
      if (outcome.status === "failed") {
        const exited = server.proc.exitCode;
        outcome.serverAlive = exited === null;
        outcome.serverOutput = server.output().slice(-2000);
        if (exited !== null) outcome.reason = `${outcome.reason} (the server had exited with ${exited})`;
      }
      result.scenarios.push(outcome);
      const summary =
        outcome.status !== "ok"
          ? `${outcome.status}: ${outcome.reason}`
          : scenario.kind === "load"
            ? `${outcome.load!.median.requestsPerSec.toFixed(0)} req/s (median of ${opts.runs})`
            : `${(outcome.memory!.bytesPerConnection / 1024).toFixed(1)} kiB per connection` +
              (outcome.memory!.reliable ? "" : "  [UNRELIABLE - see notes]");
      step(`${id.padEnd(14)} ${summary}`);
    }
  } catch (error) {
    result.status = "failed";
    result.reason = error instanceof Error ? error.message : String(error);
  } finally {
    server?.stop();
    await waitPortFree(app.manifest.port, 20_000);
  }

  return result;
}

async function runScenario(
  id: ScenarioId,
  base: string,
  opts: Options,
  tool: LoadTool,
  rootPid: number,
): Promise<ScenarioResult> {
  const scenario = scenarioById(id);
  try {
    await verify(base, id);
  } catch (error) {
    return { scenario: id, status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }

  const url = base + scenario.path;

  if (scenario.kind === "memory") {
    try {
      const memory = await measureMemory({ rootPid, sseUrl: url, connections: opts.memoryConnections });
      return { scenario: id, status: "ok", memory };
    } catch (error) {
      return { scenario: id, status: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  try {
    if (opts.warmupSeconds > 0) {
      // JITs warm, pools fill, the first GC happens. Discarded on purpose.
      await runLoad(tool, { url, connections: opts.connections, durationSeconds: opts.warmupSeconds });
      await Bun.sleep(1_000);
    }
    const runs = [];
    for (let i = 0; i < opts.runs; i++) {
      runs.push(await runLoad(tool, { url, connections: opts.connections, durationSeconds: opts.durationSeconds }));
      await Bun.sleep(1_000);
    }
    const summary = summarise(runs);
    if (summary.median.successRate < 0.99) {
      return {
        scenario: id,
        status: "failed",
        reason: `success rate ${(summary.median.successRate * 100).toFixed(1)}% - too many failed requests to report a throughput`,
        load: summary,
      };
    }
    return { scenario: id, status: "ok", load: summary };
  } catch (error) {
    return { scenario: id, status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed === "help") {
    console.log(HELP);
    return;
  }
  if (parsed === "cleanup") {
    const { killed, skipped } = cleanupStale();
    console.log(killed === 0 ? "  nothing orphaned" : `  killed ${killed} orphaned process tree(s)`);
    if (skipped > 0) {
      console.log(`  left ${skipped} alone: another runner is still alive and measuring with them`);
    }
    return;
  }
  if (parsed === "list") {
    console.log("\n  implementations\n");
    for (const app of listApps()) {
      const mark = app.manifest.status === "implemented" ? "ok  " : "stub";
      console.log(`    ${mark}  ${app.manifest.name.padEnd(12)} ${app.manifest.framework.padEnd(22)} port ${app.manifest.port}`);
      if (app.manifest.status === "stub") console.log(`          todo: ${app.manifest.todo}`);
    }
    console.log("\n  scenarios\n");
    for (const s of SCENARIOS) console.log(`    ${s.id.padEnd(14)} GET ${s.path}`);
    console.log("");
    return;
  }

  const opts = parsed;
  installCleanupHooks();
  const drained = cleanupStale();
  if (drained.killed > 0) console.log(`  cleaned up ${drained.killed} process tree(s) orphaned by a previous run`);
  if (drained.skipped > 0) {
    console.log(`  note: another runner is live with ${drained.skipped} server(s); leaving them alone`);
  }

  const tool = await resolveLoadTool({ prefer: opts.loadToolPath, allowDownload: !opts.noDownload });
  log(`\n  load tool: ${tool.name} ${tool.version}\n             ${tool.path}\n`);

  const all = listApps();
  if (all.length === 0) throw new Error("no implementations found under bench/apps");
  const selected = opts.apps ? all.filter((a) => opts.apps!.includes(a.manifest.name)) : all;
  if (selected.length === 0) throw new Error(`no implementation matched --apps ${opts.apps?.join(",")}`);

  const environment = await captureEnvironment(tool, opts.note);
  const results: AppResult[] = [];
  for (const app of selected) {
    log(`\n  === ${app.manifest.name} (${app.manifest.framework}) ===`);
    if (app.manifest.status === "stub") {
      step(`stub, not run: ${app.manifest.todo}`);
      results.push({ app: app.manifest.name, manifest: app.manifest, status: "stub", reason: app.manifest.todo, scenarios: [] });
      continue;
    }
    results.push(await benchmarkApp(app, opts, tool));
  }

  const config: RunConfig = {
    connections: opts.connections,
    durationSeconds: opts.durationSeconds,
    warmupSeconds: opts.warmupSeconds,
    runs: opts.runs,
    memoryConnections: opts.memoryConnections,
    scenarios: opts.scenarios,
    apps: selected.map((a) => a.manifest.name),
    loadArgvTemplate: loadArgv(tool, { url: "<url>", connections: opts.connections, durationSeconds: opts.durationSeconds })
      .slice(1)
      .join(" "),
  };
  const report: Report = { schema: 1, environment, config, results };

  mkdirSync(opts.out, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const suffix = opts.label ? `-${opts.label}` : "";
  const jsonPath = join(opts.out, `run-${stamp}${suffix}.json`);
  const mdPath = join(opts.out, `run-${stamp}${suffix}.md`);
  await Bun.write(jsonPath, JSON.stringify(report, null, 2) + "\n");
  await Bun.write(mdPath, reportMarkdown(report));

  log(`\n  wrote ${jsonPath}`);
  log(`  wrote ${mdPath}\n`);

  const failed = results.filter((r) => r.status === "failed");
  if (failed.length > 0) {
    for (const f of failed) console.error(`  FAILED ${f.app}: ${f.reason}`);
    process.exitCode = 1;
  }
}

// a refusal must read as a refusal, not as a stack trace: the most likely one
// is "no load generator", and the message explains what to install
await main().catch((error) => {
  console.error(`\n  ${error instanceof Error ? error.message : String(error)}\n`);
  killAll();
  process.exit(1);
});
