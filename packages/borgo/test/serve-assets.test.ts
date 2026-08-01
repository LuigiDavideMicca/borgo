import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, gunzipSync, gzipSync } from "node:zlib";
import { buildAssetIndex, serveAsset, serveIndexed, type AssetInfo } from "../src/compress";

// a real public/ tree: a hashed bundle with both siblings, a css with only a
// gzip sibling, an image, a service worker. the contents of each sibling are
// distinct on purpose, so the body always names the file that produced it.
let dir: string;
let index: Map<string, AssetInfo>;

const RAW_JS = "console.log('identity javascript payload');";
const RAW_CSS = "body { color: rebeccapurple; }";
const RAW_PNG = "PNG bytes, not really";
const RAW_SW = "self.addEventListener('fetch', () => {});";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "borgo-serve-assets-"));
  mkdirSync(join(dir, "public", "assets"), { recursive: true });
  const js = join(dir, "public", "assets", "client-abcd1234.js");
  writeFileSync(js, RAW_JS);
  writeFileSync(js + ".gz", gzipSync(RAW_JS));
  writeFileSync(js + ".br", brotliCompressSync(RAW_JS));
  writeFileSync(join(dir, "public", "style.css"), RAW_CSS);
  writeFileSync(join(dir, "public", "style.css.gz"), gzipSync(RAW_CSS));
  writeFileSync(join(dir, "public", "logo.png"), RAW_PNG);
  writeFileSync(join(dir, "public", "sw.js"), RAW_SW);
  index = buildAssetIndex(join(dir, "public"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const req = (headers: Record<string, string> = {}, method = "GET") =>
  new Request("http://app.test/assets/client-abcd1234.js", { method, headers });

const info = (url: string) => {
  const found = index.get(url);
  if (!found) throw new Error(`not indexed: ${url}`);
  return found;
};

describe("serveIndexed: variant selection", () => {
  test("no accept-encoding serves identity, with etag, length and immutable caching", async () => {
    const i = info("/assets/client-abcd1234.js");
    const res = serveIndexed(req(), i);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(RAW_JS);
    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect(res.headers.get("Content-Length")).toBe(String(RAW_JS.length));
    expect(res.headers.get("ETag")).toBe(i.identity.etag);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("Vary")).toBe("Accept-Encoding");
    expect(res.headers.get("Last-Modified")).toBe(i.lastModified);
  });

  test("br wins over gzip when the client takes both", async () => {
    const i = info("/assets/client-abcd1234.js");
    const res = serveIndexed(req({ "accept-encoding": "gzip, br" }), i);
    expect(res.headers.get("Content-Encoding")).toBe("br");
    const brVariant = i.variants.find((v) => v.encoding === "br")!;
    expect(res.headers.get("ETag")).toBe(brVariant.etag);
    expect(res.headers.get("Content-Length")).toBe(String(brVariant.size));
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      new Uint8Array(brotliCompressSync(RAW_JS)),
    );
  });

  test("gzip-only client gets the gzip sibling", async () => {
    const res = serveIndexed(req({ "accept-encoding": "gzip" }), info("/assets/client-abcd1234.js"));
    expect(res.headers.get("Content-Encoding")).toBe("gzip");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(gzipSync(RAW_JS)));
  });

  test("an asset is only offered the encodings it actually has", async () => {
    // style.css has a .gz and no .br. Negotiating against every encoding
    // borgo knows would resolve "br, gzip" to br, miss, and serve identity -
    // shipping raw bytes past a compressed file sitting on disk
    const i = info("/style.css");
    const res = serveIndexed(
      new Request("http://app.test/style.css", { headers: { "accept-encoding": "br, gzip" } }),
      i,
    );
    expect(res.headers.get("Content-Encoding")).toBe("gzip");
    expect(res.headers.get("ETag")).toBe(i.variants.find((v) => v.encoding === "gzip")!.etag);
    expect(new TextDecoder().decode(gunzipSync(await res.arrayBuffer()))).toBe(RAW_CSS);
  });

  test("a client that accepts only what the asset lacks gets identity", async () => {
    // br alone against a gzip-only file: there is nothing to negotiate to, and
    // identity is the honest answer rather than a body labelled with an
    // encoding it was never compressed with
    const i = info("/style.css");
    const res = serveIndexed(
      new Request("http://app.test/style.css", { headers: { "accept-encoding": "br" } }),
      i,
    );
    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect(await res.text()).toBe(RAW_CSS);
    expect(res.headers.get("ETag")).toBe(i.identity.etag);
  });

  test("server preference still decides when the asset has both", async () => {
    const i = info("/assets/client-abcd1234.js");
    const res = serveIndexed(
      new Request("http://app.test/assets/client-abcd1234.js", {
        headers: { "accept-encoding": "gzip, br" },
      }),
      i,
    );
    // the client listed gzip first; the order it sends carries no preference
    // without q-values, so borgo's own order picks the better codec
    expect(res.headers.get("Content-Encoding")).toBe("br");
  });

  test("a non-compressible file has no variants and no vary", async () => {
    const i = info("/logo.png");
    const res = serveIndexed(
      new Request("http://app.test/logo.png", { headers: { "accept-encoding": "br, gzip" } }),
      i,
    );
    expect(res.headers.get("Vary")).toBeNull();
    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect(await res.text()).toBe(RAW_PNG);
  });

  test("the service worker is never heuristically cached", () => {
    const res = serveIndexed(new Request("http://app.test/sw.js"), info("/sw.js"));
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
  });
});

describe("serveIndexed: conditional requests", () => {
  test("if-none-match on the identity etag is a 304 with validators intact", async () => {
    const i = info("/assets/client-abcd1234.js");
    const res = serveIndexed(req({ "if-none-match": i.identity.etag }), i);
    expect(res.status).toBe(304);
    expect(res.body).toBeNull();
    expect(res.headers.get("ETag")).toBe(i.identity.etag);
    expect(res.headers.get("Last-Modified")).toBe(i.lastModified);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  });

  test("the etag compared is the negotiated variant's, not the identity's", () => {
    const i = info("/assets/client-abcd1234.js");
    const br = i.variants.find((v) => v.encoding === "br")!;
    // holding the br representation and asking for br again: 304
    expect(serveIndexed(req({ "accept-encoding": "br", "if-none-match": br.etag }), i).status).toBe(304);
    // holding the identity etag but negotiating br: different representation, 200
    expect(
      serveIndexed(req({ "accept-encoding": "br", "if-none-match": i.identity.etag }), i).status,
    ).toBe(200);
    // and the reverse: a br etag cannot revalidate the identity
    expect(serveIndexed(req({ "if-none-match": br.etag }), i).status).toBe(200);
  });

  test("if-none-match: * and weak/list forms match", () => {
    const i = info("/assets/client-abcd1234.js");
    expect(serveIndexed(req({ "if-none-match": "*" }), i).status).toBe(304);
    expect(serveIndexed(req({ "if-none-match": `W/${i.identity.etag}` }), i).status).toBe(304);
    expect(serveIndexed(req({ "if-none-match": `"nope", ${i.identity.etag}` }), i).status).toBe(304);
  });

  test("if-modified-since answers only when no etag was given", () => {
    const i = info("/assets/client-abcd1234.js");
    expect(serveIndexed(req({ "if-modified-since": i.lastModified }), i).status).toBe(304);
    expect(
      serveIndexed(req({ "if-modified-since": new Date(0).toUTCString() }), i).status,
    ).toBe(200);
    // a mismatched etag wins over a fresh date: rfc 9110 precedence
    expect(
      serveIndexed(req({ "if-none-match": '"stale"', "if-modified-since": i.lastModified }), i).status,
    ).toBe(200);
  });
});

describe("serveIndexed: over a real socket (range, if-range, head)", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base: string;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(r) {
        const url = new URL(r.url);
        const i = index.get(url.pathname);
        if (!i) return new Response("not found", { status: 404 });
        return serveIndexed(r, i);
      },
    });
    base = `http://localhost:${server.port}`;
  });

  afterAll(() => server.stop(true));

  // ranges are taken over the *selected* representation, so these ask for
  // identity explicitly: with a gzip sibling on disk and no accept-encoding of
  // their own, they would be slicing compressed bytes and asserting plaintext
  test("a range off a file body is a 206 of exactly those bytes", async () => {
    const res = await fetch(`${base}/style.css`, {
      headers: { range: "bytes=0-3", "accept-encoding": "identity" },
    });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe(RAW_CSS.slice(0, 4));
    expect(res.headers.get("Content-Range")).toBe(`bytes 0-3/${RAW_CSS.length}`);
  });

  test("if-range with the current validator keeps the 206", async () => {
    const i = info("/style.css");
    const res = await fetch(`${base}/style.css`, {
      headers: { range: "bytes=5-9", "if-range": i.identity.etag, "accept-encoding": "identity" },
    });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe(RAW_CSS.slice(5, 10));
  });

  test("if-range with a stale validator gets the whole representation as 200", async () => {
    const res = await fetch(`${base}/style.css`, {
      headers: { range: "bytes=5-9", "if-range": '"an-old-etag"', "accept-encoding": "identity" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(RAW_CSS);
    expect(res.headers.get("Content-Range")).toBeNull();
    // the stream body cannot tell bun the type the file would have: it must
    // be stated, or nosniff makes the browser refuse the stylesheet
    expect(res.headers.get("Content-Type")).toContain("text/css");
  });

  // A date cannot authorise a range here, however current it is. Last-Modified
  // is the file's mtime, and every encoding variant of one url reports the same
  // one, so accepting it lets a client fetch the identity file and then resume
  // out of the brotli sibling. Measured before this rule: a 206 handing brotli
  // bytes to a client assembling plain css, and a 416 telling a client holding
  // 6400 bytes the resource was 35 bytes long.
  test("if-range refuses a date validator, current or not", async () => {
    const i = info("/style.css");
    for (const ifRange of [i.lastModified, new Date(0).toUTCString()]) {
      const res = await fetch(`${base}/style.css`, {
        headers: { range: "bytes=0-3", "if-range": ifRange, "accept-encoding": "identity" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Range")).toBeNull();
      expect(await res.text()).toBe(RAW_CSS);
    }
  });

  test("a resume that changes encoding mid-download is refused, not spliced", async () => {
    const i = info("/style.css");
    const gzipEtag = i.variants.find((v) => v.encoding === "gzip")!.etag;
    // started on identity, resuming with the gzip variant negotiated: the
    // etag the client holds is the identity one, so the range must be ignored
    const res = await fetch(`${base}/style.css`, {
      headers: { range: "bytes=5-9", "if-range": i.identity.etag, "accept-encoding": "gzip" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe(gzipEtag);
    expect(res.headers.get("Content-Range")).toBeNull();
  });

  test("a weak validator never authorises a range", async () => {
    const i = info("/style.css");
    const res = await fetch(`${base}/style.css`, {
      headers: { range: "bytes=0-3", "if-range": `W/${i.identity.etag}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(RAW_CSS);
  });

  test("a range on a negotiated variant ranges the sibling's bytes", async () => {
    const gz = gzipSync(RAW_CSS);
    const res = await fetch(`${base}/style.css`, {
      headers: { "accept-encoding": "gzip", range: "bytes=0-3" },
      // 4 bytes of a gzip stream are not a gzip stream: the client must not
      // inflate them, exactly as a resuming downloader would not
      decompress: false,
    } as RequestInit);
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Encoding")).toBe("gzip");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(gz.subarray(0, 4)));
  });

  test("a head answers the negotiated variant's length, not zero", async () => {
    const i = info("/assets/client-abcd1234.js");
    const br = i.variants.find((v) => v.encoding === "br")!;
    const res = await fetch(`${base}/assets/client-abcd1234.js`, {
      method: "HEAD",
      headers: { "accept-encoding": "br" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe(String(br.size));
    expect(await res.text()).toBe("");
  });

  test("a file rewritten after boot is framed from disk, head included", async () => {
    // the index remembers boot-time sizes, and a HEAD used to be answered from
    // it - so a client sizing a download from HEAD was told a number the GET
    // then contradicted, by any factor. Both are framed from the file now.
    const grown = RAW_PNG + " and then it grew past the indexed size";
    writeFileSync(join(dir, "public", "logo.png"), grown);
    try {
      const get = await fetch(`${base}/logo.png`);
      expect(await get.text()).toBe(grown);
      expect(get.headers.get("Content-Length")).toBe(String(grown.length));
      const head = await fetch(`${base}/logo.png`, { method: "HEAD" });
      expect(head.headers.get("Content-Length")).toBe(String(grown.length));
      expect(head.headers.get("Content-Length")).toBe(get.headers.get("Content-Length"));
    } finally {
      writeFileSync(join(dir, "public", "logo.png"), RAW_PNG);
    }
  });
});

describe("serveAsset: the unindexed path", () => {
  // the server builds this path as "public" + url.pathname: always forward
  // slashes, which the sw.js cache rule and the hash pattern both expect
  const p = (...parts: string[]) => join(dir, ...parts).replaceAll("\\", "/");

  test("a non-compressible file serves identity with an explicit length", async () => {
    const path = p("public", "logo.png");
    const res = await serveAsset(new Request("http://app.test/logo.png"), path, Bun.file(path), {
      dev: false,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(RAW_PNG);
    expect(res.headers.get("Content-Length")).toBe(String(RAW_PNG.length));
    expect(res.headers.get("Vary")).toBeNull();
    expect(res.headers.get("Content-Encoding")).toBeNull();
  });

  test("dev never serves a sibling, even when one exists on disk", async () => {
    const path = p("public", "style.css");
    const res = await serveAsset(
      new Request("http://app.test/style.css", { headers: { "accept-encoding": "gzip, br" } }),
      path,
      Bun.file(path),
      { dev: true },
    );
    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect(await res.text()).toBe(RAW_CSS);
    expect(res.headers.get("Vary")).toBe("Accept-Encoding");
  });

  test("production serves the gzip sibling with the original's content-type", async () => {
    const path = p("public", "style.css");
    const gz = gzipSync(RAW_CSS);
    const res = await serveAsset(
      new Request("http://app.test/style.css", { headers: { "accept-encoding": "gzip" } }),
      path,
      Bun.file(path),
      { dev: false },
    );
    expect(res.headers.get("Content-Encoding")).toBe("gzip");
    expect(res.headers.get("Content-Length")).toBe(String(gz.length));
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(gz));
    // the sibling is served under the original's type, not application/gzip
    expect(res.headers.get("Content-Type")).toContain("text/css");
  });

  test("a negotiated encoding without a sibling falls back to identity", async () => {
    // style.css has no .br sibling: a br-preferring client gets identity
    const path = p("public", "style.css");
    const res = await serveAsset(
      new Request("http://app.test/style.css", { headers: { "accept-encoding": "br" } }),
      path,
      Bun.file(path),
      { dev: false },
    );
    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect(await res.text()).toBe(RAW_CSS);
  });

  test("br sibling wins when present and accepted", async () => {
    const path = p("public", "assets", "client-abcd1234.js");
    const res = await serveAsset(
      new Request("http://app.test/assets/client-abcd1234.js", {
        headers: { "accept-encoding": "gzip, br" },
      }),
      path,
      Bun.file(path),
      { dev: false },
    );
    expect(res.headers.get("Content-Encoding")).toBe("br");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      new Uint8Array(brotliCompressSync(RAW_JS)),
    );
  });

  test("cache-control mirrors the indexed path: hashed immutable, sw.js no-cache", async () => {
    const hashed = p("public", "assets", "client-abcd1234.js");
    const sw = p("public", "sw.js");
    const plain = p("public", "style.css");
    const cc = async (p: string) =>
      (await serveAsset(new Request("http://app.test/x"), p, Bun.file(p), { dev: true })).headers.get(
        "Cache-Control",
      );
    expect(await cc(hashed)).toBe("public, max-age=31536000, immutable");
    expect(await cc(sw)).toBe("no-cache");
    // an asset with no policy of its own now carries a Last-Modified, and a
    // browser is free to heuristically cache anything dated for a tenth of its
    // age. In dev that is the rebuilt-in-place bundle pinned for the afternoon,
    // so dev states no-cache: revalidate, and take the 304 when nothing moved.
    expect(await cc(plain)).toBe("no-cache");
    const prod = await serveAsset(new Request("http://app.test/x"), plain, Bun.file(plain), {
      dev: false,
    });
    expect(prod.headers.get("Cache-Control")).toBeNull();
  });

  // This path used to emit no ETag, no Last-Modified and never consult
  // If-Range, while negotiating br/gz per request off one url and handing back
  // a rangeable Bun.file body. That is exactly the cross-encoding splice
  // serveIndexed has nine lines of comment about - here with no mitigation and
  // no validator a client could even have sent to be checked.
  describe("validators", () => {
    const serve = (path: string, headers: Record<string, string> = {}, dev = false) =>
      serveAsset(new Request("http://app.test/style.css", { headers }), path, Bun.file(path), { dev });

    test("every response carries an etag and a last-modified", async () => {
      for (const path of [p("public", "style.css"), p("public", "logo.png"), p("public", "sw.js")]) {
        const res = await serve(path);
        expect(res.headers.get("ETag")).toMatch(/^"[0-9a-z]+-[0-9a-z]+"$/);
        expect(Date.parse(res.headers.get("Last-Modified")!)).not.toBeNaN();
      }
    });

    test("the etag revalidates: if-none-match answers 304 with no body", async () => {
      const path = p("public", "style.css");
      const etag = (await serve(path)).headers.get("ETag")!;
      const res = await serve(path, { "if-none-match": etag });
      expect(res.status).toBe(304);
      expect(await res.text()).toBe("");
      expect(res.headers.get("ETag")).toBe(etag);
      // and a stale one still gets the file
      const stale = await serve(path, { "if-none-match": '"nope-nope"' });
      expect(stale.status).toBe(200);
      expect(await stale.text()).toBe(RAW_CSS);
    });

    // each encoding of one url is its own representation. Sharing a validator
    // is what lets a client revalidate the identity file and be handed a 304
    // for the brotli one, or splice a range of one onto a prefix of the other.
    test("each variant gets its own etag, and one does not answer for another", async () => {
      const path = p("public", "style.css");
      const identity = (await serve(path)).headers.get("ETag")!;
      const gzipped = await serve(path, { "accept-encoding": "gzip" });
      expect(gzipped.headers.get("Content-Encoding")).toBe("gzip");
      expect(gzipped.headers.get("ETag")).not.toBe(identity);
      expect(gzipped.headers.get("ETag")).toContain("-gzip");

      // the identity etag must not 304 a request that would be answered gzipped
      const crossed = await serve(path, {
        "if-none-match": identity,
        "accept-encoding": "gzip",
      });
      expect(crossed.status).toBe(200);
      expect(crossed.headers.get("Content-Encoding")).toBe("gzip");
    });

    // rfc 9110 §13.1.5: a range whose validator no longer matches must be
    // answered with the whole representation, or the client splices new bytes
    // onto an old prefix and calls the result a file. bun ranges a Bun.file
    // body without ever consulting If-Range, so the refusal is spelled as a
    // stream body - which bun does not range. Only bun's own server turns a
    // Range into a 206, so these two go over a real socket.
    describe("over a real socket", () => {
      let server: ReturnType<typeof Bun.serve>;
      let base: string;

      beforeAll(() => {
        server = Bun.serve({
          port: 0,
          fetch(r) {
            const path = join(dir, "public", new URL(r.url).pathname).replaceAll("\\", "/");
            return serveAsset(r, path, Bun.file(path), { dev: false });
          },
        });
        base = `http://localhost:${server.port}`;
      });

      afterAll(() => server.stop(true));

      test("a range with a matching if-range is still a 206 of exactly those bytes", async () => {
        const etag = (await fetch(`${base}/style.css`, {
          headers: { "accept-encoding": "identity" },
        })).headers.get("ETag")!;
        const res = await fetch(`${base}/style.css`, {
          headers: { range: "bytes=0-3", "if-range": etag, "accept-encoding": "identity" },
        });
        expect(res.status).toBe(206);
        expect(await res.text()).toBe(RAW_CSS.slice(0, 4));
      });

      test("a range with a stale if-range gets the whole representation as 200", async () => {
        const res = await fetch(`${base}/style.css`, {
          headers: { range: "bytes=0-3", "if-range": '"an-old-etag"', "accept-encoding": "identity" },
        });
        expect(res.status).toBe(200);
        expect(await res.text()).toBe(RAW_CSS);
        expect(res.headers.get("Content-Range")).toBeNull();
        // a stream body loses the type bun derives from a file, and under the
        // global nosniff a typeless stylesheet is a refused stylesheet
        expect(res.headers.get("Content-Type")).toContain("text/css");
      });

      // the splice this refusal exists for: resume a download started as
      // identity, this time accepting gzip, and the range would be filled out
      // of the compressed sibling
      test("a resume that would cross encodings is refused, not spliced", async () => {
        const identity = (await fetch(`${base}/style.css`, {
          headers: { "accept-encoding": "identity" },
        })).headers.get("ETag")!;
        const res = await fetch(`${base}/style.css`, {
          headers: { range: "bytes=0-3", "if-range": identity, "accept-encoding": "gzip" },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Range")).toBeNull();
      });
    });

    test("the etag moves when the file does", async () => {
      const path = join(dir, "public", "mutable.css");
      writeFileSync(path, "a{}");
      const before = (await serve(path)).headers.get("ETag");
      writeFileSync(path, "a{color:red}");
      // the same size would still be a different mtime, but make both move
      expect((await serve(path)).headers.get("ETag")).not.toBe(before);
      rmSync(path, { force: true });
    });

    test("a file deleted between the caller's check and the read is a 404, not a throw", async () => {
      const gone = join(dir, "public", "vanished.css").replaceAll("\\", "/");
      const res = await serve(gone);
      expect(res.status).toBe(404);
    });
  });
});

test("a precompressed sibling deleted after boot degrades to identity, not a 500", async () => {
  const dir = mkdtempSync(join(tmpdir(), "borgo-stale-"));
  const file = join(dir, "app.js");
  writeFileSync(file, "console.log('hello')");
  writeFileSync(file + ".gz", gzipSync(Buffer.from("console.log('hello')")));
  const index = buildAssetIndex(dir);
  const info = [...index.values()][0];
  expect(info.variants.some((v) => v.encoding === "gzip")).toBe(true);

  // the sibling vanishes the way a parallel `borgo dev` build removes it
  rmSync(file + ".gz");
  const res = serveIndexed(
    new Request("http://x/app.js", { headers: { "accept-encoding": "gzip" } }),
    info,
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("content-encoding")).toBe(null);
  expect(await res.text()).toBe("console.log('hello')");
  rmSync(dir, { recursive: true, force: true });
});
