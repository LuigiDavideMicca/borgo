import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import {
  isRangeStale,
  assetCacheControl,
  assetEtag,
  buildAssetIndex,
  documentStream,
  gzipStream,
  isCompressiblePath,
  isNotModified,
  jsonResponse,
  NO_BUILD_OUTPUTS,
  pickEncoding,
  precompressAssets,
  serveAsset,
  serveIndexed,
  type AssetInfo,
  type BuildOutputs,
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

    // rfc 9110 5.6.6: parameter names are case-insensitive, so "Q=0" is a
    // refusal in a spelling no less valid than "q=0". Only the lowercase one was
    // matched, which left the refusal unread and the quality at its default 1 -
    // so an asset, a json payload and a rendered document all went out gzip- or
    // brotli-encoded to a client that had just said it cannot decode them. The
    // coding name beside it was already folded; the parameter was not. gzip.go's
    // refusesCoding folds both, and the two halves read the same header.
    ["uppercase Q=0 is still a refusal", "gzip;Q=0", ["gzip"], null],
    ["uppercase Q=0 with space", "gzip; Q=0.00", ["gzip"], null],
    ["uppercase Q=0 falls through to the next coding", "br;Q=0, gzip", ["br", "gzip"], "gzip"],
    ["a wildcard refusal is honoured in either case", "*;Q=0", ["gzip"], null],
    ["and a nonzero uppercase Q still accepts", "gzip;Q=0.5", ["gzip"], "gzip"],
    ["mixed case name and parameter", "GZIP;Q=0", ["gzip"], null],
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

  // The old rule read the *shape* of a name: `-[a-z0-9]{8}\.(js|css)` under
  // assets/. Any eight-letter word satisfies that, so these three were served
  // `immutable` for a year off a real production build, and updating one in
  // place left every browser that had seen it holding the old copy with no
  // revalidation. Nothing about a name can settle this; only the build knows.
  const OUT: BuildOutputs = {
    dir: "public/assets",
    sizes: new Map([
      ["client-50dbnr0a.js", 100],
      ["logo-6nnjve26.png", 200],
      ["inter-6nnjve26.woff2", 300],
    ]),
  };
  const IMMUTABLE = "public, max-age=31536000, immutable";

  test("an eight-letter word does not buy a year", () => {
    for (const name of [
      "stripe-checkout.js",
      "vendor-database.css",
      "hero-carousel.js",
      "google-analytics.js", // escaped the old rule only by being nine letters
    ]) {
      expect(`${name}: ${assetCacheControl(`public/assets/${name}`, OUT, 100)}`).toBe(
        `${name}: no-cache`,
      );
    }
  });

  test("only a name the build recorded, at the length it recorded, is pinned", () => {
    expect(assetCacheControl("public/assets/client-50dbnr0a.js", OUT, 100)).toBe(IMMUTABLE);
    // the extensions the old js/css rule refused, which bun hashes all the same
    expect(assetCacheControl("public/assets/logo-6nnjve26.png", OUT, 200)).toBe(IMMUTABLE);
    expect(assetCacheControl("public/assets/inter-6nnjve26.woff2", OUT, 300)).toBe(IMMUTABLE);
    // emitted by the same build, deliberately not hashed
    expect(assetCacheControl("public/assets/client.js", OUT, 100)).toBe("no-cache");
    expect(assetCacheControl("public/assets/style.css", OUT, 100)).toBe("no-cache");
  });

  // the manifest vouches for bytes, not for a name. a recorded chunk deleted
  // and recreated after boot keeps the name and the entry, and used to inherit
  // the year with them
  test("a recorded name at the wrong length is not the file that was hashed", () => {
    expect(assetCacheControl("public/assets/client-50dbnr0a.js", OUT, 101)).toBe("no-cache");
    expect(assetCacheControl("public/assets/client-50dbnr0a.js", OUT, 0)).toBe("no-cache");
    // an unstattable file settles the same way: unknown is not a promise
    expect(assetCacheControl("public/assets/client-50dbnr0a.js", OUT, null)).toBe("no-cache");
  });

  // The directory is matched whole. Gating on a path *segment* called "assets"
  // pinned /copy/assets/… and /deep/nested/assets/… on the wire - bytes the
  // bundler never saw - because the basename was recorded and some ancestor
  // happened to be spelled the same. Every bundle copied into public/ ships one.
  test("only the build's own output directory, not any folder spelled assets", () => {
    for (const path of [
      "public/copy/assets/client-50dbnr0a.js",
      "public/deep/nested/assets/client-50dbnr0a.js",
      "public/vendor/client-50dbnr0a.js",
      "public/client-50dbnr0a.js",
      "public/assetsx/client-50dbnr0a.js",
      // inside the right directory but a level down: a different file
      "public/assets/sub/client-50dbnr0a.js",
    ]) {
      expect(`${path}: ${assetCacheControl(path, OUT, 100)}`).toBe(`${path}: no-cache`);
    }
  });

  // readBuildOutputs drops manifest keys carrying a separator, so this can only
  // arrive from a BuildOutputs built in code - which the type permits. "Only
  // files directly in the output directory" has to hold either way, or the
  // reader's filter is the single thing standing between a crafted manifest
  // and a pinned path somewhere else in the tree.
  test("a manifest key with a separator still cannot reach below the directory", () => {
    const sneaky: BuildOutputs = {
      dir: "public/assets",
      sizes: new Map([["sub/client-50dbnr0a.js", 100]]),
    };
    expect(assetCacheControl("public/assets/sub/client-50dbnr0a.js", sneaky, 100)).toBe("no-cache");
  });

  // Both lengths, and neither alone. Checking only the identity pinned a
  // replaced .gz (749 -> 75 bytes, shipped `immutable`); checking only the
  // representation would keep pinning a .gz whose identity file a partial
  // deploy had already rewritten, and `immutable` is a promise about the url.
  test("a sibling is pinned only when it and its identity are both vouched for", () => {
    const out: BuildOutputs = {
      dir: "public/assets",
      sizes: new Map([
        ["client-50dbnr0a.js", 100],
        ["client-50dbnr0a.js.gz", 40],
      ]),
    };
    const cc = (sentSize: number, identitySize: number) =>
      assetCacheControl("public/assets/client-50dbnr0a.js.gz", out, sentSize, {
        path: "public/assets/client-50dbnr0a.js",
        size: identitySize,
      });
    expect(cc(40, 100)).toBe(IMMUTABLE);
    // the sibling was replaced: the bytes going out are not the vouched bytes
    expect(cc(75, 100)).toBe("no-cache");
    // the identity moved out from under it: the url no longer has one content
    expect(cc(40, 101)).toBe("no-cache");
    expect(cc(75, 101)).toBe("no-cache");
    // a sibling the build never measured, beside a perfectly good identity
    expect(
      assetCacheControl("public/assets/client-50dbnr0a.js.br", out, 40, {
        path: "public/assets/client-50dbnr0a.js",
        size: 100,
      }),
    ).toBe("no-cache");
  });

  test("with no manifest nothing is pinned, and everything still gets a header", () => {
    for (const p of ["public/assets/client-50dbnr0a.js", "public/assets/client.js", "public/a.png"]) {
      expect(assetCacheControl(p)).toBe("no-cache");
      expect(assetCacheControl(p, NO_BUILD_OUTPUTS, 100)).toBe("no-cache");
    }
  });

  test("windows separators resolve to the same policy as forward slashes", () => {
    expect(assetCacheControl("public\\assets\\client-50dbnr0a.js", OUT, 100)).toBe(IMMUTABLE);
    expect(assetCacheControl("public\\sw.js", OUT, 100)).toBe("no-cache");
    // and a manifest whose dir was recorded with backslashes still matches
    const win = { dir: "public\\assets", sizes: OUT.sizes };
    expect(assetCacheControl("public/assets/client-50dbnr0a.js", win, 100)).toBe(IMMUTABLE);
  });

  // sw.js is not in the output directory, so it could only be pinned by a
  // manifest that named it - and it must not be, whatever a manifest says
  test("the service worker is never pinned, even by a manifest that names it", () => {
    const rogue: BuildOutputs = { dir: "public", sizes: new Map([["sw.js", 42]]) };
    expect(assetCacheControl("public/sw.js", rogue, 42)).toBe("no-cache");
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

      const index = buildAssetIndex(dir, undefined, {
        dir: `${dir.replaceAll("\\", "/")}/assets`,
        sizes: new Map([["client-6f5e37fs.js", "console.log(1)".length]]),
      });
      const css = index.get("/assets/style.css")!;
      expect(css.identity.path.endsWith("/assets/style.css")).toBe(true);
      expect(css.variants.map((v) => v.encoding)).toEqual(["br", "gzip"]);
      expect(css.compressible).toBe(true);
      expect(css.identity.pinnedSize).toBeNull();
      expect(css.type).toContain("text/css");
      expect(new Date(css.lastModified).getTime()).toBeGreaterThan(0);

      // every representation gets its own etag, or a cache could hand a
      // brotli body to a client that asked for identity
      const tags = new Set([css.identity.etag, ...css.variants.map((v) => v.etag)]);
      expect(tags.size).toBe(3);

      // the index records what the build vouched for, per representation;
      // whether the file still has that length is settled per request, on the
      // wire. the css has siblings the manifest never measured, so neither
      // encoding of it is pinnable even though the file itself is present
      expect(index.get("/assets/client-6f5e37fs.js")!.identity.pinnedSize).toBe(
        "console.log(1)".length,
      );
      expect(css.variants.map((v) => v.pinnedSize)).toEqual([null, null]);
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

  // The index is a boot-time snapshot, and every field it carries is a fact
  // about a file as it was then. `mtimeMs` was one of them and nothing ever
  // read it - not serveIndexed, which re-stats the file it is about to send,
  // and not a test. Named as a set, so a field that arrives without a reader
  // has to be argued for here rather than accumulate quietly beside the ones
  // that are load-bearing.
  test("carries no field nobody reads", async () => {
    await withAssets(async (dir) => {
      await Bun.write(join(dir, "assets/style.css"), "body{color:red}");
      await Bun.write(join(dir, "assets/style.css.gz"), "gz");
      const css = buildAssetIndex(dir).get("/assets/style.css")!;
      expect(Object.keys(css).sort()).toEqual([
        "compressible",
        "identity",
        "lastModified",
        "type",
        "variants",
      ]);
      for (const variant of [css.identity, ...css.variants]) {
        expect(Object.keys(variant).sort()).toEqual(
          (variant.encoding
            ? ["encoding", "etag", "path", "pinnedSize", "size"]
            : ["etag", "path", "pinnedSize", "size"]) as string[],
        );
      }
    });
  });

  test("cache-control: vouched-for files forever, everything else revalidates", () => {
    const out: BuildOutputs = {
      dir: "public/assets",
      sizes: new Map([["client-6f5e37fs.js", 14]]),
    };
    expect(assetCacheControl("public/assets/client-6f5e37fs.js", out, 14)).toBe(
      "public, max-age=31536000, immutable",
    );
    // a url that does not identify its content never answers with the empty
    // string: no policy is not a weaker policy, it is a heuristic one
    expect(assetCacheControl("public/assets/style.css", out, 14)).toBe("no-cache");
    expect(assetCacheControl("public/logo.svg", out, 14)).toBe("no-cache");
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
    // and weak on *our* side is the same refusal, echoed back exactly. This is
    // the live clause, not the one above: every tag borgo emits is weak, so a
    // client that quotes the validator it was given still gets the whole body.
    const weak = assetEtag(591, 1_770_000_000_000, "");
    expect(isRangeStale(req({ range: "bytes=0-9", "if-range": weak }), weak)).toBe(true);
    expect(isRangeStale(req({ range: "bytes=0-9", "if-range": weak.replace("W/", "") }), weak)).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// THE VALIDATOR, MEASURED ON REAL FILES
//
// The etag is size and mtime. Both halves are forgeable by ordinary tools, so
// this block writes the files rather than the numbers: every case below is a
// real stat of a real file, served through the real production path.
//
// What is asserted, per case, is the *outcome* of a conditional request:
// If-None-Match alone, If-Modified-Since alone, and the two together (rfc 9110
// §13.1.3: when both are present the etag decides and the date is ignored).
// Where the outcome is a 304 on bytes the client does not have, it is asserted
// as such and the validator is required to have declared itself weak - which is
// the whole of what this pair can honestly promise.
// ---------------------------------------------------------------------------
describe("asset validators, on real files", () => {
  let dir: string;
  let index: Map<string, AssetInfo>;

  // one fixed date for everything that has to collide, because a collision is
  // exactly what cp -p, rsync -t, tar, a reproducible build and docker's COPY
  // produce: the bytes get a new inode and the old mtime rides along
  const SHARED_MTIME = Date.parse("2026-03-01T12:00:00.000Z");

  const at = (p: string) => join(dir, "public", p);
  const mtimeOf = (p: string) => statSync(at(p)).mtimeMs;
  const setMtime = (p: string, ms: number) => utimesSync(at(p), new Date(ms), new Date(ms));
  const write = (p: string, body: string, ms = SHARED_MTIME) => {
    writeFileSync(at(p), body);
    setMtime(p, ms);
  };
  // `cp -p`: the bytes, then the timestamps
  const copyPreserving = (from: string, to: string) => {
    copyFileSync(at(from), at(to));
    setMtime(to, mtimeOf(from));
  };
  // one byte replaced in place, the length untouched, the date put back. A
  // deploy that rewrites a file and preserves its mtime leaves exactly this.
  const substituteByte = (p: string, offset: number, byte: string) => {
    const was = mtimeOf(p);
    const buf = readFileSync(at(p));
    buf[offset] = byte.charCodeAt(0);
    writeFileSync(at(p), buf);
    setMtime(p, was);
  };

  const HASHED = "assets/app-a1b2c3d4.js";
  const HASHED_BODY = "export const hello=()=>0;"; // 25
  const PLAIN_BODY = "main{padding:1rem}"; // 18
  const SW_BODY = "self.addEventListener('fetch',()=>{});"; // 38

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "borgo-validators-"));
    mkdirSync(join(dir, "public", "assets"), { recursive: true });

    // 1. two different files of equal length, given the same mtime
    write("twin-a.txt", "AAAAAAAAAA");
    write("twin-b.txt", "BBBBBBBBBB");
    // 2. the same content copied the way every deploy tool copies it
    write("origin.txt", "the original bytes");
    copyPreserving("origin.txt", "copy.txt");
    // 3. a file back-dated after it was written
    write("dated.txt", "some content here", Date.parse("2026-06-01T00:00:00.000Z"));
    // 4. the one that matters: one byte substituted at constant length
    write("edited.txt", "payload version one");
    // 5. permissions changed, content and mtime untouched
    write("moded.txt", "unchanged bytes");
    // 6. the service worker, which controls every url in its scope
    write("sw.js", SW_BODY);
    // 7. and 8. a file the build hashed and vouched for, and one it did not
    write(HASHED, HASHED_BODY);
    write("site.css", PLAIN_BODY);

    index = buildAssetIndex(join(dir, "public"), undefined, {
      dir: join(dir, "public", "assets").replaceAll("\\", "/"),
      sizes: new Map([["app-a1b2c3d4.js", HASHED_BODY.length]]),
    });
  });

  afterAll(() => {
    chmodSync(at("moded.txt"), 0o666);
    rmSync(dir, { recursive: true, force: true });
  });

  const info = (url: string) => {
    const found = index.get(url);
    if (!found) throw new Error(`not indexed: ${url}`);
    return found;
  };
  // the indexed production path. It re-stats on every request, so a file
  // rewritten after boot is measured as it is now, not as the index saw it.
  const serve = (url: string, headers: Record<string, string> = {}) =>
    serveIndexed(new Request(`http://app.test${url}`, { headers }), info(url));

  const validators = (url: string) => {
    const res = serve(url, { "accept-encoding": "identity" });
    return { etag: res.headers.get("ETag")!, date: res.headers.get("Last-Modified")! };
  };

  // one url, one validator pair the client claims to hold, three request shapes
  const conditional = (url: string, etag: string, date: string) => ({
    inm: serve(url, { "if-none-match": etag }).status,
    ims: serve(url, { "if-modified-since": date }).status,
    both: serve(url, { "if-none-match": etag, "if-modified-since": date }).status,
  });

  const isWeak = (tag: string) => tag.startsWith('W/"');

  test("every validator borgo emits declares itself weak", () => {
    for (const url of [
      "/twin-a.txt",
      "/copy.txt",
      "/dated.txt",
      "/edited.txt",
      "/moded.txt",
      "/sw.js",
      `/${HASHED}`,
      "/site.css",
    ]) {
      expect(isWeak(validators(url).etag)).toBe(true);
    }
    // including the negotiated siblings, whose suffix rides inside the quotes
    expect(assetEtag(23, SHARED_MTIME, "-br")).toBe(
      `W/"n-${Math.floor(SHARED_MTIME).toString(36)}-br"`,
    );
  });

  // 1. two files of equal length with the same mtime
  test("two different files of equal length and equal mtime share one validator", () => {
    const a = validators("/twin-a.txt");
    const b = validators("/twin-b.txt");
    expect(a.etag).toBe(b.etag);
    expect(a.date).toBe(b.date);
    // a client holding twin-a's bytes revalidates twin-b and is told to keep
    // them. Nothing in the pair can separate the two files, which is why the
    // tag says W/ instead of pretending otherwise.
    expect(conditional("/twin-b.txt", a.etag, a.date)).toEqual({ inm: 304, ims: 304, both: 304 });
  });

  // 2. the same content copied with cp -p
  test("cp -p reproduces the validator, and here the 304 is right", () => {
    const origin = validators("/origin.txt");
    const copy = validators("/copy.txt");
    expect(copy.etag).toBe(origin.etag);
    expect(conditional("/copy.txt", origin.etag, origin.date)).toEqual({
      inm: 304,
      ims: 304,
      both: 304,
    });
    // the bytes really are the same, so this 304 is correct. It is listed
    // because it is the mechanism, not the bug: preserving the mtime is what
    // the tool is *for*, which is what makes case 1 and case 4 reachable.
    expect(readFileSync(at("copy.txt")).equals(readFileSync(at("origin.txt")))).toBe(true);
  });

  // 3. a file touched to a past date
  test("touching a file to a past date moves the etag and back-dates the 304", () => {
    const before = validators("/dated.txt");
    const heldDate = before.date;
    setMtime("dated.txt", Date.parse("2020-01-01T00:00:00.000Z"));
    const after = validators("/dated.txt");
    expect(after.etag).not.toBe(before.etag);
    // the etag moved, so a client holding the old one is served the body...
    expect(conditional("/dated.txt", before.etag, before.date).inm).toBe(200);
    // ...but a date-only client is told nothing changed, because the file now
    // claims to predate what that client holds. This is the direction that
    // hurts: back-dating is what tar and restored backups do, and a client
    // that revalidates by date alone never learns the file moved.
    expect(serve("/dated.txt", { "if-modified-since": heldDate }).status).toBe(304);
    // both headers: the etag decides and the date is ignored (§13.1.3)
    expect(serve("/dated.txt", { "if-none-match": before.etag, "if-modified-since": heldDate })
      .status).toBe(200);
  });

  // 4. THE CASE: one byte substituted, length and mtime unchanged
  test("a byte substituted at constant length under a preserved mtime is invisible", () => {
    const before = validators("/edited.txt");
    const bodyBefore = readFileSync(at("edited.txt")).toString();
    substituteByte("edited.txt", 8, "2");
    const after = validators("/edited.txt");
    const bodyAfter = readFileSync(at("edited.txt")).toString();

    // the bytes changed and the validator did not
    expect(bodyAfter).not.toBe(bodyBefore);
    expect(bodyAfter.length).toBe(bodyBefore.length);
    expect(after.etag).toBe(before.etag);
    expect(after.date).toBe(before.date);

    // so every conditional shape 304s over changed bytes. This is the defect,
    // stated rather than hidden: size and mtime cannot see this edit, and no
    // per-request check can, because size and mtime are all a request has.
    expect(conditional("/edited.txt", before.etag, before.date)).toEqual({
      inm: 304,
      ims: 304,
      both: 304,
    });

    // THE PROPERTY, in the only form this validator can keep: it does not
    // claim to be exact. A strong tag here would be a promise that these two
    // bodies are byte-identical, and they are not.
    expect(isWeak(after.etag)).toBe(true);
    // and a weak tag can never authorise a range, so the one failure that
    // corrupts rather than staling - a resume splicing new bytes onto an old
    // prefix - is refused even when the client quotes our own validator back
    expect(
      isRangeStale(
        new Request("http://app.test/edited.txt", {
          headers: { range: "bytes=0-3", "if-range": after.etag },
        }),
        after.etag,
      ),
    ).toBe(true);
  });

  test("the refused range is a whole 200 on the wire, not a 206", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(r) {
        const found = index.get(new URL(r.url).pathname);
        return found ? serveIndexed(r, found) : new Response("no", { status: 404 });
      },
    });
    try {
      const { etag } = validators("/edited.txt");
      const res = await fetch(`http://localhost:${server.port}/edited.txt`, {
        headers: { range: "bytes=0-3", "if-range": etag, "accept-encoding": "identity" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Range")).toBeNull();
      expect(await res.text()).toBe(readFileSync(at("edited.txt")).toString());
    } finally {
      server.stop(true);
    }
  });

  // 5. chmod: ctime moves, mtime does not
  test("a chmod leaves the validator alone, which is why ctime is not in it", () => {
    const before = validators("/moded.txt");
    const mtimeBefore = mtimeOf("moded.txt");
    const ctimeBefore = statSync(at("moded.txt")).ctimeMs;
    chmodSync(at("moded.txt"), 0o444);
    const after = validators("/moded.txt");

    // the bytes did not change, so nothing about the answer should
    expect(mtimeOf("moded.txt")).toBe(mtimeBefore);
    expect(after.etag).toBe(before.etag);
    expect(conditional("/moded.txt", before.etag, before.date)).toEqual({
      inm: 304,
      ims: 304,
      both: 304,
    });
    // ctime is the metadata clock: it never runs backwards, and a chmod is
    // exactly the event that advances it while the content stands still. A
    // validator built on it would have charged a full download for a
    // permission bit - and for every backup and hardlink besides. Whether this
    // particular filesystem advances it is not asserted (windows does not),
    // because the reason ctime is out is that it moves for non-content events
    // wherever it moves at all.
    expect(statSync(at("moded.txt")).ctimeMs).toBeGreaterThanOrEqual(ctimeBefore);
  });

  // 6. sw.js, the file this was measured on
  test("sw.js is never pinned, and its validator is as weak as any other", () => {
    const res = serve("/sw.js", { "accept-encoding": "identity" });
    // it controls every url in its scope, so it always revalidates...
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    const before = validators("/sw.js");
    substituteByte("sw.js", 0, "S");
    const after = validators("/sw.js");
    // ...and that revalidation is the one this edit walks straight through
    expect(readFileSync(at("sw.js")).toString()).not.toBe(SW_BODY);
    expect(after.etag).toBe(before.etag);
    expect(conditional("/sw.js", before.etag, before.date)).toEqual({
      inm: 304,
      ims: 304,
      both: 304,
    });
    expect(isWeak(after.etag)).toBe(true);
  });

  // 7. a file the build hashed and recorded
  test("a hashed asset keeps its year and still says W/", () => {
    const res = serve(`/${HASHED}`, { "accept-encoding": "identity" });
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    const before = validators(`/${HASHED}`);
    substituteByte(HASHED, 7, "X");
    const after = serve(`/${HASHED}`, { "accept-encoding": "identity" });
    // the length is what pinPolicy checks and the length did not move, so the
    // year survives the edit too. The name's content hash is not a validator
    // the server can verify per request - it is a claim about what the build
    // wrote, checked against exactly the size this edit preserves.
    expect(after.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(after.headers.get("ETag")).toBe(before.etag);
    expect(conditional(`/${HASHED}`, before.etag, before.date)).toEqual({
      inm: 304,
      ims: 304,
      both: 304,
    });
    expect(isWeak(after.headers.get("ETag")!)).toBe(true);
  });

  // 8. a file no build vouched for
  test("an unhashed asset revalidates every load, which is what bounds the blast radius", () => {
    const res = serve("/site.css", { "accept-encoding": "identity" });
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    const { etag, date } = validators("/site.css");
    expect(conditional("/site.css", etag, date)).toEqual({ inm: 304, ims: 304, both: 304 });
    // a stale answer here is corrected by the next revalidation; under
    // `immutable` there is no next revalidation for a year
    expect(isWeak(etag)).toBe(true);
  });

  // the live path (dev, and anything written after boot) must say the same
  test("serveAsset emits the same weak validator as the indexed path", () => {
    const path = at("site.css");
    const res = serveAsset(
      new Request("http://app.test/site.css", { headers: { "accept-encoding": "identity" } }),
      path,
      Bun.file(path),
      { dev: false },
    );
    expect(res.headers.get("ETag")).toBe(validators("/site.css").etag);
    expect(isWeak(res.headers.get("ETag")!)).toBe(true);
  });

  test("a client echoing the weak validator still gets its 304", () => {
    // the weak comparison strips the marker from both sides. Stripping only
    // the client's side - which was enough while every tag was strong - would
    // turn every asset revalidation into a full download the moment they were
    // not, and the cost would show up as bandwidth, not as a failure.
    const { etag } = validators("/site.css");
    const r = (h: Record<string, string>) => new Request("http://app.test/site.css", { headers: h });
    expect(isNotModified(r({ "if-none-match": etag }), etag, 0)).toBe(true);
    expect(isNotModified(r({ "if-none-match": etag.replace("W/", "") }), etag, 0)).toBe(true);
    expect(serve("/site.css", { "if-none-match": etag }).status).toBe(304);
  });
});
