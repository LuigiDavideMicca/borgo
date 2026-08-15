import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, gunzipSync, gzipSync } from "node:zlib";
import {
  buildAssetIndex,
  serveAsset,
  serveIndexed,
  type AssetInfo,
  type BuildOutputs,
} from "../src/compress";

// a real public/ tree: a hashed bundle with both siblings, a css with only a
// gzip sibling, an image, a service worker. the contents of each sibling are
// distinct on purpose, so the body always names the file that produced it.
let dir: string;
let index: Map<string, AssetInfo>;

// what `borgo build` recorded: the directory it wrote and the byte length of
// each output it hashed. the server is never asked to infer either from a
// name, so the fixture states them the same way the build does.
let outputs: BuildOutputs;

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
  outputs = {
    dir: join(dir, "public", "assets").replaceAll("\\", "/"),
    sizes: new Map([["client-abcd1234.js", RAW_JS.length]]),
  };
  index = buildAssetIndex(join(dir, "public"), undefined, outputs);
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
    // the tag is already weak, and "W/W/\"...\"" is not an entity-tag at all
    // (RFC 9110 §8.8.3) - refusing it is the right answer, so the fixture asks
    // the question it meant to ask: the same tag, quoted as the client sends it
    expect(serveIndexed(req({ "if-none-match": i.identity.etag }), i).status).toBe(304);
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

  // the retirement, asserted rather than deleted: the validator is size+mtime,
  // which two different files can share, and a range is the one place where a
  // wrong match CORRUPTS - new bytes spliced onto an old prefix - instead of
  // merely serving stale that no-cache would recheck. RFC 9110 §13.1.5 lets
  // only a strong validator authorise one, so ours never does
  test("a range is refused even when the client quotes back the validator we sent", async () => {
    const i = info("/style.css");
    const res = await fetch(`${base}/style.css`, {
      headers: { range: "bytes=5-9", "if-range": i.identity.etag, "accept-encoding": "identity" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(RAW_CSS);
    expect(res.headers.get("Content-Range")).toBeNull();
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

  // An HTTP date resolves to one second, so it cannot name which representation
  // it describes. Measured before this rule: a 206 handing brotli bytes to a
  // client assembling plain css, and a 416 telling a client holding 6400 bytes
  // the resource was 35 bytes long.
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
      (
        await serveAsset(new Request("http://app.test/x"), p, Bun.file(p), {
          dev: true,
          outputs,
        })
      ).headers.get("Cache-Control");
    expect(await cc(hashed)).toBe("public, max-age=31536000, immutable");
    expect(await cc(sw)).toBe("no-cache");
    // an asset with no policy of its own still carries a Last-Modified, and a
    // browser is free to heuristically cache anything dated for a tenth of its
    // age: yesterday's bundle pinned against today's document. dev and prod
    // state the same no-cache - the policy belongs to the url, not to the
    // environment, and this used to be the one place they disagreed.
    expect(await cc(plain)).toBe("no-cache");
    const prod = await serveAsset(new Request("http://app.test/x"), plain, Bun.file(plain), {
      dev: false,
      outputs,
    });
    expect(prod.headers.get("Cache-Control")).toBe("no-cache");
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
        expect(res.headers.get("ETag")).toMatch(/^W\/"[0-9a-z]+-[0-9a-z]+"$/);
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

      // same retirement on the live path: the tag we hand out is weak, so
      // handing it straight back does not buy a range
      test("the validator we just served does not authorise a range", async () => {
        const etag = (await fetch(`${base}/style.css`, {
          headers: { "accept-encoding": "identity" },
        })).headers.get("ETag")!;
        expect(etag).toMatch(/^W\//);
        const res = await fetch(`${base}/style.css`, {
          headers: { range: "bytes=0-3", "if-range": etag, "accept-encoding": "identity" },
        });
        expect(res.status).toBe(200);
        expect(await res.text()).toBe(RAW_CSS);
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

// Measured on the wire against a production build: /assets/client.js,
// /assets/style.css and /logo.svg all came back 200 with an ETag, a
// Last-Modified and no Cache-Control, while /assets/client-50dbnr0a.js beside
// them carried the year. The document referencing those unhashed names is
// private, no-store and therefore always fresh, so a returning browser fetched
// today's html and ran a heuristically-cached yesterday's bundle against it.
//
// These go over a socket on purpose. The defect was two serving paths
// disagreeing about one url - the indexed snapshot said nothing, the live path
// said nothing in production and no-cache in dev - and a function's return
// value cannot say which of them answered.
// brotli at max quality on a real tree runs past bun's 5s default, and these
// two blocks precompress one. A test that goes red because the machine was
// busy is not measuring what it claims - it teaches everyone to re-run instead
// of to read, which is how a real failure gets waved through.
const WIRE_TIMEOUT = 60_000;

describe("cache-control on the wire: every serving path, every encoding", () => {
  let root: string;
  let servers: { name: string; base: string; stop: () => void }[];

  // exactly what a build would have recorded for this tree: the one directory
  // it wrote, and a byte length per output it hashed. Note what is NOT here:
  // the entry bundle it emitted, and every app file in the same folder.
  let MANIFEST: BuildOutputs;

  const HASHED_BODIES: Record<string, string> = {
    "client-50dbnr0a.js": "console.log('hashed chunk');",
    "style-9f3a1c07.css": "main{padding:1rem}",
    "logo-6nnjve26.png": "hashed PNG bytes",
    "inter-6nnjve26.woff2": "hashed WOFF2 bytes",
  };

  // Same basenames, byte-for-byte identical bodies, in another folder that
  // happens to be called "assets" - which is what every Vite/CRA/Astro bundle
  // copied into public/ ships. Identical bytes on purpose: the length check
  // cannot save these, so only matching the whole directory can. Measured on
  // the wire before that: pinned for a year on bytes the bundler never saw.
  const IMPOSTORS = [
    "/copy/assets/client-50dbnr0a.js",
    "/deep/nested/assets/client-50dbnr0a.js",
    "/copy/assets/logo-6nnjve26.png",
    // a folder whose name merely starts the same, and a level below the real one
    "/assetsx/client-50dbnr0a.js",
    "/assets/sub/client-50dbnr0a.js",
  ];

  const HASHED = [
    "/assets/client-50dbnr0a.js",
    "/assets/style-9f3a1c07.css",
    // bun hashes these too, and the old js/css rule refused them: every image
    // and font paid a conditional round trip per load, forever
    "/assets/logo-6nnjve26.png",
    "/assets/inter-6nnjve26.woff2",
  ];

  const REVALIDATED = [
    "/assets/client.js", // unhashed entry bundle
    "/assets/style.css", // unhashed stylesheet
    "/logo.svg", // unhashed static file, compressible
    "/photo.png", // unhashed static file, not compressible
    "/sw.js", // its own rule, and it must keep it
    // app files the old shape rule pinned for a year off a real build. Every
    // one of these is an eight-letter word where a hash was assumed to be.
    "/assets/stripe-checkout.js",
    "/assets/hero-carousel.js",
    "/assets/vendor-database.css",
    // nine letters, so it escaped the old rule by luck rather than by design
    "/assets/google-analytics.js",
    ...IMPOSTORS,
  ];

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "borgo-cache-control-"));
    const pub = join(root, "public");
    mkdirSync(join(pub, "assets"), { recursive: true });
    const write = (rel: string, body: string, siblings: ("gz" | "br")[] = []) => {
      const path = join(pub, rel);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, body);
      if (siblings.includes("gz")) writeFileSync(path + ".gz", gzipSync(body));
      if (siblings.includes("br")) writeFileSync(path + ".br", brotliCompressSync(body));
    };
    write("assets/client.js", "console.log('unhashed entry bundle');", ["gz", "br"]);
    write("assets/client-50dbnr0a.js", HASHED_BODIES["client-50dbnr0a.js"], ["gz", "br"]);
    write("assets/style.css", "body{color:rebeccapurple}", ["gz"]);
    write("assets/style-9f3a1c07.css", HASHED_BODIES["style-9f3a1c07.css"], ["gz"]);
    write("assets/logo-6nnjve26.png", HASHED_BODIES["logo-6nnjve26.png"]);
    write("assets/inter-6nnjve26.woff2", HASHED_BODIES["inter-6nnjve26.woff2"]);
    for (const url of IMPOSTORS) write(url.slice(1), HASHED_BODIES[url.split("/").pop()!]);
    write("logo.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>");
    write("photo.png", "PNG bytes, not really");
    write("sw.js", "self.addEventListener('fetch',()=>{});");
    // the app's own files, dropped into the build's output directory exactly
    // as build.ts:583 says apps do
    write("assets/stripe-checkout.js", "window.Stripe && Stripe('pk_live');", ["gz"]);
    write("assets/hero-carousel.js", "export const carousel = () => {};", ["gz"]);
    write("assets/vendor-database.css", ".db-grid{display:grid}", ["gz"]);
    write("assets/google-analytics.js", "window.dataLayer = window.dataLayer || [];", ["gz"]);

    // the build measures every representation it wrote, identity and siblings
    // alike, because each of them goes out under the same directive
    const sizes = new Map<string, number>();
    for (const [name, body] of Object.entries(HASHED_BODIES)) {
      sizes.set(name, body.length);
      for (const [ext, bytes] of [
        [".gz", gzipSync(body)],
        [".br", brotliCompressSync(body)],
      ] as const) {
        if (existsSync(join(pub, "assets", name + ext))) sizes.set(name + ext, bytes.length);
      }
    }
    MANIFEST = { dir: join(pub, "assets").replaceAll("\\", "/"), sizes };

    const live = (dev: boolean) => (r: Request) => {
      // the same path the server builds: "public" + the url, forward slashes,
      // which is what the sw.js rule and the manifest lookup both read
      const path = join(pub, new URL(r.url).pathname).replaceAll("\\", "/");
      return serveAsset(r, path, Bun.file(path), { dev, outputs: MANIFEST });
    };
    const indexed = buildAssetIndex(pub.replaceAll("\\", "/"), undefined, MANIFEST);
    const routes: [string, (r: Request) => Response][] = [
      // production, boot-time snapshot: the path that shipped no header at all
      [
        "indexed",
        (r) => {
          const i = indexed.get(new URL(r.url).pathname);
          return i ? serveIndexed(r, i) : new Response("not indexed", { status: 500 });
        },
      ],
      // production, anything written into public/ after boot
      ["live-prod", live(false)],
      // dev, where the index is deliberately empty
      ["live-dev", live(true)],
    ];
    servers = routes.map(([name, fetchOne]) => {
      const server = Bun.serve({ port: 0, fetch: fetchOne });
      return { name, base: `http://localhost:${server.port}`, stop: () => server.stop(true) };
    });
  });

  afterAll(() => {
    for (const s of servers) s.stop();
    rmSync(root, { recursive: true, force: true });
  });

  // "identity" rather than an absent header: fetch supplies its own
  // accept-encoding, and the precompressed variants are a different branch
  const ENCODINGS = ["identity", "gzip"] as const;

  const get = (base: string, url: string, encoding: string, extra: Record<string, string> = {}) =>
    fetch(`${base}${url}`, {
      headers: { "accept-encoding": encoding, ...extra },
      decompress: false,
    } as RequestInit);

  test("an asset whose url does not identify its content always revalidates", async () => {
    for (const { name, base } of servers) {
      for (const url of REVALIDATED) {
        for (const encoding of ENCODINGS) {
          const res = await get(base, url, encoding);
          expect(res.status).toBe(200);
          expect(`${name} ${url} ${encoding}: ${res.headers.get("Cache-Control")}`).toBe(
            `${name} ${url} ${encoding}: no-cache`,
          );
          // no-cache is not no-store: the body may be kept, it just may not be
          // reused without asking, which is what the validator below is for
          expect(res.headers.get("Cache-Control")).not.toContain("no-store");
          expect(res.headers.get("ETag")).toMatch(/^W\/"[0-9a-z]+-[0-9a-z]+(-br|-gzip)?"$/);
        }
      }
    }
  }, WIRE_TIMEOUT);

  // The dangerous direction, and the one that was actually shipping. An app
  // file living in the build's output directory is not the build's, and no
  // amount of it looking like a chunk makes its url a promise. Measured on the
  // wire before this: stripe-checkout.js pinned for a year, so updating the
  // vendored file in place left every browser that had seen it holding the old
  // copy with no revalidation.
  test("an app file in assets/ is never pinned, however hash-shaped its name", async () => {
    const traps = REVALIDATED.filter((u) => /^\/assets\/[^/]+-[^/]+$/.test(u));
    expect(traps.length).toBeGreaterThan(0);
    for (const { name, base } of servers) {
      for (const url of traps) {
        for (const encoding of ENCODINGS) {
          const res = await get(base, url, encoding);
          expect(`${name} ${url} ${encoding}: ${res.headers.get("Cache-Control")}`).toBe(
            `${name} ${url} ${encoding}: no-cache`,
          );
        }
      }
    }
  }, WIRE_TIMEOUT);

  // A folder called "assets" is not the build's output directory. These hold
  // bytes identical to the recorded ones, so the length check passes and only
  // matching the whole directory can refuse them.
  test("another folder spelled assets is not the build's output directory", async () => {
    for (const { name, base } of servers) {
      for (const url of IMPOSTORS) {
        for (const encoding of ENCODINGS) {
          const res = await get(base, url, encoding);
          expect(res.status).toBe(200);
          expect(`${name} ${url} ${encoding}: ${res.headers.get("Cache-Control")}`).toBe(
            `${name} ${url} ${encoding}: no-cache`,
          );
        }
      }
    }
  }, WIRE_TIMEOUT);

  // The representation on the wire is the one that has to be vouched for.
  // Measured before this: identity untouched at its recorded length, the .gz
  // replaced 749 -> 75 bytes, and the 75 stale bytes went out `immutable`
  // because the check was pointed at the identity file. Nearly every client
  // sends Accept-Encoding, so that was the common case, not a corner of it.
  test("a replaced sibling is not pinned, even though the identity file is", async () => {
    const url = "/assets/client-50dbnr0a.js";
    const name = "client-50dbnr0a.js";
    const gz = join(root, "public", "assets", `${name}.gz`);
    const original = gzipSync(HASHED_BODIES[name]);
    try {
      writeFileSync(gz, "unrelated bytes, nothing like the recorded sibling");
      for (const { name: server, base } of servers) {
        for (const encoding of ["identity", "gzip", "br"]) {
          const res = await get(base, url, encoding);
          // keyed off what actually came back, not off what was asked for:
          // dev negotiates no siblings and answers identity to all three
          const sent = res.headers.get("Content-Encoding") ?? "identity";
          const expected = sent === "gzip" ? "no-cache" : "public, max-age=31536000, immutable";
          expect(`${server} sent=${sent}: ${res.headers.get("Cache-Control")}`).toBe(
            `${server} sent=${sent}: ${expected}`,
          );
        }
      }
    } finally {
      writeFileSync(gz, original);
    }
  }, WIRE_TIMEOUT);

  // a sibling on disk that no build measured cannot be pinned either, however
  // intact the identity file beside it is
  test("a sibling the build never measured is never pinned", async () => {
    // this css was built with a .gz the manifest recorded and no .br at all;
    // a .br appearing later is a file no build ever vouched for
    const name = "style-9f3a1c07.css";
    const br = join(root, "public", "assets", `${name}.br`);
    try {
      writeFileSync(br, brotliCompressSync(HASHED_BODIES[name]));
      const fresh = buildAssetIndex(join(root, "public").replaceAll("\\", "/"), undefined, MANIFEST);
      const info = fresh.get(`/assets/${name}`)!;
      expect(info.identity.pinnedSize).toBe(HASHED_BODIES[name].length);
      const pinned = Object.fromEntries(info.variants.map((v) => [v.encoding, v.pinnedSize]));
      expect(pinned.br).toBeNull();
      expect(pinned.gzip).toBe(gzipSync(HASHED_BODIES[name]).length);

      const serve = (accept: string) =>
        serveIndexed(
          new Request(`http://app.test/assets/${name}`, { headers: { "accept-encoding": accept } }),
          info,
        );
      const brRes = serve("br");
      expect(brRes.headers.get("Content-Encoding")).toBe("br");
      expect(brRes.headers.get("Cache-Control")).toBe("no-cache");
      // and the measured sibling beside it is unaffected
      const gzRes = serve("gzip");
      expect(gzRes.headers.get("Content-Encoding")).toBe("gzip");
      expect(gzRes.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    } finally {
      rmSync(br, { force: true });
    }
  }, WIRE_TIMEOUT);

  // The manifest vouches for bytes, not for a name. A recorded chunk deleted
  // and recreated after boot keeps its name and its manifest entry, and used
  // to inherit the year with them - on the live path measured directly.
  test("a recorded name whose bytes changed after boot loses its year", async () => {
    const url = "/assets/client-50dbnr0a.js";
    const path = join(root, "public", "assets", "client-50dbnr0a.js");
    const original = HASHED_BODIES["client-50dbnr0a.js"];
    try {
      // pinned while it is still the file the build measured
      for (const { base } of servers) {
        expect((await get(base, url, "identity")).headers.get("Cache-Control")).toContain(
          "immutable",
        );
      }
      writeFileSync(path, "console.log('someone rewrote this after boot');");
      for (const { name, base } of servers) {
        for (const encoding of ENCODINGS) {
          const res = await get(base, url, encoding);
          expect(`${name} ${encoding}: ${res.headers.get("Cache-Control")}`).toBe(
            `${name} ${encoding}: no-cache`,
          );
        }
      }
      // and it is pinned again once the recorded bytes are back
      writeFileSync(path, original);
      expect(
        (await get(servers[0].base, url, "identity")).headers.get("Cache-Control"),
      ).toContain("immutable");
    } finally {
      writeFileSync(path, original);
    }
  }, WIRE_TIMEOUT);

  // The other direction, and the cost of getting cautious wrong. Too strict and
  // every content-addressed asset loses its year - a regression nobody notices
  // until they measure. The old rule matched js and css alone, so bun's hashed
  // images and fonts paid a conditional request per load forever; they are in
  // this list on purpose.
  test("a content-hashed asset keeps its year on every path and every encoding", async () => {
    for (const { name, base } of servers) {
      for (const url of HASHED) {
        for (const encoding of [...ENCODINGS, "br", "br, gzip"]) {
          const res = await get(base, url, encoding);
          expect(res.status).toBe(200);
          expect(`${name} ${url} ${encoding}: ${res.headers.get("Cache-Control")}`).toBe(
            `${name} ${url} ${encoding}: public, max-age=31536000, immutable`,
          );
        }
      }
    }
  }, WIRE_TIMEOUT);

  // the invariant that actually broke: not "the wrong policy" but "no policy",
  // which is the one answer a browser is free to replace with a guess
  test("no asset is ever served without a policy", async () => {
    for (const { name, base } of servers) {
      for (const url of [...REVALIDATED, ...HASHED]) {
        const res = await get(base, url, "gzip");
        expect(`${name} ${url} set: ${res.headers.has("Cache-Control")}`).toBe(
          `${name} ${url} set: true`,
        );
      }
    }
  }, WIRE_TIMEOUT);

  // no-cache is only cheap because the revalidation it forces is answered
  // without a body: if the etag did not round-trip, this would be a full
  // re-download of every unhashed asset on every navigation
  test("the forced revalidation is a bodyless 304, per path and per encoding", async () => {
    for (const { name, base } of servers) {
      for (const url of [...REVALIDATED, ...HASHED]) {
        for (const encoding of ENCODINGS) {
          const first = await get(base, url, encoding);
          const etag = first.headers.get("ETag")!;
          const second = await get(base, url, encoding, { "if-none-match": etag });
          expect(`${name} ${url} ${encoding}: ${second.status}`).toBe(
            `${name} ${url} ${encoding}: 304`,
          );
          expect(await second.text()).toBe("");
          // the validators and the policy survive the 304, or the cache
          // updates its entry with nothing and asks again next time
          expect(second.headers.get("ETag")).toBe(etag);
          expect(second.headers.get("Cache-Control")).toBe(first.headers.get("Cache-Control"));
        }
      }
    }
  }, WIRE_TIMEOUT);
});

// A deploy that replaces files in place under a running `borgo start`. The
// index is a boot snapshot, and serving its ETag and its Last-Modified meant
// new bytes went out labelled with the old validator: measured on the wire,
// ETag "gf-msf40zn3" - gf is 591 in base36 - on a response whose
// Content-Length was 557, the etag contradicting the length beside it, and
// every conditional request that quoted it came back 304 forever. The
// no-cache the previous fix added is precisely what sends a browser down this
// path, so it made the defect more reachable rather than less.
//
// Over a socket, on both serving paths, with the files replaced under the
// running servers rather than only at boot: a snapshot defect is invisible to
// a request made at boot, and a return value cannot say which path answered.
describe("validators on the wire: an in-place deploy under a running server", () => {
  let root: string;
  let servers: { name: string; base: string; stop: () => void }[];
  let MANIFEST: BuildOutputs;

  const HASHED = "assets/app-a1b2c3d4.js";
  const V1: Record<string, string> = {
    "assets/app.js": "console.log('v1 of the unhashed entry bundle');",
    [HASHED]: "console.log('v1 of the hashed chunk');",
    "sw.js": "self.addEventListener('fetch', () => { /* v1 */ });",
  };
  // shorter on purpose: a stale etag's own size field then contradicts the
  // Content-Length in the very same response, which is how this was spotted
  const V2: Record<string, string> = {
    "assets/app.js": "console.log('v2');",
    [HASHED]: "console.log('v2 chunk');",
    "sw.js": "self.addEventListener('fetch',()=>{});",
  };
  const URLS = ["/assets/app.js", `/${HASHED}`, "/sw.js"];
  // the precompressed sibling is a separate representation with its own file
  // and its own validator, so it has to be asked for separately
  const ENCODINGS = ["identity", "gzip"] as const;

  // backdated at boot so the deploy below moves the mtime across a whole
  // second: http dates have a one second resolution, and a rewrite inside the
  // same second is indistinguishable to If-Modified-Since on any correct
  // implementation. Ten seconds is a deploy, not a fixture trick.
  const AGE_MS = 10_000;

  const write = (rel: string, body: string) => {
    const path = join(root, "public", rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
    writeFileSync(path + ".gz", gzipSync(body));
  };

  const backdate = () => {
    const when = new Date(Date.now() - AGE_MS);
    for (const rel of Object.keys(V1)) {
      for (const path of [join(root, "public", rel), join(root, "public", rel + ".gz")]) {
        utimesSync(path, when, when);
      }
    }
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "borgo-deploy-in-place-"));
    for (const [rel, body] of Object.entries(V1)) write(rel, body);
    backdate();

    const pub = join(root, "public").replaceAll("\\", "/");
    // the build vouched for the hashed chunk and both of its representations
    MANIFEST = {
      dir: join(root, "public", "assets").replaceAll("\\", "/"),
      sizes: new Map([
        ["app-a1b2c3d4.js", V1[HASHED].length],
        ["app-a1b2c3d4.js.gz", gzipSync(V1[HASHED]).length],
      ]),
    };
    const indexed = buildAssetIndex(pub, undefined, MANIFEST);
    const routes: [string, (r: Request) => Response][] = [
      [
        "indexed",
        (r) => {
          const i = indexed.get(new URL(r.url).pathname);
          return i ? serveIndexed(r, i) : new Response("not indexed", { status: 500 });
        },
      ],
      [
        "live-prod",
        (r) => {
          const path = join(pub, new URL(r.url).pathname).replaceAll("\\", "/");
          return serveAsset(r, path, Bun.file(path), { dev: false, outputs: MANIFEST });
        },
      ],
    ];
    servers = routes.map(([name, fetchOne]) => {
      const server = Bun.serve({ port: 0, fetch: fetchOne });
      return { name, base: `http://localhost:${server.port}`, stop: () => server.stop(true) };
    });
  }, WIRE_TIMEOUT);

  afterAll(() => {
    for (const s of servers) s.stop();
    rmSync(root, { recursive: true, force: true });
  });

  const get = (base: string, url: string, encoding: string, extra: Record<string, string> = {}) =>
    fetch(`${base}${url}`, {
      headers: { "accept-encoding": encoding, ...extra },
      decompress: false,
    } as RequestInit);

  // the leading field of an etag is the byte length of the representation it
  // labels, in base36. A response whose etag and Content-Length disagree is
  // carrying a validator for bytes it is not sending, and that mismatch is
  // readable off a single response with nothing to compare it to.
  // the tag is weak, so the W/ prefix comes off before the length is read
  const etagSize = (etag: string) => parseInt(etag.replace(/^W\//, "").slice(1).split("-")[0], 36);

  // The strict direction, and it costs too: a validator that moves while the
  // bytes did not turns every revalidation into a full re-download of an asset
  // the client already holds. Asserted first, on an untouched tree, so the
  // fresh-validator tests below cannot be satisfied by simply never repeating
  // an etag.
  test("an unchanged file still answers 304, on both validators", async () => {
    for (const { name, base } of servers) {
      for (const url of URLS) {
        for (const encoding of ENCODINGS) {
          const key = `${name} ${url} ${encoding}`;
          const first = await get(base, url, encoding);
          expect(`${key}: ${first.status}`).toBe(`${key}: 200`);
          const etag = first.headers.get("ETag")!;
          const date = first.headers.get("Last-Modified")!;
          // repeated with nothing touched in between: still the same file
          const again = await get(base, url, encoding);
          expect(`${key} stable: ${again.headers.get("ETag")}`).toBe(`${key} stable: ${etag}`);
          expect(`${key} stable: ${again.headers.get("Last-Modified")}`).toBe(`${key} stable: ${date}`);

          const byEtag = await get(base, url, encoding, { "if-none-match": etag });
          expect(`${key} etag: ${byEtag.status}`).toBe(`${key} etag: 304`);
          expect(await byEtag.text()).toBe("");
          const byDate = await get(base, url, encoding, { "if-modified-since": date });
          expect(`${key} date: ${byDate.status}`).toBe(`${key} date: 304`);
        }
      }
    }
  }, WIRE_TIMEOUT);

  // Boot and the socket must compute one url's validator the same way, or an
  // untouched file appears to change between the snapshot and the wire. When
  // the two formulas drifted apart, the tests comparing them passed alone and
  // failed only in a full run.
  test("the boot snapshot's etag is the one that goes on the wire", async () => {
    const { base } = servers.find((s) => s.name === "indexed")!;
    const fresh = buildAssetIndex(join(root, "public").replaceAll("\\", "/"), undefined, MANIFEST);
    for (const rel of Object.keys(V1)) {
      const i = fresh.get(`/${rel}`)!;
      expect(`${rel} identity: ${(await get(base, `/${rel}`, "identity")).headers.get("ETag")}`).toBe(
        `${rel} identity: ${i.identity.etag}`,
      );
      expect(`${rel} gzip: ${(await get(base, `/${rel}`, "gzip")).headers.get("ETag")}`).toBe(
        `${rel} gzip: ${i.variants.find((v) => v.encoding === "gzip")!.etag}`,
      );
      expect(`${rel} date: ${(await get(base, `/${rel}`, "identity")).headers.get("Last-Modified")}`).toBe(
        `${rel} date: ${i.lastModified}`,
      );
    }
  }, WIRE_TIMEOUT);

  // The bug. Every assertion here is a header off a real socket, taken after
  // the bytes on disk moved under the running server.
  test("a file replaced under the running server never 304s the old copy", async () => {
    const before: Record<string, { etag: string; date: string }> = {};
    for (const { name, base } of servers) {
      for (const url of URLS) {
        for (const encoding of ENCODINGS) {
          const res = await get(base, url, encoding);
          before[`${name} ${url} ${encoding}`] = {
            etag: res.headers.get("ETag")!,
            date: res.headers.get("Last-Modified")!,
          };
        }
      }
    }
    // the hashed chunk is still the one the build measured, so it is pinned:
    // the fresh validator must not have cost the pin its recorded lengths
    for (const { base } of servers) {
      for (const encoding of ENCODINGS) {
        const res = await get(base, `/${HASHED}`, encoding);
        expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
      }
    }

    try {
      for (const [rel, body] of Object.entries(V2)) write(rel, body);

      for (const { name, base } of servers) {
        for (const url of URLS) {
          for (const encoding of ENCODINGS) {
            const key = `${name} ${url} ${encoding}`;
            const was = before[key];
            const res = await get(base, url, encoding);
            expect(`${key}: ${res.status}`).toBe(`${key}: 200`);

            const etag = res.headers.get("ETag")!;
            const length = Number(res.headers.get("Content-Length"));
            // the length actually sent, and the length the etag claims
            const expected = encoding === "gzip" ? gzipSync(V2[url.slice(1)]).length : V2[url.slice(1)].length;
            expect(`${key} length: ${length}`).toBe(`${key} length: ${expected}`);
            expect(`${key} etag describes: ${etagSize(etag)}`).toBe(`${key} etag describes: ${length}`);
            expect(`${key} etag moved: ${etag !== was.etag}`).toBe(`${key} etag moved: true`);
            expect(`${key} date moved: ${res.headers.get("Last-Modified") !== was.date}`).toBe(
              `${key} date moved: true`,
            );
            // the previous fix stands: a policy on every response
            expect(`${key} policy: ${res.headers.has("Cache-Control")}`).toBe(`${key} policy: true`);

            // the revalidation that no-cache sends every browser back to make.
            // A 304 here is the whole defect: the client keeps v1 forever.
            const byEtag = await get(base, url, encoding, { "if-none-match": was.etag });
            expect(`${key} old etag: ${byEtag.status}`).toBe(`${key} old etag: 200`);
            expect(`${key} old etag body: ${(await byEtag.arrayBuffer()).byteLength}`).toBe(
              `${key} old etag body: ${expected}`,
            );
            const byDate = await get(base, url, encoding, { "if-modified-since": was.date });
            expect(`${key} old date: ${byDate.status}`).toBe(`${key} old date: 200`);

            // and the new validator revalidates, or no-cache would mean a full
            // re-download on every navigation from here on
            const fresh = await get(base, url, encoding, { "if-none-match": etag });
            expect(`${key} new etag: ${fresh.status}`).toBe(`${key} new etag: 304`);
          }
        }
      }

      // the pin reads the disk too: v2 is not the length the build recorded
      for (const { name, base } of servers) {
        for (const encoding of ENCODINGS) {
          const res = await get(base, `/${HASHED}`, encoding);
          expect(`${name} ${encoding}: ${res.headers.get("Cache-Control")}`).toBe(
            `${name} ${encoding}: no-cache`,
          );
        }
      }
    } finally {
      for (const [rel, body] of Object.entries(V1)) write(rel, body);
      backdate();
    }
  }, WIRE_TIMEOUT);

  // A sibling replaced on its own. The identity file is untouched at its
  // recorded length, so only the sibling's own stat can tell that the bytes
  // going out are not the ones the last etag described.
  test("a precompressed sibling replaced alone gets its own new etag", async () => {
    const gz = join(root, "public", HASHED + ".gz");
    const original = gzipSync(V1[HASHED]);
    const url = `/${HASHED}`;
    const before: Record<string, string> = {};
    for (const { name, base } of servers) {
      before[name] = (await get(base, url, "gzip")).headers.get("ETag")!;
    }
    try {
      writeFileSync(gz, gzipSync("console.log('a different sibling entirely');"));
      for (const { name, base } of servers) {
        const res = await get(base, url, "gzip");
        expect(`${name}: ${res.headers.get("Content-Encoding")}`).toBe(`${name}: gzip`);
        const etag = res.headers.get("ETag")!;
        expect(`${name} moved: ${etag !== before[name]}`).toBe(`${name} moved: true`);
        expect(`${name} describes: ${etagSize(etag)}`).toBe(
          `${name} describes: ${Number(res.headers.get("Content-Length"))}`,
        );
        expect(`${name} stale 304: ${(await get(base, url, "gzip", { "if-none-match": before[name] })).status}`).toBe(
          `${name} stale 304: 200`,
        );
        // the identity beside it never moved, and must not have been dragged
        const identity = await get(base, url, "identity");
        expect(`${name} identity: ${etagSize(identity.headers.get("ETag")!)}`).toBe(
          `${name} identity: ${V1[HASHED].length}`,
        );

        // The date is the sibling's own, not the url's. Sharing one meant a
        // date-only revalidation 304'd a replaced .gz until somebody happened
        // to touch the identity file - and a deploy that only refreshes
        // precompressed siblings never does, so it was permanent, not a race.
        // Measured: 304 returning ETag "2n-..." (95 bytes) to a client holding
        // 323, repeated at +2s and +5s.
        expect(`${name} own date: ${res.headers.get("Last-Modified") !== identity.headers.get("Last-Modified")}`).toBe(
          `${name} own date: true`,
        );
        const dated = await get(base, url, "gzip", {
          "if-modified-since": identity.headers.get("Last-Modified")!,
        });
        expect(`${name} date 304: ${dated.status}`).toBe(`${name} date 304: 200`);
      }
    } finally {
      writeFileSync(gz, original);
      backdate();
    }
  }, WIRE_TIMEOUT);

  // One url, one answer. The indexed path used to serve an orphaned sibling
  // 200 while the live path 404'd it - so the same server answered the same
  // url two ways depending on Accept-Encoding, and a restart flipped it again.
  test("a representation whose identity file is gone is refused on both paths", async () => {
    const rel = HASHED;
    const identityPath = join(root, "public", rel);
    const body = V1[rel];
    try {
      rmSync(identityPath, { force: true });
      for (const { name, base } of servers) {
        for (const encoding of ENCODINGS) {
          const res = await get(base, `/${rel}`, encoding);
          expect(`${name} ${encoding}: ${res.status}`).toBe(`${name} ${encoding}: 404`);
        }
      }
    } finally {
      writeFileSync(identityPath, body);
      backdate();
    }
  }, WIRE_TIMEOUT);

});
