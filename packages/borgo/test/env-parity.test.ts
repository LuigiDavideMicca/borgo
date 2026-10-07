import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ENV_META, defineEnv, type EnvMeta } from "../src/env";

type Row = { type: string; raw: string; ok: boolean; value?: unknown; error?: string };

// the go half reads the app's server variables with borgo.ReadEnv, and its
// test holds it to this table; this holds the table to env.ts, so the two
// halves cannot drift apart with both suites green
test("the parity table is what env.ts answers", () => {
  const rows = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "testdata", "env_parity.json"), "utf8")) as Row[];
  expect(rows.length).toBeGreaterThan(50);
  for (const row of rows) {
    const env = defineEnv({ server: { V: { type: row.type as never } } }, { V: row.raw }) as unknown as Record<
      symbol,
      EnvMeta
    > & { V: unknown };
    const failures = env[ENV_META].failures;
    const got: Row = failures.length
      ? { type: row.type, raw: row.raw, ok: false, error: failures[0] }
      : { type: row.type, raw: row.raw, ok: true, value: env.V };
    // through json, as the table was written: -0 is 0 there, as it is to go
    expect(JSON.parse(JSON.stringify(got))).toEqual(row);
  }
});
