import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..");

// docs/database.md shows the full template's migration runner whole, as a
// no-check block: the scaffold CI compiles and tests the template's copy, and
// this holds the page to it, byte for byte
test("the runner on the database page is the one the full template ships", () => {
  const doc = readFileSync(join(root, "docs", "database.md"), "utf8").replaceAll("\r\n", "\n");
  const runner = readFileSync(join(root, "packages", "create-borgo", "templates", "full", "db", "migrate.go"), "utf8")
    .replaceAll("\r\n", "\n")
    .trimEnd();
  const blocks = [...doc.matchAll(/```go no-check\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  expect(blocks).toContain(runner);
});
