import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { API_RETRIES, ApiError, makeApiClient } from "../src/api";

type Call = { url: string; init: RequestInit };

const realFetch = globalThis.fetch;
const calls: Call[] = [];

function stubFetch(response: () => Response) {
  calls.length = 0;
  globalThis.fetch = (async (url: URL | string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return response();
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("makeApiClient", () => {
  test("substitutes and encodes path params", async () => {
    stubFetch(() => Response.json({ ok: true }));
    const api = makeApiClient("http://api:1");
    await api("GET /api/tasks/{id}", { params: { id: "a b" } });
    expect(calls[0].url).toBe("http://api:1/api/tasks/a%20b");
    expect(calls[0].init.method).toBe("GET");
  });

  test("a route key without a method fails loudly, not with a mangled url", async () => {
    stubFetch(() => Response.json({}));
    const api = makeApiClient("http://api:1");
    const untyped = api as unknown as (route: string) => Promise<unknown>;
    await expect(untyped("/api/tasks")).rejects.toThrow('expected "METHOD /path"');
    expect(calls.length).toBe(0);
  });

  test("missing param throws before fetching", async () => {
    stubFetch(() => Response.json({}));
    const api = makeApiClient("http://api:1");
    await expect(api("GET /api/tasks/{id}", { params: {} as never })).rejects.toThrow(
      'missing param "id"',
    );
    expect(calls.length).toBe(0);
  });

  test("appends query params", async () => {
    stubFetch(() => Response.json({}));
    const api = makeApiClient("http://api:1");
    await api("GET /api/tasks", { query: { page: 2, done: true } });
    expect(calls[0].url).toBe("http://api:1/api/tasks?page=2&done=true");
  });

  test("serializes body and sets content-type", async () => {
    stubFetch(() => Response.json({}));
    const api = makeApiClient("http://api:1");
    await api("POST /api/tasks", { body: { title: "x" } });
    expect(calls[0].init.body).toBe('{"title":"x"}');
    expect((calls[0].init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
  });

  test("merges default headers under per-call headers", async () => {
    stubFetch(() => Response.json({}));
    const api = makeApiClient("http://api:1", { cookie: "s=1", "x-a": "default" });
    await api("GET /api/tasks", { headers: { "x-a": "override" } });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.cookie).toBe("s=1");
    expect(headers["x-a"]).toBe("override");
  });

  test("maps non-2xx to ApiError with status and body", async () => {
    stubFetch(() => new Response("boom", { status: 503 }));
    const api = makeApiClient("http://api:1");
    try {
      await api("GET /api/tasks");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(503);
      expect((error as ApiError).body).toBe("boom");
      expect((error as ApiError).message).toContain("GET /api/tasks");
    }
  });

  test("caps a huge error body instead of holding it all", async () => {
    stubFetch(() => new Response("x".repeat(200_000), { status: 500 }));
    const api = makeApiClient("http://api:1");
    const error = (await api("GET /api/tasks").catch((e) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.body.length).toBe(2048);
  });

  test("omits undefined and null query values", async () => {
    stubFetch(() => Response.json({}));
    const api = makeApiClient("http://api:1");
    await api("GET /api/tasks", {
      query: { page: 2, cursor: undefined, tag: null } as never,
    });
    expect(calls[0].url).toBe("http://api:1/api/tasks?page=2");
  });

  test("an empty 200 body resolves to undefined", async () => {
    stubFetch(() => new Response("", { status: 200, headers: { "content-length": "0" } }));
    const api = makeApiClient("http://api:1");
    expect(await api("GET /api/tasks")).toBeUndefined();
  });

  test("a non-json 200 body fails with the route in the error", async () => {
    stubFetch(() => new Response("<html>proxy</html>", { status: 200 }));
    const api = makeApiClient("http://api:1");
    const error = (await api("GET /api/tasks").catch((e) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain("GET /api/tasks");
  });

  test("204 resolves to undefined", async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    const api = makeApiClient("http://api:1");
    expect(await api("DELETE /api/tasks/{id}", { params: { id: 1 } })).toBeUndefined();
  });

  test("2xx resolves to parsed json", async () => {
    stubFetch(() => Response.json({ tasks: [1, 2] }));
    const api = makeApiClient("http://api:1");
    expect(await api("GET /api/tasks")).toEqual({ tasks: [1, 2] });
  });

  test("no timeout by default: fetch gets no signal", async () => {
    stubFetch(() => Response.json({}));
    const api = makeApiClient("http://api:1");
    await api("GET /api/tasks");
    expect(calls[0].init.signal).toBeUndefined();
  });

  test("timeout abandons a hung handler with the route in the error", async () => {
    calls.length = 0;
    globalThis.fetch = ((url: URL | string, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    }) as typeof fetch;
    const api = makeApiClient("http://api:1");
    const error = (await api("GET /api/tasks", { timeout: 20 }).catch((e) => e)) as Error;
    expect(error.message).toBe("api GET /api/tasks: no response within 20ms");
    expect(calls.length).toBe(1); // a timeout is not retried like a refused connection
  });

  test("a fast response is untouched by the timeout", async () => {
    stubFetch(() => Response.json({ ok: true }));
    const api = makeApiClient("http://api:1");
    expect(await api("GET /api/tasks", { timeout: 5_000 })).toEqual({ ok: true });
  });
});

// ONE NUMBER FOR BOTH HOPS TO THE SAME PROCESS.
//
// This client and the /api proxy dial the go api the front server was started
// beside. The proxy takes 3 in production and its comment says why - a refused
// connection there means the api is DOWN, and holding requests open while they
// are retried only piles connections up. This side hard-coded 15, so 16
// attempts at 250ms apart: a call that should have failed at once hung about
// four seconds, per loader, on every request - longer than a container
// readiness probe's own deadline, and invisible in it.
describe("connection-refused retries", () => {
  const refused = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });

  // the real sleep would make this test four seconds long, which is the point
  const noWait = <T>(run: () => Promise<T>) => {
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as typeof setTimeout;
    return run().finally(() => {
      globalThis.setTimeout = realSetTimeout;
    });
  };

  const attemptsUntilItGivesUp = (retries?: number) =>
    noWait(async () => {
      let attempts = 0;
      globalThis.fetch = (async () => {
        attempts++;
        throw refused();
      }) as unknown as typeof fetch;
      const api = makeApiClient("http://api:1", {}, undefined, retries);
      await api("GET /api/tasks").catch(() => {});
      return attempts;
    });

  test("the default is the production number the proxy already uses", async () => {
    expect(API_RETRIES).toBe(3);
    expect(await attemptsUntilItGivesUp()).toBe(API_RETRIES + 1);
  });

  test("the caller decides, because only the caller knows dev from production", async () => {
    expect(await attemptsUntilItGivesUp(0)).toBe(1);
    expect(await attemptsUntilItGivesUp(15)).toBe(16);
  });

  test("nothing but a refused connection is retried", async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      throw new Error("some other failure");
    }) as unknown as typeof fetch;
    const api = makeApiClient("http://api:1");
    await expect(api("GET /api/tasks")).rejects.toThrow("some other failure");
    expect(attempts).toBe(1);
  });

  test("the front server hands both hops the same number", () => {
    const src = readFileSync(join(import.meta.dir, "../src/server.ts"), "utf8");
    expect(src).toContain("const apiRetries = dev ? 15 : API_RETRIES;");
    // the same value reaches the typed client and the proxy
    expect(src).toContain("makeApiClient(api, cookie ? { cookie } : {}, onSetCookie, apiRetries)");
    expect(src).toContain("retries: apiRetries,");
  });
});
