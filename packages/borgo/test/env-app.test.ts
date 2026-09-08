import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appEnvMetas, clientEnvDefine, clientEnvRefusal, envRefusal } from "../src/env-app";

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
    expect(await appEnvMetas(appWith())).toEqual([]);
  });

  test("every exported borgo env is found, other exports are ignored", async () => {
    const dir = appWith(`${defineImport}
export const env = defineEnv({ server: { A: { default: "x" } } }, {});
export const other = defineEnv({ server: { B: {} } }, {});
export const notEnv = 42;
export function alsoNot() {}
`);
    const metas = await appEnvMetas(dir);
    expect(metas).toHaveLength(2);
    expect(metas.flatMap((m) => m.failures)).toEqual(["B: missing (expected a string)"]);
  });

  test("an edited env.ts is read as it is, not as it was - the cache is busted", async () => {
    const dir = appWith(`${defineImport}
export const env = defineEnv({ server: { A: {} } }, {});
`);
    expect((await appEnvMetas(dir)).flatMap((m) => m.failures)).toHaveLength(1);
    // rewritten healthy: a second read must see the new file
    writeFileSync(
      join(dir, "env.ts"),
      `${defineImport}
export const env = defineEnv({ server: { A: { default: "x" } } }, {});
`,
    );
    expect((await appEnvMetas(dir)).flatMap((m) => m.failures)).toHaveLength(0);
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
