import { unlink } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { matchRoute, type PageModule, type Route } from "../src/router";
import {
  bodyTooLarge,
  framedLength,
  limitRequestBody,
  proxyRequest,
  readBodyWithin,
  resolveSwitches,
  runAction,
  shouldBufferBody,
  type ActionOptions,
  type RouteMatch,
} from "../src/util";

// BORGO_MAX_BODY used to be handed to bun as `maxRequestBodySize`, and bun's
// cap counts a DECLARED Content-Length. Everything below is driven over a real
// socket because that is the only place the framing exists: a `new Request()`
// built in-process has no chunked encoding to not-declare, so a unit test of
// this limit would have passed against the hole for as long as it stood. The
// two paths that buffer - `runAction` and `proxyRequest` - run behind a real
// bun server whose own ceiling is out of the way, exactly as server.ts runs
// them.
//
// The cap travels in a header rather than in a shared variable: a test that
// times out here is abandoned but its sockets are not, and a mutable cap gets
// rewritten under the next test by the one that was supposed to be over.

const CAP = 64;
const SLOW = 30_000;

// ---------------------------------------------------------------- raw client

type Sent = {
  status: number | null;
  body: string;
  // how many bytes the far end reported reading, for the cases that get through
  read: string | null;
  // no response line at all: the socket died before anything was written
  silent: boolean;
};

const parse = (raw: string): Sent => {
  const head = raw.includes("\r\n\r\n") ? raw.slice(0, raw.indexOf("\r\n\r\n")) : raw;
  const body = raw.includes("\r\n\r\n") ? raw.slice(raw.indexOf("\r\n\r\n") + 4) : "";
  const m = /^HTTP\/1\.1 (\d{3})/.exec(head.split("\r\n")[0] ?? "");
  return {
    status: m ? Number(m[1]) : null,
    body,
    read: /\r\nx-read: *(\S+)/i.exec(head)?.[1] ?? null,
    silent: !m,
  };
};

type Shape = {
  // null means Transfer-Encoding: chunked
  declare: number | null;
  send: number;
  pieces?: number;
  // stop halfway: half the bytes, no terminating chunk, socket held open
  halt?: boolean;
  // and then hang up. A FIN mid-body races the refusal being written - bun
  // tears the connection down on an unfinished request and the queued response
  // can go with it (measured, both ways, on the same shape) - so a test that
  // demanded the 413 here would be asserting a coin toss. What is demanded is
  // that it is never answered as if the body had arrived.
  hangup?: boolean;
};

let front: ReturnType<typeof Bun.serve>;
let upstream: ReturnType<typeof Bun.serve>;

const speak = (path: string, cap: number, shape: Shape): Promise<Sent> =>
  new Promise((resolve) => {
    const { declare, send, pieces = 1, halt = false, hangup = false } = shape;
    const sock = net.connect(Number(front.port), "127.0.0.1");
    let raw = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {}
      resolve(parse(raw));
    };
    sock.on("connect", async () => {
      const head =
        `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
        `Content-Type: application/x-www-form-urlencoded\r\n` +
        // the enhanced envelope is what carries the action's byte count back
        `X-Borgo-Action: 1\r\nX-Test-Cap: ${cap}\r\n` +
        (declare === null ? "Transfer-Encoding: chunked\r\n" : `Content-Length: ${declare}\r\n`) +
        "\r\n";
      const write = async (buf: string | Buffer) => {
        if (settled) return false;
        if (!sock.write(buf as never, () => {})) {
          const drained = await Promise.race([
            new Promise<boolean>((r) => sock.once("drain", () => r(true))),
            Bun.sleep(3000).then(() => false),
          ]);
          if (!drained) return false;
        }
        return !settled;
      };
      if (!(await write(head))) return;
      const total = halt || hangup ? Math.floor(send / 2) : send;
      const size = Math.max(1, Math.ceil(total / pieces));
      for (let at = 0; at < total; at += size) {
        const n = Math.min(size, total - at);
        // "t=" makes the same bytes a legal urlencoded field on the action
        // path and an opaque payload on the proxy one
        const payload =
          at === 0 && n >= 2 ? Buffer.concat([Buffer.from("t="), Buffer.alloc(n - 2, 0x78)]) : Buffer.alloc(n, 0x78);
        if (declare === null) {
          if (!(await write(`${n.toString(16)}\r\n`))) return;
          if (!(await write(payload))) return;
          if (!(await write("\r\n"))) return;
        } else if (!(await write(payload))) return;
      }
      if (hangup) {
        setTimeout(() => {
          try {
            sock.end();
          } catch {}
        }, 50);
        return;
      }
      // halt: nothing more is written and the socket stays open, which is a
      // client that stopped rather than one that left
      if (halt) return;
      if (declare === null) await write("0\r\n\r\n");
    });
    sock.on("data", (d) => {
      raw += d.toString("latin1");
      if (raw.includes("\r\n\r\n")) setTimeout(finish, 60);
    });
    sock.on("error", finish);
    sock.on("close", finish);
    setTimeout(finish, SLOW - 4000);
  });

const form = (cap: number, shape: Shape) => speak("/form", cap, shape);
const api = (cap: number, shape: Shape) => speak("/api/x", cap, shape);

// ------------------------------------------------------------- the two paths

const route = (module: Partial<PageModule>): Route => ({
  pattern: "/form",
  file: "form.tsx",
  module: { default: () => null, ...module } as PageModule,
  layouts: [],
});

const actionOptions = (maxBody: number): ActionOptions => ({
  dev: false,
  apiUrl: "http://api.test/api",
  serverError: null,
  csrfRejects: async () => false,
  maxBody,
  apiFor: () => ({}) as never,
  runLoader: async () => ({}),
  renderPage: async () => new Response("doc", { headers: { "Content-Type": "text/html" } }),
  sendJson: (_req, value, init) => Response.json(value, init),
  renderOverlay: () => "overlay",
  onError: () => {},
});

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    development: false,
    async fetch(req) {
      let n = 0;
      if (req.body) {
        const reader = req.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            n += value.byteLength;
          }
        } catch {
          return new Response("upstream: body broke", { status: 400, headers: { "x-read": String(n) } });
        }
      }
      return new Response("upstream ok", { headers: { "x-read": String(n) } });
    },
  });

  front = Bun.serve({
    port: 0,
    // exactly what server.ts does now: bun's ceiling is out of the way and
    // borgo counts instead
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    development: false,
    async fetch(req) {
      const url = new URL(req.url);
      const cap = Number(req.headers.get("x-test-cap") ?? CAP);
      // the body is buffered before it is handed back rather than re-wrapped.
      // A `new Response(res.body)` here turns a measured answer into a
      // streamed one, and bun drops a streamed response whose client has
      // already half-closed - which made a refusal that WAS written look like
      // a refusal that was not. That is this fixture's artefact, not borgo's:
      // `bodyTooLarge` states its own length and goes out whole.
      const say = async (res: Response, read: string) => {
        const headers = new Headers(res.headers);
        headers.set("x-read", read);
        return new Response(await res.text(), { status: res.status, headers });
      };
      try {
        if (url.pathname.startsWith("/api/")) {
          const res = await proxyRequest(req, {
            target: `http://127.0.0.1:${upstream.port}${url.pathname}`,
            deadlineMs: 0,
            retries: 0,
            maxBody: cap,
            onError: () => {},
          });
          return await say(res, res.headers.get("x-read") ?? "-");
        }
        if (url.pathname === "/big") {
          // a large RESPONSE under a tiny request limit: the two directions
          // are not the same limit and must not become one
          return new Response("y".repeat(1024 * 1024), { headers: { "x-read": "-" } });
        }
        const target: RouteMatch | null = matchRoute(url.pathname, [
          route({
            action: async ({ request }) => ({
              got: String((await request.formData()).get("t") ?? "").length,
            }),
          }),
        ]);
        const answered = await runAction(req, target, actionOptions(cap));
        if (!answered) return new Response("no action", { status: 405, headers: { "x-read": "-" } });
        const envelope = await answered.clone().text();
        return await say(answered, /"got":(\d+)/.exec(envelope)?.[1] ?? "-");
      } catch (error) {
        // what serve() would answer: the body read broke under us
        return new Response(`handler threw: ${(error as Error)?.message}\n`, {
          status: 500,
          headers: { "x-read": "-" },
        });
      }
    },
  });
});

afterAll(() => {
  front?.stop(true);
  upstream?.stop(true);
});

// ------------------------------------------------------------- the ledger

const rows: string[] = [];
const record = (name: string, path: string, r: Sent) =>
  rows.push(
    `${name.padEnd(30)} ${path.padEnd(5)} ${String(r.status ?? (r.silent ? "SILENT" : "?")).padEnd(7)} read=${(r.read ?? "-").padEnd(10)} ${JSON.stringify(r.body.slice(0, 44))}`,
  );

const both = async (name: string, cap: number, shape: Shape) => {
  const a = await form(cap, shape);
  const b = await api(cap, shape);
  record(name, "form", a);
  record(name, "/api", b);
  return { form: a, api: b };
};

describe("BORGO_MAX_BODY: every framing, on a real socket", () => {
  test(
    "under the limit passes, declared and chunked alike",
    async () => {
      const declared = await both("under, declared", CAP, { declare: 32, send: 32 });
      expect(declared.form.status).toBe(200);
      expect(declared.form.read).toBe("30"); // "t=" + 30 filler
      expect(declared.api.status).toBe(200);
      expect(declared.api.read).toBe("32");

      const chunked = await both("under, chunked", CAP, { declare: null, send: 32 });
      expect(chunked.form.status).toBe(200);
      expect(chunked.form.read).toBe("30");
      expect(chunked.api.status).toBe(200);
      expect(chunked.api.read).toBe("32");
    },
    SLOW,
  );

  test(
    "exactly at the limit passes, declared and chunked alike",
    async () => {
      const declared = await both("exact, declared", CAP, { declare: CAP, send: CAP });
      expect(declared.form.status).toBe(200);
      expect(declared.form.read).toBe(String(CAP - 2));
      expect(declared.api.status).toBe(200);
      expect(declared.api.read).toBe(String(CAP));

      const chunked = await both("exact, chunked", CAP, { declare: null, send: CAP });
      expect(chunked.form.status).toBe(200);
      expect(chunked.form.read).toBe(String(CAP - 2));
      expect(chunked.api.status).toBe(200);
      expect(chunked.api.read).toBe(String(CAP));
    },
    SLOW,
  );

  test(
    "one byte over is 413, declared and chunked alike",
    async () => {
      const declared = await both("one over, declared", CAP, { declare: CAP + 1, send: CAP + 1 });
      expect(declared.form.status).toBe(413);
      expect(declared.form.body).toContain("request body too large");
      expect(declared.api.status).toBe(413);
      expect(declared.api.body).toContain("request body too large");

      // THE CASE THE OLD LIMIT NEVER SAW: one byte over, framed by nothing bun
      // could count in advance
      const chunked = await both("one over, chunked", CAP, { declare: null, send: CAP + 1 });
      expect(chunked.form.status).toBe(413);
      expect(chunked.form.body).toContain("request body too large");
      expect(chunked.api.status).toBe(413);
      expect(chunked.api.body).toContain("request body too large");
      // and go never saw it
      expect(chunked.api.read).toBe("-");
    },
    SLOW,
  );

  test(
    "far over answers 413 with a body, and does not die silently",
    async () => {
      const MB = 1024 * 1024;
      // this exact shape used to close the socket with nothing written at all
      const declared = await both("1 MiB, declared", CAP, { declare: MB, send: MB });
      expect(declared.form.silent).toBe(false);
      expect(declared.form.status).toBe(413);
      expect(declared.form.body).toContain("request body too large");
      expect(declared.api.silent).toBe(false);
      expect(declared.api.status).toBe(413);

      const one = await both("1 MiB, chunked, 1 chunk", CAP, { declare: null, send: MB });
      expect(one.form.status).toBe(413);
      expect(one.api.status).toBe(413);

      const many = await both("1 MiB, chunked, 1000 chunks", CAP, { declare: null, send: MB, pieces: 1000 });
      expect(many.form.status).toBe(413);
      expect(many.api.status).toBe(413);
    },
    SLOW,
  );

  test(
    "a chunked body that stops halfway is refused if it is over, and never completes if it is not",
    async () => {
      // over the limit before it stops: the count decides while the client
      // still holds the socket, and it does not wait for a terminating chunk
      // that is not coming
      const long = await both("chunked halted, over cap", CAP, { declare: null, send: 4096, halt: true });
      expect(long.form.status).toBe(413);
      expect(long.api.status).toBe(413);

      // and it decides even when the client then leaves
      const gone = await both("chunked hangup, over cap", CAP, { declare: null, send: 4096, hangup: true });
      expect(gone.form.status).not.toBe(200);
      expect(gone.api.status).not.toBe(200);

      // under the limit and unfinished: the body never ends, so it must never
      // reach an action as if it had - and the read must not be sitting on a
      // buffer it has already accepted
      const short = await both("chunked halted, under cap", CAP, { declare: null, send: 40, hangup: true });
      expect(short.form.status).not.toBe(200);
      expect(short.api.status).not.toBe(200);
    },
    SLOW,
  );

  test(
    "a Content-Length that lies in excess is refused on the declaration alone",
    async () => {
      // declares 200 against a cap of 64 and then sends only half of it: the
      // refusal must not have waited for bytes that were never coming
      const r = await both("CL lies high (200/100)", CAP, { declare: 200, send: 200, halt: true });
      expect(r.form.status).toBe(413);
      expect(r.api.status).toBe(413);

      // and the same lie from a client that then leaves is still never served
      const gone = await both("CL lies high, hangup", CAP, { declare: 200, send: 200, hangup: true });
      expect(gone.form.status).not.toBe(200);
      expect(gone.api.status).not.toBe(200);
    },
    SLOW,
  );

  test(
    "a Content-Length that lies low cannot smuggle bytes past the count",
    async () => {
      // declares 64 - allowed - and then writes 256. bun frames the body by
      // the declaration, so what borgo reads is 64 and the surplus is not
      // body at all. (At 1 MiB of surplus the connection desynchronises and
      // bun kills it before anything is written back, which is bun's framing
      // and not this limit; measured, and not asserted here.)
      const a = await form(CAP, { declare: CAP, send: 256 });
      record("CL lies low (64/256)", "form", a);
      expect(a.status).toBe(200);
      expect(Number(a.read)).toBe(CAP - 2);

      const b = await api(CAP, { declare: CAP, send: 256 });
      record("CL lies low (64/256)", "/api", b);
      expect(b.status).toBe(200);
      expect(Number(b.read)).toBe(CAP);
    },
    SLOW,
  );

  test(
    "an empty body, and no body at all, are not refused",
    async () => {
      const empty = await both("empty body, declared 0", CAP, { declare: 0, send: 0 });
      expect(empty.form.status).toBe(200);
      expect(empty.api.status).toBe(200);

      const chunked = await both("empty body, chunked", CAP, { declare: null, send: 0 });
      expect(chunked.form.status).toBe(200);
      expect(chunked.api.status).toBe(200);
    },
    SLOW,
  );

  test(
    "BORGO_MAX_BODY=0 still means no limit at all",
    async () => {
      // and handed to bun it did NOT: `maxRequestBodySize: 0` makes bun refuse
      // EVERY body - measured, a 1000-byte POST answered 413 - which is the
      // exact inverse of what the variable documents
      const MB = 1024 * 1024;
      const declared = await form(0, { declare: MB, send: MB });
      record("cap=0, 1 MiB declared", "form", declared);
      expect(declared.status).toBe(200);
      expect(declared.read).toBe(String(MB - 2));

      const chunked = await api(0, { declare: null, send: MB, pieces: 64 });
      record("cap=0, 1 MiB chunked", "/api", chunked);
      expect(chunked.status).toBe(200);
      expect(chunked.read).toBe(String(MB));

      const small = await form(0, { declare: 10, send: 10 });
      record("cap=0, 10 B declared", "form", small);
      expect(small.status).toBe(200);
      expect(small.read).toBe("8");
    },
    SLOW,
  );
});

// ------------------------------------------------------------------- memory

describe("BORGO_MAX_BODY: what is actually allocated", () => {
  // a source that produces a chunk only when someone pulls it, so "how much
  // was produced" IS "how much borgo read". A status-code assertion would pass
  // just as happily with the whole 100 MiB buffered first, which is the one
  // thing the limit exists to prevent.
  const lazy = (total: number, chunk: number) => {
    let produced = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced >= total) return controller.close();
        const n = Math.min(chunk, total - produced);
        produced += n;
        controller.enqueue(new Uint8Array(n));
      },
    });
    return { stream, produced: () => produced };
  };

  const HUNDRED_MIB = 100 * 1024 * 1024;

  test("a 100 MiB body under a 64 byte cap is never pulled past one chunk", async () => {
    const src = lazy(HUNDRED_MIB, 1024 * 1024);
    const req = new Request("http://app.test/form", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: src.stream,
      // @ts-expect-error bun accepts duplex on a streamed request body
      duplex: "half",
    });
    expect(await limitRequestBody(req, CAP)).toBe(null);
    // one chunk, not a hundred: the read stopped AT the limit instead of
    // discovering the size after holding it
    expect(src.produced()).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  test("readBodyWithin drops the chunk that crosses the limit", async () => {
    const src = lazy(HUNDRED_MIB, 4096);
    expect(await readBodyWithin(src.stream, CAP)).toBe(null);
    expect(src.produced()).toBe(4096);
  });

  // IN ANOTHER PROCESS, because a client that writes 100 MiB and a server that
  // refuses to read it cannot share an RSS reading: measured in-process the
  // delta was 167 MiB, all of it the sending half's own buffers, and the
  // number said nothing about the half under test. The child holds only the
  // server.
  // the port is assigned by the parent rather than reported by the child: a
  // child's console.log through a pipe is block-buffered and the line never
  // arrives (measured - the parent waited 5s for a port the child had already
  // bound)
  // absolute, because the script is written to a temp directory and a relative
  // import would resolve beside it rather than beside the repo
  const UTIL = Bun.pathToFileURL(join(process.cwd(), "packages/borgo/src/util.ts")).href;
  const CHILD = `
import { limitRequestBody } from ${JSON.stringify(UTIL)};
const server = Bun.serve({
  port: Number(process.env.CHILD_PORT),
  maxRequestBodySize: Number.MAX_SAFE_INTEGER,
  development: false,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/rss") { Bun.gc(true); return new Response(String(process.memoryUsage().rss)); }
    if (url.pathname === "/stop") { setTimeout(() => process.exit(0), 10); return new Response("bye"); }
    try {
      const limited = await limitRequestBody(req, 64);
      if (limited === null) return new Response("too large", { status: 413 });
      return new Response("read " + (await limited.arrayBuffer()).byteLength);
    } catch { return new Response("broke", { status: 400 }); }
  },
});
// A DEAD MAN'S SWITCH. Bun.spawn's kill did not end this process on windows
// (measured: two of them outlived the runs that spawned them), and a survivor
// holding an inherited stdout keeps the whole pipeline's reader waiting - a
// test run that had finished sat there for four minutes. It closes its own
// door: the parent asks first, this is the backstop.
setTimeout(() => process.exit(0), 150_000);
`;

  const freePort = () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = Number(probe.port);
    probe.stop(true);
    return port;
  };

  test(
    "a 100 MiB body under a 64 byte cap allocates nothing in the process that refuses it",
    async () => {
      const port = freePort();
      // a file, not `bun -e`: the eval flag came back with bun's own usage
      // banner here and no server at all
      const script = join(tmpdir(), `borgo-body-limit-${port}.ts`);
      await Bun.write(script, CHILD);
      const child = Bun.spawn(["bun", script], {
        cwd: process.cwd(),
        env: { ...process.env, CHILD_PORT: String(port) },
        // never the parent's streams: a child that outlives its kill keeps an
        // inherited pipe open, and the reader on the other end waits forever
        stdout: "ignore",
        stderr: "ignore",
      });
      try {
        const rss = async () => Number(await (await fetch(`http://127.0.0.1:${port}/rss`)).text());
        let up = 0;
        for (let i = 0; i < 100 && !up; i++) {
          up = await rss().catch(() => 0);
          if (!up) await Bun.sleep(100);
        }
        expect(up).toBeGreaterThan(0);
        const blast = (shape: Shape) =>
          new Promise<number | null>((resolve) => {
            const sock = net.connect(port, "127.0.0.1");
            let raw = "";
            let settled = false;
            const done = () => {
              if (settled) return;
              settled = true;
              try {
                sock.destroy();
              } catch {}
              resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1] ?? 0) || null);
            };
            sock.on("connect", async () => {
              sock.write(
                `POST /x HTTP/1.1\r\nHost: h\r\n` +
                  (shape.declare === null
                    ? "Transfer-Encoding: chunked\r\n\r\n"
                    : `Content-Length: ${shape.declare}\r\n\r\n`),
              );
              // one buffer, reused: the sender must not be the thing that grows
              const piece = Buffer.alloc(1024 * 1024, 0x78);
              for (let at = 0; at < shape.send && !settled; at += piece.length) {
                if (shape.declare === null && !sock.write(`${piece.length.toString(16)}\r\n`)) {
                  await Promise.race([
                    new Promise<void>((r) => sock.once("drain", () => r())),
                    Bun.sleep(2000),
                  ]);
                }
                if (!sock.write(piece)) {
                  const ok = await Promise.race([
                    new Promise<boolean>((r) => sock.once("drain", () => r(true))),
                    Bun.sleep(2000).then(() => false),
                  ]);
                  if (!ok) break;
                }
                if (shape.declare === null) sock.write("\r\n");
              }
            });
            sock.on("data", (d) => {
              raw += d.toString("latin1");
              if (raw.includes("\r\n\r\n")) setTimeout(done, 50);
            });
            sock.on("error", done);
            sock.on("close", done);
            setTimeout(done, 20_000);
          });

        // warm: the first request pulls in whatever the server allocates once
        await blast({ declare: 32, send: 32 });
        const before = await rss();
        const declared = await blast({ declare: HUNDRED_MIB, send: HUNDRED_MIB });
        const chunked = await blast({ declare: null, send: HUNDRED_MIB });
        const after = await rss();
        const grew = after - before;
        rows.push(
          `${"child rss".padEnd(30)} ${(before / 1048576).toFixed(1)} -> ${(after / 1048576).toFixed(1)} MiB ` +
            `(delta ${(grew / 1048576).toFixed(1)}) after 2 x 100 MiB refused, declared=${declared} chunked=${chunked}`,
        );
        expect(declared).toBe(413);
        expect(chunked).toBe(413);
        // 200 MiB arrived at this process and 64 bytes of it were ever
        // allowed to be held. The slack is for bun's own socket buffers,
        // not for a body.
        expect(grew).toBeLessThan(16 * 1024 * 1024);
      } finally {
        // asked, then killed, then waited for: the ask is what actually works
        await fetch(`http://127.0.0.1:${port}/stop`).catch(() => {});
        child.kill(9);
        await Promise.race([child.exited, Bun.sleep(5000)]);
        await unlink(script).catch(() => {});
      }
    },
    180_000,
  );
});

// --------------------------------------------------- what must NOT be limited

describe("BORGO_MAX_BODY: what the limit does not reach", () => {
  test("an event stream answering a bounded request is not bounded with it", async () => {
    // the response side is a different direction and a different clock: an SSE
    // or ndjson answer to a request whose BODY was within the limit must not
    // acquire a limit of its own. Driven through the injected fetch, and with
    // a stream that enqueues without awaiting, because on this bun a
    // ReadableStream whose producer awaits at all is never drainable - it
    // stalls a plain `new Response(stream).text()` and a bare `getReader()`
    // loop alike, with no borgo in the picture. The chunk count is what
    // matters here: 64 of them, through a 64 byte request limit.
    const events = new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        for (let i = 0; i < 64; i++) c.enqueue(enc.encode(`data: ${i}\n\n`.padEnd(1024, " ")));
        c.close();
      },
    });
    const res = await proxyRequest(
      new Request("http://app.test/api/feed", {
        method: "POST",
        headers: { "content-length": "4" },
        body: "ping",
      }),
      {
        target: "http://upstream.test/api/feed",
        deadlineMs: 0,
        retries: 0,
        maxBody: CAP,
        fetchImpl: async () => new Response(events, { headers: { "Content-Type": "text/event-stream" } }),
      },
    );
    expect(res.status).toBe(200);
    // 64 KiB of response through a 64 byte request limit
    expect((await res.text()).length).toBeGreaterThan(60_000);
  });

  test(
    "a 1 MiB response comes back whole through a 64 byte request limit, over a real socket",
    async () => {
      const res = await fetch(`http://127.0.0.1:${front.port}/big`, {
        method: "POST",
        headers: { "X-Test-Cap": String(CAP) },
      });
      expect(res.status).toBe(200);
      expect((await res.text()).length).toBe(1024 * 1024);
    },
    SLOW,
  );

  test("a GET carrying a forged Content-Length is not refused on it", async () => {
    // GET and HEAD have no body to count, and the header is the client's
    const res = await proxyRequest(
      new Request("http://app.test/api/x", {
        method: "GET",
        headers: { "content-length": String(10 * 1024 * 1024) },
      }),
      {
        target: "http://upstream.test/api/x",
        deadlineMs: 0,
        retries: 0,
        maxBody: CAP,
        fetchImpl: async () => new Response("ok"),
      },
    );
    expect(res.status).toBe(200);
  });

  test("a post to a page with no action never reads a body at all", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(4096));
      },
    });
    const req = new Request("http://app.test/nope", {
      method: "POST",
      body,
      // @ts-expect-error bun accepts duplex on a streamed request body
      duplex: "half",
    });
    // bun pulls once while building the Request, on a later tick; the baseline
    // is taken after that, so what is measured is what runAction did and
    // nothing else
    await Bun.sleep(25);
    const baseline = pulled;
    // no route, so runAction hands it back as "not mine" - and must not have
    // bounded, buffered, or otherwise touched a body on the way
    expect(await runAction(req, null, actionOptions(CAP))).toBe(null);
    expect(pulled).toBe(baseline);
  });
});

// ---------------------------------------------------------------- the pieces

describe("the pieces the limit is built from", () => {
  test("framedLength reads a length only when a length frames the body", () => {
    expect(framedLength(new Headers({ "content-length": "5" }))).toBe(5);
    expect(framedLength(new Headers({ "content-length": "5, 5" }))).toBe(5);
    expect(framedLength(new Headers({ "content-length": "5, 9" }))).toBe(null);
    expect(framedLength(new Headers())).toBe(null);
    expect(framedLength(new Headers({ "transfer-encoding": "chunked" }))).toBe(null);
    // rfc 9112 §6.3: the length beside a transfer-encoding is not a length.
    // bun answers that pair 400 itself (measured), so this is the guard for
    // every other caller of these exported functions
    expect(framedLength(new Headers({ "content-length": "4", "transfer-encoding": "chunked" }))).toBe(null);
  });

  test("shouldBufferBody will not size a body its framing cannot size", () => {
    expect(shouldBufferBody("POST", "512")).toBe(true);
    expect(shouldBufferBody("POST", "512", "chunked")).toBe(false);
    expect(shouldBufferBody("POST", "512", "gzip, chunked")).toBe(false);
  });

  test("limitRequestBody hands back the same request when there is nothing to bound", async () => {
    const nobody = new Request("http://app.test/x", { method: "POST" });
    expect(await limitRequestBody(nobody, CAP)).toBe(nobody);
    const unlimited = new Request("http://app.test/x", { method: "POST", body: "x".repeat(1000) });
    expect(await limitRequestBody(unlimited, 0)).toBe(unlimited);
  });

  test("the limited request keeps the original's abort signal, not a copy", async () => {
    const control = new AbortController();
    const req = new Request("http://app.test/x", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "t=abc",
      signal: control.signal,
    });
    const limited = await limitRequestBody(req, CAP);
    expect(limited).not.toBe(null);
    control.abort();
    // runAction and serve() both ask a request whether the client is still
    // there; a copied signal would answer "still here" forever
    expect(limited!.signal.aborted).toBe(true);
  });

  test("the limited request is still parseable twice - the csrf clone, then the action", async () => {
    const req = new Request("http://app.test/x", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "t=abc&borgo_csrf=tok",
    });
    const limited = (await limitRequestBody(req, CAP))!;
    expect(String((await limited.clone().formData()).get("borgo_csrf"))).toBe("tok");
    expect(String((await limited.formData()).get("t"))).toBe("abc");
  });

  test("the 413 carries a body and names the variable", async () => {
    const res = bodyTooLarge(64);
    expect(res.status).toBe(413);
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toContain("BORGO_MAX_BODY=64");
  });

  test("a BORGO_MAX_BODY nobody can read is refused before a port is bound", () => {
    // the same grammar every other switch uses, and the refusal has to happen
    // in resolveSwitches - which serve-entry calls above the try that would
    // otherwise answer it from a bound fallback port
    expect(() => resolveSwitches({ BORGO_MAX_BODY: "lots" }, false)).toThrow(/BORGO_MAX_BODY/);
    expect(() => resolveSwitches({ BORGO_MAX_BODY: "0.5" }, false)).toThrow(/BORGO_MAX_BODY/);
    expect(() => resolveSwitches({ BORGO_MAX_BODY: "-1" }, false)).toThrow(/BORGO_MAX_BODY/);
    expect(() => resolveSwitches({ BORGO_MAX_BODY: "64\r" }, false)).toThrow(/BORGO_MAX_BODY/);
    expect(resolveSwitches({ BORGO_MAX_BODY: "0" }, false).maxBody).toBe(0);
    expect(resolveSwitches({ BORGO_MAX_BODY: "64" }, false).maxBody).toBe(64);
  });
});

// -------------------------------------------------------- the coupling guard

describe("every request body borgo reads is counted", () => {
  // server.ts hands bun MAX_SAFE_INTEGER now, so bun is no longer the backstop
  // under a path that forgets to count. THIS is what makes that safe: a fourth
  // body read appearing anywhere in src/ fails the build until it goes through
  // limitRequestBody, readBodyWithin, or the proxy's counting pass-through.
  const KNOWN: Record<string, string[]> = {
    // the csrf clone, reached only from runAction, whose body limitRequestBody
    // has already bounded; the proxy's buffered branch, bounded by the
    // declaration it checked; and the two halves of the counter itself
    "util.ts": ["req.clone().formData()", "req.arrayBuffer()", "req.body.pipeThrough(", "body.getReader()"],
    // the push endpoint, bounded at its call site
    "server.ts": ["limited.json()"],
  };
  // substrings, judged a line at a time with comments dropped: a regex over
  // whole files matched borgo's own prose about the reads (and took 19s doing
  // it), and a guard that fires on a comment is a guard nobody keeps
  const READS = [
    ".arrayBuffer()",
    ".formData()",
    ".json()",
    ".text()",
    ".blob()",
    ".bytes()",
    ".getReader()",
    ".pipeThrough(",
  ];

  // generous: reading src/ cold off this filesystem was measured at 13.5s
  // against 12ms warm
  test("no unbounded body read has appeared in src/", async () => {
    const found: string[] = [];
    for (const file of new Bun.Glob("*.ts").scanSync("packages/borgo/src")) {
      const allowed = KNOWN[file] ?? [];
      const source = await Bun.file(`packages/borgo/src/${file}`).text();
      for (const raw of source.split("\n")) {
        const line = raw.trim();
        if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) continue;
        // only reads of the inbound request; a Response's own body is not a
        // request body and is not what this limit is about
        if (!/\b(?:req|request|original|limited)\b/.test(line)) continue;
        for (const read of READS) {
          if (!line.includes(read)) continue;
          if (allowed.some((a) => line.includes(a))) continue;
          found.push(`${file}: ${line}`);
        }
      }
    }
    expect(found).toEqual([]);
  }, SLOW);
});

afterAll(() => {
  if (rows.length) {
    console.log(["", "  BODY LIMIT LEDGER (cap = 64 unless stated)", ...rows.map((r) => "  " + r), ""].join("\n"));
  }
});
