import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { API_RETRIES, ApiError, makeApiClient, multipartBody } from "../src/api";

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

  // ServeMux's own wildcards were sent as written: the handler received the
  // literal "{rest...}", and {$} was a 404 (found by hunt 3)
  test("{$} takes no value and {name...} keeps the slashes of its value", async () => {
    stubFetch(() => Response.json({}));
    const untyped = makeApiClient("http://api:1") as unknown as (route: string, opts?: object) => Promise<unknown>;
    await untyped("GET /api/files/{rest...}", { params: { rest: "a b/c%d" } });
    expect(calls[0].url).toBe("http://api:1/api/files/a%20b/c%25d");
    await untyped("GET /api/exact/{$}");
    expect(calls[1].url).toBe("http://api:1/api/exact/");
  });

  // ".." was resolved away by the url: DELETE /api/tasks/{id} with id ".."
  // was DELETE /api/ (found by hunt 3)
  test("a dot segment in a param is refused before anything is sent", async () => {
    stubFetch(() => Response.json({}));
    const untyped = makeApiClient("http://api:1") as unknown as (route: string, opts?: object) => Promise<unknown>;
    for (const id of [".", ".."]) {
      await expect(untyped("DELETE /api/tasks/{id}", { params: { id } })).rejects.toThrow("dot segment");
    }
    await expect(untyped("GET /api/files/{rest...}", { params: { rest: "a/../secret" } })).rejects.toThrow("dot segment");
    expect(calls.length).toBe(0);
    await untyped("GET /api/tasks/{id}", { params: { id: "..." } });
    expect(calls[0].url).toBe("http://api:1/api/tasks/...");
  });

  // followed, a redirect carried the boot key to whatever host an open ?next=
  // named (found by hunt 3)
  test("a redirect from the api is an answer, not a request sent on", async () => {
    globalThis.fetch = realFetch;
    let reached: string | null = null;
    const elsewhere = Bun.serve({
      port: 0,
      fetch(req) {
        reached = req.headers.get("x-borgo-internal") ?? "";
        return new Response("elsewhere");
      },
    });
    const api = Bun.serve({ port: 0, fetch: () => Response.redirect(`http://127.0.0.1:${elsewhere.port}/steal`, 302) });
    try {
      const client = makeApiClient(`http://127.0.0.1:${api.port}`, { "X-Borgo-Internal": "the-boot-key" });
      const untyped = client as unknown as (route: string) => Promise<unknown>;
      const error = await untyped("GET /api/go").catch((e) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(302);
      expect(reached).toBeNull();
    } finally {
      api.stop(true);
      elsewhere.stop(true);
    }
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

  // borgo.BindMultipart reads multipart/form-data: a body holding a file is
  // sent as a FormData, with no content-type of ours so fetch writes the
  // boundary; a FormData is sent as it is; anything else stays JSON
  test("a body holding a file goes as multipart/form-data", async () => {
    stubFetch(() => Response.json({}));
    const api = makeApiClient("http://api:1");
    const file = new File(["PNGBYTES"], "shot.png", { type: "image/png" });
    const extra = new File(["two"], "2.txt", { type: "text/plain" });
    await api("POST /api/attachments", {
      body: { note: "hi", count: 3, file, extras: [file, extra], cover: null, skipped: undefined },
    });
    const body = calls[0].init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get("note")).toBe("hi");
    expect(body.get("count")).toBe("3");
    expect((body.get("file") as File).name).toBe("shot.png");
    expect(await (body.get("file") as File).text()).toBe("PNGBYTES");
    expect(body.getAll("extras").map((f) => (f as File).name)).toEqual(["shot.png", "2.txt"]);
    expect(body.has("cover")).toBe(false);
    expect(body.has("skipped")).toBe(false);
    expect((calls[0].init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  // go reads a part with no filename as text, never as a file: a File goes
  // under its own name, and a plain Blob - which bun would send with an empty
  // one - under "blob"
  test("every file part carries a filename", async () => {
    const form = multipartBody({ shot: new File(["a"], "shot.png"), raw: new Blob(["b"]) })!;
    const wire = await new Response(form).text();
    expect(wire).toContain('name="shot"; filename="shot.png"');
    expect(wire).toContain('name="raw"; filename="blob"');
  });

  // a content type of the caller's would replace the one fetch writes with
  // the boundary in it, and go could not split the parts
  test("a caller's content-type is dropped from a multipart body and kept on json", async () => {
    stubFetch(() => Response.json({}));
    const api = makeApiClient("http://api:1");
    const file = new File(["x"], "x.txt");
    await api("POST /api/attachments", { body: { file }, headers: { "Content-Type": "text/plain", "X-Other": "kept" } });
    const sent = calls[0].init.headers as Record<string, string>;
    expect(Object.keys(sent).map((k) => k.toLowerCase())).not.toContain("content-type");
    expect(sent["X-Other"]).toBe("kept");
    await api("POST /api/tasks", { body: { title: "t" }, headers: { "Content-Type": "application/merge-patch+json" } });
    expect((calls[1].init.headers as Record<string, string>)["Content-Type"]).toBe("application/merge-patch+json");
  });

  test("an array of files alone is a multipart body, and what no part carries is refused", async () => {
    stubFetch(() => Response.json({}));
    const api = makeApiClient("http://api:1");
    const file = new File(["one"], "1.txt", { type: "text/plain" });
    await api("POST /api/attachments", { body: { extras: [file] } });
    expect((calls[0].init.body as FormData).getAll("extras").length).toBe(1);
    expect(multipartBody(null)).toBeNull();
    expect(multipartBody([file])).toBeNull();
    expect(() => multipartBody({ when: new Date(0), file })).toThrow(/"when" holds \[object Date\]/);
    expect(() => multipartBody({ meta: { inner: file }, file })).toThrow(/"meta" holds \[object Object\]/);
    expect(calls.length).toBe(1);
  });

  test("a FormData is sent as it is, and an object with no file stays JSON", async () => {
    stubFetch(() => Response.json({}));
    const api = makeApiClient("http://api:1");
    const form = new FormData();
    form.append("note", "mine");
    await api("POST /api/attachments", { body: form });
    expect(calls[0].init.body).toBe(form);
    expect((calls[0].init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    await api("POST /api/tasks", { body: { title: "x", tags: ["a"] } });
    expect(calls[1].init.body).toBe('{"title":"x","tags":["a"]}');
    expect((calls[1].init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
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

// THE NUMBER, NOW THERE IS ONE HOP.
//
// This client dials the go api the render service was started beside. A
// refused connection in production means the api is DOWN, and holding
// requests open while they are retried only piles connections up. This side
// hard-coded 15, so 16 attempts at 250ms apart: a call that should have
// failed at once hung about four seconds, per loader, on every request -
// longer than a container readiness probe's own deadline, and invisible in
// it. (The /api proxy that took the same number is gone: the go front
// answers /api in its own process.)
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

  // there is one hop left: the typed client the loaders and actions call.
  // The proxy that used to take the same number is gone with the topology -
  // the go front answers /api in its own process
  test("the render service hands its one hop that number", () => {
    const src = readFileSync(join(import.meta.dir, "../src/server.ts"), "utf8");
    expect(src).toContain("const apiRetries = dev ? 15 : API_RETRIES;");
    expect(src).toContain(`requestApiClient(api, { ...apiDefaults, ...forwardedClient(req, render) }, req.headers.get("cookie"), onSetCookie, apiRetries)`);
    expect(src).not.toContain("proxyRequest");
  });
});

// an empty value collapsed its segment and routed the call elsewhere, and a
// name ServeMux takes went unsubstituted when it was not a word (found by
// the verifier of hunt 3's fixes)
test("an empty param is refused, and any name ServeMux takes is filled", async () => {
  stubFetch(() => Response.json({}));
  const untyped = makeApiClient("http://api:1") as unknown as (route: string, opts?: object) => Promise<unknown>;
  await expect(untyped("GET /api/t/{id}", { params: { id: "" } })).rejects.toThrow("is empty");
  await expect(untyped("GET /api/files/{rest...}", { params: { rest: "/a" } })).rejects.toThrow("is empty");
  await expect(untyped("GET /api/files/{rest...}", { params: { rest: "a//b" } })).rejects.toThrow("is empty");
  expect(calls.length).toBe(0);
  await untyped("GET /api/città/{città}", { params: { città: "roma" } });
  expect(calls[0].url).toBe("http://api:1/api/citt%C3%A0/roma");
});
