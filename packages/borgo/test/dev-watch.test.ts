import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChangeBatcher, createContentDedup } from "../src/dev";
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
