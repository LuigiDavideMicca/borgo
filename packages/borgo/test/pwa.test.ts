import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifest, pwaInit, restampServiceWorker, serviceWorker, stampWorkerFile } from "../src/pwa";

const app = () => {
  const dir = mkdtempSync(join(tmpdir(), "borgo-pwa-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "notes" }));
  return dir;
};

describe("manifest", () => {
  test("is valid json naming the app", () => {
    const m = JSON.parse(manifest("notes"));
    expect(m.name).toBe("notes");
    expect(m.start_url).toBe("/");
    expect(m.display).toBe("standalone");
    expect(m.icons.length).toBeGreaterThan(0);
  });

  test("short_name stays within the length browsers show", () => {
    const m = JSON.parse(manifest("an-extremely-long-application-name"));
    expect(m.short_name.length).toBeLessThanOrEqual(12);
  });
});

describe("service worker", () => {
  const sw = serviceWorker();

  test("keys its cache on the precache stamp", () => {
    expect(sw).toContain("/assets/precache.json");
    expect(sw).toContain('const CACHE = "app-" + BUILD;');
  });

  // THE bug this file exists for. A browser reinstalls a service worker only
  // when the worker's own bytes change. A body that is byte-identical on every
  // deploy means install - the only thing that ever writes to the cache - runs
  // once in the app's life, activate never prunes, and every later deploy's
  // /assets/client.js is shadowed by the first deploy's until the user clears
  // site data. client.js carries the route table and the chunk hashes, and
  // build.ts deletes yesterday's chunks from disk, so those lazy imports 404
  // and hydration is broken permanently.
  test("its bytes change with the build stamp", () => {
    expect(serviceWorker("aaa")).not.toBe(serviceWorker("bbb"));
    expect(serviceWorker("aaa")).toBe(serviceWorker("aaa"));
    expect(serviceWorker("aaa")).toContain('const BUILD = "aaa";');
  });

  test("never caches the manifest that tells it which stamp is current", () => {
    // a cached manifest pins the worker to an old build permanently
    expect(sw).toContain("url.pathname === MANIFEST");
  });

  test("only handles same-origin GETs under /assets", () => {
    expect(sw).toContain('event.request.method !== "GET"');
    expect(sw).toContain("url.origin !== location.origin");
    expect(sw).toContain('!url.pathname.startsWith("/assets/")');
  });

  test("drops old caches but keeps the current one", () => {
    expect(sw).toContain('key.startsWith("app-") && key !== CACHE');
  });

  // caches.match() with no cacheName searches every cache in CacheStorage, in
  // creation order, oldest first: a cache activate has not pruned yet answers
  // for the deploy that owns it, which is the same stale-asset failure again
  // by a different route
  test("reads only from this build's cache, never all of CacheStorage", () => {
    const code = sw.replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bcaches\.match\(/);
    expect(sw).toContain("caches.open(CACHE)");
    expect(sw).toContain("cache.match(event.request)");
  });

  test("is syntactically valid javascript", () => {
    // a generated worker that does not parse is worse than none
    expect(() => new Function(sw.replace(/\bself\b/g, "globalThis"))).not.toThrow();
    expect(() => new Function(serviceWorker("1234").replace(/\bself\b/g, "globalThis"))).not.toThrow();
  });
});

describe("restamping a worker at build time", () => {
  test("rewrites only the stamp line, so an edited worker keeps its edits", () => {
    const mine = serviceWorker("old").replace(
      "self.addEventListener(\"fetch\"",
      "// my own handler\nself.addEventListener(\"fetch\"",
    );
    const next = restampServiceWorker(mine, "new")!;
    expect(next).toContain('const BUILD = "new";');
    expect(next).not.toContain('const BUILD = "old";');
    expect(next).toContain("// my own handler");
    // one line moved, and only one
    const changed = next.split("\n").filter((line, i) => line !== mine.split("\n")[i]);
    expect(changed).toEqual(['const BUILD = "new";']);
  });

  test("a hand-written worker with no stamp line is left alone", () => {
    expect(restampServiceWorker("self.addEventListener('fetch', () => {});", "x")).toBeNull();
  });

  test("stampWorkerFile rewrites public/sw.js in place, and tolerates no worker", () => {
    const dir = app();
    try {
      // no public/sw.js at all: not every app runs `borgo pwa init`
      expect(stampWorkerFile("s1", dir)).toBe(false);

      mkdirSync(join(dir, "public"), { recursive: true });
      writeFileSync(join(dir, "public", "sw.js"), serviceWorker("s0"));
      expect(stampWorkerFile("s1", dir)).toBe(true);
      const written = readFileSync(join(dir, "public", "sw.js"), "utf8");
      expect(written).toContain('const BUILD = "s1";');
      expect(written).toBe(serviceWorker("s1"));

      // an unchanged rebuild must not rewrite the file: the same stamp is the
      // same worker, and a pointless write is a pointless reinstall
      expect(stampWorkerFile("s1", dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a worker written after a build starts from that build's stamp", () => {
    const dir = app();
    try {
      mkdirSync(join(dir, "public", "assets"), { recursive: true });
      writeFileSync(
        join(dir, "public", "assets", "precache.json"),
        JSON.stringify({ stamp: "9876", assets: ["/assets/client.js"] }),
      );
      expect(pwaInit(false, dir)).toBe(0);
      expect(readFileSync(join(dir, "public", "sw.js"), "utf8")).toContain('const BUILD = "9876";');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pwa init", () => {
  test("writes both files into public/ and reports success", () => {
    const dir = app();
    expect(pwaInit(false, dir)).toBe(0);
    expect(existsSync(join(dir, "public", "manifest.webmanifest"))).toBe(true);
    expect(existsSync(join(dir, "public", "sw.js"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "public", "manifest.webmanifest"), "utf8")).name).toBe(
      "notes",
    );
    rmSync(dir, { recursive: true, force: true });
  });

  test("creates public/ when the app does not have one yet", () => {
    const dir = app();
    expect(existsSync(join(dir, "public"))).toBe(false);
    expect(pwaInit(false, dir)).toBe(0);
    expect(existsSync(join(dir, "public", "sw.js"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("refuses to overwrite an existing worker without --force", () => {
    const dir = app();
    mkdirSync(join(dir, "public"));
    writeFileSync(join(dir, "public", "sw.js"), "// mine");
    expect(pwaInit(false, dir)).toBe(1);
    expect(readFileSync(join(dir, "public", "sw.js"), "utf8")).toBe("// mine");
    // and nothing else was written alongside it
    expect(existsSync(join(dir, "public", "manifest.webmanifest"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("--force overwrites", () => {
    const dir = app();
    mkdirSync(join(dir, "public"));
    writeFileSync(join(dir, "public", "sw.js"), "// mine");
    expect(pwaInit(true, dir)).toBe(0);
    expect(readFileSync(join(dir, "public", "sw.js"), "utf8")).toContain("precache.json");
    rmSync(dir, { recursive: true, force: true });
  });
});
