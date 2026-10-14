// F10: two asset builds writing public/assets at once rename each other's
// chunks, and the loser opens a name the winner already moved - "ENOENT open
// public/assets/[id]-hash.js", borgo dev answering 500. Measured with two
// real builds of an app with a pages/tasks/[id].tsx: five trials of six
// failed. The lock serialises them; these pin it.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { takeOverStale, withBuildLock } from "../src/build";
import { selfStart, startedAfter } from "../src/parent-watch";

const APP_HOST = join(import.meta.dir, "../../../examples/tasks");

describe("withBuildLock", () => {
  test("two builds in one process run one after the other", async () => {
    const lock = join(mkdtempSync(join(tmpdir(), "borgo-lock-")), "build.lock");
    const events: string[] = [];
    const build = (name: string) =>
      withBuildLock(async () => {
        events.push(`${name} start`);
        await Bun.sleep(80);
        events.push(`${name} end`);
      }, lock);
    await Promise.all([build("a"), build("b")]);
    // whichever went first, it finished before the other started
    expect([events[0].split(" ")[1], events[1].split(" ")[1]]).toEqual(["start", "end"]);
    expect(events[0].split(" ")[0]).toBe(events[1].split(" ")[0]);
    expect(existsSync(lock)).toBe(false);
  });

  test("the lock is released when the build throws", async () => {
    const lock = join(mkdtempSync(join(tmpdir(), "borgo-lock-")), "build.lock");
    await expect(withBuildLock(async () => Promise.reject(new Error("bundle failed")), lock)).rejects.toThrow("bundle failed");
    expect(existsSync(lock)).toBe(false);
    // and the next build is not held by the failed one
    expect(await withBuildLock(async () => "next", lock, 1_000)).toBe("next");
  });

  // dev kills the render service mid-build on every restart: the next boot
  // must take the directory at once, not wait five minutes on a corpse
  test("a lock whose holder is gone is taken over immediately", async () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-lock-"));
    const lock = join(dir, "build.lock");
    const dead = Bun.spawn([process.execPath, "-e", ""]);
    await dead.exited;
    writeFileSync(lock, JSON.stringify({ pid: dead.pid, token: "the dead one", startedAt: Date.now() }));
    const started = Date.now();
    expect(await withBuildLock(async () => "took it", lock, 2_000)).toBe("took it");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  // a build killed hard leaves its lock, and windows hands its pid to the
  // next process: a live pid that started otherwise is not the holder
  test("a lock whose pid now belongs to another process is taken over", async () => {
    const lock = join(mkdtempSync(join(tmpdir(), "borgo-lock-")), "build.lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "a killed build", start: { clock: "ms", value: 1 } }));
    // this process is alive; the lock says its holder started in 1970
    const started = Date.now();
    expect(await withBuildLock(async () => "took it", lock, 2_000, () => ({ clock: "ms", value: Date.now() }))).toBe("took it");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  // asked about the holder the lock names, and once: on windows the answer
  // is a powershell spawn, and a waiter polls every 50 ms (found by the
  // verifier)
  test("the holder's start is asked about its own pid, once per lock", async () => {
    const holder = Bun.spawn([process.execPath, "-e", "await Bun.sleep(10000)"]);
    try {
      const lock = join(mkdtempSync(join(tmpdir(), "borgo-lock-")), "build.lock");
      writeFileSync(lock, JSON.stringify({ pid: holder.pid, token: "a live build", start: { clock: "ms", value: 1 } }));
      const asked: number[] = [];
      await expect(
        withBuildLock(async () => "jumped the queue", lock, 400, (pid) => (asked.push(pid), { clock: "ms", value: 1 })),
      ).rejects.toThrow("another asset build");
      expect(asked).toEqual([holder.pid]);
    } finally {
      holder.kill();
    }
  });

  // a waiter killed inside the takeover leaves its guard: it must not hold
  // every later build off the stale lock forever
  // between judging a lock stale and taking the guard, another waiter may
  // have replaced it with a live one: only the text judged is removed
  test("a takeover removes the lock it judged, never one made since", () => {
    const lock = join(mkdtempSync(join(tmpdir(), "borgo-lock-")), "build.lock");
    const fresh = JSON.stringify({ pid: process.pid, token: "made a moment ago" });
    writeFileSync(lock, fresh);
    takeOverStale(lock, JSON.stringify({ pid: 999_999, token: "dead" }));
    expect(readFileSync(lock, "utf8")).toBe(fresh);
    takeOverStale(lock, fresh);
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(`${lock}.takeover`)).toBe(false);
  });

  test("a takeover guard left by a dead waiter is cleared", async () => {
    const lock = join(mkdtempSync(join(tmpdir(), "borgo-lock-")), "build.lock");
    writeFileSync(lock, JSON.stringify({ pid: 999_999, token: "dead" }));
    writeFileSync(`${lock}.takeover`, "999998");
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${lock}.takeover`, old, old);
    expect(await withBuildLock(async () => "took it", lock, 2_000)).toBe("took it");
    expect(existsSync(`${lock}.takeover`)).toBe(false);
  });

  test("every build asks with the real reader", () => {
    const src = readFileSync(join(import.meta.dir, "../src/build.ts"), "utf8");
    expect(src).toContain("startOf: (pid: number) => StartToken | null = processStart,");
    expect(src).toContain("return withBuildLock(() => buildAssetsUnlocked(dev));");
  });

  // six processes woken at once against a lock a dead build left: each
  // judged it stale, and the slower deleted the lock the faster had just
  // made - two builds inside, 9 trials in 10 on linux (found by hunt 3)
  test("waiters taking over one stale lock let one build in at a time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-lockrace-"));
    const worker = join(dir, "worker.ts");
    writeFileSync(
      worker,
      [
        'import { appendFileSync } from "node:fs";',
        `import { withBuildLock } from ${JSON.stringify(join(import.meta.dir, "../src/build.ts"))};`,
        "const [lock, log, at] = process.argv.slice(2);",
        "while (Date.now() < Number(at)) await Bun.sleep(1);",
        "await withBuildLock(async () => {",
        "  appendFileSync(log, 'enter ' + performance.now() + String.fromCharCode(10));",
        "  await Bun.sleep(300);",
        "  appendFileSync(log, 'leave' + String.fromCharCode(10));",
        "}, lock, 20_000);",
      ].join(String.fromCharCode(10)),
    );
    let worst = 0;
    for (let trial = 0; trial < 3; trial++) {
      const lock = join(dir, `build-${trial}.lock`);
      const log = join(dir, `log-${trial}.txt`);
      writeFileSync(lock, JSON.stringify({ pid: 999_999, token: "dead" }));
      writeFileSync(log, "");
      const at = String(Date.now() + 1_000);
      const procs = Array.from({ length: 6 }, () => Bun.spawn([process.execPath, worker, lock, log, at], { stdout: "ignore", stderr: "inherit" }));
      await Promise.all(procs.map((p) => p.exited));
      // appended in order: a second enter before a leave is two inside
      let inside = 0;
      for (const line of readFileSync(log, "utf8").trim().split(String.fromCharCode(10))) {
        inside += line.startsWith("enter") ? 1 : -1;
        worst = Math.max(worst, inside);
      }
    }
    rmSync(dir, { recursive: true, force: true });
    expect(worst).toBe(1);
  }, 60_000);

  test("a build records its own start in the lock", async () => {
    const lock = join(mkdtempSync(join(tmpdir(), "borgo-lock-")), "build.lock");
    const recorded = await withBuildLock(async () => JSON.parse(readFileSync(lock, "utf8")).start, lock);
    expect(recorded).toEqual(expect.objectContaining({ clock: selfStart().clock }));
    expect(startedAfter(selfStart(), recorded)).toBe(false);
  });

  test("a live holder that started when the lock says is waited for", async () => {
    const lock = join(mkdtempSync(join(tmpdir(), "borgo-lock-")), "build.lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "a running build", start: { clock: "ms", value: 1 } }));
    await expect(withBuildLock(async () => "jumped the queue", lock, 300, () => ({ clock: "ms", value: 1 }))).rejects.toThrow("another asset build");
  });

  // the holder's token decides: a build must not delete a lock it does not own
  test("a build removes only the lock it made", async () => {
    const lock = join(mkdtempSync(join(tmpdir(), "borgo-lock-")), "build.lock");
    await withBuildLock(async () => {
      // somebody replaced it while this build ran - a stale takeover elsewhere
      writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "somebody else", startedAt: Date.now() }));
    }, lock);
    expect(JSON.parse(readFileSync(lock, "utf8")).token).toBe("somebody else");
  });
});

// the race itself, the way it happened: two processes building one app with
// an [id] page into one public/assets
describe("two real asset builds in one directory", () => {
  test.skipIf(!existsSync(join(APP_HOST, "node_modules/react")))(
    "both succeed, trial after trial",
    async () => {
      const dir = mkdtempSync(join(APP_HOST, "borgo-build-race-"));
      try {
        mkdirSync(join(dir, "pages/tasks"), { recursive: true });
        writeFileSync(join(dir, "style.scss"), "body { color: rebeccapurple; }\n");
        writeFileSync(join(dir, "pages/index.tsx"), "export default () => <h1>index</h1>;\n");
        writeFileSync(join(dir, "pages/tasks/[id].tsx"), "export default () => <h1>task</h1>;\n");
        const child = join(dir, "build-once.ts");
        writeFileSync(
          child,
          `process.chdir(${JSON.stringify(dir)});\n` +
            `const { buildAssets } = await import(${JSON.stringify(join(import.meta.dir, "../src/build.ts"))});\n` +
            `try { await buildAssets(true); console.log("VERDICT ok"); }\n` +
            `catch (e) { console.log("VERDICT " + String(e?.message ?? e).split("\\n")[0]); }\n`,
        );
        for (let trial = 1; trial <= 3; trial++) {
          const run = () => Bun.spawn([process.execPath, child], { stdout: "pipe", stderr: "pipe" });
          const [a, b] = [run(), run()];
          const verdicts = await Promise.all(
            [a, b].map(async (p) => {
              const out = await new Response(p.stdout).text();
              await p.exited;
              return out.split("\n").find((l) => l.startsWith("VERDICT"))?.slice(8) ?? "no verdict";
            }),
          );
          expect(`trial ${trial}: ${verdicts.join(" | ")}`).toBe(`trial ${trial}: ok | ok`);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
