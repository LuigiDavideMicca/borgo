import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// react's cjs entry picks development or production AT REQUIRE TIME from
// NODE_ENV, and server.ts requires react at module load - so the default has
// to land before that module evaluates, in a process whose environment is the
// one under test. measured before the fix: production ssr ran the development
// react-dom (~1240 vs ~1690 req/s on the bench page, alternated arms).
const serverTs = fileURLToPath(new URL("../src/server.ts", import.meta.url));
// an app directory with react installed, for server.ts's appRequire
const appDir = join(import.meta.dir, "..", "..", "..", "examples", "tasks");

function nodeEnvAfterImport(env: Record<string, string | undefined>): string {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...env })) {
    if (v !== undefined) clean[k] = v;
  }
  delete clean.NODE_ENV;
  if (env.NODE_ENV !== undefined) clean.NODE_ENV = env.NODE_ENV;
  const proc = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `await import(${JSON.stringify(serverTs)}); console.log(process.env.NODE_ENV);`,
    ],
    { cwd: appDir, env: clean, stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) throw new Error(`import failed:\n${proc.stderr.toString()}`);
  return proc.stdout.toString().trim();
}

describe("the react build the server loads", () => {
  test("a bare environment defaults to production before react is required", () => {
    expect(nodeEnvAfterImport({ BORGO_DEV: undefined })).toBe("production");
  });

  test("the dev loop keeps development react and its warnings", () => {
    expect(nodeEnvAfterImport({ BORGO_DEV: "1" })).toBe("development");
  });

  test("an explicit NODE_ENV is the operator's word, not borgo's", () => {
    expect(nodeEnvAfterImport({ NODE_ENV: "staging", BORGO_DEV: undefined })).toBe("staging");
  });
});
