import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import {
  isRangeStale,
  assetCacheControl,
  buildAssetIndex,
  documentStream,
  gzipStream,
  isCompressiblePath,
  isHashedAsset,
  isNotModified,
  jsonResponse,
  pickEncoding,
  precompressAssets,
} from "../src/compress";

describe("pickEncoding", () => {
  const cases: Array<[string, string | null, readonly string[], string | null]> = [
    ["no header", null, ["br", "gzip"], null],
    ["gzip only", "gzip", ["br", "gzip"], "gzip"],
    ["server preference wins", "gzip, deflate, br", ["br", "gzip"], "br"],
    ["dynamic path is gzip only", "gzip, br", ["gzip"], "gzip"],
    ["q=0 disables", "br;q=0, gzip", ["br", "gzip"], "gzip"],
    ["all disabled", "gzip;q=0, br;q=0", ["br", "gzip"], null],
    ["wildcard", "*", ["br", "gzip"], "br"],
    ["identity only", "identity", ["br", "gzip"], null],
    ["fractional q", "gzip;q=0.5", ["gzip"], "gzip"],
    ["case insensitive", "GZIP", ["gzip"], "gzip"],
    ["curl --compressed", "deflate, gzip, br, zstd", ["br", "gzip"], "br"],
  ];
  for (const [name, header, preferred, want] of cases) {
    test(name, () => {
      expect(pickEncoding(header, preferred)).toBe(want);
    });
  }
});

describe("asset classification", () => {
  test("compressible types", () => {
    for (const path of ["a/client.js", "style.css", "index.html", "logo.svg", "data.json"]) {
      expect(isCompressiblePath(path)).toBe(true);
    }
    for (const path of ["photo.png", "font.woff2", "movie.mp4", "archive.gz"]) {
      expect(isCompressiblePath(path)).toBe(false);
    }
  });

  test("hashed build outputs are detected, plain files are not", () => {
    expect(isHashedAsset("public/assets/client-6f5e37fs.js")).toBe(true);
    expect(isHashedAsset("public/assets/[id]-p5d0n9ga.js")).toBe(true);
    expect(isHashedAsset("public/assets/client.js")).toBe(false);
    expect(isHashedAsset("public/assets/islands-client.js")).toBe(false);
    expect(isHashedAsset("public/assets/style.css")).toBe(false);
    expect(isHashedAsset("public/my-download.js")).toBe(false);
  });
});

describe("precompressAssets", () => {
  test("writes smaller .gz and .br siblings, skips what would not shrink", async () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-precompress-"));
    try {
      const big = "export const data = 'chunk';\n".repeat(300);
      await Bun.write(join(dir, "big.js"), big);
      await Bun.write(join(dir, "photo.png"), "not really a png but binary enough");
      // 3 bytes: the gzip container alone outweighs any saving
      await Bun.write(join(dir, "tiny.svg"), "svg");

      await precompressAssets(dir);

      const gz = Bun.file(join(dir, "big.js.gz"));
      const br = Bun.file(join(dir, "big.js.br"));
      expect(await gz.exists()).toBe(true);
      expect(await br.exists()).toBe(true);
      expect(gz.size).toBeLessThan(big.length);
      expect(br.size).toBeLessThan(big.length);
      expect(gunzipSync(Buffer.from(await gz.arrayBuffer())).toString()).toBe(big);
      expect(brotliDecompressSync(Buffer.from(await br.arrayBuffer())).toString()).toBe(big);

      expect(existsSync(join(dir, "photo.png.gz"))).toBe(false);
      expect(existsSync(join(dir, "tiny.svg.gz"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildAssetIndex", () => {
  const withAssets = async (fn: (dir: string) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-assets-"));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("indexes files by url path with their precompressed siblings", async () => {
    await withAssets(async (dir) => {
      await Bun.write(join(dir, "assets/style.css"), "body{color:red}");
      await Bun.write(join(dir, "assets/style.css.gz"), "gz");
      await Bun.write(join(dir, "assets/style.css.br"), "br");
      await Bun.write(join(dir, "assets/client-6f5e37fs.js"), "console.log(1)");
      await Bun.write(join(dir, "logo.png"), "png");

      const index = buildAssetIndex(dir);
      const css = index.get("/assets/style.css")!;
      expect(css.identity.path.endsWith("/assets/style.css")).toBe(true);
      expect(css.variants.map((v) => v.encoding)).toEqual(["br", "gzip"]);
      expect(css.compressible).toBe(true);
      expect(css.cacheControl).toBe("");
      expect(css.type).toContain("text/css");
      expect(new Date(css.lastModified).getTime()).toBeGreaterThan(0);

      // every representation gets its own etag, or a cache could hand a
      // brotli body to a client that asked for identity
      const tags = new Set([css.identity.etag, ...css.variants.map((v) => v.etag)]);
      expect(tags.size).toBe(3);

      expect(index.get("/assets/client-6f5e37fs.js")!.cacheControl).toBe(
        "public, max-age=31536000, immutable",
      );
      const png = index.get("/logo.png")!;
      expect(png.compressible).toBe(false);
      expect(png.variants).toEqual([]);
    });
  });

  test("every variant carries its own byte size, so a HEAD can be answered", async () => {
    await withAssets(async (dir) => {
      await Bun.write(join(dir, "assets/style.css"), "body{color:red}");
      await Bun.write(join(dir, "assets/style.css.gz"), "gzipped-ish");
      const css = buildAssetIndex(dir).get("/assets/style.css")!;
      expect(css.identity.size).toBe("body{color:red}".length);
      expect(css.variants[0].size).toBe("gzipped-ish".length);
      // the compressed sibling must not inherit the identity length, or a
      // HEAD would report the wrong size for the body a GET returns
      expect(css.variants[0].size).not.toBe(css.identity.size);
    });
  });

  test("a missing directory is not fatal", () => {
    expect(buildAssetIndex(join(tmpdir(), "borgo-does-not-exist-" + Date.now())).size).toBe(0);
  });

  test("cache-control: hashed forever, service worker never", () => {
    expect(assetCacheControl("public/assets/client-6f5e37fs.js")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(assetCacheControl("public/sw.js")).toBe("no-cache");
    expect(assetCacheControl("public/assets/style.css")).toBe("");
  });
});

describe("isNotModified", () => {
  const at = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");
  const req = (headers: Record<string, string>) => new Request("http://x/a.css", { headers });

  test("a matching etag revalidates", () => {
    expect(isNotModified(req({ "if-none-match": '"abc"' }), '"abc"', at)).toBe(true);
    expect(isNotModified(req({ "if-none-match": 'W/"abc"' }), '"abc"', at)).toBe(true);
    expect(isNotModified(req({ "if-none-match": '"x", "abc"' }), '"abc"', at)).toBe(true);
    expect(isNotModified(req({ "if-none-match": "*" }), '"abc"', at)).toBe(true);
  });

  test("a different etag is a miss, and wins over if-modified-since", () => {
    expect(isNotModified(req({ "if-none-match": '"other"' }), '"abc"', at)).toBe(false);
    const both = req({
      "if-none-match": '"other"',
      "if-modified-since": "Wed, 21 Oct 2026 07:28:00 GMT",
    });
    expect(isNotModified(both, '"abc"', at)).toBe(false);
  });

  test("if-modified-since compares at second resolution", () => {
    expect(
      isNotModified(req({ "if-modified-since": "Wed, 21 Oct 2026 07:28:00 GMT" }), '"a"', at + 400),
    ).toBe(true);
    expect(
      isNotModified(req({ "if-modified-since": "Wed, 21 Oct 2026 07:27:59 GMT" }), '"a"', at),
    ).toBe(false);
    expect(isNotModified(req({ "if-modified-since": "not a date" }), '"a"', at)).toBe(false);
  });

  test("an unconditional request is never a 304", () => {
    expect(isNotModified(req({}), '"abc"', at)).toBe(false);
  });
});

describe("documentStream", () => {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const render = (parts: string[], onReturn?: () => void) => {
    let index = 0;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (index >= parts.length) return { done: true as const, value: undefined };
            return { done: false as const, value: encoder.encode(parts[index++]) };
          },
          async return() {
            onReturn?.();
            return { done: true as const, value: undefined };
          },
        };
      },
    } as AsyncIterable<Uint8Array>;
  };

  const drain = async (stream: ReadableStream<Uint8Array>) => {
    let out = "";
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      out += decoder.decode(chunk);
    }
    return out;
  };

  test("wraps the render between the shell head and tail", async () => {
    const out = await drain(documentStream("<head>", render(["a", "b"]), "</body>"));
    expect(out).toBe("<head>ab</body>");
  });

  test("an empty render still emits the shell", async () => {
    expect(await drain(documentStream("<head>", render([]), "</body>"))).toBe("<head></body>");
  });

  test("a client disconnect ends the render instead of finishing the page", async () => {
    let returned = false;
    let asked = 0;
    const endless: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        async next() {
          asked++;
          return { done: false as const, value: encoder.encode("chunk") };
        },
        async return() {
          returned = true;
          return { done: true as const, value: undefined };
        },
      }),
    };
    const reader = documentStream("<head>", endless, "</body>").getReader();
    expect(decoder.decode((await reader.read()).value)).toBe("<head>");
    await reader.read();
    await reader.cancel("client went away");
    expect(returned).toBe(true);
    const seen = asked;
    await Bun.sleep(20);
    // nothing keeps rendering behind the closed connection
    expect(asked).toBe(seen);
  });

  test("backpressure: a consumer that stops reading stops the render", async () => {
    let asked = 0;
    const endless: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        async next() {
          asked++;
          return { done: false as const, value: encoder.encode("x".repeat(64)) };
        },
      }),
    };
    const reader = documentStream("", endless, "").getReader();
    await reader.read();
    await Bun.sleep(20);
    // the queue holds one chunk ahead, it does not race to the end of the page
    expect(asked).toBeLessThan(5);
    await reader.cancel();
  });

  test("a render that throws errors the response stream", async () => {
    const boom: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        async next(): Promise<IteratorResult<Uint8Array>> {
          throw new Error("render exploded");
        },
      }),
    };
    const reader = documentStream("<head>", boom, "</body>").getReader();
    await reader.read();
    await expect(reader.read()).rejects.toThrow("render exploded");
  });
});

describe("gzipStream", () => {
  const encoder = new TextEncoder();

  test("round-trips a multi-chunk stream", async () => {
    const parts = ["<html>shell</html>", "streamed section ".repeat(50), "<script>end</script>"];
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(encoder.encode(part));
        controller.close();
      },
    });
    const compressed = Buffer.concat(
      (await Array.fromAsync(gzipStream(source) as unknown as AsyncIterable<Uint8Array>)).map(
        (c) => Buffer.from(c),
      ),
    );
    expect(gunzipSync(compressed).toString()).toBe(parts.join(""));
    expect(compressed.length).toBeLessThan(parts.join("").length);
  });

  test("a client disconnect mid-stream cancels cleanly and reaches the source", async () => {
    let sourceCancelled = false;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("shell ".repeat(200)));
      },
      cancel() {
        sourceCancelled = true;
      },
    });
    const reader = gzipStream(source).getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    // used to throw "ReadableStream is locked" and kill the process
    await reader.cancel("client went away");
    expect(sourceCancelled).toBe(true);
  });

  test("flushes per chunk so streamed ssr stays progressive", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const source = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode("shell ".repeat(200)));
        await gate;
        controller.enqueue(encoder.encode("late chunk"));
        controller.close();
      },
    });
    const reader = gzipStream(source).getReader();
    // without a sync flush zlib would sit on the first kilobyte and this
    // read would only resolve after the source closed
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value!.length).toBeGreaterThan(20);
    release();
    const chunks = [Buffer.from(first.value!)];
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      chunks.push(Buffer.from(next.value));
    }
    expect(gunzipSync(Buffer.concat(chunks)).toString()).toBe("shell ".repeat(200) + "late chunk");
  });

  test("a stalled client throttles the render instead of buffering the page", async () => {
    // documentStream is pull-based so a slow client paces react; in production
    // every document is compressed, and gzip's output is pushed from a 'data'
    // handler that cannot see the consumer's queue. the pump has to be the one
    // that waits, or wrapping the stream silently undoes the backpressure.
    const TOTAL = 300;
    let produced = 0;
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        async next() {
          if (produced >= TOTAL) return { done: true as const, value: undefined };
          produced++;
          return { done: false as const, value: encoder.encode("<li>" + "x".repeat(2000) + "</li>") };
        },
        async return() {
          return { done: true as const, value: undefined };
        },
      }),
    };

    const reader = gzipStream(documentStream("<head>", source, "</body>")).getReader();
    const first = await reader.read();
    const afterFirstRead = produced;
    await Bun.sleep(150);
    // the consumer has not read again: the render must not have run away
    expect(produced).toBe(afterFirstRead);
    expect(produced).toBeLessThan(TOTAL);

    // and draining still yields the whole document
    const chunks: Buffer[] = [Buffer.from(first.value!)];
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      chunks.push(Buffer.from(next.value));
    }
    expect(produced).toBe(TOTAL);
    expect(gunzipSync(Buffer.concat(chunks)).toString()).toBe(
      "<head>" + ("<li>" + "x".repeat(2000) + "</li>").repeat(TOTAL) + "</body>",
    );
  });

  test("a client that leaves while the pump is parked does not strand it", async () => {
    let returned = false;
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        async next() {
          return { done: false as const, value: encoder.encode("<li>" + "y".repeat(2000) + "</li>") };
        },
        async return() {
          returned = true;
          return { done: true as const, value: undefined };
        },
      }),
    };
    const reader = gzipStream(documentStream("<head>", source, "</body>")).getReader();
    await reader.read();
    await Bun.sleep(50); // the pump is now waiting on the consumer's queue
    await reader.cancel("client went away");
    expect(returned).toBe(true);
  });
});

describe("jsonResponse", () => {
  const withEncoding = (value: string | null) =>
    new Request("http://localhost/", value ? { headers: { "accept-encoding": value } } : {});

  test("gzips a payload past the threshold", async () => {
    const value = { items: Array.from({ length: 100 }, (_, i) => `item number ${i}`) };
    const res = jsonResponse(withEncoding("gzip, br"), value);
    expect(res.headers.get("Content-Encoding")).toBe("gzip");
    expect(res.headers.get("Vary")).toBe("Accept-Encoding");
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const body = gunzipSync(Buffer.from(await res.arrayBuffer())).toString();
    expect(JSON.parse(body)).toEqual(value);
  });

  test("leaves small payloads identity", async () => {
    const res = jsonResponse(withEncoding("gzip"), { ok: true });
    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect(res.headers.get("Vary")).toBe("Accept-Encoding");
    expect(await res.json()).toEqual({ ok: true });
  });

  test("leaves everything identity without accept-encoding", async () => {
    const value = { items: Array.from({ length: 100 }, (_, i) => `item number ${i}`) };
    const res = jsonResponse(withEncoding(null), value);
    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect(await res.json()).toEqual(value);
  });

  test("keeps the caller's status", () => {
    const res = jsonResponse(withEncoding("gzip"), { notFound: true }, { status: 404 });
    expect(res.status).toBe(404);
  });
});

describe("isRangeStale", () => {
  const req = (headers: Record<string, string>) => new Request("http://x/a.css", { headers });
  const ETAG = '"1ni-ms8ppm9r"';
  const LM = "Wed, 30 Jul 2026 09:00:00 GMT";

  test("no range, or no if-range, is never stale", () => {
    expect(isRangeStale(req({}), ETAG)).toBe(false);
    expect(isRangeStale(req({ range: "bytes=0-9" }), ETAG)).toBe(false);
    // an if-range without a range means nothing at all
    expect(isRangeStale(req({ "if-range": '"other"' }), ETAG)).toBe(false);
  });

  test("a validator that still matches lets the range through", () => {
    expect(isRangeStale(req({ range: "bytes=0-9", "if-range": ETAG }), ETAG)).toBe(false);
    // the date is NOT accepted: every encoding variant of one url shares it,
    // so honouring it authorises a range of the brotli file to be spliced into
    // an identity download - measured, before this rule, as a 206 of brotli
    // bytes handed to a client assembling plain css
    expect(isRangeStale(req({ range: "bytes=0-9", "if-range": LM }), ETAG)).toBe(true);
    expect(isRangeStale(req({ range: "bytes=0-9", "if-range": ` ${ETAG} ` }), ETAG)).toBe(false);
  });

  test("a validator that no longer matches refuses it", () => {
    expect(isRangeStale(req({ range: "bytes=0-9", "if-range": '"deadbeef-0"' }), ETAG)).toBe(true);
    expect(isRangeStale(req({ range: "bytes=0-9", "if-range": "Mon, 01 Jan 2001 00:00:00 GMT" }), ETAG)).toBe(true);
  });

  test("resuming across a change of encoding is a mismatch, not a range", () => {
    // the prefix the client holds is brotli; this request negotiated identity.
    // filling it from the identity file would hand back a spliced file
    const brEtag = '"fc-ms8ppmnf-br"';
    expect(isRangeStale(req({ range: "bytes=100-", "if-range": brEtag }), ETAG)).toBe(true);
    expect(isRangeStale(req({ range: "bytes=100-", "if-range": brEtag }), brEtag)).toBe(false);
  });

  test("a weak validator can never authorise a range", () => {
    expect(isRangeStale(req({ range: "bytes=0-9", "if-range": `W/${ETAG}` }), ETAG)).toBe(true);
  });
});
