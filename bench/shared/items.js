/**
 * The one definition of the benchmark dataset for every JavaScript and
 * TypeScript implementation. Plain ESM with JSDoc types on purpose: Node, Bun,
 * Deno and every bundler here can import this same file, so no implementation
 * gets to drift by having its own copy.
 *
 * The Go twin lives in bench/apps/borgo/api/items.go. CONTRACT.md is the spec
 * both answer to.
 *
 * @typedef {{ id: number, title: string, done: boolean, tag: string, createdAt: string }} BenchItem
 */

/** @type {readonly string[]} */
export const TAGS = ["alpha", "beta", "gamma", "delta"];
export const CREATED_AT = "2026-01-01T00:00:00Z";
export const HELLO = { message: "hello, world" };

/**
 * Built per request on purpose: a cached array would measure the cache, and a
 * framework that happens to cache would read as a framework that happens to be
 * fast.
 *
 * @param {number} n
 * @returns {BenchItem[]}
 */
export function items(n) {
  const count = clamp(n);
  /** @type {BenchItem[]} */
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const id = i + 1;
    out[i] = {
      id,
      title: `Item ${id}`,
      done: id % 3 === 0,
      tag: /** @type {string} */ (TAGS[id % 4]),
      createdAt: CREATED_AT,
    };
  }
  return out;
}

/**
 * The contract's clamp: [1, 1000], defaulting to 100 for anything unparsable.
 * @param {unknown} raw
 * @returns {number}
 */
export function clamp(raw) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 100;
  return Math.max(1, Math.min(1000, Math.floor(parsed)));
}

/**
 * @param {string | null | undefined} raw the raw ?n= value
 * @returns {number}
 */
export function countFromQuery(raw) {
  return raw === null || raw === undefined || raw === "" ? 100 : clamp(raw);
}

/**
 * The contract's list response body.
 * @param {number} n
 */
export function itemList(n) {
  const list = items(n);
  return { items: list, count: list.length };
}
