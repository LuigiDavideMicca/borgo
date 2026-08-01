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
}

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
  };
}

export function environmentMarkdown(env: Environment): string {
  const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1) + " GiB";
  return [
    "| field | value |",
    "| --- | --- |",
    `| captured | ${env.capturedAt} |`,
    `| os | ${env.host.osType} ${env.host.osRelease} (${env.host.platform}/${env.host.arch}) |`,
    `| cpu | ${env.host.cpuModel} - ${env.host.cpuCount} logical cores @ ${env.host.cpuMhz} MHz |`,
    `| memory | ${gb(env.host.totalMemBytes)} total, ${gb(env.host.freeMemBytesAtStart)} free at start |`,
    `| go | ${env.versions.go} |`,
    `| bun | ${env.versions.bun} |`,
    `| node | ${env.versions.node} |`,
    `| deno | ${env.versions.deno} |`,
    `| borgo | ${env.repo.borgoVersion} (repo commit ${env.repo.commit.slice(0, 12)}${env.repo.dirty ? ", working tree dirty" : ""}) |`,
    `| load tool | ${env.loadTool.name} ${env.loadTool.version} |`,
    `| operator note | ${env.note || "(none given)"} |`,
  ].join("\n");
}
