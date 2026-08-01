import { existsSync } from "node:fs";
import { capture, run } from "./proc";
import { median } from "./stats";
import { ensureOha, pinnedOhaPath } from "../tools/get-oha";
import type { LoadRunResult, LoadStats } from "./types";

export interface LoadTool {
  name: "oha" | "wrk";
  path: string;
  version: string;
}

/**
 * oha is preferred because it emits machine-readable JSON including per-status
 * counts, so a run that is fast because it is 500ing cannot be reported as a
 * win. wrk is accepted as a fallback (its text output is parsed). If neither is
 * available we refuse: a hand-rolled loop in the same runtime as one of the
 * subjects would be a benchmark of our own client.
 */
export async function resolveLoadTool(opts: { prefer?: string; allowDownload?: boolean } = {}): Promise<LoadTool> {
  if (opts.prefer) {
    if (!existsSync(opts.prefer)) throw new Error(`--load-tool ${opts.prefer} does not exist`);
    const name = /wrk/i.test(opts.prefer) ? "wrk" : "oha";
    return { name, path: opts.prefer, version: await toolVersion(name, opts.prefer) };
  }

  const fromEnv = process.env.BENCH_OHA;
  if (fromEnv && existsSync(fromEnv)) return { name: "oha", path: fromEnv, version: await toolVersion("oha", fromEnv) };

  const pinned = pinnedOhaPath();
  if (pinned && existsSync(pinned)) return { name: "oha", path: pinned, version: await toolVersion("oha", pinned) };

  for (const candidate of ["oha", "wrk"] as const) {
    const found = await which(candidate);
    if (found) return { name: candidate, path: found, version: await toolVersion(candidate, found) };
  }

  if (opts.allowDownload !== false) {
    const path = await ensureOha();
    return { name: "oha", path, version: await toolVersion("oha", path) };
  }

  throw new Error(
    "no load generator found.\n" +
      "  install oha   : https://github.com/hatoo/oha  (or run `bun bench/tools/get-oha.ts`)\n" +
      "  or install wrk: https://github.com/wg/wrk\n" +
      "  or point at one: --load-tool <path>  /  BENCH_OHA=<path>\n" +
      "refusing to substitute a hand-written loop: it would measure the client, not the server.",
  );
}

async function which(bin: string): Promise<string> {
  const argv = process.platform === "win32" ? ["where", bin] : ["which", bin];
  const res = await run(argv, { cwd: process.cwd(), timeoutMs: 10_000 });
  if (res.code !== 0) return "";
  const first = res.stdout.split("\n")[0]?.trim() ?? "";
  return first && existsSync(first) ? first : "";
}

async function toolVersion(name: "oha" | "wrk", path: string): Promise<string> {
  if (name === "oha") return (await capture([path, "--version"])) || "unknown";
  // wrk has no --version; it prints usage including the version on a bad flag
  const res = await run([path, "--version"], { cwd: process.cwd(), timeoutMs: 10_000 });
  return ((res.stdout + res.stderr).split("\n")[0] ?? "").trim() || "unknown";
}

export interface LoadOptions {
  url: string;
  connections: number;
  durationSeconds: number;
  /** oha only; wrk always uses its own thread heuristic */
  threads?: number;
}

/** the exact argv used, recorded in the results so the run can be replayed by hand */
export function loadArgv(tool: LoadTool, opts: LoadOptions): string[] {
  if (tool.name === "oha") {
    return [
      tool.path,
      "-z", `${opts.durationSeconds}s`,
      "-c", String(opts.connections),
      "--no-tui",
      "--output-format", "json",
      // keep-alive stays ON: it is what browsers and reverse proxies do, and
      // disabling it would benchmark the OS accept path instead of the server
      "--disable-compression",
      opts.url,
    ];
  }
  return [
    tool.path,
    `-t${opts.threads ?? Math.min(8, opts.connections)}`,
    `-c${opts.connections}`,
    `-d${opts.durationSeconds}s`,
    "--latency",
    opts.url,
  ];
}

export async function runLoad(tool: LoadTool, opts: LoadOptions): Promise<LoadStats> {
  const argv = loadArgv(tool, opts);
  const res = await run(argv, { cwd: process.cwd(), timeoutMs: (opts.durationSeconds + 120) * 1000 });
  if (res.code !== 0) throw new Error(`${tool.name} exited ${res.code}: ${(res.stderr || res.stdout).trim().slice(0, 800)}`);
  return tool.name === "oha" ? parseOha(res.stdout) : parseWrk(res.stdout);
}

interface OhaJson {
  summary: { successRate: number; requestsPerSec: number; total: number };
  latencyPercentiles: Record<string, number>;
  statusCodeDistribution: Record<string, number>;
  errorDistribution?: Record<string, number>;
}

/**
 * Share of counted responses whose status was not 2xx.
 *
 * oha's own `successRate` is transport-level: it says the exchange completed,
 * not that the server agreed to do the work. A server that 500s under load
 * answers faster than one that does not, so this is the figure the runner
 * actually gates on.
 *
 * wrk's parser emits the synthetic keys "2xx" and "non-2xx"; both are handled
 * here so the two tools mean the same thing.
 */
export function non2xxRate(statusCodes: Record<string, number>): number {
  let total = 0;
  let bad = 0;
  for (const [code, count] of Object.entries(statusCodes)) {
    total += count;
    if (code !== "2xx" && !code.startsWith("2")) bad += count;
  }
  return total === 0 ? 0 : bad / total;
}

export function parseOha(stdout: string): LoadStats {
  const json = JSON.parse(stdout) as OhaJson;
  const sec = (v: number | undefined) => (v ?? 0) * 1000;
  const statusCodes = json.statusCodeDistribution ?? {};
  const total = Object.values(statusCodes).reduce((a, b) => a + b, 0);
  return {
    requestsPerSec: json.summary.requestsPerSec,
    successRate: json.summary.successRate,
    non2xxRate: non2xxRate(statusCodes),
    totalRequests: total,
    latencyMs: {
      p50: sec(json.latencyPercentiles["p50"]),
      p90: sec(json.latencyPercentiles["p90"]),
      p95: sec(json.latencyPercentiles["p95"]),
      p99: sec(json.latencyPercentiles["p99"]),
      // oha reports a true max as well; this is p99.99 and the field name now
      // says so. It was called `max` and was written into every artifact
      // under that name while holding a tail percentile.
      p9999: sec(json.latencyPercentiles["p99.99"]),
    },
    statusCodes,
    errors: json.errorDistribution ?? {},
  };
}

/**
 * wrk's text output. NOTE: parsed but not verified on this machine (wrk does not
 * build on Windows); treat the first wrk-based run on Linux as a smoke test of
 * this function as much as of the server.
 */
export function parseWrk(stdout: string): LoadStats {
  const num = (re: RegExp) => Number(re.exec(stdout)?.[1] ?? "0");
  const dur = (raw: string | undefined): number => {
    if (!raw) return 0;
    const m = /^([\d.]+)(us|ms|s|m)$/.exec(raw.trim());
    if (!m) return 0;
    const value = Number(m[1]);
    return { us: value / 1000, ms: value, s: value * 1000, m: value * 60_000 }[m[2] as "us" | "ms" | "s" | "m"];
  };
  const pct = (label: string) => dur(new RegExp(`\\s+${label}\\s+([\\d.]+\\w+)`).exec(stdout)?.[1]);
  const requests = num(/(\d+) requests in /);
  const nonSuccess = num(/Non-2xx or 3xx responses: (\d+)/);
  const socketErrors = /Socket errors: connect (\d+), read (\d+), write (\d+), timeout (\d+)/.exec(stdout);
  return {
    requestsPerSec: num(/Requests\/sec:\s+([\d.]+)/),
    successRate: requests > 0 ? (requests - nonSuccess) / requests : 0,
    non2xxRate: requests > 0 ? nonSuccess / requests : 0,
    totalRequests: requests,
    // wrk reports no p99.99, and 0 is the honest answer rather than a number
    latencyMs: { p50: pct("50%"), p90: pct("90%"), p95: pct("95%"), p99: pct("99%"), p9999: 0 },
    statusCodes: nonSuccess > 0 ? { "2xx": requests - nonSuccess, "non-2xx": nonSuccess } : { "2xx": requests },
    errors: socketErrors
      ? {
          connect: Number(socketErrors[1]),
          read: Number(socketErrors[2]),
          write: Number(socketErrors[3]),
          timeout: Number(socketErrors[4]),
        }
      : {},
  };
}

/**
 * Median per field across runs - never the best run.
 *
 * Two things this deliberately does NOT do any more. It does not put summed
 * counters inside the object called `median`: `statusCodes` and `errors` are
 * totals over every run, and printing a 3-run total in the same row as a 1-run
 * median made the non-2xx column silently three times too large relative to
 * `totalRequests`. And it does not let the median hide a catastrophe: with
 * three runs the median success rate discards the worst one entirely, so the
 * worst run is carried separately and is what the runner gates on.
 *
 * The `median` object is still a synthetic composite - each field is picked
 * independently, so it corresponds to no single run. That is intended for
 * latency percentiles and throughput; it is why counts are not in it.
 */
export function summarise(runs: LoadStats[]): LoadRunResult {
  const pick = (fn: (s: LoadStats) => number) => median(runs.map(fn));
  const sum = (get: (s: LoadStats) => Record<string, number>) => {
    const out: Record<string, number> = {};
    for (const runStats of runs) {
      for (const [key, count] of Object.entries(get(runStats))) out[key] = (out[key] ?? 0) + count;
    }
    return out;
  };
  return {
    runs,
    median: {
      requestsPerSec: pick((s) => s.requestsPerSec),
      successRate: pick((s) => s.successRate),
      non2xxRate: pick((s) => s.non2xxRate),
      totalRequests: pick((s) => s.totalRequests),
      latencyMs: {
        p50: pick((s) => s.latencyMs.p50),
        p90: pick((s) => s.latencyMs.p90),
        p95: pick((s) => s.latencyMs.p95),
        p99: pick((s) => s.latencyMs.p99),
        p9999: pick((s) => s.latencyMs.p9999),
      },
    },
    totals: {
      runs: runs.length,
      requests: runs.reduce((acc, r) => acc + r.totalRequests, 0),
      statusCodes: sum((s) => s.statusCodes),
      errors: sum((s) => s.errors),
    },
    worst: {
      successRate: runs.length === 0 ? 0 : Math.min(...runs.map((r) => r.successRate)),
      non2xxRate: runs.length === 0 ? 0 : Math.max(...runs.map((r) => r.non2xxRate)),
    },
  };
}
