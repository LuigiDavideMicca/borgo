import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupStale, isAlive, isCorpse } from "../lib/proc";
import { benchRoot } from "../lib/paths";

// real /proc/<pid>/stat lines, captured on wsl2
const LIVE = "7551 (python3) R 7547 7551 7551 34821 7551 4194560 1919 591 7 0 2 1 0 0 20 0 1 0 142863 20598784";
const CORPSE = "7553 (python3) Z 7551 7551 7551 34821 7551 4227148 94 0 0 0 0 0 0 0 20 0 1 0 142958 0 0";
const LIVE_UNESCAPED = "7692 (my prog (x)) S 7683 7683 7683 34821 7683 4194368 204 0 0 0 0 0 0 0 20 0 1 0 146738";
const CORPSE_UNESCAPED = "7692 (my prog (x)) Z 7683 7683 7683 34821 7683 4228172 204 0 0 0 0 0 0 0 20 0 1 0 146738";

const linux = process.platform === "linux";
const started: Bun.Subprocess[] = [];
const track = <T extends Bun.Subprocess>(proc: T): T => {
  started.push(proc);
  return proc;
};

afterAll(async () => {
  for (const proc of started) if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  await Promise.all(started.map((proc) => proc.exited));
});

/** a perl that forks a child, lets it exit and never waits: the child is a corpse for as long as perl sleeps */
async function spawnCorpse(): Promise<{ holder: Bun.Subprocess; corpse: number }> {
  const holder = track(
    Bun.spawn(["perl", "-e", 'my $p = fork; exit 0 if !$p; $| = 1; print "$p\n"; sleep 60'], { stdout: "pipe", stderr: "ignore" }),
  );
  const first = await (holder.stdout as ReadableStream<Uint8Array>).getReader().read();
  const corpse = Number(new TextDecoder().decode(first.value).trim());
  if (!Number.isFinite(corpse) || corpse <= 0) throw new Error("perl did not report the child pid");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (isCorpse(readFileSync(`/proc/${corpse}/stat`, "utf8"))) return { holder, corpse };
    await Bun.sleep(20);
  }
  throw new Error(`pid ${corpse} never read as Z`);
}

describe("isCorpse reads the state field past an unescaped comm", () => {
  test("live is live, Z is a corpse, whatever the comm contains", () => {
    expect(isCorpse(LIVE)).toBe(false);
    expect(isCorpse(CORPSE)).toBe(true);
    expect(isCorpse(LIVE_UNESCAPED)).toBe(false);
    expect(isCorpse(CORPSE_UNESCAPED)).toBe(true);
    expect(isCorpse("42 (Zed) R 1 1 1 0 -1 4194304 100 0 0")).toBe(false);
    expect(isCorpse("42 (Z) S 1 1 1 0 -1 4194304 100 0 0")).toBe(false);
    expect(isCorpse("42 (sh) X 1 1 1 0 -1 0 0 0 0")).toBe(true);
    expect(isCorpse("42 (sh) x 1 1 1 0 -1 0 0 0 0")).toBe(true);
  });

  test("no /proc, no answer", () => {
    expect(isCorpse(null)).toBe(false);
    expect(isCorpse("")).toBe(false);
    expect(isCorpse("42 no parens Z")).toBe(false);
    expect(isCorpse("42 (sh)")).toBe(false);
  });
});

describe("isAlive", () => {
  test("this process is alive, a reaped child is not", async () => {
    expect(isAlive(process.pid)).toBe(true);
    const child = track(Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" }));
    await child.exited;
    expect(isAlive(child.pid)).toBe(false);
  }, 20_000);

  test.if(linux)("a corpse that still accepts signal 0 is not alive", async () => {
    const { holder, corpse } = await spawnCorpse();
    expect(() => process.kill(corpse, 0)).not.toThrow();
    expect(isAlive(corpse)).toBe(false);
    expect(isAlive(holder.pid)).toBe(true);
  });
});

describe("cleanupStale", () => {
  const pidfile = join(benchRoot(), ".tools", "running.pids");

  test.if(linux)("a server whose runner is a corpse is orphaned and gets killed", async () => {
    if (existsSync(pidfile)) throw new Error(`${pidfile} exists: a runner may be measuring, not touching it`);
    const { corpse } = await spawnCorpse();
    const server = track(Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore" }));
    mkdirSync(join(benchRoot(), ".tools"), { recursive: true });
    writeFileSync(pidfile, `${corpse}:${server.pid}\n`, "utf8");
    try {
      expect(cleanupStale()).toEqual({ killed: 1, skipped: 0 });
      await server.exited;
      expect(server.signalCode).toBe("SIGKILL");
      expect(existsSync(pidfile)).toBe(false);
    } finally {
      rmSync(pidfile, { force: true });
    }
  });
});
