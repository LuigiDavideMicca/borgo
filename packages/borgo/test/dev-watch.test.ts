import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChangeBatcher, createContentDedup, gitignoredMatcher, readDevLock } from "../src/dev";
import { propsPathEnabled } from "../src/runtime";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// the browser ignores an update naming a page other than the one on screen:
// a window carrying only its last file drops a "Save All" in silence
describe("createChangeBatcher", () => {
  test("every file in one window rides the rebuild it caused", async () => {
    const flushes: Array<[string, string[]]> = [];
    const schedule = createChangeBatcher(20, (side, files) => flushes.push([side, files]));

    schedule("pages/index.tsx", "app");
    await sleep(5);
    schedule("pages/about.tsx", "app");
    await sleep(60);

    // one rebuild, both files
    expect(flushes).toHaveLength(1);
    expect(flushes[0][0]).toBe("app");
    expect(flushes[0][1].sort()).toEqual(["pages/about.tsx", "pages/index.tsx"]);
  });

  test("the same file saved twice is one entry, not two", async () => {
    const flushes: string[][] = [];
    const schedule = createChangeBatcher(20, (_side, files) => flushes.push(files));
    schedule("pages/index.tsx", "app");
    schedule("pages/index.tsx", "app");
    await sleep(60);
    expect(flushes).toEqual([["pages/index.tsx"]]);
  });

  test("sides stay independent, and each carries its own set", async () => {
    const flushes: Array<[string, string[]]> = [];
    const schedule = createChangeBatcher(20, (side, files) => flushes.push([side, files]));
    schedule("main.go", "api");
    schedule("pages/index.tsx", "app");
    schedule("style.scss", "css");
    await sleep(60);
    expect(flushes.map(([side]) => side).sort()).toEqual(["api", "app", "css"]);
    for (const [, files] of flushes) expect(files).toHaveLength(1);
  });

  test("a later window starts empty instead of replaying the last one", async () => {
    const flushes: string[][] = [];
    const schedule = createChangeBatcher(20, (_side, files) => flushes.push(files));
    schedule("pages/a.tsx", "app");
    await sleep(60);
    schedule("pages/b.tsx", "app");
    await sleep(60);
    expect(flushes).toEqual([["pages/a.tsx"], ["pages/b.tsx"]]);
  });

  test("a file arriving during the window extends it rather than splitting it", async () => {
    const flushes: string[][] = [];
    const schedule = createChangeBatcher(30, (_side, files) => flushes.push(files));
    schedule("a.tsx", "app");
    await sleep(20);
    schedule("b.tsx", "app");
    await sleep(20);
    // still inside the extended window
    expect(flushes).toHaveLength(0);
    schedule("c.tsx", "app");
    await sleep(70);
    expect(flushes).toEqual([["a.tsx", "b.tsx", "c.tsx"]]);
  });
});

// "kill it and save again" must be actionable: that save writes identical bytes
describe("createContentDedup", () => {
  const withFile = (fn: (file: string, write: (text: string) => void) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-dedup-"));
    const file = join(dir, "main.go");
    try {
      fn(file, (text) => writeFileSync(file, text));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("the first sight of a file is a change, an identical second is not", () => {
    withFile((file, write) => {
      const dedup = createContentDedup(readFileSync);
      write("package main");
      expect(dedup.isUnchanged(file)).toBe(false);
      expect(dedup.isUnchanged(file)).toBe(true);
      write("package main // edited");
      expect(dedup.isUnchanged(file)).toBe(false);
    });
  });

  test("forget() lets the next identical save through", () => {
    withFile((file, write) => {
      const dedup = createContentDedup(readFileSync);
      write("package main");
      expect(dedup.isUnchanged(file)).toBe(false);
      expect(dedup.isUnchanged(file)).toBe(true);
      // the swap failed and the user was told to save again; the bytes on disk
      // are the same ones, and swallowing that save leaves the api down in
      // silence with the message still on screen
      dedup.forget();
      expect(dedup.isUnchanged(file)).toBe(false);
    });
  });

  test("an unreadable file forgets its hash, so recreating it rebuilds", () => {
    withFile((file, write) => {
      const dedup = createContentDedup(readFileSync);
      write("package main");
      expect(dedup.isUnchanged(file)).toBe(false);
      rmSync(file);
      // deleted: unreadable is not "unchanged"
      expect(dedup.isUnchanged(file)).toBe(false);
      // git stash pop restores byte-identical content, and it must rebuild
      write("package main");
      expect(dedup.isUnchanged(file)).toBe(false);
    });
  });

  test("files are tracked independently", () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-dedup-"));
    try {
      const a = join(dir, "a.go");
      const b = join(dir, "b.go");
      writeFileSync(a, "same");
      writeFileSync(b, "same");
      const dedup = createContentDedup(readFileSync);
      expect(dedup.isUnchanged(a)).toBe(false);
      // identical contents, different file: still a change
      expect(dedup.isUnchanged(b)).toBe(false);
      expect(dedup.isUnchanged(a)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("importing dev.ts is inert", () => {
  expect(typeof createChangeBatcher).toBe("function");
  expect(propsPathEnabled()).toBe(true);
});

describe("gitignoredMatcher", () => {
  // an app that writes uploads or a sqlite file inside its own directory
  // overflowed the watcher's event queue, and an overflow forces a full
  // rebuild that restarts the front server with requests in flight
  test("plain names and bare extension globs are ignored, at the root", () => {
    const ignore = gitignoredMatcher("node_modules/\nuploads/\n*.db\n.env\n");
    expect(ignore("uploads/a1b2c3")).toBe(true);
    expect(ignore(String.raw`uploads\a1b2c3`)).toBe(true);
    expect(ignore("tasks.db")).toBe(true);
    expect(ignore("data/app.DB")).toBe(true);
    expect(ignore(".env")).toBe(true);
  });

  test("source is never ignored by a name that merely appears inside it", () => {
    const ignore = gitignoredMatcher("uploads/\n*.db\n");
    expect(ignore("pages/uploads.tsx")).toBe(false);
    expect(ignore("api/uploads.go")).toBe(false);
    expect(ignore("pages/index.tsx")).toBe(false);
  });

  // the grammar is deliberately literal: a pattern this cannot read must
  // leave the file watched, because a silently unwatched page is the one
  // failure mode worse than a noisy rebuild
  test("patterns it does not understand are not guessed at", () => {
    const ignore = gitignoredMatcher("**/tmp\nbuild/*/cache\n!keep.db\nsrc?/\n");
    expect(ignore("pages/tmp/x.tsx")).toBe(false);
    expect(ignore("build/a/cache/x")).toBe(false);
    expect(ignore("srcX/page.tsx")).toBe(false);
  });

  test("no gitignore, or nothing usable in it, ignores nothing", () => {
    expect(gitignoredMatcher("")("uploads/x")).toBe(false);
    expect(gitignoredMatcher("# just a comment\n\n")("uploads/x")).toBe(false);
  });
});

describe("readDevLock", () => {
  // two dev sessions share public/assets and rename each other's chunks
  // mid-build; the loser reports ENOENT on a name that existed a moment ago
  const live = () => true;
  const dead = () => false;

  test("a live session in this directory is reported, ports included", () => {
    const held = readDevLock(JSON.stringify({ pid: 4321, port: "3000", apiPort: "3501" }), live, 99);
    expect(held).toEqual({ pid: 4321, port: "3000", apiPort: "3501" });
  });

  test("a lock whose process is gone is not a session", () => {
    expect(readDevLock(JSON.stringify({ pid: 4321, port: "3000" }), dead, 99)).toBeNull();
  });

  test("our own lock is not somebody else's", () => {
    expect(readDevLock(JSON.stringify({ pid: 99, port: "3000" }), live, 99)).toBeNull();
  });

  test("a torn or foreign lock file refuses nobody", () => {
    expect(readDevLock("", live, 99)).toBeNull();
    expect(readDevLock("{not json", live, 99)).toBeNull();
    expect(readDevLock(JSON.stringify({ pid: "4321" }), live, 99)).toBeNull();
  });
});
