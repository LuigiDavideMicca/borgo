import { readdirSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants, createGzip, gzipSync } from "node:zlib";

// types worth compressing; images, fonts and media are already compressed
const compressibleRe = /\.(js|mjs|css|html|htm|svg|json|map|txt|xml|webmanifest)$/i;

export const isCompressiblePath = (path: string) => compressibleRe.test(path);

// bun's chunk naming is [name]-[hash].[ext]: a new hash on every content
// change makes these safe to cache forever. scoped to the build-owned
// assets dir so a user file that happens to match stays out
export const isHashedAsset = (path: string) =>
  /(^|\/)assets\/[^/]+-[a-z0-9]{8}\.(js|css)$/i.test(path.replaceAll("\\", "/"));

// picks the first server-preferred encoding the client accepts (q > 0)
export function pickEncoding(
  acceptEncoding: string | null,
  preferred: readonly string[],
): string | null {
  if (!acceptEncoding) return null;
  const q = new Map<string, number>();
  for (const part of acceptEncoding.split(",")) {
    const [name, ...params] = part.trim().split(";");
    const token = name.trim().toLowerCase();
    if (!token) continue;
    let quality = 1;
    for (const param of params) {
      const [key, value] = param.trim().split("=");
      if (key.trim() === "q") quality = Number(value);
    }
    q.set(token, Number.isNaN(quality) ? 0 : quality);
  }
  for (const encoding of preferred) {
    const quality = q.get(encoding) ?? q.get("*");
    if (quality !== undefined && quality > 0) return encoding;
  }
  return null;
}

// build time: write .gz and .br siblings next to every compressible asset,
// so serving them costs nothing at runtime. skipped when not smaller.
export async function precompressAssets(dir: string) {
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !isCompressiblePath(entry.name)) continue;
    const path = join(entry.parentPath, entry.name);
    // the listing is a snapshot: a `borgo dev` rebuilding the same app
    // deletes stale hashed chunks, and a file that vanished between the
    // scan and the read is not a reason to fail the whole build
    let raw: Buffer;
    try {
      raw = Buffer.from(await Bun.file(path).arrayBuffer());
    } catch {
      continue;
    }
    const gz = gzipSync(raw, { level: constants.Z_BEST_COMPRESSION });
    if (gz.length < raw.length) await Bun.write(path + ".gz", gz);
    const br = brotliCompressSync(raw, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
        [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
      },
    });
    if (br.length < raw.length) await Bun.write(path + ".br", br);
  }
}

// size and mtime, base36. the suffix distinguishes the encoded variants of one
// url: they are separate representations, and a conditional request answered
// for one of them must never be answered out of another.
export const assetEtag = (size: number, mtimeMs: number, suffix: string): string =>
  `"${size.toString(36)}-${Math.floor(mtimeMs).toString(36)}${suffix}"`;

export type AssetVariant = { path: string; encoding?: "br" | "gzip"; etag: string; size: number };

export type AssetInfo = {
  identity: AssetVariant;
  // precompressed siblings in server preference order
  variants: AssetVariant[];
  cacheControl: string;
  compressible: boolean;
  mtimeMs: number;
  lastModified: string;
  type: string;
};

// one walk of the served directory at boot, so a request never stats the disk
// to learn whether a file - or its .br/.gz sibling - is there, and every asset
// gets an etag it can be revalidated against. only used in production: dev
// rebuilds assets in place under stable names, where a cached etag would pin
// the browser to yesterday's bundle. anything written after boot is simply not
// in here and falls back to a live lookup.
export function buildAssetIndex(
  dir: string,
  caseInsensitive: boolean = CASE_INSENSITIVE_FS,
): Map<string, AssetInfo> {
  const files = new Map<string, { size: number; mtimeMs: number }>();
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, recursive: true });
  } catch {
    return new Map();
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name).replaceAll("\\", "/");
    try {
      const stat = statSync(path);
      files.set(path, { size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {}
  }

  const base = dir.replaceAll("\\", "/").replace(/\/+$/, "");
  const tag = (path: string, suffix: string) => {
    const file = files.get(path)!;
    return assetEtag(file.size, file.mtimeMs, suffix);
  };

  const index = new Map<string, AssetInfo>();
  for (const [path, file] of files) {
    const url = path.slice(base.length);
    const compressible = isCompressiblePath(path);
    const variants: AssetVariant[] = [];
    if (compressible) {
      for (const [encoding, ext] of [
        ["br", ".br"],
        ["gzip", ".gz"],
      ] as const) {
        const sibling = files.get(path + ext);
        if (sibling) {
          variants.push({
            path: path + ext,
            encoding,
            etag: tag(path + ext, `-${encoding}`),
            size: sibling.size,
          });
        }
      }
    }
    const info: AssetInfo = {
      identity: { path, etag: tag(path, ""), size: file.size },
      variants,
      cacheControl: assetCacheControl(path),
      compressible,
      mtimeMs: file.mtimeMs,
      lastModified: new Date(file.mtimeMs).toUTCString(),
      type: Bun.file(path).type,
    };
    index.set(url, info);
    // the folded alias findAsset falls back to, where the filesystem folds
    // too. never over a real url: an exact match is always the right answer.
    if (caseInsensitive) {
      const folded = url.toLowerCase();
      if (folded !== url && !index.has(folded)) index.set(folded, info);
    }
  }
  return index;
}

// hashed build outputs cache forever; a service worker must never be
// heuristically cached, or updates to it (and to everything it controls) lag
// behind deploys
export function assetCacheControl(path: string): string {
  if (path === "public/sw.js" || path.endsWith("/public/sw.js")) return "no-cache";
  return isHashedAsset(path) ? "public, max-age=31536000, immutable" : "";
}

// rfc 9110: if-none-match decides on its own when present, if-modified-since
// only answers when there is no etag to compare
export function isNotModified(req: Request, etag: string, mtimeMs: number): boolean {
  const ifNoneMatch = req.headers.get("if-none-match");
  if (ifNoneMatch !== null) {
    if (ifNoneMatch.trim() === "*") return true;
    for (const candidate of ifNoneMatch.split(",")) {
      if (candidate.trim().replace(/^W\//, "") === etag) return true;
    }
    return false;
  }
  const ifModifiedSince = req.headers.get("if-modified-since");
  if (!ifModifiedSince) return false;
  const since = Date.parse(ifModifiedSince);
  // http dates have a one second resolution: compare truncated
  return !Number.isNaN(since) && Math.floor(mtimeMs / 1000) * 1000 <= since;
}

// rfc 9110 §13.1.5: If-Range makes a range request conditional on the client
// still holding the representation it started downloading. if the validator
// does not match, the range must be ignored and the whole representation sent
// - otherwise the client splices new bytes onto an old prefix and calls the
// result a file. the mismatch is not exotic here: the same url negotiates to
// a different encoding on every Accept-Encoding, so a resume that arrives
// without the accept-encoding the first request carried is asking for a range
// of the brotli file to be filled from the identity one.
// a weak validator (W/"...") can never authorise a range, so it never matches.
//
// Only the etag is accepted, and the date deliberately is not. Every variant of
// one url shares a Last-Modified - it is the file's mtime, and the siblings are
// built from it - so a date would authorise precisely the splice above: fetch
// the identity file, resume with If-Range set to that date and a different
// Accept-Encoding, and the range is answered out of the brotli file. Measured
// before this rule: a 416 declaring a 6400-byte resource to be 35 bytes long,
// and a 206 handing brotli bytes to a client assembling plain css. rfc 9110
// §13.1.5 allows a date validator; it does not require one, and here there is
// no date that identifies a representation rather than a url.
export function isRangeStale(req: Request, etag: string): boolean {
  const ifRange = req.headers.get("if-range");
  if (ifRange === null || !req.headers.has("range")) return false;
  return ifRange.trim() !== etag;
}

const statOf = (path: string) => {
  try {
    return statSync(path);
  } catch {
    return null;
  }
};

// windows resolves paths case-insensitively and so does macos by default; the
// index is an exact-match Map, and the two disagree. /OK.TXT missed the index
// and fell through to the live serveAsset, which opened the very same file off
// the very same filesystem - past the precomputed .br/.gz variants, past the
// etag, past the cache policy the index holds for it. The aliases are built
// where the filesystem is case-insensitive and nowhere else: on a
// case-sensitive one /OK.TXT and /ok.txt are two different files, and folding
// them would serve the wrong one.
export const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";

export function findAsset(
  index: Map<string, AssetInfo>,
  url: string,
  caseInsensitive: boolean = CASE_INSENSITIVE_FS,
): AssetInfo | undefined {
  const exact = index.get(url);
  if (exact || !caseInsensitive) return exact;
  return index.get(url.toLowerCase());
}

// the indexed path: an etag the browser can revalidate against, the variants
// already chosen, and one stat to confirm the snapshot still describes a file
export function serveIndexed(req: Request, info: AssetInfo): Response {
  let variant = info.identity;
  if (info.variants.length) {
    // negotiate against the encodings this asset actually has, not against
    // every encoding borgo knows: offering br for a file that only has a .gz
    // makes "accept-encoding: br, gzip" resolve to br, miss, and fall through
    // to identity - shipping the raw bytes past a compressed sibling that is
    // sitting right there. Server preference still decides between the ones
    // that do exist, which is why the order here is fixed and not the index's.
    const available = ["br", "gzip"].filter((e) => info.variants.some((v) => v.encoding === e));
    const encoding = pickEncoding(req.headers.get("accept-encoding"), available);
    if (encoding) variant = info.variants.find((v) => v.encoding === encoding) ?? variant;
  }
  // the index was taken at boot, and the disk moved on: a `borgo dev` writing
  // over the same public/assets, a deploy swapping files in place. one stat
  // settles all three consequences at once, which is why it is a stat and not
  // the existsSync that used to be here:
  //   - a precompressed sibling that is gone degrades to the identity file
  //     rather than 500ing for an asset still sitting on disk;
  //   - an identity that is gone too is a 404. `new Response(Bun.file(missing))`
  //     is answered by bun's own fallback page instead: 67,016 bytes of html
  //     whose base64 payload decodes to the absolute path of the file on the
  //     server, under the ambient NODE_ENV that `borgo start` in a plain shell
  //     leaves unset. serve() also runs with development:false and an error
  //     handler so no other route can leak it either, but the index is the one
  //     that *knows* the file may be gone;
  //   - the length below is the file's, not the snapshot's. bun recomputes
  //     Content-Length from the file on a GET and ignores what we set, so a
  //     stale index made HEAD and GET disagree about the same url (measured
  //     1400 against 5600) - a HEAD wrong by any factor, which is what a HEAD
  //     is asked for in the first place.
  let live = statOf(variant.path);
  if (!live && variant.encoding) {
    variant = info.identity;
    live = statOf(variant.path);
  }
  if (!live) return new Response("not found", { status: 404 });
  const headers = new Headers();
  if (info.cacheControl) headers.set("Cache-Control", info.cacheControl);
  if (info.compressible) headers.set("Vary", "Accept-Encoding");
  headers.set("ETag", variant.etag);
  headers.set("Last-Modified", info.lastModified);
  if (isNotModified(req, variant.etag, info.mtimeMs)) {
    return new Response(null, { status: 304, headers });
  }
  if (variant.encoding) {
    headers.set("Content-Encoding", variant.encoding);
    headers.set("Content-Type", info.type);
  }
  // a HEAD is answered from the headers alone, and dropping the body drops
  // the length bun would have computed from the file: without this every
  // HEAD claims Content-Length: 0 for a file a GET returns in full. the live
  // size, so the two answers agree even when the index does not.
  headers.set("Content-Length", String(live.size));
  // bun turns a Range into a 206 off a Bun.file body, and never consults
  // If-Range while doing it. a stream body is how the refusal is spelled:
  // bun ranges files, not streams, so a validator that no longer matches
  // gets the whole representation as a plain 200 - still off the disk,
  // never through memory.
  if (isRangeStale(req, variant.etag)) {
    // a stream body also loses the content type bun derives from a file, and
    // under the global nosniff a typeless stylesheet is a refused stylesheet;
    // for an encoded variant this re-sets the same value as above.
    //
    // it loses the Content-Length too, whatever we set: measured on bun
    // 1.3.14, an explicit Content-Length on a stream body is dropped and the
    // response goes out chunked, so this 200 is chunked while the 206 beside
    // it is length-framed. Both are legal framings of a complete body and the
    // client gets every byte either way; the only lever that suppresses bun's
    // range handling on a *file* body is a Content-Range header, which rfc
    // 9110 §14.4 gives meaning to on 206 and 416 alone. Trading a legal
    // framing difference for a header that has no meaning in a 200 - or for
    // reading the whole asset through memory - is the worse deal.
    headers.set("Content-Type", info.type);
    return new Response(Bun.file(variant.path).stream(), { headers });
  }
  return new Response(Bun.file(variant.path), { headers });
}

// dev, and anything written into public/ after boot. the index cannot cover
// these - it is a boot-time snapshot - but everything it does for an asset has
// to happen here too, from a live stat instead of the snapshot: this path
// negotiates the same br/gz variants off the same url, so it is exposed to the
// same cross-encoding range splice serveIndexed refuses, and until now it
// emitted no validator a client could even have sent to be checked.
export function serveAsset(
  req: Request,
  path: string,
  asset: ReturnType<typeof Bun.file>,
  { dev }: { dev: boolean },
): Response {
  let base: { size: number; mtimeMs: number };
  try {
    base = statSync(path);
  } catch {
    // deleted between the caller's exists() and here
    return new Response("not found", { status: 404 });
  }

  const headers = new Headers();
  // an asset with no explicit policy and a Last-Modified is an asset the
  // browser may heuristically cache for a tenth of its age - in dev, where
  // these are rebuilt in place under stable names, that is yesterday's bundle
  // pinned for the afternoon. no-cache still allows the 304 below.
  const cacheControl = assetCacheControl(path) || (dev ? "no-cache" : "");
  if (cacheControl) headers.set("Cache-Control", cacheControl);

  let file = asset;
  let size = base.size;
  let etag = assetEtag(base.size, base.mtimeMs, "");
  if (isCompressiblePath(path)) {
    headers.set("Vary", "Accept-Encoding");
    // dev writes no precompressed siblings and serves identity
    const encoding = dev ? null : pickEncoding(req.headers.get("accept-encoding"), ["br", "gzip"]);
    if (encoding) {
      const siblingPath = `${path}.${encoding === "br" ? "br" : "gz"}`;
      try {
        const sibling = statSync(siblingPath);
        file = Bun.file(siblingPath);
        size = sibling.size;
        etag = assetEtag(sibling.size, sibling.mtimeMs, `-${encoding}`);
        headers.set("Content-Encoding", encoding);
        headers.set("Content-Type", asset.type);
      } catch {
        // no sibling: identity, exactly as before
      }
    }
  }

  headers.set("ETag", etag);
  // one date for every variant of the url, like serveIndexed - which is
  // precisely why isRangeStale below refuses to accept a date as an If-Range
  headers.set("Last-Modified", new Date(base.mtimeMs).toUTCString());
  if (isNotModified(req, etag, base.mtimeMs)) {
    return new Response(null, { status: 304, headers });
  }
  // same reason as in serveIndexed: a HEAD keeps the headers and loses the
  // body bun would have measured
  headers.set("Content-Length", String(size));
  if (isRangeStale(req, etag)) {
    // a stream body is how a range is refused: bun ranges files, not streams,
    // and it never consults If-Range on its own. the type goes back on because
    // a stream body loses the one bun derives from a file
    headers.set("Content-Type", asset.type);
    return new Response(file.stream(), { headers });
  }
  return new Response(file, { headers });
}

const encoder = new TextEncoder();

// the ssr document: shell head, react's own stream, shell tail. pull-based on
// purpose - react is asked for the next chunk only when the consumer has room,
// so a slow client throttles the render instead of letting a whole document
// pile up in memory, and a client that goes away ends the render through the
// iterator's return() instead of paying for a page nobody will read
export function documentStream(
  head: string,
  chunks: AsyncIterable<Uint8Array>,
  tail: string,
): ReadableStream<Uint8Array> {
  const iterator = chunks[Symbol.asyncIterator]();
  let tailSent = false;
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(head));
    },
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (!next.done) return controller.enqueue(next.value);
        if (!tailSent) {
          tailSent = true;
          return controller.enqueue(encoder.encode(tail));
        }
        controller.close();
      } catch (error) {
        // a cancelled consumer (head request, client gone) rejects the pump
        // by design: only a failure on a live stream is worth a log line
        if (cancelled) return;
        console.error("stream pump failed:", error);
        controller.error(error);
      }
    },
    cancel() {
      cancelled = true;
      void iterator.return?.().catch(() => {});
    },
  });
}

// runtime: gzip a stream with a sync flush per chunk, so every react flush
// reaches the client immediately and streamed ssr stays progressive
export function gzipStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const gzip = createGzip({ flush: constants.Z_SYNC_FLUSH });
  // an explicit reader: the pump holds the source's lock, so a client
  // disconnect must cancel through the reader, never through the source -
  // cancelling a locked stream throws, and from bun's cancel callback that
  // used to take the whole server process down
  const reader = source.getReader();
  let cancelled = false;
  // gzip pushes its output from a 'data' handler, which cannot consult the
  // consumer's queue - so the pump has to be the one that waits. without this
  // the loop below reads the source as fast as zlib will take the writes, and
  // documentStream's whole point (react is pulled only when the consumer has
  // room) is lost the moment a response is compressed, which in production is
  // every response. resumed from pull(), and from cancel() so a client that
  // goes away while the pump is parked does not strand the reader.
  let resume: (() => void) | null = null;
  const wake = () => {
    const r = resume;
    resume = null;
    r?.();
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const closed = new Promise<void>((resolve) => gzip.once("close", resolve));
      gzip.on("data", (chunk: Buffer) => {
        if (!cancelled) controller.enqueue(new Uint8Array(chunk));
      });
      gzip.on("end", () => {
        if (!cancelled) controller.close();
      });
      gzip.on("error", (error) => {
        if (!cancelled) controller.error(error);
      });
      void (async () => {
        try {
          for (;;) {
            // desiredSize is null once the stream is errored or closed; treat
            // that as room and let the read below settle it
            if (!cancelled && !gzip.destroyed && (controller.desiredSize ?? 1) <= 0) {
              await new Promise<void>((resolve) => {
                resume = resolve;
              });
            }
            if (cancelled || gzip.destroyed) break;
            const { done, value } = await reader.read();
            if (done || gzip.destroyed) break;
            if (!gzip.write(value)) {
              await Promise.race([new Promise((resolve) => gzip.once("drain", resolve)), closed]);
              if (gzip.destroyed) break;
            }
          }
          if (!gzip.destroyed) gzip.end();
        } catch (error) {
          gzip.destroy(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    },
    pull() {
      wake();
    },
    cancel(reason) {
      cancelled = true;
      wake();
      gzip.destroy();
      void reader.cancel(reason).catch(() => {});
    },
  });
}

export const COMPRESS_MIN_BYTES = 1024;

// buffered json (props, redirects): gzip only above the threshold, tiny
// payloads are cheaper on the wire uncompressed
export function jsonResponse(req: Request, value: unknown, init: ResponseInit = {}): Response {
  const payload = JSON.stringify(value);
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Vary", "Accept-Encoding");
  const accepted = pickEncoding(req.headers.get("accept-encoding"), ["gzip"]);
  if (accepted && Buffer.byteLength(payload) >= COMPRESS_MIN_BYTES) {
    headers.set("Content-Encoding", "gzip");
    return new Response(gzipSync(payload), { ...init, headers });
  }
  return new Response(payload, { ...init, headers });
}
