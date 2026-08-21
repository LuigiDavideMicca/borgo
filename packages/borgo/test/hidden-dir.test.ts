import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// server.ts resolves react from process.cwd() at module scope; same dance as
// local-path.test.ts, restored at once
const cwd = process.cwd();
process.chdir(join(import.meta.dir, ".."));
const { inHiddenDirectory } = await import("../src/server");
process.chdir(cwd);

/**
 * WHICH URLS A DOT-DIRECTORY REFUSES, AND THE ONE IT MUST NOT.
 *
 * compress.ts refuses a hidden LAST segment and says so: a hidden directory
 * above it needs the url's root, which only the server has. Measured before
 * this on borgo's own front server, public/.git/config and public/.svn/entries
 * answered 200 on both roads - the boot index and the live fallback.
 *
 * .well-known is rfc 8615's, and rfc 8615 puts it at the root: "a URI whose
 * path component begins with /.well-known/". So it is exempt as the FIRST
 * segment only. acme http-01, security.txt and the app-association files all
 * live there; a renewal that fails is an expired certificate, which is the
 * worse direction, so those are asserted to pass before anything is asserted
 * to fail.
 */
describe("inHiddenDirectory", () => {
  test("the well-known tree at the root is served, whole", () => {
    for (const url of [
      "/.well-known/security.txt",
      "/.well-known/acme-challenge/tok3n",
      "/.well-known/apple-app-site-association",
      "/.well-known/deep/er/file",
    ]) {
      expect(`${url}: ${inHiddenDirectory(url)}`).toBe(`${url}: false`);
    }
  });

  test("a hidden directory anywhere in the path is refused", () => {
    for (const url of [
      "/.git/config",
      "/.git/HEAD",
      "/.svn/entries",
      "/.hg/store/x",
      "/assets/.cache/x.js",
      "/a/b/.env.d/x",
      "//.git/config",
      "/./.git/config",
    ]) {
      expect(`${url}: ${inHiddenDirectory(url)}`).toBe(`${url}: true`);
    }
  });

  // rfc 8615 is explicit that it is a root prefix; a nested one is not the
  // standard's, and it is where an exemption applied "anywhere" would leak
  test("a nested .well-known is not the standard's, and does not exempt", () => {
    expect(inHiddenDirectory("/x/.well-known/y.txt")).toBe(true);
    expect(inHiddenDirectory("/.git/.well-known/y")).toBe(true);
  });

  // exact, not folded: rfc 8615 paths are case-sensitive and every acme client
  // writes it lower-case; a folding filesystem answering /.WELL-KNOWN/ today is
  // an accident, not a contract
  test("the exemption is spelled exactly", () => {
    expect(inHiddenDirectory("/.WELL-KNOWN/security.txt")).toBe(true);
    expect(inHiddenDirectory("/.well-known2/x")).toBe(true);
    expect(inHiddenDirectory("/.well-knownx/x")).toBe(true);
  });

  test("a hidden last segment is not this guard's: compress.ts owns it", () => {
    expect(inHiddenDirectory("/.env")).toBe(false);
    expect(inHiddenDirectory("/assets/.hidden.js")).toBe(false);
    expect(inHiddenDirectory("/.well-known/.hidden")).toBe(false);
  });

  test("ordinary urls, ordinary dots", () => {
    for (const url of ["/", "/logo.svg", "/assets/app.v1.2.js", "/docs.old/x", "/a.b/c.d/e.f"]) {
      expect(`${url}: ${inHiddenDirectory(url)}`).toBe(`${url}: false`);
    }
  });
});

describe("the wiring in serve()", () => {
  test("the guard sits with the other refusals, before both roads", async () => {
    const source = await Bun.file(join(import.meta.dir, "../src/server.ts")).text();
    const guard = source.indexOf("!inHiddenDirectory(assetPath)");
    const indexed = source.indexOf("findAsset(assetIndex, assetPath)");
    const live = source.indexOf('const path = "public" + assetPath;');
    expect(guard).toBeGreaterThan(0);
    expect(indexed).toBeGreaterThan(guard);
    expect(live).toBeGreaterThan(indexed);
  });
});
