// THE AMBIENT-DECLARATION HAZARD.
//
// tsconfig.json includes ["src", "test"]. A .d.ts anywhere under those globs
// joins the program without being imported by anything, and its contents apply
// to every other file in it. A test fixture is exactly the kind of file that
// wants to contain `declare module "borgo-framework" { ... }` - and one that
// did retyped ApiRoutes for the whole suite, breaking 17 assertions in files
// that had never heard of it. The fix at the time was renaming the fixture to
// .d.ts.golden, which works and which nobody adding the next fixture will know
// about. tsconfig.json now excludes test/**/*.d.ts so the trap is not armed.
//
// This asserts the resulting *program*, not the text of the config: the
// question is which files tsc would load, and only the config parser answers
// that. Delete the "exclude" key and the first test here fails.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const CONFIG = join(import.meta.dir, "..", "tsconfig.json");

// the question is still put to the real config parser, but through the cli:
// typescript 7's native compiler no longer ships the readConfigFile /
// parseJsonConfigFileContent surface this file used to call, and
// `tsc --showConfig` answers with the resolved program - "files" included -
// on 5 and 7 alike. spawned via the running bun, never a .cmd shim
function programFiles(): string[] {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, "x", "tsc", "--showConfig", "-p", CONFIG],
    cwd: dirname(CONFIG),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`tsc --showConfig exited ${proc.exitCode}: ${proc.stderr.toString()}`);
  }
  const shown = JSON.parse(proc.stdout.toString()) as { files?: string[] };
  if (!Array.isArray(shown.files)) throw new Error("tsc --showConfig answered without a files list");
  return shown.files.map((f) => resolve(dirname(CONFIG), f));
}

const PROBE_DTS = join(import.meta.dir, "__ambient-probe.d.ts");
const PROBE_TS = join(import.meta.dir, "__ambient-probe.ts");

afterEach(() => {
  for (const path of [PROBE_DTS, PROBE_TS]) rmSync(path, { force: true });
});

describe("the test program", () => {
  test("does not load a .d.ts dropped under test/", () => {
    // the exact shape of the file that caused the incident
    writeFileSync(
      PROBE_DTS,
      'declare module "borgo-framework" {\n  export interface ApiRoutes {\n    "GET /api/probe": { response: number };\n  }\n}\n',
    );
    expect(existsSync(PROBE_DTS)).toBe(true);
    expect(programFiles()).not.toContain(resolve(PROBE_DTS));
  });

  test("still loads ordinary .ts files under test/, so the exclusion is not a blanket", () => {
    writeFileSync(PROBE_TS, "export const probe = 1;\n");
    expect(programFiles()).toContain(resolve(PROBE_TS));
  });

  test("still loads the declarations under src/, which are the ones that should apply", () => {
    const ambient = resolve(join(import.meta.dir, "..", "src", "ambient.d.ts"));
    expect(existsSync(ambient)).toBe(true);
    expect(programFiles()).toContain(ambient);
  });

  test("the committed golden fixture is still parked outside .d.ts", () => {
    // it predates the exclusion and is now belt and braces, but the golden
    // suite reads it by this exact name
    expect(existsSync(join(import.meta.dir, "golden", "api-types.d.ts.golden"))).toBe(true);
    expect(existsSync(join(import.meta.dir, "golden", "api-types.d.ts"))).toBe(false);
  });
});
