import { describe, expect, test } from "bun:test";
import {
  canonicalCount,
  canonicalItemList,
  canonicalItems,
  checkCanonicalBody,
  describeDifference,
  firstObjectKeyOrder,
  ITEM_KEY_ORDER,
} from "../lib/canonical";

const wire = (value: unknown) => JSON.stringify(value);

describe("the contract's dataset", () => {
  test("clamps n the way CONTRACT.md says", () => {
    expect(canonicalCount(undefined)).toBe(100);
    expect(canonicalCount("")).toBe(100);
    expect(canonicalCount("banana")).toBe(100);
    expect(canonicalCount("0")).toBe(1);
    expect(canonicalCount("-5")).toBe(1);
    expect(canonicalCount("9999")).toBe(1000);
    expect(canonicalCount("7")).toBe(7);
  });

  test("item i carries the specified done flag and tag", () => {
    const list = canonicalItems(12);
    expect(list[0]).toEqual({ id: 1, title: "Item 1", done: false, tag: "beta", createdAt: "2026-01-01T00:00:00Z" });
    expect(list[2]!.done).toBe(true);
    expect(list[5]!.done).toBe(true);
    expect(list.map((i) => i.tag).slice(0, 4)).toEqual(["beta", "gamma", "delta", "alpha"]);
  });
});

describe("checkCanonicalBody", () => {
  test("accepts the contract's own answer", () => {
    expect(checkCanonicalBody({ kind: "hello" }, wire({ message: "hello, world" }))).toBeNull();
    expect(checkCanonicalBody({ kind: "item-list", n: 100 }, wire(canonicalItemList(100)))).toBeNull();
  });

  test("rejects a list of the right shape whose values are cheaper to produce", () => {
    // 100 items, every key present, every regex in scenarios.ts satisfied - and
    // `done` constant, which is the shortcut the count-based check could not see
    const cheap = {
      items: canonicalItems(100).map((item) => ({ ...item, done: false })),
      count: 100,
    };
    const reason = checkCanonicalBody({ kind: "item-list", n: 100 }, wire(cheap));
    expect(reason).toContain("body.items[2].done");
  });

  test("rejects a constant tag", () => {
    const cheap = { items: canonicalItems(100).map((item) => ({ ...item, tag: "beta" })), count: 100 };
    expect(checkCanonicalBody({ kind: "item-list", n: 100 }, wire(cheap))).toContain("tag");
  });

  test("rejects a short list and a wrong count", () => {
    expect(checkCanonicalBody({ kind: "item-list", n: 100 }, wire(canonicalItemList(10)))).toContain("expected 100 entries");
    const wrongCount = { items: canonicalItems(100), count: 999 };
    expect(checkCanonicalBody({ kind: "item-list", n: 100 }, wire(wrongCount))).toContain("body.count");
  });

  test("rejects the key order the contract does not pin", () => {
    const reordered =
      '{"items":[' +
      canonicalItems(100)
        .map((item) => JSON.stringify({ title: item.title, id: item.id, done: item.done, tag: item.tag, createdAt: item.createdAt }))
        .join(",") +
      '],"count":100}';
    expect(checkCanonicalBody({ kind: "item-list", n: 100 }, reordered)).toContain("key order");
  });

  test("rejects a body that is not JSON at all", () => {
    expect(checkCanonicalBody({ kind: "hello" }, "<html>oops</html>")).toContain("not JSON");
  });

  test("rejects extra keys, so an envelope cannot be smuggled in", () => {
    expect(checkCanonicalBody({ kind: "hello" }, wire({ message: "hello, world", cached: true }))).toContain("unexpected key");
  });
});

describe("describeDifference", () => {
  test("names the path of the first disagreement", () => {
    expect(describeDifference({ a: { b: 1 } }, { a: { b: 2 } })).toBe("body.a.b: expected 2, got 1");
    expect(describeDifference([1, 2], [1, 2])).toBeNull();
  });
});

describe("firstObjectKeyOrder", () => {
  test("reads the order off the wire, not off the parsed value", () => {
    const body = '{"items":[{"id":1,"title":"Item 1","done":false,"tag":"beta","createdAt":"x"}],"count":1}';
    expect(firstObjectKeyOrder(body, '"items"')).toEqual([...ITEM_KEY_ORDER]);
  });

  test("ignores keys of nested objects", () => {
    expect(firstObjectKeyOrder('{"a":{"inner":1},"b":2}')).toEqual(["a", "b"]);
  });

  test("is not confused by a brace inside a string value", () => {
    expect(firstObjectKeyOrder('{"a":"} not a close","b":2}')).toEqual(["a", "b"]);
  });
});
