// THE TWO SUPERVISING PROCESSES, WHOSE PARENT WATCH WAS WRONG IN BOTH
// DIRECTIONS AT ONCE.
//
// dev.ts (the watcher that owns the go api and the front server) and cli.ts
// (the re-exec'd half of `borgo start`, which IS the production server) both
// watched their parent with `try { process.kill(pid, 0) } catch { exit(0) }`.
// 4bf68da took that line out of serve-entry.ts and left both of these live.
//
//   DIRECTION A - a corpse reads as ALIVE. A process that has exited but whose
//   status nobody collected keeps its pid and keeps accepting signals. Measured
//   on wsl2 with a real fork: /proc state Z, kill(pid, 0) = OK. The watcher then
//   outlives the session that started it and holds both ports and the go binary.
//
//   DIRECTION B - a live parent out of reach reads as DEAD. Measured with bun
//   1.3.14 on windows: process.kill(4, 0) - the System process, alive and
//   unopenable - throws EPERM, and a bare `catch` cannot tell EPERM from ESRCH.
//   On cli.ts that direction exits the PRODUCTION server with code 0, the
//   supervisor exits 0 with it, and `Restart=on-failure` in the systemd unit
//   borgo writes does not restart a clean exit.
//
// The /proc fixtures are transcribed from real processes on wsl2, including the
// shape that defeats a naive parser: comm is field 2, in parentheses and
// UNESCAPED, so a process literally named "my prog (x)" puts a ")" inside it.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCorpse, parentGone, readParent, watchParent, type ParentReading } from "../src/dev";

const PKG_DIR = join(import.meta.dir, "..");
const DEV_SRC = join(PKG_DIR, "src", "dev.ts");
const CLI_SRC = join(PKG_DIR, "src", "cli.ts");
const DEV_URL = Bun.pathToFileURL(DEV_SRC).href;

// real /proc/<pid>/stat lines, captured on wsl2
const LIVE = "7551 (python3) R 7547 7551 7551 34821 7551 4194560 1919 591 7 0 2 1 0 0 20 0 1 0 142863 20598784";
const CORPSE = "7553 (python3) Z 7551 7551 7551 34821 7551 4227148 94 0 0 0 0 0 0 0 20 0 1 0 142958 0 0";
const LIVE_UNESCAPED = "7692 (my prog (x)) S 7683 7683 7683 34821 7683 4194368 204 0 0 0 0 0 0 0 20 0 1 0 146738";
const CORPSE_UNESCAPED = "7692 (my prog (x)) Z 7683 7683 7683 34821 7683 4228172 204 0 0 0 0 0 0 0 20 0 1 0 146738";

const reading = (over: Partial<ParentReading> = {}): ParentReading => ({
  direct: false,
  ppid: 1,
  killError: null,
  stat: null,
  ...over,
});

// every wait is on a cancellable deadline: a test that hangs is indistinguish-
// able from a slow machine, and reads as neither pass nor fail
async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`deadline ${ms}ms expired: ${what}`)), ms);
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

// every child this file starts is registered here, killed at the end, and then
// VERIFIED gone - a suite that leaves processes behind is the defect it tests
const started: Array<{ pid: number; proc: Bun.Subprocess }> = [];
// grandchildren: this process has no Subprocess for them, only a pid, so they
// are killed by pid. Without this list a mutation that stops the watch leaves
// them running forever - measured, it left two behind the first time.
const strayPids: number[] = [];
const tempDirs: string[] = [];

function track<T extends Bun.Subprocess>(proc: T): T {
  started.push({ pid: proc.pid, proc });
  return proc;
}

const isLive = (pid: number) => !parentGone(pid, readParent(pid, false));

afterAll(async () => {
  try {
    for (const { proc } of started) {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill();
    }
    for (const pid of strayPids) {
      try {
        if (isLive(pid)) process.kill(pid, "SIGKILL");
      } catch {}
    }
    await withDeadline(Promise.all(started.map(({ proc }) => proc.exited)), 15_000, "children did not exit after kill");
    const settled = (async () => {
      while (strayPids.some(isLive)) await Bun.sleep(100);
    })();
    await withDeadline(settled, 15_000, "a tracked grandchild did not die after SIGKILL");
    // the counter must be able to SEE a live process, or every "gone" above is
    // a zero that reads identical to a success
    expect(isLive(process.pid)).toBe(true);
    const alive = [...started.map((s) => s.pid), ...strayPids].filter(isLive);
    if (alive.length) throw new Error(`left ${alive.length} live processes behind: ${alive.join(",")}`);
  } finally {
    // in the finally, or a failing assertion above leaves the scratch dirs on
    // disk - which is exactly what happened under mutation the first time
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// THE PIN. dev.ts carries its own copy of the reading rather than importing
// serve-entry.ts, and that is measured rather than preferred: serve-entry
// imports ./server, which resolves react from the app at MODULE SCOPE, so a
// top-level import of it from cli.ts makes a bare `borgo` outside a project
// throw "Cannot find package 'react'". A divergence between the two halves of
// the same framework is the defect this repository has already found more than
// once, so the copies are held equal here instead of by discipline.
// ---------------------------------------------------------------------------
// serve-entry -> ./server -> createRequire(cwd/package.json)("react") at module
// scope, so it can only be imported from a directory that resolves react.
// Restored immediately: the cwd is process-wide and other test files read it.
const cwdBeforeImport = process.cwd();
process.chdir(PKG_DIR);
const front = await import("../src/serve-entry");
process.chdir(cwdBeforeImport);

describe("dev.ts and serve-entry.ts answer the same question the same way", () => {
  // every reading either half can be handed, including the ones only one
  // platform ever produces
  const table: ParentReading[] = [
    reading(),
    reading({ killError: "ESRCH" }),
    reading({ killError: "EPERM" }),
    reading({ killError: "UNKNOWN" }),
    reading({ killError: null, stat: LIVE }),
    reading({ killError: null, stat: CORPSE }),
    reading({ killError: "EPERM", stat: CORPSE }),
    reading({ killError: "EPERM", stat: LIVE }),
    reading({ killError: null, stat: LIVE_UNESCAPED }),
    reading({ killError: null, stat: CORPSE_UNESCAPED }),
    reading({ direct: true, ppid: 1, killError: null, stat: LIVE }),
    reading({ direct: true, ppid: 7683, killError: null, stat: LIVE }),
    reading({ direct: true, ppid: 7683, killError: "ESRCH" }),
    reading({ direct: false, ppid: 1, killError: null, stat: LIVE }),
    reading({ direct: true, ppid: 1, killError: null, stat: null }),
  ];

  test("parentGone agrees on every reading, one by one", () => {
    for (const r of table) {
      expect([JSON.stringify(r), parentGone(7683, r)]).toEqual([JSON.stringify(r), front.parentGone(7683, r)]);
    }
    expect(table).toHaveLength(15);
  });

  test("isCorpse agrees on every stat line, the parser traps included", () => {
    const stats = [null, "", LIVE, CORPSE, LIVE_UNESCAPED, CORPSE_UNESCAPED, "42 (Zed) R 1 1", "42 (Z) S 1 1", "42 (sh) X 1", "42 (sh) x 1", "42 no parens Z", "42 (sh)"];
    for (const s of stats) expect([s, isCorpse(s)]).toEqual([s, front.isCorpse(s)]);
  });

  test("readParent agrees about this very process", () => {
    expect(readParent(process.pid, true)).toEqual(front.readParent(process.pid, true));
  });

  // the table above only covers the readings it lists. this catches a change to
  // the decision itself - a branch added, removed or reordered in one half.
  test("the three functions are the same code in both files", () => {
    const strip = (fn: unknown) =>
      String(fn)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/\s+/g, " ")
        .trim();
    expect(strip(parentGone)).toBe(strip(front.parentGone));
    expect(strip(isCorpse)).toBe(strip(front.isCorpse));
    expect(strip(readParent)).toBe(strip(front.readParent));
    // and the stripper must actually be able to tell two functions apart
    expect(strip(parentGone)).not.toBe(strip(isCorpse));
  });
});

// ---------------------------------------------------------------------------
// THE DECISION
// ---------------------------------------------------------------------------
describe("parentGone: the two directions, decided one by one", () => {
  // DIRECTION A - the corpse the old catch never saw
  test("a corpse the signal accepted is GONE, not alive", () => {
    expect(parentGone(7553, reading({ killError: null, stat: CORPSE }))).toBe(true);
  });

  // DIRECTION B - the one that takes a production server down
  test("EPERM is a LIVE parent out of reach, never a dead one", () => {
    expect(parentGone(4, reading({ killError: "EPERM" }))).toBe(false);
  });

  test("EPERM plus a /proc corpse is still gone - the refusal is not the answer", () => {
    expect(parentGone(7553, reading({ killError: "EPERM", stat: CORPSE }))).toBe(true);
  });

  test("ESRCH is the one certainty of death", () => {
    expect(parentGone(999_999, reading({ killError: "ESRCH" }))).toBe(true);
  });

  test("an error nobody named is read as gone, as it was before", () => {
    expect(parentGone(123, reading({ killError: "UNKNOWN" }))).toBe(true);
  });

  test("a running parent is alive", () => {
    expect(parentGone(7551, reading({ killError: null, stat: LIVE }))).toBe(false);
  });

  test("no /proc and a signal that succeeded: alive, exactly as before", () => {
    expect(parentGone(7551, reading({ killError: null, stat: null }))).toBe(false);
  });

  // measured with a three-generation fork on wsl2: the grandchild's ppid had
  // ALREADY moved off a parent still reading Z and still accepting kill 0, and
  // it moved to a subreaper (13602), not to pid 1 - so the test is "changed",
  // never "is 1"
  test("a reparented child knows its parent left, with the probe still saying alive", () => {
    expect(parentGone(7683, reading({ direct: true, ppid: 1, killError: null, stat: LIVE }))).toBe(true);
    expect(parentGone(7683, reading({ direct: true, ppid: 13602, killError: null, stat: LIVE }))).toBe(true);
  });

  test("an unchanged ppid keeps the session alive", () => {
    expect(parentGone(7683, reading({ direct: true, ppid: 7683, killError: null, stat: LIVE }))).toBe(false);
  });

  test("a ppid that differs is NOT an exit when the watched pid is not the parent", () => {
    expect(parentGone(7683, reading({ direct: false, ppid: 1, killError: null, stat: LIVE }))).toBe(false);
  });
});

describe("isCorpse: the state field, past a comm nobody escaped", () => {
  test("a real uncollected corpse is a corpse, a real running process is not", () => {
    expect(isCorpse(CORPSE)).toBe(true);
    expect(isCorpse(LIVE)).toBe(false);
  });

  test('a process named "my prog (x)" does not fake a corpse while it runs', () => {
    expect(isCorpse(LIVE_UNESCAPED)).toBe(false);
    expect(isCorpse(CORPSE_UNESCAPED)).toBe(true);
  });

  test("a Z inside the comm is not the state", () => {
    expect(isCorpse("42 (Zed) R 1 1 1 0 -1 4194304 100 0 0")).toBe(false);
    expect(isCorpse("42 (Z) S 1 1 1 0 -1 4194304 100 0 0")).toBe(false);
  });

  test("X and x, the moment after Z, count too", () => {
    expect(isCorpse("42 (sh) X 1 1 1 0 -1 0 0 0 0")).toBe(true);
    expect(isCorpse("42 (sh) x 1 1 1 0 -1 0 0 0 0")).toBe(true);
  });

  test("no /proc, no answer: null and unparseable read as NOT a corpse", () => {
    expect(isCorpse(null)).toBe(false);
    expect(isCorpse("")).toBe(false);
    expect(isCorpse("42 no parens here Z")).toBe(false);
    expect(isCorpse("42 (sh)")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE READING, AGAINST PROCESSES THAT REALLY EXIST
// ---------------------------------------------------------------------------
describe("readParent and watchParent, on real pids", () => {
  test("a child that has exited and been reaped reads as gone", async () => {
    const proc = track(Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" }));
    const pid = proc.pid;
    await withDeadline(proc.exited, 10_000, "the short-lived child never exited");
    expect(parentGone(pid, readParent(pid, false))).toBe(true);
  });

  // the EPERM direction, on a process that really is alive and really is out of
  // reach: a live system process must NEVER be read as gone
  test("a process this one may not signal is never read as dead", () => {
    const unreachable = process.platform === "win32" ? 4 : 1;
    const r = readParent(unreachable, false);
    expect(["EPERM", null]).toContain(r.killError);
    if (process.platform === "win32") expect(r.killError).toBe("EPERM");
    if (process.platform === "linux") {
      expect(r.stat).toContain(`${unreachable} (`);
      expect(isCorpse(r.stat)).toBe(false);
    }
    expect(parentGone(unreachable, r)).toBe(false);
  });

  // measured on windows with bun 1.3.14: a child that has exited reads ESRCH
  // even while this process still holds its Subprocess handle, so windows has
  // no analogue of the /proc corpse for THIS probe (OpenProcess alone would
  // have one - watchdog_windows.go carries that case on the go side)
  test("an exited child whose handle is still held is gone, not alive", async () => {
    const proc = track(Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" }));
    const pid = proc.pid;
    await withDeadline(proc.exited, 10_000, "the short-lived child never exited");
    await Bun.sleep(300);
    expect(readParent(pid, false).killError).not.toBe(null);
  });

  test("watchParent refuses a pid that cannot be a parent, and starts no timer", () => {
    for (const bad of [0, 1, -5, Number.NaN, Number("")]) {
      let fired = 0;
      const timer = watchParent(bad, () => fired++, 20);
      // cleared before the assertion: a timer this test leaves running fires
      // into whatever test comes next, which is how a mutation here reddens a
      // process test three describes away and looks like a kill it is not
      if (timer !== null) clearInterval(timer);
      expect([bad, timer, fired]).toEqual([bad, null, 0]);
    }
  });

  test("watchParent fires for a pid that is already dead", async () => {
    const corpse = track(Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" }));
    const deadPid = corpse.pid;
    await withDeadline(corpse.exited, 10_000, "the child that should die did not");
    const fired = new Promise<void>((resolve) => {
      const timer = watchParent(deadPid, () => {
        clearInterval(timer as ReturnType<typeof setInterval>);
        resolve();
      }, 50);
      expect(timer).not.toBe(null);
    });
    await withDeadline(fired, 10_000, "watchParent never noticed a pid that was already gone");
  }, 15_000);

  test("watchParent stays quiet under a parent that is alive", async () => {
    let fired = false;
    const timer = watchParent(process.pid, () => (fired = true), 50);
    await Bun.sleep(600);
    clearInterval(timer as ReturnType<typeof setInterval>);
    expect(fired).toBe(false);
  });

  test("direct is carried through to the reading rather than recomputed", () => {
    expect(readParent(process.pid, true).direct).toBe(true);
    expect(readParent(process.pid, false).direct).toBe(false);
    expect(readParent(process.pid, false).ppid).toBe(process.ppid);
  });
});

// ---------------------------------------------------------------------------
// THE TWO SITES AS REAL PROCESSES
// ---------------------------------------------------------------------------
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "borgo-pw-"));
  tempDirs.push(dir);
  return dir;
}

describe("site 1 - the dev watcher, in the shape dev() uses", () => {
  // dev() calls watchParent(process.ppid, ...). The launcher of `borgo dev` is
  // a shell or a task runner, NOT bun - and that distinction is the whole point
  // on windows: measured, taskkill /F on a cmd.exe that started a bun process
  // left the bun process ALIVE, where the same kill on a BUN parent took its
  // bun child down through the job object. So the middle process here is a
  // shell on windows: if it were bun, the job object would do the killing and
  // this test would pass while proving nothing about the watch.
  test("a watcher whose launcher is force-killed exits by itself", async () => {
    const dir = scratch();
    const watcher = join(dir, "watcher.ts");
    writeFileSync(
      watcher,
      `import { watchParent } from ${JSON.stringify(DEV_URL)};\n` +
        `import { writeFileSync } from "node:fs";\n` +
        `writeFileSync(${JSON.stringify(join(dir, "pid").replaceAll("\\", "/"))}, String(process.pid));\n` +
        `watchParent(process.ppid, () => process.exit(0), 200);\n` +
        `setInterval(() => {}, 1_000);\n`,
      "utf8",
    );

    const middle =
      process.platform === "win32"
        ? track(Bun.spawn(["cmd.exe", "/c", process.execPath, watcher], { stdout: "ignore", stderr: "ignore" }))
        : track(Bun.spawn(["/bin/sh", "-c", `"$1" "$2"; :`, "sh", process.execPath, watcher], { stdout: "ignore", stderr: "ignore" }));

    // wait for the watcher to have written its pid, on a deadline
    const pidFile = join(dir, "pid");
    const deadline = Date.now() + 15_000;
    let watcherPid = 0;
    while (Date.now() < deadline && !watcherPid) {
      try {
        watcherPid = Number(readFileSync(pidFile, "utf8"));
      } catch {}
      if (!watcherPid) await Bun.sleep(100);
    }
    expect(watcherPid).toBeGreaterThan(1);
    strayPids.push(watcherPid);

    // it must be running before the kill, or "gone afterwards" proves nothing
    expect(isLive(watcherPid)).toBe(true);
    expect(middle.pid).not.toBe(watcherPid);

    middle.kill("SIGKILL");
    await withDeadline(middle.exited, 10_000, "the middle process never died");

    const gone = (async () => {
      while (isLive(watcherPid)) await Bun.sleep(100);
    })();
    await withDeadline(gone, 15_000, "the watcher outlived the launcher it was watching");
  }, 45_000);
});

describe("site 2 - the re-exec'd borgo start, in the shape cli.ts uses", () => {
  // handed an already-dead supervisor rather than one killed mid-test, on
  // purpose: on windows bun puts a Bun.spawn'd child in a job object that takes
  // it down with its parent (measured), so killing a live bun supervisor would
  // pass through the job object and prove nothing about this poll.
  test("a server handed a dead BORGO_SUPERVISOR_PID exits by itself, code 0", async () => {
    const dir = scratch();
    const server = join(dir, "server.ts");
    writeFileSync(
      server,
      `import { watchParent } from ${JSON.stringify(DEV_URL)};\n` +
        `const supervisor = Number(process.env.BORGO_SUPERVISOR_PID);\n` +
        `watchParent(supervisor, () => process.exit(0), 200)?.unref();\n` +
        `setInterval(() => {}, 1_000);\n`,
      "utf8",
    );

    const corpse = track(Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" }));
    const deadPid = corpse.pid;
    await withDeadline(corpse.exited, 10_000, "the child that should die did not");

    const proc = track(
      Bun.spawn([process.execPath, server], {
        stdout: "ignore",
        stderr: "ignore",
        env: { ...process.env, BORGO_SUPERVISOR_PID: String(deadPid) },
      }),
    );
    const code = await withDeadline(proc.exited, 20_000, "the server never noticed its supervisor was gone");
    expect(code).toBe(0);
  }, 30_000);

  test("and keeps serving under a supervisor that is alive", async () => {
    const dir = scratch();
    const server = join(dir, "server.ts");
    writeFileSync(
      server,
      `import { watchParent } from ${JSON.stringify(DEV_URL)};\n` +
        `const supervisor = Number(process.env.BORGO_SUPERVISOR_PID);\n` +
        `watchParent(supervisor, () => process.exit(0), 200)?.unref();\n` +
        `setInterval(() => {}, 1_000);\n`,
      "utf8",
    );
    const proc = track(
      Bun.spawn([process.execPath, server], {
        stdout: "ignore",
        stderr: "ignore",
        env: { ...process.env, BORGO_SUPERVISOR_PID: String(process.pid) },
      }),
    );
    let exited: number | null = null;
    void proc.exited.then((c) => (exited = c));
    await Bun.sleep(3_000);
    expect(exited).toBe(null);
    proc.kill();
    await withDeadline(proc.exited, 10_000, "the server never exited after kill");
  }, 20_000);
});

// ---------------------------------------------------------------------------
// THE WIRING. Neither entry point can be imported and asserted: dev() spawns go
// builds and binds ports, and cli.ts is a top-level switch that runs the whole
// cli on import. The behaviour above is proven on real processes; that the two
// sites still CALL it is held here, by source. Regression guards, not proof.
// ---------------------------------------------------------------------------
describe("the two sites are wired to the reading and not to a bare probe", () => {
  const dev = readFileSync(DEV_SRC, "utf8");
  const cli = readFileSync(CLI_SRC, "utf8");

  test("dev() watches its own direct parent through watchParent", () => {
    expect(dev).toContain("watchParent(process.ppid, () => process.exit(0))");
  });

  test("borgo start watches BORGO_SUPERVISOR_PID through watchParent, unref'd", () => {
    expect(cli).toContain("watchParent(supervisor, () => process.exit(0))?.unref()");
    expect(cli).toContain('Number(process.env.BORGO_SUPERVISOR_PID)');
  });

  // the exact line 4bf68da named as still live in both files. comments are
  // stripped first, or the paragraphs that quote the old probe in order to
  // explain it would keep this green forever after somebody put it back.
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  test("neither file still reads a parent with a bare kill probe", () => {
    // exactly one in dev.ts, inside readParent, whose result is INSPECTED
    // rather than caught and turned straight into an exit; none in cli.ts
    for (const [name, src, want] of [["dev.ts", dev, 1], ["cli.ts", cli, 0]] as const) {
      expect([name, [...code(src).matchAll(/process\.kill\([^)]*,\s*0\)/g)].length]).toEqual([name, want]);
    }
    // and the stripper has to leave real code behind, or the count above is a
    // zero that reads identical to a pass
    expect(code(dev)).toContain("process.kill(parentPid, 0)");
    expect(code(dev)).not.toContain("try { process.kill(pid, 0) }");
  });

  test("cli.ts does not import serve-entry, which would break a bare borgo", () => {
    expect(cli).not.toContain("serve-entry");
  });
});

// ---------------------------------------------------------------------------
// WHY A REUSED PID CANNOT REACH ANY OF THIS - held, not assumed.
//
// A pid is not an identity: nothing in a bare `int` separates "the process that
// spawned me" from "whatever the system later handed that number to". The one
// answer no reused number can forge is reparenting, and it is available only
// while `direct` is true - which holds because EVERY pid borgo hands out is the
// spawner's OWN. Four sites do it: dev.ts spawns the go api and the front
// server, cli.ts re-execs itself and spawns the go api.
//
// Break that - hand a supervisor's pid that is not the parent, or interpose a
// shell between spawner and child - and `direct` is false, the bare probe is the
// whole answer, and a reused pid reads as the parent still running on every
// platform at once. Nothing else in the tree would fail; this does.
// ---------------------------------------------------------------------------
describe("every pid borgo hands a child is that child's direct parent", () => {
  const dev = readFileSync(DEV_SRC, "utf8");
  const cli = readFileSync(CLI_SRC, "utf8");
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  test("all four spawn sites pass process.pid, and there are exactly four", () => {
    const sites: Array<[string, string]> = [];
    for (const [name, src] of [["dev.ts", dev], ["cli.ts", cli]] as const) {
      for (const m of strip(src).matchAll(/BORGO_(?:PARENT|SUPERVISOR)_PID:\s*String\(([^)]*)\)/g)) {
        sites.push([name, m[1].trim()]);
      }
    }
    // the count is asserted too: a fifth site added without a pid that is the
    // spawner's own would otherwise pass unread
    expect(sites).toEqual([
      ["dev.ts", "process.pid"],
      ["dev.ts", "process.pid"],
      ["cli.ts", "process.pid"],
      ["cli.ts", "process.pid"],
    ]);
    // and the stripper has to leave the assignments behind, or an empty list
    // reads identical to four correct ones
    expect(strip(dev)).toContain("BORGO_PARENT_PID: String(process.pid)");
  });

  test("no site names a pid read from anywhere but this process", () => {
    // the env is where a non-parent pid would come from: cli.ts READS
    // BORGO_SUPERVISOR_PID (it is the watcher there) but must never re-emit a
    // pid it did not mint itself
    for (const [name, src] of [["dev.ts", dev], ["cli.ts", cli]] as const) {
      const emitted = [...strip(src).matchAll(/BORGO_(?:PARENT|SUPERVISOR)_PID:\s*([^,\n}]*)/g)].map((m) => m[1].trim());
      expect([name, emitted.filter((e) => !e.startsWith("String(process.pid)"))]).toEqual([name, []]);
    }
  });

  // the source pins above say what borgo intends; this says the operating
  // system agrees, on real processes, in the shape dev.ts spawns the front
  // server with
  test("a child spawned the way dev.ts spawns one computes direct = true", async () => {
    const dir = scratch();
    const child = join(dir, "child.ts");
    writeFileSync(
      child,
      `import { writeFileSync } from "node:fs";\n` +
        `const parentPid = Number(process.env.BORGO_PARENT_PID || 0);\n` +
        `writeFileSync(${JSON.stringify(join(dir, "out").replaceAll("\\", "/"))},\n` +
        `  JSON.stringify({ ppid: process.ppid, parentPid, direct: process.ppid === parentPid }));\n`,
      "utf8",
    );
    const proc = track(
      Bun.spawn([process.execPath, child], {
        stdout: "ignore",
        stderr: "ignore",
        env: { ...process.env, BORGO_PARENT_PID: String(process.pid) },
      }),
    );
    await withDeadline(proc.exited, 15_000, "the child never finished");
    const got = JSON.parse(readFileSync(join(dir, "out"), "utf8"));
    expect(got).toEqual({ ppid: process.pid, parentPid: process.pid, direct: true });
  }, 25_000);
});
