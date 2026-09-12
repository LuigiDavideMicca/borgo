import { describe, expect, test } from "bun:test";
import { normalizeTag, readIsrPolicy } from "../src/isr";

// What a page declares about being shareable is read in this process,
// which imports the page module. The cache that acts on it is the go
// front's, and so are its tests: the storability guard, the lru and its tag
// index, the single-flight regeneration, the doomed flights, the per-replay
// nonce, the persisted pairs and their sweep all moved to isr.go and
// isr_test.go with the code. The table this file feeds the front is
// covered in render-mode.test.ts (isrPolicyTable).
describe("readIsrPolicy", () => {
  test("no revalidate export is an opt-out, not an error", () => {
    expect(readIsrPolicy({})).toBeNull();
    expect(readIsrPolicy({ tags: ["posts"] })).toBeNull();
  });

  test("seconds and manual are the two shapes", () => {
    expect(readIsrPolicy({ revalidate: 300 })).toEqual({ seconds: 300, tags: [] });
    expect(readIsrPolicy({ revalidate: "manual" })).toEqual({ seconds: "manual", tags: [] });
  });

  test("tags ride along, trimmed", () => {
    expect(readIsrPolicy({ revalidate: 60, tags: [" posts ", "home"] })).toEqual({
      seconds: 60,
      tags: ["posts", "home"],
    });
  });

  // serving would hide the typo forever: the wrong opt-in is named, not guessed at
  test("a wrong opt-in is named, never guessed at", () => {
    for (const bad of [0, -1, NaN, Infinity, "300", true, null]) {
      const got = readIsrPolicy({ revalidate: bad });
      expect(typeof got).toBe("string");
      expect(got as string).toContain("revalidate");
    }
    const badTags = readIsrPolicy({ revalidate: 60, tags: ["ok", ""] });
    expect(typeof badTags).toBe("string");
    expect(badTags as string).toContain("tags");
  });
});

describe("normalizeTag", () => {
  // one spelling on both sides of the bridge: a page tagged " news " was
  // stored under "news" while RevalidateTag(" news ") - the spelling its
  // author sees in their own go source - dropped nothing, silently
  test("trims and normalises, so both sides meet on equal bytes", () => {
    expect(normalizeTag("  news ")).toBe("news");
    expect(normalizeTag("café")).toBe("café");
    expect(normalizeTag("café")).toBe("café");
  });
});
