// F10: two asset builds writing public/assets at once rename each other's
// chunks, and the loser opens a name the winner already moved - "ENOENT open
// public/assets/[id]-hash.js", borgo dev answering 500. Measured with two
// real builds of an app with a pages/tasks/[id].tsx: five trials of six
// failed. The lock serialises them; these pin it.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withBuildLock } from "../src/build";

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
