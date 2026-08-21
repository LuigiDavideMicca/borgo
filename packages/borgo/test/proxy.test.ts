import { describe, expect, test } from "bun:test";
import { proxyRequest, type ProxyFetch, type ProxyOptions } from "../src/util";

// the proxy is driven entirely through injected seams: fetchImpl stands in for
// the go api, sleep collapses the retry backoff, onError keeps the run quiet
const opts = (over: Partial<ProxyOptions> = {}): ProxyOptions => ({
  target: "http://api.test/api/x",
  deadlineMs: 50,
  retries: 3,
  // the default for every test that is not about the body limit: no limit, so
  // the framing tests below measure framing and nothing else
  maxBody: 0,
  sleep: async () => {},
  onError: () => {},
  ...over,
});

const refused = () => Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), {
  code: "ConnectionRefused",
});

const req = (method = "GET", init: { headers?: Record<string, string>; body?: BodyInit } = {}) =>
  new Request("http://app.test/api/x", {
    method,
    headers: init.headers,
    ...(init.body === undefined ? {} : { body: init.body }),
  });

describe("proxyRequest: connection refused", () => {
  test("a refused connection is retried, then answered 502", async () => {
    let calls = 0;
    const slept: number[] = [];
    const res = await proxyRequest(
      req(),
      opts({
        retries: 3,
        retryDelayMs: 250,
        sleep: async (ms) => void slept.push(ms),
        fetchImpl: async () => {
          calls++;
          throw refused();
        },
      }),
    );
    expect(res.status).toBe(502);
    expect(await res.text()).toBe("api unreachable");
    // retries: 3 means the first attempt plus three more
    expect(calls).toBe(4);
    expect(slept).toEqual([250, 250, 250]);
  });

  test("the api coming back mid-retry is served, not counted as a failure", async () => {
    let calls = 0;
    const res = await proxyRequest(
      req(),
      opts({
        fetchImpl: async () => {
          if (++calls < 3) throw refused();
          return new Response("late but here", { status: 200 });
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("late but here");
    expect(calls).toBe(3);
  });

  test("retries: 0 answers 502 on the first refusal", async () => {
    let calls = 0;
    const res = await proxyRequest(
      req(),
      opts({
        retries: 0,
        fetchImpl: async () => {
          calls++;
          throw refused();
        },
      }),
    );
    expect(res.status).toBe(502);
    expect(calls).toBe(1);
  });

  test("every shape of refusal bun reports is recognised", async () => {
    for (const err of [
      Object.assign(new Error("x"), { code: "ConnectionRefused" }),
      Object.assign(new Error("x"), { code: "ECONNREFUSED" }),
      new Error("connect ECONNREFUSED 127.0.0.1:3501"),
      new Error("Unable to connect. Is the computer able to access the url?"),
    ]) {
      let calls = 0;
      await proxyRequest(
        req(),
        opts({
          retries: 1,
          fetchImpl: async () => {
            calls++;
            throw err;
          },
        }),
      );
      expect(calls).toBe(2);
    }
  });

  test("a failure that is not a refusal is not retried", async () => {
    let calls = 0;
    const logged: unknown[] = [];
    const res = await proxyRequest(
      req(),
      opts({
        onError: (v) => void logged.push(v),
        fetchImpl: async () => {
          calls++;
          throw new TypeError("Invalid HTTP response received from server");
        },
      }),
    );
    expect(res.status).toBe(502);
    expect(calls).toBe(1);
    expect((logged[0] as Error).message).toContain("Invalid HTTP response");
  });
});

describe("proxyRequest: retriability of bodies", () => {
  const attempts = async (r: Request, over: Partial<ProxyOptions> = {}) => {
    let calls = 0;
    await proxyRequest(
      r,
      opts({
        retries: 2,
        fetchImpl: async () => {
          calls++;
          throw refused();
        },
        ...over,
      }),
    );
    return calls;
  };

  test("a small declared body is buffered, so it can be re-sent", async () => {
    expect(await attempts(req("POST", { headers: { "content-length": "5" }, body: "hello" }))).toBe(3);
  });

  test("a repeated content-length still buffers - and still retries", async () => {
    // rfc 9112 §6.3; Headers joins the repeats into "5, 5", which Number()
    // reads as NaN. the whole retry hangs off that parse
    expect(await attempts(req("POST", { headers: { "content-length": "5, 5" }, body: "hello" }))).toBe(3);
  });

  test("repeats that disagree are no length: the body streams, unretried", async () => {
    expect(await attempts(req("POST", { headers: { "content-length": "5, 9" }, body: "hello" }))).toBe(1);
  });

  test("an unsized (chunked) body streams through once, without retry", async () => {
    expect(await attempts(req("POST", { body: "hello" }))).toBe(1);
  });

  test("a body past the buffer cap streams through once, without retry", async () => {
    expect(
      await attempts(req("POST", { headers: { "content-length": String(11 * 1024 * 1024) }, body: "x" })),
    ).toBe(1);
  });

  test("a body-less post is as retriable as a get", async () => {
    expect(await attempts(req("POST"))).toBe(3);
    expect(await attempts(req("DELETE"))).toBe(3);
  });

  test("get and head are always retriable", async () => {
    expect(await attempts(req("GET"))).toBe(3);
    expect(await attempts(req("HEAD"))).toBe(3);
  });

  test("a buffered body is re-sent byte for byte on the retry", async () => {
    const seen: string[] = [];
    let calls = 0;
    await proxyRequest(
      req("POST", { headers: { "content-length": "11" }, body: "hello world" }),
      opts({
        retries: 2,
        fetchImpl: async (_t, init) => {
          seen.push(new TextDecoder().decode(init.body as ArrayBuffer));
          if (++calls < 2) throw refused();
          return new Response("ok");
        },
      }),
    );
    expect(seen).toEqual(["hello world", "hello world"]);
  });
});

describe("proxyRequest: the header deadline", () => {
  // an upstream that accepts the connection and then says nothing
  const hung: ProxyFetch = (_t, init) =>
    new Promise((_resolve, reject) => {
      const signal = init.signal;
      signal?.addEventListener("abort", () => reject(new Error("The operation was aborted.")));
    });

  test("an upstream that never answers becomes a 504", async () => {
    const t0 = performance.now();
    const res = await proxyRequest(req(), opts({ deadlineMs: 30, fetchImpl: hung }));
    expect(res.status).toBe(504);
    expect(await res.text()).toBe("api timeout");
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  test("a deadline that fires under arriving headers answers 504, not an empty 200", async () => {
    // the abort tore the connection down, but fetch still resolved - with a
    // body that ends at zero bytes. a 200 here is indistinguishable from a
    // genuinely empty answer, and on sse it is a stream dead on arrival
    let cancelled = false;
    const late: ProxyFetch = (_t, init) =>
      new Promise((resolve) => {
        init.signal?.addEventListener("abort", () =>
          setTimeout(
            () =>
              resolve(
                new Response(
                  new ReadableStream({
                    cancel() {
                      cancelled = true;
                    },
                  }),
                  { status: 200, headers: { "Content-Type": "text/event-stream" } },
                ),
              ),
            5,
          ),
        );
      });
    const res = await proxyRequest(req(), opts({ deadlineMs: 20, fetchImpl: late }));
    expect(res.status).toBe(504);
    expect(await res.text()).toBe("api timeout");
    // and the upstream body is not left dangling
    await Bun.sleep(5);
    expect(cancelled).toBe(true);
  });

  test("a timeout is never retried, however refused-looking the error", async () => {
    // the deadline already decided. a naive `isConnRefused(err) -> retry`
    // would sit here for retries x deadline before answering anything
    let calls = 0;
    const t0 = performance.now();
    const res = await proxyRequest(
      req(),
      opts({
        deadlineMs: 20,
        retries: 5,
        fetchImpl: (_t, init) =>
          new Promise((_resolve, reject) => {
            calls++;
            init.signal?.addEventListener("abort", () => reject(refused()));
          }),
      }),
    );
    expect(res.status).toBe(504);
    expect(calls).toBe(1);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  // the attempt has to sit well inside the deadline and three of them well
  // outside it; at 20 against 60 a sleep stretched past 60 by the machine read
  // as a shared deadline (1/5 under 16 burners on 8 cores, 504 for 200)
  const ATTEMPT_MS = 400;
  const OWN_DEADLINE_MS = 1000;

  test("each retry gets its own deadline, and a slow success is not timed out", async () => {
    let calls = 0;
    const res = await proxyRequest(
      req(),
      opts({
        deadlineMs: OWN_DEADLINE_MS,
        retries: 3,
        fetchImpl: async () => {
          if (++calls < 3) {
            await Bun.sleep(ATTEMPT_MS);
            throw refused();
          }
          await Bun.sleep(ATTEMPT_MS);
          return new Response("ok");
        },
      }),
    );
    // three attempts, 1200ms of waiting in total: a deadline shared across
    // the loop would have fired on the last one
    expect(res.status).toBe(200);
    expect(calls).toBe(3);
  }, 15_000);

  test("deadlineMs: 0 disables the deadline entirely", async () => {
    let signal: AbortSignal | null | undefined;
    const res = await proxyRequest(
      req(),
      opts({
        deadlineMs: 0,
        fetchImpl: async (_t, init) => {
          signal = init.signal;
          await Bun.sleep(30);
          return new Response("slow but fine");
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(signal).toBeUndefined();
  });

  test("the deadline is dropped once headers arrive: a long stream outlives it", async () => {
    // sse: the response resolves fast, the body runs for far longer than the
    // deadline. a deadline covering the whole exchange would kill it.
    const res = await proxyRequest(
      req(),
      opts({
        deadlineMs: 25,
        fetchImpl: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              async start(controller) {
                for (let i = 0; i < 4; i++) {
                  await Bun.sleep(15);
                  controller.enqueue(new TextEncoder().encode(`data: ${i}\n\n`));
                }
                controller.close();
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          ),
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("data: 0");
    expect(text).toContain("data: 3");
  });
});

describe("proxyRequest: upstream responses", () => {
  test("an upstream 101 becomes a 502 instead of a desynchronised client", async () => {
    let cancelled = false;
    const logged: unknown[] = [];
    const res = await proxyRequest(
      req(),
      opts({
        target: "http://api.test/api/socket?x=1",
        onError: (v) => void logged.push(v),
        fetchImpl: async () =>
          new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
            { status: 101, headers: { Upgrade: "websocket" } },
          ),
      }),
    );
    expect(res.status).toBe(502);
    expect(await res.text()).toBe("api upgrade not supported");
    expect(res.headers.get("Upgrade")).toBeNull();
    await Bun.sleep(5);
    expect(cancelled).toBe(true);
    // the log names the path, not the whole target with its query
    expect(logged[0]).toBe("/api/socket answered 101; /api cannot tunnel an upgrade");
  });

  test("every other status is handed back untouched, headers and all", async () => {
    for (const status of [200, 204, 301, 400, 404, 418, 500, 503]) {
      const res = await proxyRequest(
        req(),
        opts({
          fetchImpl: async () =>
            new Response(status === 204 ? null : "body", {
              status,
              headers: { "X-Go": "yes", "Content-Type": "application/json", "Set-Cookie": "s=1; HttpOnly" },
            }),
        }),
      );
      expect(res.status).toBe(status);
      expect(res.headers.get("X-Go")).toBe("yes");
      expect(res.headers.getSetCookie()).toEqual(["s=1; HttpOnly"]);
    }
  });

  test("go's own content-encoding survives: the proxy must not re-frame it", async () => {
    const gz = Bun.gzipSync(new TextEncoder().encode("compressed by go"));
    let init: RequestInit | undefined;
    const res = await proxyRequest(
      req("GET", { headers: { "accept-encoding": "gzip" } }),
      opts({
        fetchImpl: async (_t, i) => {
          init = i;
          return new Response(gz, {
            headers: { "Content-Encoding": "gzip", "Content-Type": "text/plain" },
          });
        },
      }),
    );
    expect((init as { decompress?: boolean }).decompress).toBe(false);
    expect(res.headers.get("Content-Encoding")).toBe("gzip");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(gz));
  });

  test("an upstream that dies mid-body keeps its status: the headers already shipped", async () => {
    const res = await proxyRequest(
      req(),
      opts({
        fetchImpl: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("half"));
                controller.error(new Error("connection reset"));
              },
            }),
            { status: 200, headers: { "Content-Length": "8" } },
          ),
      }),
    );
    // there is no 502 to give: 200 and the length were already committed
    expect(res.status).toBe(200);
    expect(res.text()).rejects.toThrow();
  });

  test("a malformed upstream (fetch itself rejects) is a 502, unretried", async () => {
    let calls = 0;
    const res = await proxyRequest(
      req(),
      opts({
        fetchImpl: async () => {
          calls++;
          throw Object.assign(new Error("Headers overflow"), { code: "ERR_HTTP_HEADERS_OVERFLOW" });
        },
      }),
    );
    expect(res.status).toBe(502);
    expect(calls).toBe(1);
  });
});

describe("proxyRequest: the outbound request", () => {
  test("method, target and query are the ones the browser asked for", async () => {
    let seen: [string, string] = ["", ""];
    await proxyRequest(
      req("PATCH", { headers: { "content-length": "2" }, body: "hi" }),
      opts({
        target: "http://localhost:3501/api/users/7?full=1&q=a%20b",
        fetchImpl: async (t, init) => {
          seen = [String(t), init.method!];
          return new Response("ok");
        },
      }),
    );
    expect(seen).toEqual(["http://localhost:3501/api/users/7?full=1&q=a%20b", "PATCH"]);
  });

  test("hop-by-hop headers stop here; everything the app needs goes on", async () => {
    let headers: Headers | undefined;
    await proxyRequest(
      req("GET", {
        headers: {
          connection: "keep-alive, X-Api-Key",
          "keep-alive": "timeout=5",
          upgrade: "websocket",
          "transfer-encoding": "chunked",
          "proxy-authorization": "Basic Zm9v",
          "x-api-key": "stripped-by-connection",
          cookie: "borgo_session=abc",
          authorization: "Bearer t",
          "accept-encoding": "gzip",
        },
      }),
      opts({
        fetchImpl: async (_t, init) => {
          headers = new Headers(init.headers);
          return new Response("ok");
        },
      }),
    );
    for (const name of ["connection", "keep-alive", "upgrade", "transfer-encoding", "proxy-authorization", "x-api-key"]) {
      expect(headers!.has(name)).toBe(false);
    }
    expect(headers!.get("cookie")).toBe("borgo_session=abc");
    expect(headers!.get("authorization")).toBe("Bearer t");
    expect(headers!.get("accept-encoding")).toBe("gzip");
  });

  test("the browser's Host does not become go's r.Host", async () => {
    // r.Host is what go builds absolute urls from. forwarded verbatim, the
    // client picks the site's own name - a password reset mailed to the
    // victim points at the attacker's host and still looks like the app
    let headers: Headers | undefined;
    await proxyRequest(
      req("GET", { headers: { host: "evil.example.com", cookie: "borgo_session=abc" } }),
      opts({
        target: "http://localhost:3501/api/me",
        fetchImpl: async (_t, init) => {
          headers = new Headers(init.headers);
          return new Response("ok");
        },
      }),
    );
    // no Host on the outbound request: bun writes the target's authority
    expect(headers!.has("host")).toBe(false);
    // the value is not lost, it is moved somewhere that names itself untrusted
    expect(headers!.get("x-forwarded-host")).toBe("evil.example.com");
    expect(headers!.get("cookie")).toBe("borgo_session=abc");
  });

  // Dropping Host and then passing the client's own X-Forwarded-Host through
  // moves the primitive one header over: app code building an absolute url, or
  // keying a rate limit, reaches for exactly that field. The old rule was "a
  // front proxy already set it", which was never true of the deployment borgo
  // ships - its generated nginx sets Host, X-Forwarded-For and
  // X-Forwarded-Proto, and no X-Forwarded-Host at all - so in practice the only
  // sender was the browser, and it reached go verbatim (confirmed on the wire).
  test("a client-supplied X-Forwarded-Host does not survive", async () => {
    let headers: Headers | undefined;
    await proxyRequest(
      req("GET", { headers: { host: "localhost:3000", "x-forwarded-host": "attacker.example" } }),
      opts({
        clientIp: "203.0.113.7",
        fetchImpl: async (_t, init) => {
          headers = new Headers(init.headers);
          return new Response("ok");
        },
      }),
    );
    // behind a proxy the inbound Host IS the public name (nginx's $host), so
    // this is both the honest value and the only one borgo saw for itself
    expect(headers!.get("x-forwarded-host")).toBe("localhost:3000");
    expect(headers!.has("host")).toBe(false);
  });

  test("a request with no Host of its own gains no X-Forwarded-Host, invented or inherited", async () => {
    let headers: Headers | undefined;
    await proxyRequest(
      req("GET", { headers: { "x-forwarded-host": "attacker.example" } }),
      opts({
        fetchImpl: async (_t, init) => {
          headers = new Headers(init.headers);
          return new Response("ok");
        },
      }),
    );
    expect(headers!.has("x-forwarded-host")).toBe(false);
  });

  describe("X-Forwarded-For", () => {
    const forwardedFor = async (over: Partial<ProxyOptions>, headers: Record<string, string> = {}) => {
      let seen: Headers | undefined;
      await proxyRequest(
        req("GET", { headers }),
        opts({
          ...over,
          fetchImpl: async (_t, init) => {
            seen = new Headers(init.headers);
            return new Response("ok");
          },
        }),
      );
      return seen!.get("x-forwarded-for");
    };

    test("the real peer is appended, the way $proxy_add_x_forwarded_for does", async () => {
      // a trusted front proxy's chain is kept and extended: borgo cannot tell a
      // real chain from an invented one, but it can always name the hop it read
      // the request from, and that is now the last entry
      expect(await forwardedFor({ clientIp: "127.0.0.1" }, { "x-forwarded-for": "198.51.100.9" })).toBe(
        "198.51.100.9, 127.0.0.1",
      );
    });

    test("a client's invention never travels alone", async () => {
      // forwarded verbatim it is a rate-limit key and an audit log the client
      // writes for itself
      expect(await forwardedFor({ clientIp: "203.0.113.7" }, { "x-forwarded-for": "1.2.3.4" })).toBe(
        "1.2.3.4, 203.0.113.7",
      );
      expect(await forwardedFor({ clientIp: "203.0.113.7" })).toBe("203.0.113.7");
    });

    test("with no peer to vouch for, nothing travels at all", async () => {
      // the connection is already gone: a chain borgo cannot sign is not evidence
      expect(await forwardedFor({}, { "x-forwarded-for": "1.2.3.4" })).toBeNull();
    });
  });

  // The read deadline bounds the request, not the response - but bun has one
  // knob for both, so the caller lifts it the instant the request body is
  // entirely in hand. Granting that only after the handler resolves is too
  // late: an upstream taking 6s to produce headers had the connection closed at
  // 4.0s with zero bytes delivered, which also defeated BORGO_API_TIMEOUT=0.
  describe("onBodyRead: when the read deadline stops applying", () => {
    const lifts = async (method: string, init: { headers?: Record<string, string>; body?: BodyInit } = {}) => {
      const order: string[] = [];
      await proxyRequest(
        req(method, init),
        opts({
          onBodyRead: () => order.push("lifted"),
          fetchImpl: async () => {
            order.push("upstream");
            return new Response("ok");
          },
        }),
      );
      return order;
    };

    test("a buffered body is lifted before the upstream is even dialled", async () => {
      expect(await lifts("POST", { headers: { "content-length": "3" }, body: "abc" })).toEqual([
        "lifted",
        "upstream",
      ]);
    });

    test("a body still arriving keeps the deadline", async () => {
      // no content-length means an unbuffered passthrough: the client is still
      // writing, so this is still a read and still the deadline's business
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("x"));
          c.close();
        },
      });
      const order: string[] = [];
      await proxyRequest(
        new Request("http://app.test/api/x", {
          method: "POST",
          body: stream,
          // @ts-expect-error bun accepts a stream body with duplex: "half"
          duplex: "half",
        }),
        opts({
          onBodyRead: () => order.push("lifted"),
          fetchImpl: async () => {
            order.push("upstream");
            return new Response("ok");
          },
        }),
      );
      expect(order).toEqual(["upstream"]);
    });

    test("a GET has nothing to wait for and is lifted by the caller, not here", async () => {
      // serve() lifts a body-less request at the top of fetch(), before this
      // function is ever reached; there is nothing left for the proxy to signal
      expect(await lifts("GET")).toEqual(["upstream"]);
    });
  });

  test("a head carries no body, and is not turned into a get", async () => {
    let init: RequestInit | undefined;
    const res = await proxyRequest(
      req("HEAD", { headers: { "content-length": "5" } }),
      opts({
        fetchImpl: async (_t, i) => {
          init = i;
          return new Response(null, { status: 200, headers: { "Content-Length": "1234" } });
        },
      }),
    );
    expect(init!.method).toBe("HEAD");
    expect("body" in init!).toBe(false);
    // even with a content-length header on the inbound head
    expect(res.headers.get("Content-Length")).toBe("1234");
  });

  test("a get never carries a body either", async () => {
    let init: RequestInit | undefined;
    await proxyRequest(
      req("GET"),
      opts({
        fetchImpl: async (_t, i) => {
          init = i;
          return new Response("ok");
        },
      }),
    );
    expect("body" in init!).toBe(false);
  });

  test("an unbuffered body is passed as the live stream, not read into memory", async () => {
    let body: unknown;
    await proxyRequest(
      req("POST", { body: "streamed" }),
      opts({
        fetchImpl: async (_t, init) => {
          body = init.body;
          return new Response("ok");
        },
      }),
    );
    expect(body).toBeInstanceOf(ReadableStream);
    expect(await new Response(body as ReadableStream).text()).toBe("streamed");
  });

  test("the inbound request's own headers are not mutated", async () => {
    const inbound = req("GET", { headers: { connection: "keep-alive", cookie: "a=1" } });
    await proxyRequest(inbound, opts({ fetchImpl: async () => new Response("ok") }));
    expect(inbound.headers.get("connection")).toBe("keep-alive");
  });
});

describe("proxyRequest: over a real socket", () => {
  // the injected fetch proves the control flow; these prove what actually
  // reaches a listening server, framing included
  const upstream = async (handler: (req: Request) => Response | Promise<Response>) => {
    const server = Bun.serve({ port: 0, fetch: handler });
    return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) };
  };
  // A real round trip, so the 50ms default is a budget the machine sets, not a
  // property under test: measured 5/5 red under 16 burners on 8 cores, every
  // one a 504 where a 200 or 502 was asserted. The tests that assert ON the
  // deadline pass their own; these take a wide one, and declare a budget above
  // bun's 5s so that it is the deadline that decides and not bun.
  const LIVE_DEADLINE_MS = 10_000;
  const LIVE_BUDGET_MS = 30_000;
  const live = (over: Partial<ProxyOptions> = {}) => opts({ deadlineMs: LIVE_DEADLINE_MS, ...over });

  test("a buffered body arrives whole, with an honest content-length", async () => {
    let seen: { len: string | null; body: string } | undefined;
    const up = await upstream(async (r) => {
      seen = { len: r.headers.get("content-length"), body: await r.text() };
      return new Response("got it");
    });
    const res = await proxyRequest(
      new Request("http://app.test/api/x", {
        method: "POST",
        headers: { "content-length": "11", "content-type": "text/plain" },
        body: "hello world",
      }),
      live({ target: `${up.url}/api/x` }),
    );
    expect(res.status).toBe(200);
    expect(seen).toEqual({ len: "11", body: "hello world" });
    up.stop();
  }, LIVE_BUDGET_MS);

  test("a streamed body arrives whole too, framed by bun and not by the client", async () => {
    let seen: { len: string | null; te: string | null; body: string } | undefined;
    const up = await upstream(async (r) => {
      seen = { len: r.headers.get("content-length"), te: r.headers.get("transfer-encoding"), body: await r.text() };
      return new Response("got it");
    });
    const payload = "x".repeat(70_000);
    await proxyRequest(
      new Request("http://app.test/api/x", { method: "POST", body: payload }),
      live({ target: `${up.url}/api/x` }),
    );
    expect(seen!.body).toBe(payload);
    // the client's own framing never reaches go; bun writes its own
    expect(seen!.te === "chunked" || seen!.len === String(payload.length)).toBe(true);
    up.stop();
  }, LIVE_BUDGET_MS);

  test("a real refused connection retries and then answers 502", async () => {
    // bind and release a port, so nothing is listening on it
    const dead = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = dead.port;
    dead.stop(true);
    await Bun.sleep(20);
    let slept = 0;
    const res = await proxyRequest(
      req(),
      live({
        target: `http://localhost:${port}/api/x`,
        retries: 2,
        sleep: async () => void slept++,
      }),
    );
    expect(res.status).toBe(502);
    expect(await res.text()).toBe("api unreachable");
    expect(slept).toBe(2);
  }, LIVE_BUDGET_MS);

  test("a real hung upstream is cut at the deadline", async () => {
    const up = await upstream(() => new Promise<Response>(() => {}));
    const res = await proxyRequest(req(), opts({ target: `${up.url}/api/x`, deadlineMs: 60, retries: 0 }));
    expect(res.status).toBe(504);
    up.stop();
  });

  // a hand-built Request cannot carry `Connection: keep-alive,` - only bun's
  // own parser hands a value like that to a handler. the proxy used to throw
  // on it, from outside its own try, so serve() answered /api with a rendered
  // 500 document. the whole point of this hop is that it fails as an api.
  test("a malformed Connection value is proxied, not thrown on", async () => {
    const up = await upstream(
      (r) => new Response(r.headers.has("x-api-key") ? "leaked" : "clean", { headers: { "Content-Type": "text/plain" } }),
    );
    const front = Bun.serve({
      port: 0,
      fetch: (r) => proxyRequest(r, live({ target: `${up.url}/api/x` })),
    });
    // read to the end of the answer, not for a fixed 120ms: under load that
    // window closed on an empty buffer (measured 5/5, Received: "")
    const wire = async (connection: string) => {
      const chunks: Uint8Array[] = [];
      let settle = () => {};
      const whole = () => {
        const text = Buffer.concat(chunks).toString("latin1");
        const split = text.indexOf("\r\n\r\n");
        if (split < 0) return false;
        const declared = /content-length:\s*(\d+)/i.exec(text.slice(0, split));
        return declared !== null && text.length - split - 4 >= Number(declared[1]);
      };
      const sock = await Bun.connect({
        hostname: "127.0.0.1",
        port: Number(front.port),
        socket: {
          data: (_s, d) => {
            chunks.push(d);
            if (whole()) settle();
          },
          close: () => settle(),
        },
      });
      sock.write(
        `GET /api/x HTTP/1.1\r\nHost: app.test\r\nConnection: ${connection}\r\nX-Api-Key: k\r\n\r\n`,
      );
      await new Promise<void>((resolve) => {
        const cap = setTimeout(resolve, LIVE_DEADLINE_MS);
        settle = () => {
          clearTimeout(cap);
          resolve();
        };
        if (whole()) settle();
      });
      sock.end();
      return Buffer.concat(chunks).toString("latin1");
    };
    // a value that names nothing forwards X-Api-Key, as it should - the
    // failure being pinned here is the throw, which never reached the api
    for (const connection of ["keep-alive,", ",", '"foo"', "@bad"]) {
      const answer = await wire(connection);
      expect(answer).toContain("200 OK");
      expect(answer).not.toContain("500 Internal Server Error");
      expect(answer.endsWith("leaked")).toBe(true);
    }
    // a junk token in the list does not shield the real one beside it
    for (const connection of ["keep-alive, X-Api-Key", 'X-Api-Key, "junk"', ", X-Api-Key, ,"]) {
      expect(await wire(connection)).toEndWith("clean");
    }
    front.stop(true);
    up.stop();
  }, LIVE_BUDGET_MS);
});

describe("proxyRequest: event streams", () => {
  // Bun.serve withholds a response's headers until its body produces a byte,
  // so the client's fetch() resolves when the *stream* first speaks, not when
  // it opens. That makes the upstream's opening bytes load-bearing, and these
  // tests pin the proxy's half of the contract: it must forward them the
  // instant they arrive and add nothing of its own. borgo.SSE's own preamble
  // is covered on the Go side, by TestSSEOpensWithBytesBeforeAnyEvent.
  const upstream = (opening: string) => {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(sock) {
          sock.write(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n" +
              `${opening.length.toString(16)}\r\n${opening}\r\n`,
          );
        },
      },
    });
    return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
  };

  const withinBudget = async <T>(work: Promise<T>, ms: number, what: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${what} did not arrive within ${ms}ms`)), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  test("an upstream that opens with a comment reaches the client at once", async () => {
    const up = upstream(":ok\n\n");
    const front = Bun.serve({
      port: 0,
      fetch: (req) => proxyRequest(req, opts({ target: `${up.url}/api/events`, deadlineMs: 0 })),
    });
    const res = await withinBudget(fetch(`http://127.0.0.1:${front.port}/api/events`), 2000, "response headers");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const reader = res.body!.getReader();
    const first = await withinBudget(reader.read(), 2000, "first chunk");
    // byte for byte what the upstream sent: the proxy neither buffers it nor
    // adds a preamble of its own
    expect(new TextDecoder().decode(first.value)).toBe(":ok\n\n");

    await reader.cancel();
    front.stop(true);
    up.stop();
  });

  test("the stream body is forwarded untouched, whatever its content type", async () => {
    for (const type of ["text/event-stream", "application/json", "text/plain", "application/octet-stream"]) {
      const res = await proxyRequest(
        req(),
        opts({ fetchImpl: async () => new Response("data: 1\n\n", { headers: { "content-type": type } }) }),
      );
      expect(await res.text()).toBe("data: 1\n\n");
    }
  });
});
