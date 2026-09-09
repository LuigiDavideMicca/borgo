import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { startEnv, startNeedsReexec } from "../src/util";

// react's cjs entry picks development or production from NODE_ENV at require
// time, and bun can pin a page's jsx transform before any module code runs -
// so the default has to ride the LAUNCH environment, via the re-exec in
// cli.ts. a mid-module `process.env.NODE_ENV ||= ...` was tried and produced
// a render crash on a real app: a jsxDEV-compiled layout meeting the
// production react-dom (`dispatcher.getOwner is not a function`). measured
// stakes: the bench ssr page at ~1240 req/s under development react against
// ~1690 under production, alternated arms.
describe("what `borgo start` guarantees its launch environment", () => {
  test("a bare environment re-execs, and the re-exec carries both defaults", () => {
    expect(startNeedsReexec({})).toBe(true);
    expect(startEnv({})).toEqual({
      BUN_CONFIG_MAX_HTTP_REQUESTS: "16384",
      NODE_ENV: "production",
    });
  });

  test("an explicit NODE_ENV is the operator's word, not borgo's", () => {
    expect(startEnv({ NODE_ENV: "staging" }).NODE_ENV).toBe("staging");
    expect(startEnv({ BUN_CONFIG_MAX_HTTP_REQUESTS: "256" }).BUN_CONFIG_MAX_HTTP_REQUESTS).toBe("256");
  });

  test("with both present nothing re-execs - the process shape stays flat", () => {
    expect(
      startNeedsReexec({ BUN_CONFIG_MAX_HTTP_REQUESTS: "16384", NODE_ENV: "production" }),
    ).toBe(false);
    expect(startNeedsReexec({ BUN_CONFIG_MAX_HTTP_REQUESTS: "16384" })).toBe(true);
    expect(startNeedsReexec({ NODE_ENV: "production" })).toBe(true);
  });
});

// the counterpart guarantee: importing the server module must NOT assign
// NODE_ENV - a module-time default is exactly the mismatch above, and an
// embedder with a bare environment gets development react everywhere, which
// is slow and coherent rather than fast and broken
describe("what importing the server does not do", () => {
  test("server.ts leaves an unset NODE_ENV unset", () => {
    const serverTs = fileURLToPath(new URL("../src/server.ts", import.meta.url));
    const appDir = join(import.meta.dir, "..", "..", "..", "examples", "tasks");
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) clean[k] = v;
    delete clean.NODE_ENV;
    const proc = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `await import(${JSON.stringify(serverTs)}); console.log(String(process.env.NODE_ENV));`,
      ],
      { cwd: appDir, env: clean, stdout: "pipe", stderr: "pipe" },
    );
    if (proc.exitCode !== 0) throw new Error(`import failed:\n${proc.stderr.toString()}`);
    expect(proc.stdout.toString().trim()).toBe("undefined");
  });
});
