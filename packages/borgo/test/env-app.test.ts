import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appEnvMetas, clientEnvDefine, clientEnvRefusal, envRefusal } from "../src/env-app";
import type { EnvMeta as EnvMetaShape } from "../src/env";

const appWith = (envTs?: string) => {
  const dir = mkdtempSync(join(tmpdir(), "borgo-env-"));
  if (envTs !== undefined) writeFileSync(join(dir, "env.ts"), envTs);
  return dir;
};

// the temp app cannot resolve "borgo-framework", so its env.ts imports the
// source by absolute url - same defineEnv, same object shape
const defineImport = `import { defineEnv } from ${JSON.stringify(
  new URL("../src/env.ts", import.meta.url).href,
)};`;

describe("appEnvMetas", () => {
  test("no env.ts means no schema, not an error", async () => {
    expect(await appEnvMetas(appWith())).toEqual({ metas: [], envExports: [], otherExports: [] });
  });

  test("every exported borgo env is found, other exports are named apart", async () => {
    const dir = appWith(`${defineImport}
export const env = defineEnv({ server: { A: { default: "x" } } }, {});
export const other = defineEnv({ server: { B: {} } }, {});
export const notEnv = 42;
export function alsoNot() {}
`);
    const app = await appEnvMetas(dir);
    expect(app.metas).toHaveLength(2);
    expect(app.metas.flatMap((m) => m.failures)).toEqual(["B: missing (expected a string)"]);
    expect(app.envExports.toSorted()).toEqual(["env", "other"]);
    expect(app.otherExports.toSorted()).toEqual(["alsoNot", "notEnv"]);
  });

  // export const env + export default env is ONE schema: counted twice it
  // double-reported every failure and false-refused the build as two schemas
  test("the same proxy exported twice is one schema with two export names", async () => {
    const dir = appWith(`${defineImport}
export const env = defineEnv({ server: { A: {} } }, {});
export default env;
`);
    const app = await appEnvMetas(dir);
    expect(app.metas).toHaveLength(1);
    expect(app.metas[0].failures).toHaveLength(1);
    expect(app.envExports.toSorted()).toEqual(["default", "env"]);
  });

  // the event that never happens: an env.ts whose import never completes
  // froze build, rebuilds and boot forever - spawnSync stops the event loop
  test(
    "an env.ts that never finishes importing is refused by name, not waited on forever",
    async () => {
      const dir = appWith(`${defineImport}
await new Promise(() => {});
export const env = defineEnv({}, {});
`);
      await expect(appEnvMetas(dir)).rejects.toThrow("did not finish importing");
    },
    20_000,
  );

  test("an edited env.ts is read as it is, not as it was - the cache is busted", async () => {
    const dir = appWith(`${defineImport}
export const env = defineEnv({ server: { A: {} } }, {});
`);
    expect((await appEnvMetas(dir)).metas.flatMap((m) => m.failures)).toHaveLength(1);
    // rewritten healthy: a second read must see the new file
    writeFileSync(
      join(dir, "env.ts"),
      `${defineImport}
export const env = defineEnv({ server: { A: { default: "x" } } }, {});
`,
    );
    expect((await appEnvMetas(dir)).metas.flatMap((m) => m.failures)).toHaveLength(0);
  });

  // found adversarially: the schema used to travel on stdout, and one
  // console.log in env.ts - the most natural debugging gesture - broke boot
  // and build with a bare JSON SyntaxError that never named env.ts
  test("a console.log in env.ts is forwarded, and the schema still arrives", async () => {
    const dir = appWith(`${defineImport}
console.log("debug: loading env schema");
process.stdout.write("partial ");
export const env = defineEnv({ server: { A: { default: "x" } } }, {});
`);
    const { metas } = await appEnvMetas(dir);
    expect(metas).toHaveLength(1);
    expect(metas[0].failures).toEqual([]);
  });

  test("an env.ts that exits at import time is named, not parsed", async () => {
    const dir = appWith(`${defineImport}
process.exit(0);
`);
    await expect(appEnvMetas(dir)).rejects.toThrow("schema never came back");
  });

  // the memo hashes env.ts alone; fresh is how a dev rebuild sees edits to
  // the files env.ts imports
  test("fresh bypasses the memo when env.ts itself did not change", async () => {
    const dir = appWith(`${defineImport}
import { min } from "./rules.ts";
export const env = defineEnv({ server: { K: { validate: (raw) => { if (raw.length < min) throw new Error("too short"); return raw; } } } }, { K: "abc" });
`);
    const { writeFileSync: write } = await import("node:fs");
    const { join: j } = await import("node:path");
    write(j(dir, "rules.ts"), "export const min = 1;");
    expect((await appEnvMetas(dir)).metas.flatMap((m) => m.failures)).toHaveLength(0);
    write(j(dir, "rules.ts"), "export const min = 100;");
    // the memo answers stale by design; fresh reads the world as it is
    expect((await appEnvMetas(dir)).metas.flatMap((m) => m.failures)).toHaveLength(0);
    expect((await appEnvMetas(dir, { fresh: true })).metas.flatMap((m) => m.failures)).toHaveLength(1);
  });

  test("a schema mistake in env.ts throws as itself", async () => {
    const dir = appWith(`${defineImport}
export const env = defineEnv({ client: { NOT_PREFIXED: {} } }, {});
`);
    await expect(appEnvMetas(dir)).rejects.toThrow("BORGO_PUBLIC_");
  });
});

describe("the two refusals", () => {
  test("envRefusal names every failure at once, and stays quiet when healthy", () => {
    expect(envRefusal([])).toBeNull();
    expect(
      envRefusal([
        { failures: ["A: missing"], clientFailures: [], clientNames: [], clientValues: {} },
        { failures: ["B: bad"], clientFailures: [], clientNames: [], clientValues: {} },
      ]),
    ).toContain("2 variables");
  });

  test("clientEnvRefusal fires only on client failures - the build does not own server secrets", () => {
    const serverBroken = [
      { failures: ["SECRET: missing"], clientFailures: [], clientNames: [], clientValues: {} },
    ];
    expect(clientEnvRefusal(serverBroken)).toBeNull();
    const clientBroken = [
      {
        failures: ["BORGO_PUBLIC_X: missing"],
        clientFailures: ["BORGO_PUBLIC_X: missing"],
        clientNames: ["BORGO_PUBLIC_X"],
        clientValues: {},
      },
    ];
    expect(clientEnvRefusal(clientBroken)).toContain("BORGO_PUBLIC_X");
  });
});

describe("the define the build ships", () => {
  test("one object, defined even with no schema - the wall holds before the first variable exists", () => {
    expect(clientEnvDefine([])).toEqual({ __BORGO_CLIENT_ENV__: "{}" });
  });

  // found adversarially: two exported schemas declaring one client variable
  // resolved by export order, the last one winning in silence
  test("one client variable in two exported schemas refuses the build by name", () => {
    const meta = (value: string): EnvMetaShape => ({
      failures: [],
      clientFailures: [],
      clientNames: ["BORGO_PUBLIC_NAME"],
      clientValues: { BORGO_PUBLIC_NAME: value },
    });
    expect(() => clientEnvDefine([meta("first"), meta("second")])).toThrow(
      "one variable, one source of truth",
    );
  });

  test("client values ride as json, undefined optionals drop out", () => {
    const define = clientEnvDefine([
      {
        failures: [],
        clientFailures: [],
        clientNames: ["BORGO_PUBLIC_A", "BORGO_PUBLIC_B"],
        clientValues: { BORGO_PUBLIC_A: "x", BORGO_PUBLIC_B: undefined },
      },
    ]);
    expect(JSON.parse(define.__BORGO_CLIENT_ENV__)).toEqual({ BORGO_PUBLIC_A: "x" });
  });
});

describe("the client shim", () => {
  // the client bundle replaces env.ts with this: same export names, zero
  // schema - server defaults, validators and names were measured shipping
  // verbatim in a served asset when the module bundled as written
  test("re-exports every env name, default included, and carries no schema", async () => {
    const { envClientShim } = await import("../src/env-app");
    const shim = envClientShim({ metas: [], envExports: ["env", "default"], otherExports: [] });
    expect(shim).toContain('from "borgo-framework"');
    expect(shim).toContain("export const env = $borgoEnv;");
    expect(shim).toContain("export default $borgoEnv;");
    expect(shim).not.toContain("defineEnv");
    expect(shim).not.toContain("server");
    // and it parses: `export const env = env` was this generator's own
    // first bug, caught by asking the transpiler instead of the eye
    expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(shim)).not.toThrow();
  });
});
