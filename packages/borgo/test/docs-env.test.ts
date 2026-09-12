// A variable named in the docs that no code reads is the most expensive kind
// of stale page: it sends a reader to set something, and nothing happens. The
// 0.30 topology change retired two of them - BORGO_API_TIMEOUT and
// BORGO_FRONT_READ_TIMEOUT, which belonged to the bun front server - and five
// pages still documented them as stable afterwards, found by hand. That is
// exactly the kind of finding that should not need a person.
//
// The gate runs both ways: every name the docs mention must be read somewhere
// in the tree, and every name excused as retired must be read nowhere. So a
// page cannot document a knob that does not exist, and the excuse list cannot
// keep covering for a name that came back.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");

const NAME =
  /\b(?:BORGO_[A-Z0-9_]+|BUN_CONFIG_[A-Z0-9_]+|API_PORT|API_URL|FRONT_URL|SESSION_SECRET|SESSION_SECURE|DB_PATH|NO_COLOR)\b/g;

// retired with the topology they belonged to. The docs name them only to say
// where they went; the second test holds them to being really gone
const RETIRED = new Set(["BORGO_API_TIMEOUT", "BORGO_FRONT_READ_TIMEOUT"]);

// a prefix the templates document as a convention, not a variable
const NOT_A_VARIABLE = new Set(["BORGO_PUBLIC_", "BORGO_"]);

const walk = (dir: string, keep: (f: string) => boolean, out: string[] = []): string[] => {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".borgo" || entry === "dist" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, keep, out);
    else if (keep(entry)) out.push(full);
  }
  return out;
};

const code = (f: string) => /\.(ts|tsx|go|json|yml|yaml|sh)$/.test(f);
const read = (files: string[]) => files.map((f) => readFileSync(f, "utf8")).join("\n");

const goFiles = readdirSync(repoRoot)
  .filter((f) => f.endsWith(".go"))
  .map((f) => join(repoRoot, f));

// what reads a variable at runtime: the framework, the scaffolder, the
// templates it writes, the repo's own tooling
const runtime = [
  ...goFiles,
  ...walk(join(repoRoot, "packages/borgo/src"), code),
  ...walk(join(repoRoot, "packages/create-borgo/src"), code),
  ...walk(join(repoRoot, "packages/create-borgo/templates"), code),
  ...walk(join(repoRoot, "scripts"), code),
  ...walk(join(repoRoot, "borgogen"), code),
];
// the tests pin behaviour and may be the only place a name appears in full;
// enough to answer "something reads this", not enough to be runtime
const anywhere = [...runtime, ...walk(join(repoRoot, "packages/borgo/test"), code), ...walk(join(repoRoot, "e2e"), code)];

const runtimeText = read(runtime);
const anywhereText = read(anywhere);

describe("the docs name only variables something reads", () => {
  for (const doc of walk(join(repoRoot, "docs"), (f) => f.endsWith(".md"))) {
    const page = doc.slice(repoRoot.length + 1).replaceAll("\\", "/");
    test(page, () => {
      const unread = new Set<string>();
      for (const [name] of readFileSync(doc, "utf8").matchAll(NAME)) {
        if (NOT_A_VARIABLE.has(name) || RETIRED.has(name)) continue;
        if (!anywhereText.includes(name)) unread.add(name);
      }
      expect([...unread].sort()).toEqual([]);
    });
  }

  test("nothing excused as retired is read any more", () => {
    expect([...RETIRED].filter((name) => runtimeText.includes(name))).toEqual([]);
  });
});
