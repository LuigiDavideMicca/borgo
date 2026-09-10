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

  // found hunting: `NODE_ENV=` (empty, one malformed .env line) made the
  // re-exec fire, the ?? defaulting kept the empty string, the child fired
  // again - a supervisor chain growing forever. the invariant is that one
  // re-exec always settles it, whatever the environment held
  test("one re-exec settles it: the child never re-execs, empty values included", () => {
    for (const env of [
      {},
      { NODE_ENV: "" },
      { BUN_CONFIG_MAX_HTTP_REQUESTS: "" },
      { NODE_ENV: "", BUN_CONFIG_MAX_HTTP_REQUESTS: "" },
      { NODE_ENV: "staging" },
      { BUN_CONFIG_MAX_HTTP_REQUESTS: "256" },
      // whitespace is nobody's deliberate mode: it settles like empty
      { NODE_ENV: " " },
      { NODE_ENV: "\t", BUN_CONFIG_MAX_HTTP_REQUESTS: "  " },
    ]) {
      expect(startNeedsReexec({ ...env, ...startEnv(env) })).toBe(false);
    }
    expect(startEnv({ NODE_ENV: "" }).NODE_ENV).toBe("production");
    expect(startEnv({ BUN_CONFIG_MAX_HTTP_REQUESTS: "" }).BUN_CONFIG_MAX_HTTP_REQUESTS).toBe("16384");
    // found hunting round 2: `NODE_ENV=" "` slipped past the || and reached
    // react as a non-production value on a production server
    expect(startNeedsReexec({ NODE_ENV: " ", BUN_CONFIG_MAX_HTTP_REQUESTS: "256" })).toBe(true);
    expect(startEnv({ NODE_ENV: " " }).NODE_ENV).toBe("production");
  });

  test("with both present nothing re-execs - the process shape stays flat", () => {
    expect(
      startNeedsReexec({ BUN_CONFIG_MAX_HTTP_REQUESTS: "16384", NODE_ENV: "production" }),
    ).toBe(false);
    expect(startNeedsReexec({ BUN_CONFIG_MAX_HTTP_REQUESTS: "16384" })).toBe(true);
    expect(startNeedsReexec({ NODE_ENV: "production" })).toBe(true);
  });
});

// the whole launch matrix, pinned: one configuration once produced a page
// compiled for jsxDEV meeting the production react-dom (the mid-module
// default, since reverted) and the mechanism was never reproducible in
// isolation - so the guarantee is measured per mode instead: the server
// boots, a page renders, the jsx-dev runtime is never pulled in, and the
// react build matches the mode
describe("the launch matrix is coherent in every mode", () => {
  const serverTs = fileURLToPath(new URL("../src/server.ts", import.meta.url));
  const appDir = join(import.meta.dir, "..", "..", "..", "examples", "tasks");

  const boot = (nodeEnv: string | undefined, port: number) => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    delete env.NODE_ENV;
    if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
    env.PORT = String(port);
    env.BUN_CONFIG_MAX_HTTP_REQUESTS = "16384";
    // /about has no loader, so the go api is not needed for the render
    const script = `
      const { serve } = await import(${JSON.stringify(serverTs)});
      await serve({ dev: false });
      const res = await fetch("http://localhost:" + process.env.PORT + "/about");
      const body = await res.text();
      const jsxDev = Object.keys(require.cache).some((k) => k.includes("jsx-dev-runtime"));
      const prodDom = Object.keys(require.cache).some((k) => k.includes("react-dom-server.bun.production"));
      console.log(JSON.stringify({ status: res.status, about: body.includes("<h1>About</h1>"), jsxDev, prodDom }));
      process.exit(0);
    `;
    const proc = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: appDir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) throw new Error(`boot failed:\n${proc.stderr.toString()}`);
    const line = proc.stdout.toString().trim().split("\n").at(-1)!;
    return JSON.parse(line) as { status: number; about: boolean; jsxDev: boolean; prodDom: boolean };
  };

  test("unset, production and development all render, and jsxDEV never loads", () => {
    const unset = boot(undefined, 3971);
    expect(unset).toEqual({ status: 200, about: true, jsxDev: false, prodDom: false });
    const prod = boot("production", 3972);
    expect(prod).toEqual({ status: 200, about: true, jsxDev: false, prodDom: true });
    const dev = boot("development", 3973);
    expect(dev).toEqual({ status: 200, about: true, jsxDev: false, prodDom: false });
  }, 60_000);
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
