// EVERY /ws REFUSAL NAMES ITS TRUE CAUSE, AND WRITES IT WHERE SOMEONE READS IT.
//
// A refused upgrade is the one answer the client cannot show anyone. Measured
// against a live front server (examples/tasks, a real socket, a bun client): a
// 400 on the handshake arrives as close code 1002 "Expected 101 status code"
// and nothing else - no status, no body - and the spec gives a browser 1006
// with an empty reason for the same shape.
// So the two places the cause exists are the response body (for curl, and for
// anything that is not a handshake) and the server's own log. A refusal that
// fills neither is a support ticket; one that fills them with the wrong cause
// is worse, because it sends the caller to fix something that is not broken.
//
// That is what a 129-character topic used to get: status 400, body "too many
// topics" - a count the request did not have - and nothing in the log at all,
// while the comma refusal one branch up logged and named itself correctly.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// server.ts requires react through `createRequire(process.cwd()/package.json)`
// at module scope, so it only imports from a directory that can resolve it.
// Restored immediately: the cwd is process-wide and other test files read it.
const cwd = process.cwd();
process.chdir(join(import.meta.dir, ".."));
const { MAX_WS_TOPICS, MAX_WS_TOPIC_LENGTH, wsTopicRefusal } = await import("../src/server");
process.chdir(cwd);

const topics = (n: number, length = 4) =>
  Array.from({ length: n }, (_, i) => `t${i}`.padEnd(length, "x").slice(0, length));

describe("what /ws refuses, and what it says about it", () => {
  test("a topic exactly at the cap is not refused", () => {
    expect(wsTopicRefusal(["x".repeat(MAX_WS_TOPIC_LENGTH)])).toBe(null);
  });

  test("one character over is refused, and the refusal is about LENGTH", () => {
    const why = wsTopicRefusal(["x".repeat(MAX_WS_TOPIC_LENGTH + 1)])!;
    expect(why).toContain("129 characters");
    expect(why).toContain(`over the ${MAX_WS_TOPIC_LENGTH}`);
    // the sentence that used to come back, for a request holding one topic
    expect(why).not.toContain("too many topics");
  });

  test("exactly the topic cap is not refused, one more is - and that one IS about the count", () => {
    expect(wsTopicRefusal(topics(MAX_WS_TOPICS))).toBe(null);
    const why = wsTopicRefusal(topics(MAX_WS_TOPICS + 1))!;
    expect(why).toContain(`33 topics on one socket, over the ${MAX_WS_TOPICS}`);
    expect(why).not.toContain("characters");
  });

  test("both at once names both: fixing one alone would come straight back on the other", () => {
    const both = [...topics(MAX_WS_TOPICS), "y".repeat(200)];
    const why = wsTopicRefusal(both)!;
    expect(why).toContain("200 characters");
    expect(why).toContain("33 topics on one socket");
  });

  test("the caller's own string is truncated in the sentence, but its length is exact", () => {
    // it goes into a log line, and the client chose how long it is
    const why = wsTopicRefusal(["z".repeat(5_000)])!;
    expect(why).toContain("5000 characters");
    expect(why).toContain(`"${"z".repeat(40)}"...`);
    expect(why.length).toBeLessThan(200);
  });

  test("nothing to refuse: no topics, one topic, an ordinary handful", () => {
    expect(wsTopicRefusal([])).toBe(null);
    expect(wsTopicRefusal(["chat"])).toBe(null);
    expect(wsTopicRefusal(["chat", "news", "tasks"])).toBe(null);
  });
});

// ------------------------------------------------------------ coupling guard

describe("no /ws refusal is silent", () => {
  // the defect was never the sentence alone - it was a 400 written with nothing
  // said anywhere a human looks. This reads the handler itself, because the
  // guarantee is about the SITE of every refusal and not about one of them.
  test("every 400 the /ws handler returns is logged first", async () => {
    const source = await Bun.file(join(import.meta.dir, "../src/server.ts")).text();
    const start = source.indexOf('if (url.pathname === "/ws") {');
    expect(start).toBeGreaterThan(0);
    // up to the next top-level branch in the same handler
    const end = source.indexOf('if (req.method === "POST" && url.pathname === "/__borgo/publish")', start);
    expect(end).toBeGreaterThan(start);
    const block = source.slice(start, end).split("\n");

    const unlogged: string[] = [];
    for (let i = 0; i < block.length; i++) {
      if (!/return secure\((?:badRequest\(|new Response\([^)]*400)/.test(block[i])) continue;
      const before = block.slice(Math.max(0, i - 4), i).join("\n");
      if (!before.includes("console.error")) unlogged.push(block[i].trim());
    }
    expect(unlogged).toEqual([]);
  });

  test("the undecodable-query refusal names which part would not decode", async () => {
    // "%" alone is a topics value no decoder accepts, and the sentence without
    // the value says nothing about WHICH of the topics on the wire it was
    const source = await Bun.file(join(import.meta.dir, "../src/server.ts")).text();
    expect(source).toContain("topics is not a decodable query value: ${JSON.stringify(part.slice(0, 40))}");
  });
});
