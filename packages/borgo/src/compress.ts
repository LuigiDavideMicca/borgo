import { readdirSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants, createGzip, gzipSync } from "node:zlib";

// types worth compressing; images, fonts and media are already compressed
const compressibleRe = /\.(js|mjs|css|html|htm|svg|json|map|txt|xml|webmanifest)$/i;

export const isCompressiblePath = (path: string) => compressibleRe.test(path);

// What a build vouched for: where it wrote, and the byte length of each output
// whose name carries its own content hash. A list rather than a pattern - see
// readBuildOutputs in build.ts for the measurement that killed the pattern -
// and a length rather than a bare name, because `immutable` is a claim about
// bytes and a name alone cannot keep it.
export type BuildOutputs = { dir: string; sizes: ReadonlyMap<string, number> };

// no build has vouched for anything, so nothing is pinned. every default in
// this file points here on purpose.
export const NO_BUILD_OUTPUTS: BuildOutputs = { dir: "", sizes: new Map() };

const IMMUTABLE = "public, max-age=31536000, immutable";

const asUrl = (path: string) => path.replaceAll("\\", "/");

const isServiceWorker = (url: string) => url === "public/sw.js" || url.endsWith("/public/sw.js");

/**
 * The byte length the build recorded for this exact path, or null if no build
 * vouched for it.
 *
 * The directory is compared whole, not by segment name. Gating on
 * `/(^|\/)assets\//` accepted *any* folder called assets: measured on the wire,
 * /copy/assets/index-n12gjnyv.js and /deep/nested/assets/index-n12gjnyv.js were
 * pinned for a year on bytes the bundler never saw, because their basename was
 * in the manifest and an ancestor happened to be spelled "assets". Every
 * bundle an app copies into public/ ships such a folder. The build knows the
 * one directory it wrote, so it records it and this compares against that.
 */
export function recordedSize(path: string, outputs: BuildOutputs): number | null {
  const dir = asUrl(outputs.dir).replace(/\/+$/, "");
  if (!dir) return null;
  const url = asUrl(path);
  if (!url.startsWith(dir + "/")) return null;
  const name = url.slice(dir.length + 1);
  // directly in the output directory: the manifest keys are filenames, and a
  // deeper path is a different file whatever it is called
  if (!name || name.includes("/")) return null;
  return outputs.sizes.get(name) ?? null;
}

// null when the build never vouched for this path. a service worker is named
// explicitly and never pinned: it controls every url in its scope, so it must
// keep revalidating even if the rules around it are ever loosened.
export const pinnedSizeFor = (path: string, outputs: BuildOutputs): number | null =>
  isServiceWorker(asUrl(path)) ? null : recordedSize(path, outputs);

/**
 * The one place a year is granted, and it is granted against the disk - twice.
 *
 * The manifest vouches for a *name*; whatever occupies that name would
 * otherwise inherit the year. Measured: a recorded chunk deleted and recreated
 * with different bytes after boot was still served `immutable`. Comparing the
 * recorded length turns "this name was once hashed" into "this file is still
 * the file that was hashed", which is the claim `immutable` actually makes.
 *
 * Two lengths, not one, and neither alone is enough. Checking only the identity
 * file pinned a replaced sibling: 749 -> 75 bytes, and the stale 75 shipped
 * `immutable` to every client that sent Accept-Encoding, which is nearly all of
 * them. Checking only the representation sent would let a partial deploy that
 * rewrote the identity file and left the .gz behind keep pinning that .gz - and
 * `immutable` is a promise about the *url*, which no longer holds one content
 * once its representations disagree. So a sibling is pinned only when it is
 * itself vouched for and the identity beside it still is too.
 *
 * Length, not a per-request digest, and not mtime. A digest would read every
 * asset on every hit. mtime moves whenever a deploy copies a file that did not
 * change, so it would unpin the entire bundle on every release - the strict
 * failure, permanently on. Length survives a copy and moves with almost any
 * edit. What it does not catch is a replacement of exactly the same byte
 * length under a name that already carried a matching content hash, which is
 * the residual hole and is documented as such.
 *
 * DECLARED LIMITATION - the length is compared, and then the bytes are sent;
 * the two are not atomic. A file rewritten in the window between them goes out
 * under a directive granted for its previous contents. Measured under a loop
 * rewriting public/assets in place beneath a running server: 22 responses in
 * 10,628 on the indexed path and 7 in 11,230 on the live path, the latter 204s
 * with an empty body pinned for a year.
 *
 * It is not closed here because it cannot be closed by the handle. Holding the
 * file open does not help: an in-place rewrite truncates the same inode, and a
 * descriptor opened before it reports the new length afterwards (measured:
 * 1000 -> 20 bytes through one fd). Closing it means reading every asset into
 * memory to measure the bytes actually sent - a per-request cost this path
 * exists to avoid, since `new Response(Bun.file(...))` streams off the disk and
 * never through the process.
 *
 * The trigger is a deploy that rewrites public/assets in place. For a
 * content-addressed name that is already the hash lying about its bytes - the
 * residual above - so the exposure a correct build adds is the transient one:
 * during the rewrite a client may cache a truncated or oversized body for a
 * year. Deploying into a new directory and swapping, which is what the
 * Dockerfile does, does not reach this window at all.
 */
const vouched = (pinnedSize: number | null, sizeOnDisk: number | null): boolean =>
  pinnedSize !== null && pinnedSize === sizeOnDisk;

export const pinPolicy = (
  sent: number | null,
  sentSize: number | null,
  // defaults collapse to one check when the representation being sent *is* the
  // identity, which is the only case where the two questions are the same one
  identity: number | null = sent,
  identitySize: number | null = sentSize,
): string =>
  vouched(sent, sentSize) && vouched(identity, identitySize) ? IMMUTABLE : "no-cache";

// picks the first server-preferred encoding the client accepts (q > 0).
//
// the parameter name is matched case-insensitively, like the coding name beside
// it: rfc 9110 5.6.6 makes parameter names case-insensitive, so "gzip;Q=0" is a
// client refusing gzip in a spelling no less valid than "gzip;q=0". Matching
// only the lowercase one left the refusal unread and the quality at its default
// 1 - so every asset, every json payload and every rendered document went out
// compressed to a client that had just said it cannot decode gzip. gzip.go's
// refusesCoding folds the same name for the same reason; the two halves negotiate
// the same header and must read it the same way.
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
      if (key.trim().toLowerCase() === "q") quality = Number(value);
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

// size and mtime, base36. the suffix keeps one url's encodings from
// revalidating each other.
export const assetEtag = (size: number, mtimeMs: number, suffix: string): string =>
  `"${size.toString(36)}-${Math.floor(mtimeMs).toString(36)}${suffix}"`;

// pinnedSize is the byte length the build recorded for *this representation's*
// file, or null if no build vouched for it. Per variant, not per url: the
// directive travels on the response, and the response carries these bytes.
//
// `etag`, `size`, `mtimeMs` and `lastModified` on these two types are what boot
// saw. Nothing is served from them - see serveIndexed.
export type AssetVariant = {
  path: string;
  encoding?: "br" | "gzip";
  etag: string;
  size: number;
  pinnedSize: number | null;
};

export type AssetInfo = {
  identity: AssetVariant;
  // precompressed siblings in server preference order
  variants: AssetVariant[];
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
  outputs: BuildOutputs = NO_BUILD_OUTPUTS,
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
    // same formula the request path uses, or the snapshot etag and the
    // served one disagree for a file nobody touched
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
            pinnedSize: pinnedSizeFor(path + ext, outputs),
          });
        }
      }
    }
    const info: AssetInfo = {
      identity: {
        path,
        etag: tag(path, ""),
        size: file.size,
        pinnedSize: pinnedSizeFor(path, outputs),
      },
      variants,
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

// An asset may be reused without asking only when its url is a promise about
// its bytes; everything else must be revalidated first. rfc 9111 §4.2.2 lets a
// cache invent a freshness lifetime when none is given, and browsers commonly
// take ~10% of (now - Last-Modified), so an asset untouched for 100 days is
// heuristically fresh for ~10. The document is private, no-store and therefore
// always fresh, so a returning browser fetches today's html after a deploy and
// runs yesterday's /assets/client.js against today's ssr markup and today's
// props shape, without ever asking. no-cache is "revalidate before reuse", not
// no-store: the etag beside it turns each revalidation into a bodyless 304.
//
// What counts as that promise is decided by three facts, none of which a name
// can supply on its own, because every previous version of this rule accepted a
// name as proof and every one of them was wrong on the wire:
//
//   1. the bundler put this file's own content hash into its name
//      (build.ts nameCarriesHash). The rule before that was
//      `-[a-z0-9]{8}\.(js|css)` under assets/, which any eight-letter word
//      satisfies - /assets/stripe-checkout.js and /assets/hero-carousel.js
//      were pinned for a year, and google-analytics.js escaped only because
//      "analytics" is nine characters;
//   2. it sits in the one directory the build wrote, compared whole. Gating on
//      a path segment called "assets" pinned /copy/assets/… and
//      /deep/nested/assets/… - bytes the bundler never saw - and every bundle
//      an app copies into public/ ships such a folder;
//   3. the file *about to be sent* still has the byte length the build
//      recorded for it. The manifest vouches for a name, and whatever occupies
//      that name would otherwise inherit the year: a recorded chunk deleted and
//      recreated after boot was served `immutable` on bytes nobody had ever
//      hashed. The representation matters as much as the url - checking the
//      identity file while shipping a replaced .gz pinned 75 stale bytes where
//      749 had been vouched for, and since nearly every client sends
//      Accept-Encoding that was the common case, not a corner of it. Each
//      encoding is therefore vouched for separately, on AssetVariant.
//
// The comment that once defended (1) claimed assets/ was build-owned;
// build.ts says the opposite in its own words - it is "also where an app drops
// an analytics snippet or a vendored widget" - and the inventory exists at all
// because the sweep had already been burned by the identical assumption.
//
// how this fails if it is wrong: an asset that really is content-addressed
// loses its year - `.borgo/` not copied into an image, an app upgrading from a
// borgo that recorded no sizes, public/assets holding a different build than
// the manifest describes, or a file legitimately rewritten to a new length -
// and pays one conditional request per asset per load. That is a performance
// regression and it surfaces only in a measurement. The other direction now
// needs all three facts at once, for the exact file being sent. What survives
// it is a replacement of exactly the recorded byte length under a name that
// already carried a matching content hash inside the build's own directory,
// and the rewrite window declared on pinPolicy. Doubt resolves toward
// revalidating: every degradation of the manifest pins nothing, a sibling the
// build did not measure is never pinned even when its identity file is, a
// recorded length of zero is dropped rather than stored, and an asset nobody
// can vouch for is never cached.
export function assetCacheControl(
  sentPath: string,
  outputs: BuildOutputs = NO_BUILD_OUTPUTS,
  sentSize: number | null = null,
  // the identity file behind the representation being sent. Defaults to the
  // representation itself, which is what it is whenever no sibling was chosen.
  identity: { path: string; size: number | null } = { path: sentPath, size: sentSize },
): string {
  return pinPolicy(
    pinnedSizeFor(sentPath, outputs),
    sentSize,
    pinnedSizeFor(identity.path, outputs),
    identity.size,
  );
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
  // http dates resolve to one second: compare truncated.
  //
  // DECLARED LIMITATION - a rewrite inside the second of the date we sent 304s
  // over changed bytes (measured: 500 -> 9999 bytes at +997ms). Reachable only
  // by a client that sent no etag, bounded to that one second, and self-healing
  // on the next revalidation no-cache forces. rfc 9110 §8.8.2.2's mitigation -
  // refuse a date 304 while mtime is in the current second - is declined
  // because it makes the answer depend on the wall clock at request time.
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
// Only the etag is accepted, and the date deliberately is not. Each
// representation reports its own mtime now, but an http date resolves to one
// second and a url's representations routinely land inside the same one, so a
// date cannot be relied on to name which - and a date that names the wrong one
// authorises exactly the splice above. Measured before this rule: a 416
// declaring a 6400-byte resource to be 35 bytes long, and a 206 handing brotli
// bytes to a client assembling plain css. rfc 9110 §13.1.5 allows a date
// validator; it does not require one.
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

// the indexed path: the variants already chosen from the snapshot, and the
// stats that say what those files are right now - which is where the etag,
// the date and the length all come from
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
  // the identity behind the sent representation: its recorded length for the
  // pin, and its absence for the 404. A sibling whose identity file is gone is
  // refused, because serveAsset refuses it and a restart would too - serving
  // it made one url answer 200 or 404 by Accept-Encoding alone.
  const identityLive = variant.encoding ? statOf(info.identity.path) : live;
  if (!identityLive) return new Response("not found", { status: 404 });

  const headers = new Headers();
  // the recorded length is the build's claim; whether the file on disk is
  // still that file only this stat can say. Both halves: with the identity
  // untouched at its recorded length and index-n12gjnyv.js.gz replaced
  // 749 -> 75 bytes, the 75 stale bytes went out `immutable`.
  //
  // unconditional - the `if` that used to guard it shipped production's
  // unhashed assets with no policy at all.
  headers.set(
    "Cache-Control",
    pinPolicy(variant.pinnedSize, live.size, info.identity.pinnedSize, identityLive.size),
  );
  if (info.compressible) headers.set("Vary", "Accept-Encoding");
  // set before the 304 return: a 304 updates a cache's stored headers, and
  // serveAsset states them there, so the two paths must not differ on it
  if (variant.encoding) {
    headers.set("Content-Encoding", variant.encoding);
    headers.set("Content-Type", info.type);
  }
  // Both validators off `live` - the file whose bytes are going out - never off
  // the index, and never off the identity when a sibling was chosen. Wrong in
  // this direction it is silent: stale bytes 304 forever. Measured on the wire,
  // once per mistake: ETag "gf-msf40zn3" (gf = 591) on a 557-byte body; and a
  // .gz replaced 323 -> 95 with the identity untouched, answering 304 to
  // If-Modified-Since at +0s, +2s and +5s.
  const etag = assetEtag(live.size, live.mtimeMs, variant.encoding ? `-${variant.encoding}` : "");
  headers.set("ETag", etag);
  headers.set("Last-Modified", new Date(live.mtimeMs).toUTCString());
  if (isNotModified(req, etag, live.mtimeMs)) {
    return new Response(null, { status: 304, headers });
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
  if (isRangeStale(req, etag)) {
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
  { dev, outputs = NO_BUILD_OUTPUTS }: { dev: boolean; outputs?: BuildOutputs },
): Response {
  let base: { size: number; mtimeMs: number };
  try {
    base = statSync(path);
  } catch {
    // deleted between the caller's exists() and here
    return new Response("not found", { status: 404 });
  }

  const headers = new Headers();
  let file = asset;
  let sentPath = path;
  let size = base.size;
  let mtimeMs = base.mtimeMs;
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
        sentPath = siblingPath;
        size = sibling.size;
        mtimeMs = sibling.mtimeMs;
        etag = assetEtag(sibling.size, sibling.mtimeMs, `-${encoding}`);
        headers.set("Content-Encoding", encoding);
        headers.set("Content-Type", asset.type);
      } catch {
        // no sibling: identity, exactly as before
      }
    }
  }

  // after negotiation: what is vouched for is the representation going out.
  // Checking the identity instead pinned whatever bytes a replaced .gz held.
  // The fallback here used to be `dev ? ... : ""` - armed where a stale asset
  // costs an afternoon, disarmed where it survives a deploy.
  headers.set(
    "Cache-Control",
    assetCacheControl(sentPath, outputs, size, { path, size: base.size }),
  );

  // `mtimeMs` is the sent representation's, like the etag: the identity's date
  // on a sibling's bytes 304s a replaced .gz until someone touches the
  // identity, which a sibling-only deploy never does
  headers.set("ETag", etag);
  headers.set("Last-Modified", new Date(mtimeMs).toUTCString());
  if (isNotModified(req, etag, mtimeMs)) {
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
