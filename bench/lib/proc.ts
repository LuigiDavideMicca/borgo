import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { benchRoot } from "./paths";

/**
 * Orphaned benchmark servers are the classic way to poison the next run: they
 * hold the port, they hold memory, and the numbers they produce are somebody
 * else's. Everything spawned here is registered, killed as a tree, and also
 * written to a pidfile so a hard-killed runner can be cleaned up afterwards
 * with `bun run.ts --cleanup`.
 */

const PIDFILE = () => join(benchRoot(), ".tools", "running.pids");

const live = new Set<number>();
let hooksInstalled = false;

/**
 * Each line is `<runnerPid>:<serverPid>`. The owner matters: a second runner
 * started while a first one is mid-measurement must not kill the first one's
 * servers - which is exactly what a naive pidfile does, and exactly what
 * happened once during development, silently corrupting a run in progress.
 */
function writePidfile() {
  try {
    const lines = [...live].map((pid) => `${process.pid}:${pid}`);
    if (lines.length === 0) rmSync(PIDFILE(), { force: true });
    else writeFileSync(PIDFILE(), lines.join("\n"), "utf8");
  } catch {
    // the pidfile is a safety net, not a dependency
  }
}

function recordPid(pid: number) {
  live.add(pid);
  writePidfile();
}

function forgetPid(pid: number) {
  live.delete(pid);
  writePidfile();
}

/**
 * A process that exited but was never collected keeps its pid and keeps
 * accepting signal 0, so the corpse is read from /proc/<pid>/stat as
 * dev.ts and serve-entry.ts already do; without /proc the signal is the answer.
 */
export function isCorpse(stat: string | null): boolean {
  if (!stat) return false;
  // the comm is in parentheses and unescaped: only the last ")" closes it
  const close = stat.lastIndexOf(")");
  if (close < 0) return false;
  const state = stat.slice(close + 1).trimStart().charAt(0);
  return state === "Z" || state === "X" || state === "x";
}

/** does a process with this pid exist? signal 0 checks without signalling */
export function isAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
  } catch (error) {
    // EPERM means it exists but belongs to somebody else
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  let stat: string | null = null;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {}
  return !isCorpse(stat);
}

/** kills a pid and every descendant, synchronously enough to be usable from an exit hook */
export function killTree(pid: number): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
    } else {
      // negative pid = the process group, which is why spawns below ask for one
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
  } catch {}
  forgetPid(pid);
}

export function killAll(): void {
  for (const pid of [...live]) killTree(pid);
}

export interface CleanupReport {
  /** process trees belonging to a runner that is gone; killed */
  killed: number;
  /** process trees belonging to a runner that is still alive; left alone */
  skipped: number;
}

/**
 * Removes servers left behind by a runner that died without cleaning up - and
 * only those. Entries owned by a runner that is still alive are left strictly
 * alone: it is measuring with them.
 */
export function cleanupStale(): CleanupReport {
  const file = PIDFILE();
  if (!existsSync(file)) return { killed: 0, skipped: 0 };

  const entries = readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [owner, server] = line.split(":");
      // a file written by an older version has no owner; treat it as orphaned
      return server === undefined
        ? { owner: 0, server: Number(owner) }
        : { owner: Number(owner), server: Number(server) };
    })
    .filter((entry) => Number.isFinite(entry.server) && entry.server > 0);

  const survivors: string[] = [];
  let killed = 0;
  for (const entry of entries) {
    if (entry.owner && entry.owner !== process.pid && isAlive(entry.owner)) {
      survivors.push(`${entry.owner}:${entry.server}`);
      continue;
    }
    killTree(entry.server);
    killed++;
  }

  try {
    if (survivors.length === 0) rmSync(file, { force: true });
    else writeFileSync(file, survivors.join("\n"), "utf8");
  } catch {}

  return { killed, skipped: survivors.length };
}

export function installCleanupHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const bail = (code: number) => () => {
    killAll();
    process.exit(code);
  };
  process.on("SIGINT", bail(130));
  process.on("SIGTERM", bail(143));
  process.on("SIGHUP", bail(129));
  process.on("beforeExit", killAll);
  process.on("exit", killAll);
  process.on("uncaughtException", (error) => {
    console.error(error);
    killAll();
    process.exit(1);
  });
  process.on("unhandledRejection", (error) => {
    console.error(error);
    killAll();
    process.exit(1);
  });
}

export interface Spawned {
  proc: Subprocess<"ignore", "pipe", "pipe">;
  pid: number;
  /** everything the server printed, kept for the failure report */
  output: () => string;
  stop: () => void;
}

/** starts a long-running server, capturing its output without blocking on it */
export function spawnServer(argv: string[], opts: { cwd: string; env: Record<string, string> }): Spawned {
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // a process group makes the posix tree-kill exact instead of hopeful
    ...(process.platform === "win32" ? {} : { detached: true }),
  }) as Subprocess<"ignore", "pipe", "pipe">;

  let buffer = "";
  const drain = async (stream: ReadableStream<Uint8Array> | undefined) => {
    if (!stream) return;
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      if (buffer.length > 64_000) buffer = buffer.slice(-32_000);
    }
  };
  void drain(proc.stdout);
  void drain(proc.stderr);

  recordPid(proc.pid);
  return {
    proc,
    pid: proc.pid,
    output: () => buffer,
    stop: () => killTree(proc.pid),
  };
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** runs a build step to completion, streaming nothing, returning everything */
export async function run(argv: string[], opts: { cwd: string; env?: Record<string, string>; timeoutMs?: number }): Promise<RunResult> {
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  recordPid(proc.pid);
  const timeout = opts.timeoutMs ?? 15 * 60_000;
  const timer = setTimeout(() => killTree(proc.pid), timeout);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  forgetPid(proc.pid);
  return { code, stdout, stderr };
}

/** a quick single-shot capture used for version strings; failures are not fatal */
export async function capture(argv: string[], cwd = process.cwd()): Promise<string> {
  try {
    const res = await run(argv, { cwd, timeoutMs: 20_000 });
    const text = (res.stdout + res.stderr).trim();
    return text.split("\n")[0]?.trim() ?? "";
  } catch {
    return "";
  }
}

export function portInUse(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** waits for the port to stop answering, so the next app does not inherit a socket */
export async function waitPortFree(port: number, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portInUse(port))) return true;
    await Bun.sleep(200);
  }
  return false;
}
