import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileCss } from "../src/build";

const repo = join(import.meta.dir, "../../..");
const readPkg = (path: string) =>
  JSON.parse(readFileSync(join(repo, path), "utf8")) as {
    version: string;
    devDependencies?: Record<string, string>;
  };

// `^x.y.z` on a 0.x line means ">=x.y.z <0.(y+1).0": a caret does not cross a
// minor before 1.0. That is the whole hazard below.
function caretReaches(range: string, version: string): boolean {
  const parse = (s: string) => s.replace(/^\^/, "").split(".").map(Number);
  const [lo0, lo1, lo2] = parse(range);
  const [v0, v1, v2] = parse(version);
  if ([lo0, lo1, lo2, v0, v1, v2].some((n) => !Number.isInteger(n))) return false;
  const atLeast = v0 > lo0 || (v0 === lo0 && (v1 > lo1 || (v1 === lo1 && v2 >= lo2)));
  if (!atLeast) return false;
  // below 1.0 the caret is pinned to the minor, above it to the major
  return lo0 === 0 ? v0 === 0 && v1 === lo1 : v0 === lo0;
}

describe("caretReaches", () => {
  test("models npm's 0.x caret, which does not cross a minor", () => {
    expect(caretReaches("^0.20.1", "0.20.1")).toBe(true);
    expect(caretReaches("^0.20.1", "0.20.9")).toBe(true);
    expect(caretReaches("^0.20.1", "0.21.0")).toBe(false);
    expect(caretReaches("^0.20.1", "0.20.0")).toBe(false);
    expect(caretReaches("^0.21.0", "0.21.3")).toBe(true);
    // and the ordinary 1.x caret, for when borgo gets there
    expect(caretReaches("^1.2.0", "1.9.0")).toBe(true);
    expect(caretReaches("^1.2.0", "2.0.0")).toBe(false);
  });
});

// `borgo build --tailwind` drives the postcss plugin, not @tailwindcss/cli:
// the cli drags in @parcel/watcher, whose postinstall compiles a native watcher
// from source, and the first thing a new user sees is `Blocked 1 postinstall`.
// The scaffolder installs @tailwindcss/postcss + postcss and deliberately does
// NOT install the cli - packages/create-borgo/test/cli.test.ts asserts its
// absence. That makes the two packages a matched pair: a scaffold whose
// borgo-framework resolves to a release that predates the postcss path finds
// neither the plugin nor the cli, and `--tailwind` throws on the first build.
describe("the tailwind path and the version that ships it", () => {
  test("the framework asks for @tailwindcss/postcss and names it when missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-tw-"));
    const cwd = process.cwd();
    const saved = process.env.BORGO_TAILWIND;
    process.chdir(dir);
    process.env.BORGO_TAILWIND = "1";
    try {
      writeFileSync(join(dir, "style.css"), '@import "tailwindcss";');
      // nothing installed here: no @tailwindcss/postcss, no postcss, no cli
      expect(compileCss(false)).rejects.toThrow("@tailwindcss/postcss");
    } finally {
      process.chdir(cwd);
      if (saved === undefined) delete process.env.BORGO_TAILWIND;
      else process.env.BORGO_TAILWIND = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a scaffold made from this tree can resolve this tree's framework", () => {
    const framework = readPkg("packages/borgo/package.json").version;
    const scaffolder = readPkg("packages/create-borgo/package.json").version;
    // create-borgo stamps `^{{version}}` with its OWN version into the template
    // package.json, so the two must stay on the same 0.x minor. Publishing a
    // framework minor without the matching create-borgo means every new
    // scaffold silently installs the previous framework - and with it, a
    // `--tailwind` that cannot find the tool the scaffolder just installed.
    expect(caretReaches(`^${scaffolder}`, framework)).toBe(true);
  });

  test("the manifest release-please releases from agrees with both", () => {
    const manifest = JSON.parse(
      readFileSync(join(repo, ".release-please-manifest.json"), "utf8"),
    ) as Record<string, string>;
    expect(manifest["packages/borgo"]).toBe(readPkg("packages/borgo/package.json").version);
    expect(manifest["packages/create-borgo"]).toBe(
      readPkg("packages/create-borgo/package.json").version,
    );
    // and the two entries must be caret-compatible with each other, which is
    // what the templates rely on
    expect(caretReaches(`^${manifest["packages/create-borgo"]}`, manifest["packages/borgo"])).toBe(
      true,
    );
  });

  test("the templates depend on the framework through that caret, not a pin", () => {
    for (const template of ["base", "full", "minimal"]) {
      const path = join(repo, "packages/create-borgo/templates", template, "package.json");
      if (!existsSync(path)) continue;
      const raw = readFileSync(path, "utf8");
      // the literal the scaffolder substitutes; a hard-coded version here
      // would freeze every scaffold on whatever was current when it was typed
      expect(raw).toContain('"borgo-framework": "{{version}}"');
    }
  });
});
