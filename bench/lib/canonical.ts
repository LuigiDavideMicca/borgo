/**
 * CONTRACT.md's response bodies, transliterated from the specification text.
 *
 * This is deliberately a *second* implementation rather than an import of
 * `bench/shared/items.js`. An oracle that imports the same module the subject
 * imports agrees with the subject by construction: it can only ever catch an
 * implementation that wrote its own dataset, and it goes blind exactly when the
 * shared module drifts. Derived from the prose in CONTRACT.md, this one
 * disagrees with the shared module too, which is the point.
 */

export const TAGS = ["alpha", "beta", "gamma", "delta"] as const;
export const CREATED_AT = "2026-01-01T00:00:00Z";
/** CONTRACT.md: "Key order is id, title, done, tag, createdAt." */
export const ITEM_KEY_ORDER = ["id", "title", "done", "tag", "createdAt"] as const;

export interface CanonicalItem {
  id: number;
  title: string;
  done: boolean;
  tag: string;
  createdAt: string;
}

/** the contract's clamp: [1, 1000], and 100 for anything missing or unparsable */
export function canonicalCount(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw === "") return 100;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 100;
  return Math.max(1, Math.min(1000, Math.floor(parsed)));
}

export function canonicalItems(n: number): CanonicalItem[] {
  const count = canonicalCount(String(n));
  const out: CanonicalItem[] = [];
  for (let i = 0; i < count; i++) {
    const id = i + 1;
    out.push({
      id,
      title: `Item ${id}`,
      done: id % 3 === 0,
      tag: TAGS[id % 4]!,
      createdAt: CREATED_AT,
    });
  }
  return out;
}

export const canonicalHello = () => ({ message: "hello, world" });

export function canonicalItemList(n: number): { items: CanonicalItem[]; count: number } {
  const list = canonicalItems(n);
  return { items: list, count: list.length };
}

/** what a scenario declares its body must be; the check lives here, the data in scenarios.ts */
export type BodySpec = { kind: "hello" } | { kind: "item-list"; n: number };

export function canonicalBody(spec: BodySpec): unknown {
  return spec.kind === "hello" ? canonicalHello() : canonicalItemList(spec.n);
}

const show = (value: unknown): string => {
  const text = typeof value === "string" ? JSON.stringify(value) : String(value);
  return text.length > 60 ? text.slice(0, 57) + "..." : text;
};

/**
 * The first structural difference between what arrived and what the contract
 * says, as a path, or null when they agree. A boolean would tell an operator
 * that a 15 kB body is wrong without saying where, which is the difference
 * between a usable failure and a shrug.
 */
export function describeDifference(actual: unknown, expected: unknown, path = "body"): string | null {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${path}: expected an array, got ${typeof actual}`;
    if (actual.length !== expected.length) {
      return `${path}: expected ${expected.length} entries, got ${actual.length}`;
    }
    for (let i = 0; i < expected.length; i++) {
      const diff = describeDifference(actual[i], expected[i], `${path}[${i}]`);
      if (diff) return diff;
    }
    return null;
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
      return `${path}: expected an object, got ${show(actual)}`;
    }
    const actualRecord = actual as Record<string, unknown>;
    const expectedRecord = expected as Record<string, unknown>;
    for (const key of Object.keys(expectedRecord)) {
      if (!(key in actualRecord)) return `${path}.${key}: missing`;
      const diff = describeDifference(actualRecord[key], expectedRecord[key], `${path}.${key}`);
      if (diff) return diff;
    }
    const extra = Object.keys(actualRecord).filter((key) => !(key in expectedRecord));
    if (extra.length > 0) return `${path}: unexpected key(s) ${extra.join(", ")}`;
    return null;
  }
  if (!Object.is(actual, expected)) return `${path}: expected ${show(expected)}, got ${show(actual)}`;
  return null;
}

/**
 * The key order of the first JSON object literal in the raw text.
 *
 * Read off the wire rather than off the parsed value on purpose: `JSON.parse`
 * preserves insertion order for string keys but silently reorders integer-like
 * ones, and the contract pins an order that a reader of the response sees.
 * Returns [] when there is no object to read.
 */
export function firstObjectKeyOrder(body: string, after = ""): string[] {
  const from = after ? body.indexOf(after) : 0;
  if (from === -1) return [];
  const open = body.indexOf("{", from + after.length);
  if (open === -1) return [];

  // one character-by-character pass, because a regex cannot tell a `}` that
  // closes the object from a `}` inside a string value - and a title like
  // "Item }" would then truncate the object and silently return half its keys
  const keys: string[] = [];
  let depth = 0;
  let literal = "";
  let inString = false;
  let escaped = false;
  for (let i = open; i < body.length; i++) {
    const char = body[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      else literal += char;
      continue;
    }
    if (char === '"') {
      inString = true;
      literal = "";
    } else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") {
      depth--;
      if (depth === 0) return keys;
    } else if (char === ":" && depth === 1 && literal !== "") {
      // depth 1 is the object we opened; anything deeper belongs to a child
      keys.push(literal);
      literal = "";
    }
  }
  return [];
}

/**
 * Checks a response body against the contract: the values, and - for the item
 * list - the key order the contract pins. Returns the reason it failed, or
 * null.
 *
 * Values matter because counting `"done":` occurrences, which is all a regex
 * can do, passes an implementation whose `done` is always false and whose
 * `tag` never changes. Those are cheaper to produce than the contract's items.
 */
export function checkCanonicalBody(spec: BodySpec, body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    return `body is not JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
  const diff = describeDifference(parsed, canonicalBody(spec));
  if (diff) return `the response does not match CONTRACT.md - ${diff}`;

  if (spec.kind === "item-list") {
    const keys = firstObjectKeyOrder(body, '"items"');
    if (keys.join(",") !== ITEM_KEY_ORDER.join(",")) {
      return `item key order on the wire is [${keys.join(", ")}]; CONTRACT.md pins [${ITEM_KEY_ORDER.join(", ")}]`;
    }
  }
  return null;
}
