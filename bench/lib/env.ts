import { cpus, freemem, platform, release, totalmem, type as osType } from "node:os";
import { capture } from "./proc";
import { repoRoot } from "./paths";

/**
 * Recorded automatically so a number can never be published without the machine
 * it was produced on. What the runner cannot know - whether the laptop was on
 * mains, whether a browser was open, what the room temperature was - is asked
 * for with --note and printed verbatim.
 */
export interface Environment {
  capturedAt: string;
  host: {
    platform: string;
    osType: string;
    osRelease: string;
    arch: string;
    cpuModel: string;
    cpuCount: number;
    cpuMhz: number;
    totalMemBytes: number;
    freeMemBytesAtStart: number;
  };
  versions: Record<string, string>;
  repo: { commit: string; dirty: boolean; borgoVersion: string };
  loadTool: { name: string; version: string; path: string };
  note: string;
  /**
   * Was anything else using this machine when the campaign started?
   *
   * "Run it on an idle box" was advice in the README and nothing more: nothing
   * measured whether the box was idle, so a campaign run alongside a build or a
   * browser produced numbers that looked exactly like a campaign run on a quiet
   * one. This is a cheap, cross-platform pre-flight reading, and the report
   * prints it whether it flatters the run or not.
   */
  idleCheck: {
    /** share of CPU time that was not idle across a short window before the first app started */
    busyRatioAtStart: number;
    sampleMs: number;
    /** the threshold the report calls "quiet" */
    quietThreshold: number;
    quiet: boolean;
  };
  /**
   * The same machine at the end. A campaign runs for tens of minutes; free
   * memory measured only at minute zero cannot say that the box filled up
   * halfway through and that the last apps measured were the ones that paid.
   */
  close?: {
    finishedAt: string;
    freeMemBytesAtEnd: number;
    busyRatioAtEnd: number;
    elapsedSeconds: number;
  };
}

export interface CpuSnapshot {
  idle: number;
  total: number;
}

/** cumulative CPU times across every logical core; the difference of two is a duty cycle */
export function cpuSnapshot(): CpuSnapshot {
  let idle = 0;
  let total = 0;
  for (const core of cpus()) {
    const t = core.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/**
 * Share of CPU time that was not idle between two snapshots, in [0, 1].
 *
 * Returns 0 when no time passed, because "no time passed" is not evidence of
 * a busy machine and a benchmark should not refuse to run over a rounding
 * artefact.
 */
export function cpuBusyRatio(before: CpuSnapshot, after: CpuSnapshot): number {
  const total = after.total - before.total;
  const idle = after.idle - before.idle;
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, 1 - idle / total));
}

export async function measureCpuBusy(sampleMs = 1_000): Promise<number> {
  const before = cpuSnapshot();
  await Bun.sleep(sampleMs);
  return cpuBusyRatio(before, cpuSnapshot());
}

/** above this, the machine was doing something else and the numbers are contaminated */
export const QUIET_THRESHOLD = 0.1;

export async function captureEnvironment(loadTool: { name: string; version: string; path: string }, note: string): Promise<Environment> {
  const root = repoRoot();
  const list = cpus();
  const [go, bun, node, npm, deno, git, gitDirty, borgoPkg] = await Promise.all([
    capture(["go", "version"], root),
    capture(["bun", "--version"], root),
    capture(["node", "--version"], root),
    capture(["npm", "--version"], root),
    capture(["deno", "--version"], root),
    capture(["git", "rev-parse", "HEAD"], root),
    capture(["git", "status", "--porcelain"], root),
    Bun.file(`${root}/packages/borgo/package.json`)
      .json()
      .then((p: { version?: string }) => p.version ?? "unknown")
      .catch(() => "unknown"),
  ]);

  const sampleMs = 1_000;
  const busy = await measureCpuBusy(sampleMs);

  return {
    capturedAt: new Date().toISOString(),
    host: {
      platform: platform(),
      osType: osType(),
      osRelease: release(),
      arch: process.arch,
      cpuModel: list[0]?.model?.trim() ?? "unknown",
      cpuCount: list.length,
      cpuMhz: list[0]?.speed ?? 0,
      totalMemBytes: totalmem(),
      freeMemBytesAtStart: freemem(),
    },
    versions: {
      go: go || "not installed",
      bun: bun || "not installed",
      node: node || "not installed",
      npm: npm || "not installed",
      deno: deno || "not installed",
    },
    repo: {
      commit: git || "unknown",
      // a dirty tree is not disqualifying, but a reader deserves to know the
      // measured code is not exactly the commit named
      dirty: gitDirty.length > 0,
      borgoVersion: borgoPkg,
    },
    loadTool,
    note,
    idleCheck: {
      busyRatioAtStart: busy,
      sampleMs,
      quietThreshold: QUIET_THRESHOLD,
      quiet: busy <= QUIET_THRESHOLD,
    },
  };
}

/** the machine again, after the last app has been measured */
export async function captureClose(env: Environment): Promise<Environment["close"]> {
  const busy = await measureCpuBusy(1_000);
  const finishedAt = new Date();
  return {
    finishedAt: finishedAt.toISOString(),
    freeMemBytesAtEnd: freemem(),
    busyRatioAtEnd: busy,
    elapsedSeconds: Math.max(0, (finishedAt.getTime() - new Date(env.capturedAt).getTime()) / 1000),
  };
}

/**
 * Everything about this run a reader is entitled to be told before they read a
 * table, in the words they would want it in. The report prints these as a
 * warning block: a harness that cannot enforce a condition in code has to say
 * so in the output, not stay quiet and hope.
 */
export function environmentWarnings(env: Environment): string[] {
  const out: string[] = [];
  const pct = (ratio: number) => `${(ratio * 100).toFixed(1)}%`;

  if (!env.idleCheck.quiet) {
    out.push(
      `The machine was ${pct(env.idleCheck.busyRatioAtStart)} busy before the first app was even started ` +
        `(threshold ${pct(env.idleCheck.quietThreshold)}). Something else was using these cores. Every number ` +
        `below is contaminated by an unknown amount and none of them should be published as a comparison.`,
    );
  }
  if (!env.note.trim()) {
    out.push(
      "No `--note` was given, so nobody has stated on the record whether this machine was on mains power, " +
        "thermally throttled, or running anything else. The runner cannot see any of that. Treat these " +
        "numbers as unattested.",
    );
  }
  if (env.repo.dirty) {
    out.push(
      `The working tree was dirty, so the measured code is not exactly commit ${env.repo.commit.slice(0, 12)}. ` +
        "Whatever was uncommitted is not recoverable from this file.",
    );
  }
  if (env.close) {
    if (env.close.busyRatioAtEnd > env.idleCheck.quietThreshold) {
      out.push(
        `The machine was still ${pct(env.close.busyRatioAtEnd)} busy after the campaign finished and every ` +
          "server had been killed. Something arrived during the run; the apps measured late paid for it.",
      );
    }
    const drop = env.host.freeMemBytesAtStart - env.close.freeMemBytesAtEnd;
    if (drop > env.host.totalMemBytes * 0.25) {
      out.push(
        `Free memory fell by ${(drop / 1024 ** 3).toFixed(1)} GiB over the campaign - more than a quarter of ` +
          "the machine. Whatever consumed it was not this harness's servers, which are killed between apps.",
      );
    }
  }
  return out;
}

export function environmentMarkdown(env: Environment): string {
  const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1) + " GiB";
  const pct = (ratio: number) => `${(ratio * 100).toFixed(1)}%`;
  const memory = env.close
    ? `${gb(env.host.totalMemBytes)} total, ${gb(env.host.freeMemBytesAtStart)} free at start, ` +
      `${gb(env.close.freeMemBytesAtEnd)} free at end`
    : `${gb(env.host.totalMemBytes)} total, ${gb(env.host.freeMemBytesAtStart)} free at start`;
  return [
    "| field | value |",
    "| --- | --- |",
    `| captured | ${env.capturedAt} |`,
    env.close ? `| finished | ${env.close.finishedAt} (${(env.close.elapsedSeconds / 60).toFixed(0)} min) |` : "",
    `| os | ${env.host.osType} ${env.host.osRelease} (${env.host.platform}/${env.host.arch}) |`,
    `| cpu | ${env.host.cpuModel} - ${env.host.cpuCount} logical cores @ ${env.host.cpuMhz} MHz |`,
    `| cpu busy before the campaign | ${pct(env.idleCheck.busyRatioAtStart)} over ${env.idleCheck.sampleMs} ms ` +
      `- ${env.idleCheck.quiet ? "idle enough" : `**NOT IDLE**, over the ${pct(env.idleCheck.quietThreshold)} threshold`} |`,
    env.close ? `| cpu busy after the campaign | ${pct(env.close.busyRatioAtEnd)} |` : "",
    `| memory | ${memory} |`,
    `| go | ${env.versions.go} |`,
    `| bun | ${env.versions.bun} |`,
    `| node | ${env.versions.node} |`,
    `| deno | ${env.versions.deno} |`,
    `| borgo | ${env.repo.borgoVersion} (repo commit ${env.repo.commit.slice(0, 12)}${env.repo.dirty ? ", working tree dirty" : ""}) |`,
    `| load tool | ${env.loadTool.name} ${env.loadTool.version} |`,
    `| operator note | ${env.note || "**(none given - nobody attested this machine was idle)**"} |`,
  ]
    .filter(Boolean)
    .join("\n");
}
