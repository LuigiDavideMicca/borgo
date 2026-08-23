// a refused upgrade is the one answer the client cannot show anyone: measured
// live, a 400 on the handshake arrives as close code 1002 "Expected 101 status
// code" and nothing else, a browser gets 1006 with an empty reason. so the
// cause exists in the response body (curl) and in the server's log, and a
// refusal filling them with the wrong cause sends the caller to fix what is not broken
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// server.ts requires react through `createRequire(process.cwd()/package.json)`
// at module scope, so it only imports from a directory that can resolve it.
// Restored immediately: the cwd is process-wide and other test files read it.
const cwd = process.cwd();
process.chdir(join(import.meta.dir, ".."));
const { MAX_WS_TOPICS, MAX_WS_TOPIC_LENGTH, WS_CLOSE_ORIGIN_REFUSED, wsOriginRefusal, wsTopicRefusal } =
  await import("../src/server");
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
    // the count's sentence, for a request holding one topic
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
  // the guarantee is about the SITE of every refusal, so the handler itself is read
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

// the origin refusal is the one the client can read. measured live (bun
// client, Origin http://evil.example): a bare 403 arrived as 1002 and was
// redialled 6 times in 60 s, forever after at 30 s; upgrading and closing
// with 4403 arrives with the reason intact, one dial, and none of the 20
// messages published into its topic meanwhile. chromium cannot be measured
// cross-origin on loopback (ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS, 1006)
describe("the origin refusal reaches the client as a close frame", () => {
  test("the code is in the 4xxx application range, and the reason names origin and host", () => {
    expect(WS_CLOSE_ORIGIN_REFUSED).toBe(4403);
    const why = wsOriginRefusal("http://evil.example", "app.test");
    expect(why).toContain('"http://evil.example"');
    expect(why).toContain("app.test");
  });

  test("no Origin at all names the switch that would accept it", () => {
    const why = wsOriginRefusal(null, "app.test");
    expect(why).toContain("BORGO_WS_ALLOW_NO_ORIGIN");
    expect(why).toContain("wsAllowNoOrigin");
  });

  test("the client's own string is truncated in the reason", () => {
    const why = wsOriginRefusal("http://" + "x".repeat(5000), "app.test");
    expect(why.length).toBeLessThan(300);
  });

  test("the /ws handler upgrades the refused origin instead of answering 403, logs it, and open() closes it before any subscribe", async () => {
    const source = await Bun.file(join(import.meta.dir, "../src/server.ts")).text();
    const start = source.indexOf('if (url.pathname === "/ws") {');
    const end = source.indexOf('if (req.method === "POST" && url.pathname === "/__borgo/publish")', start);
    const block = source.slice(start, end);
    const refusal = block.indexOf("if (!allowed) {");
    expect(refusal).toBeGreaterThan(0);
    const branch = block.slice(refusal, block.indexOf("}", block.indexOf("return secure(new Response(\"forbidden\"", refusal)));
    expect(branch).toContain("console.error(");
    expect(branch).toContain('server.upgrade(req, { data: { kind: "refused", reason: why } })');
    // the 403 is only the fallback for an upgrade bun itself declined
    expect(branch.indexOf("server.upgrade")).toBeLessThan(branch.indexOf("status: 403"));

    // the refused socket is closed at the top of open(), above the subscribe loop
    const open = source.slice(source.indexOf("      open(ws) {"), source.indexOf("      close(ws) {"));
    const closeAt = open.indexOf("ws.close(WS_CLOSE_ORIGIN_REFUSED, ws.data.reason)");
    expect(closeAt).toBeGreaterThan(0);
    expect(closeAt).toBeLessThan(open.indexOf("ws.subscribe("));
  });
});
