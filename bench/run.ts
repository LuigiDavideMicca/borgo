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
import { capture, cleanupStale, installCleanupHooks, killAll, portInUse, run, spawnServer, waitPortFree, type Spawned } from "./lib/proc";
import { reportMarkdown, type Report, type RunConfig } from "./lib/report";
import { ALL_SCENARIO_IDS, SCENARIOS, scenarioById } from "./lib/scenarios";
import type { AppResult, ResponseSample, ScenarioId, ScenarioResult } from "./lib/types";

/**
 * How many non-2xx responses a scenario may contain before its throughput is
 * refused. oha's own successRate is transport-level - a 500 that arrives
 * intact is a "success" to it - so a server that sheds work under load used to
 * be reported as a server that is fast. Applied to the WORST run, not the
 * median: with three runs a median discards one catastrophe entirely.
 */
const MAX_NON_2XX_RATE = 0.001;
const MIN_TRANSPORT_SUCCESS_RATE = 0.99;

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
  /**
   * Sweeps over the whole app list. Pass 1 runs the list forwards, pass 2
   * backwards, and so on. See the comment on `sweepOrder`.
   */
  passes: number;
  note: string;
  out: string;
  label: string;
  skipBuild: boolean;
  skipInstall: boolean;
  loadToolPath?: string;
  noDownload: boolean;
}

/**
 * The order the apps are measured in, for one sweep.
 *
 * This used to be alphabetical, once, for everything - which on a laptop that
 * drifts thermally is not an ordering, it is a handicap. borgo ran second and
 * Next.js ran last, roughly 45 minutes into a saturated machine, and the
 * committed proof run shows -24% across three consecutive 30 s runs of a
 * single scenario (19,355 -> 15,422 -> 14,665 req/s, RSD 15.3%). A queue
 * position worth 24% swamps every framework difference this harness exists to
 * find.
 *
 * The fix is not a cleverer sort. Two sweeps are run in opposite directions,
 * so every app is measured once early and once late, and both results are
 * reported. If the two disagree by more than the run-to-run noise, the machine
 * drifted and the campaign says so instead of publishing the drift as a
 * finding. Alphabetical remains the pass-1 order only because it is stable and
 * printable; nothing depends on it any more.
 */
function sweepOrder<T>(apps: T[], pass: number): T[] {
  return pass % 2 === 1 ? [...apps] : [...apps].reverse();
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
    passes: Number(value("--passes", "2")),
    note: value("--note", ""),
    out: value("--out", resultsDir()),
    label: value("--label", ""),
    skipBuild: argv.includes("--skip-build"),
    // --skip-build used to run every manifest's `install` step anyway, so the
    // flag documented as "reuse whatever is already built" could pull new
    // dependency versions and change what a second campaign was measuring.
    // Skipping the build now skips the install with it; --install forces it.
    skipInstall: argv.includes("--skip-build") && !argv.includes("--install"),
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
  --passes N            sweeps over the app list, each in the opposite order to the
                        last (default 2). Every app is therefore measured once early
                        and once late in the campaign, and both are reported: on a
                        machine that drifts thermally, queue position is worth more
                        than most framework differences. --passes 1 is faster and
                        gives you no way to tell drift from a result.
  --note "..."          free text recorded in the environment block: say whether the
                        machine was idle, on mains, thermally throttled, ...
  --label name          suffix for the output filenames
  --out DIR             where to write results (default bench/results)
  --skip-build          reuse whatever is already built, and do not reinstall
                        dependencies either (faster, less honest)
  --install             run the manifest install steps even under --skip-build
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

/** does this implementation get handed a second port it actually listens on? */
const usesApiPort = (app: App): boolean =>
  JSON.stringify([app.manifest.env ?? {}, app.manifest.start, app.manifest.build ?? []]).includes("API_PORT");

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
 *
 * The check counts as well as searches. Substring checks alone could only
 * express "this string appears somewhere", so an implementation that shipped
 * two of CONTRACT.md's seven requirements for `/page` - and skipped the twenty
 * rows, the nav and the hydrating component - passed and posted a number that
 * looked like a win. `expect.matches` carries the counts; `expect.minBytes` is
 * a floor under the response so a suspiciously short body fails rather than
 * scores.
 *
 * Returns what it saw, so the report can print response size beside req/s.
 */
async function verify(base: string, id: ScenarioId): Promise<ResponseSample | undefined> {
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
    // a stream has no body length to record: it is still open
    return undefined;
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
  // bytes, not characters: the load tool moves bytes and so does the network
  const bytes = Buffer.byteLength(body, "utf8");

  for (const needle of scenario.expect.contains ?? []) {
    if (!body.includes(needle)) {
      throw new Error(`GET ${scenario.path} body does not contain ${JSON.stringify(needle)} - the contract is not met`);
    }
  }
  for (const rule of scenario.expect.matches ?? []) {
    const min = rule.min ?? 1;
    const flags = rule.flags ?? "";
    const found = min === 1 && !flags.includes("g")
      ? (new RegExp(rule.pattern, flags).test(body) ? 1 : 0)
      : [...body.matchAll(new RegExp(rule.pattern, flags.includes("g") ? flags : flags + "g"))].length;
    if (found < min) {
      throw new Error(
        `GET ${scenario.path}: the contract requires ${rule.label} (/${rule.pattern}/ at least ${min}x); ` +
          `the response has ${found}`,
      );
    }
  }
  if (scenario.expect.minBytes !== undefined && bytes < scenario.expect.minBytes) {
    throw new Error(
      `GET ${scenario.path} returned ${bytes} bytes; the contract's floor is ${scenario.expect.minBytes}. ` +
        "A short body is not a fast body - refusing to time this.",
    );
  }

  return { status: res.status, contentType, bytes };
}

async function buildApp(app: App, env: Record<string, string>, opts: Options, ports: Ports): Promise<void> {
  const steps: string[][] = [];
  if (app.manifest.install && !opts.skipInstall) steps.push(app.manifest.install);
  if (!opts.skipBuild) steps.push(...(app.manifest.build ?? []));
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

  // Both ports, not just the public one. An implementation with a second half
  // (borgo's Go API) is proxied to on API_PORT, so a stale binary left on it by
  // a crashed run would be quietly measured instead of the one just started -
  // and the public port would look perfectly free while it happened.
  for (const port of [app.manifest.port, ...(usesApiPort(app) ? [opts.apiPort] : [])]) {
    if (await portInUse(port)) {
      return {
        ...result,
        status: "failed",
        reason: `port ${port} is already in use - refusing to measure someone else's server`,
      };
    }
  }

  try {
    await buildApp(app, env, opts, ports);
  } catch (error) {
    return { ...result, status: "failed", reason: `build failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  // the competitor's own version, recorded rather than asserted from a
  // hand-typed string in a README. `versionCommand` had been declared and set
  // by seven manifests and read by nothing at all.
  if (app.manifest.versionCommand) {
    const printed = await capture(resolveArgv(app.manifest.versionCommand, ports), app.dir);
    result.frameworkVersion = printed.split("\n")[0]?.trim() || "unknown";
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
  let sample: ResponseSample | undefined;
  try {
    sample = await verify(base, id);
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
    // the worst run, not the median: three runs and a median means one run can
    // fail completely without the campaign noticing
    if (summary.worst.successRate < MIN_TRANSPORT_SUCCESS_RATE) {
      return {
        scenario: id,
        status: "failed",
        reason:
          `worst-run transport success rate ${(summary.worst.successRate * 100).toFixed(1)}% ` +
          `- too many failed requests to report a throughput`,
        sample,
        load: summary,
      };
    }
    // and the answers themselves, which oha's successRate says nothing about:
    // a 500 delivered intact is a completed exchange to a load tool, and a
    // server that sheds work under sustained concurrency sheds it fast.
    // verify() only ever saw one response, before the load started.
    if (summary.worst.non2xxRate > MAX_NON_2XX_RATE) {
      const seen = Object.entries(summary.totals.statusCodes)
        .map(([code, count]) => `${code}:${count}`)
        .join(" ");
      return {
        scenario: id,
        status: "failed",
        reason:
          `${(summary.worst.non2xxRate * 100).toFixed(2)}% of responses in the worst run were not 2xx ` +
          `(over ${pct(MAX_NON_2XX_RATE)}) - the server degraded under load, so this is not a throughput. ` +
          `Totals over ${summary.totals.runs} run(s): ${seen}`,
        sample,
        load: summary,
      };
    }
    return { scenario: id, status: "ok", sample, load: summary };
  } catch (error) {
    return { scenario: id, status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

const pct = (rate: number) => `${(rate * 100).toFixed(2)}%`;

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
  const passOrders: string[][] = [];

  for (let pass = 1; pass <= opts.passes; pass++) {
    const order = sweepOrder(selected, pass);
    passOrders.push(order.map((a) => a.manifest.name));
    log(`\n  ==== pass ${pass} of ${opts.passes}: ${order.map((a) => a.manifest.name).join(" -> ")} ====`);
    for (const [index, app] of order.entries()) {
      const position = { pass, orderIndex: index + 1 };
      log(`\n  === ${app.manifest.name} (${app.manifest.framework}) - pass ${pass}, #${index + 1} of ${order.length} ===`);
      if (app.manifest.status === "stub") {
        step(`stub, not run: ${app.manifest.todo}`);
        results.push({
          app: app.manifest.name,
          manifest: app.manifest,
          status: "stub",
          reason: app.manifest.todo,
          scenarios: [],
          ...position,
        });
        continue;
      }
      results.push({ ...(await benchmarkApp(app, opts, tool)), ...position });
    }
  }

  const config: RunConfig = {
    connections: opts.connections,
    durationSeconds: opts.durationSeconds,
    warmupSeconds: opts.warmupSeconds,
    runs: opts.runs,
    memoryConnections: opts.memoryConnections,
    scenarios: opts.scenarios,
    apps: selected.map((a) => a.manifest.name),
    passes: opts.passes,
    passOrders,
    skipBuild: opts.skipBuild,
    skipInstall: opts.skipInstall,
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
