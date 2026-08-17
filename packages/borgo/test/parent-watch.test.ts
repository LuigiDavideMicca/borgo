// THE FRONT SERVER'S WATCH ON THE SESSION THAT STARTED IT, WRONG IN BOTH
// DIRECTIONS AT ONCE.
//
// serve-entry watched its dev session with `try { process.kill(pid, 0) } catch
// { exit(0) }`. That one line answers two opposite questions wrongly:
//
//   A corpse reads as ALIVE. A process that has exited but whose status nobody
//   collected keeps its pid and keeps accepting signals - kill(pid, 0) succeeds
//   on it. Measured on wsl2 with a real fork: state Z in /proc/<pid>/stat,
//   kill 0 = OK, for as long as nobody reaps it. The front server then outlives
//   the session that spawned it and holds the port forever, which is the orphan
//   the watch exists to prevent.
//
//   A live parent out of reach reads as DEAD. Measured with bun 1.3.14 on
//   windows: process.kill(4, 0) - the System process, alive and unopenable -
//   throws EPERM, and that bare `catch` cannot tell EPERM from ESRCH. The watch
//   then shuts the user's front server down in the middle of a session under a
//   perfectly healthy supervisor. watchdog_windows.go names this exact case
//   ("a supervisor running at a different elevation or as another user, or an
//   EDR hooking the call") and answers ALIVE to it; watchdog_unix.go answers
//   ALIVE to EPERM too. This file answered DEAD.
//
// The /proc fixtures below are transcribed from real processes on wsl2, not
// invented: a live one and a corpse, each also in the shape that defeats a
// naive parser - comm is field 2, in parentheses and UNESCAPED, so a process
// whose name is literally "my prog (x)" (set with prctl(PR_SET_NAME)) puts a
// ")" inside the field that the state character follows.
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

// server.ts requires react through `createRequire(process.cwd()/package.json)`
// at module scope, so serve-entry only imports from a directory that resolves
// it. Restored immediately: the cwd is process-wide and other test files read
// it. That this import does NOT boot a server is itself under test below.
const cwd = process.cwd();
const PKG_DIR = join(import.meta.dir, "..");
process.chdir(PKG_DIR);
const { isCorpse, parentGone, readParent } = await import("../src/serve-entry");
process.chdir(cwd);

type Reading = ReturnType<typeof readParent>;

const ENTRY = join(PKG_DIR, "src", "serve-entry.ts");

// real /proc/<pid>/stat lines, captured on wsl2
const LIVE = "7551 (python3) R 7547 7551 7551 34821 7551 4194560 1919 591 7 0 2 1 0 0 20 0 1 0 142863 20598784";
const CORPSE = "7553 (python3) Z 7551 7551 7551 34821 7551 4227148 94 0 0 0 0 0 0 0 20 0 1 0 142958 0 0";
const LIVE_UNESCAPED = "7692 (my prog (x)) S 7683 7683 7683 34821 7683 4194368 204 0 0 0 0 0 0 0 20 0 1 0 146738";
const CORPSE_UNESCAPED = "7692 (my prog (x)) Z 7683 7683 7683 34821 7683 4228172 204 0 0 0 0 0 0 0 20 0 1 0 146738";

const reading = (over: Partial<Reading> = {}): Reading => ({
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

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  if (!port) throw new Error("could not take a port to hand the front server");
  return port;
}

// every child this file starts is registered here, killed at the end, and then
// VERIFIED gone - a suite that leaves processes behind is the defect it tests
const started: Array<{ pid: number; proc: Bun.Subprocess }> = [];

function track<T extends Bun.Subprocess>(proc: T): T {
  started.push({ pid: proc.pid, proc });
  return proc;
}

afterAll(async () => {
  for (const { proc } of started) {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill();
  }
  await withDeadline(
    Promise.all(started.map(({ proc }) => proc.exited)),
    10_000,
    "children did not exit after kill",
  );
  const alive = started.filter(({ pid }) => !parentGone(pid, readParent(pid, false)));
  if (alive.length) throw new Error(`left ${alive.length} live processes behind: ${alive.map((a) => a.pid).join(",")}`);
});

describe("isCorpse: the state field, past a comm nobody escaped", () => {
  test("a real uncollected corpse is a corpse", () => {
    expect(isCorpse(CORPSE)).toBe(true);
  });

  test("a real running process is not - so the assertion above discriminates", () => {
    expect(isCorpse(LIVE)).toBe(false);
  });

  // the parser trap, built rather than imagined: splitting on whitespace, or on
  // the FIRST ")", lands on "x" here and reads a running process as torn down
  test('a process named "my prog (x)" does not fake a corpse while it runs', () => {
    expect(isCorpse(LIVE_UNESCAPED)).toBe(false);
  });

  test('the same process, once it IS a corpse, is still read as one', () => {
    expect(isCorpse(CORPSE_UNESCAPED)).toBe(true);
  });

  // a "does the line contain Z" reading passes every test above and fails here
  test("a Z inside the comm is not the state", () => {
    expect(isCorpse("42 (Zed) R 1 1 1 0 -1 4194304 100 0 0")).toBe(false);
    expect(isCorpse("42 (Z) S 1 1 1 0 -1 4194304 100 0 0")).toBe(false);
  });

  test("X and x, the moment after Z, count too", () => {
    expect(isCorpse("42 (sh) X 1 1 1 0 -1 0 0 0 0")).toBe(true);
    expect(isCorpse("42 (sh) x 1 1 1 0 -1 0 0 0 0")).toBe(true);
  });

  // off linux there is no /proc to read, and the answer must degrade to what
  // this file did before rather than to something worse
  test("no /proc, no answer: null and unparseable read as NOT a corpse", () => {
    expect(isCorpse(null)).toBe(false);
    expect(isCorpse("")).toBe(false);
    expect(isCorpse("42 no parens here Z")).toBe(false);
    expect(isCorpse("42 (sh)")).toBe(false);
  });
});

describe("parentGone: the two directions, decided one by one", () => {
  // DIRECTION A - the defect this fix is about
  test("a corpse the signal accepted is GONE, not alive", () => {
    expect(parentGone(7553, reading({ killError: null, stat: CORPSE }))).toBe(true);
  });

  // DIRECTION B - the opposite defect, and the one that costs a user their work
  test("EPERM is a LIVE parent out of reach, never a dead one", () => {
    expect(parentGone(4, reading({ killError: "EPERM" }))).toBe(false);
  });

  // the go side puts EPERM through /proc on purpose: a corpse keeps the
  // credentials that refused the signal, and /proc is readable regardless
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
});

describe("parentGone: the direct-child branch, which is the shape borgo dev has", () => {
  // measured on linux: a grandchild's getppid had ALREADY changed while its
  // parent still read as Z and still accepted signals. Reparenting happens at
  // the parent's exit, not at its reap - so this branch answers where the
  // probe cannot, and on macos and the bsds it is the ONLY thing that does,
  // there being no /proc to fall back to
  test("a reparented child knows its parent left, even with the probe saying alive", () => {
    expect(parentGone(7683, reading({ direct: true, ppid: 1, killError: null, stat: LIVE }))).toBe(true);
  });

  test("and it is not fooled by a recycled pid the probe would accept", () => {
    expect(parentGone(7683, reading({ direct: true, ppid: 1, killError: null, stat: null }))).toBe(true);
  });

  test("an unchanged ppid keeps the session alive", () => {
    expect(parentGone(7683, reading({ direct: true, ppid: 7683, killError: null, stat: LIVE }))).toBe(false);
  });

  // ppid means nothing about a pid that was never this process's parent, and
  // reading it as an exit would kill the server the moment it starts
  test("a ppid that differs is NOT an exit when the watched pid is not the parent", () => {
    expect(parentGone(7683, reading({ direct: false, ppid: 1, killError: null, stat: LIVE }))).toBe(false);
  });
});

describe("readParent, against processes that really exist", () => {
  test("a child that has exited and been reaped reads as gone", async () => {
    const proc = track(Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" }));
    const pid = proc.pid;
    await withDeadline(proc.exited, 10_000, "the short-lived child never exited");
    const r = readParent(pid, false);
    expect(parentGone(pid, r)).toBe(true);
    // and the reason is a probe that said so, not an empty reading
    expect(r.killError === null ? isCorpse(r.stat) : true).toBe(true);
  });

  test("this process is alive about itself", () => {
    const r = readParent(process.pid, false);
    expect(r.killError).toBe(null);
    expect(parentGone(process.pid, r)).toBe(false);
  });

  test("a live child is alive, and its ppid is this process", async () => {
    const proc = track(
      Bun.spawn([process.execPath, "-e", "await Bun.sleep(30_000)"], { stdout: "ignore", stderr: "ignore" }),
    );
    await Bun.sleep(300);
    expect(parentGone(proc.pid, readParent(proc.pid, false))).toBe(false);
    proc.kill();
    await withDeadline(proc.exited, 10_000, "the long-lived child never exited after kill");
  });

  // the EPERM direction, on a process that really is alive and really is out of
  // reach. Both branches assert: the invariant is that a live system process is
  // NEVER read as gone, whatever the probe was allowed to see.
  test("a process this one may not signal is never read as dead", () => {
    // pid 4 is the windows System process; pid 1 is init, EPERM for any
    // unprivileged posix process and openable only for root
    const unreachable = process.platform === "win32" ? 4 : 1;
    const r = readParent(unreachable, false);
    expect(["EPERM", null]).toContain(r.killError);
    if (process.platform === "win32") {
      // measured with bun 1.3.14: this is EPERM, and the old catch read it as death
      expect(r.killError).toBe("EPERM");
    }
    if (process.platform === "linux") {
      // a refused signal must NOT skip /proc: a corpse keeps the credentials
      // that refused it, and /proc/<pid>/stat is readable regardless of them
      expect(r.stat).toContain(`${unreachable} (`);
      expect(isCorpse(r.stat)).toBe(false);
    }
    expect(parentGone(unreachable, r)).toBe(false);
  });

  test("the /proc read is attempted where it exists and degrades to null where it does not", () => {
    const r = readParent(process.pid, false);
    if (process.platform === "linux") {
      expect(r.stat).toContain(`${process.pid} (`);
      expect(isCorpse(r.stat)).toBe(false);
    } else {
      expect(r.stat).toBe(null);
    }
  });

  test("a pid that never existed is gone, and the /proc read is not even tried", () => {
    const r = readParent(0x7ff_ffff, false);
    expect(r.killError).not.toBe(null);
    expect(r.stat).toBe(null);
    expect(parentGone(0x7ff_ffff, r)).toBe(true);
  });
});

// The watch only matters as the whole entry point behaves, spawned the way
// dev.ts spawns it: `bun <serve-entry.ts>` with BORGO_PARENT_PID in the
// environment. serve() fails here (no pages/ directory), which is the dev path
// that BINDS THE FALLBACK PORT and keeps running - exactly the process that
// must not be left holding it.
describe("serve-entry as a process, spawned the way dev.ts spawns it", () => {
  test("it exits by itself when the pid it was given is already dead", async () => {
    const corpse = track(Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" }));
    const deadPid = corpse.pid;
    await withDeadline(corpse.exited, 10_000, "the child that should die did not");

    const proc = track(
      Bun.spawn([process.execPath, ENTRY], {
        cwd: PKG_DIR,
        stdout: "ignore",
        stderr: "ignore",
        env: { ...process.env, BORGO_DEV: "1", PORT: String(freePort()), BORGO_PARENT_PID: String(deadPid) },
      }),
    );
    const code = await withDeadline(proc.exited, 15_000, "the front server never noticed its parent was gone");
    expect(code).toBe(0);
  }, 20_000);

  test("it keeps serving under a parent that is alive", async () => {
    const proc = track(
      Bun.spawn([process.execPath, ENTRY], {
        cwd: PKG_DIR,
        stdout: "ignore",
        stderr: "ignore",
        env: { ...process.env, BORGO_DEV: "1", PORT: String(freePort()), BORGO_PARENT_PID: String(process.pid) },
      }),
    );
    let exited: number | null = null;
    void proc.exited.then((c) => (exited = c));
    await Bun.sleep(5_500);
    expect(exited).toBe(null);
    proc.kill();
    await withDeadline(proc.exited, 10_000, "the front server never exited after kill");
  }, 20_000);

  // the readings above are importable only because the boot sits behind
  // import.meta.main. Without it this import binds a port and never returns,
  // and the whole file - this test included - hangs instead of failing.
  test("importing the module does not boot a server", async () => {
    const proc = track(
      Bun.spawn(
        [
          process.execPath,
          "-e",
          `const m = await import(${JSON.stringify(Bun.pathToFileURL(ENTRY).href)});
           console.log("IMPORTED:" + typeof m.parentGone + ":" + typeof m.isCorpse);`,
        ],
        {
          cwd: PKG_DIR,
          stdout: "pipe",
          stderr: "ignore",
          env: { ...process.env, BORGO_DEV: "1", PORT: String(freePort()) },
        },
      ),
    );
    const out = await withDeadline(
      new Response(proc.stdout as ReadableStream).text(),
      15_000,
      "the import never returned - the boot is not behind import.meta.main",
    );
    const code = await withDeadline(proc.exited, 5_000, "the importing process never exited");
    expect(out).toContain("IMPORTED:function:function");
    expect(code).toBe(0);
  }, 20_000);
});
