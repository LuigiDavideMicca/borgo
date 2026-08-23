import { readdirSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants, createGzip, gzipSync } from "node:zlib";

// types worth compressing; images, fonts and media are already compressed
const compressibleRe = /\.(js|mjs|css|html|htm|svg|json|map|txt|xml|webmanifest)$/i;

export const isCompressiblePath = (path: string) => compressibleRe.test(path);

// a file whose own name starts with a dot is not public content: .DS_Store
// (the directory's whole listing), .swp, a dropped .env, a killed doctor's
// probe all answered 200. last segment only, never a directory: .well-known/
// (rfc 8615) must stay served, and an allowlist can be wrong where this cannot
// reach it. a hidden directory that is not .well-known needs the url's root,
// which is known where the url is accepted: inHiddenDirectory. both separators, a join() built the path
export const isHiddenAsset = (path: string): boolean =>
  path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1).startsWith(".");

// the other half, judged against the url's root the caller passes; here, in
// the one module server.ts and export.ts both import, so `borgo export` does
// not resolve react to get it. .well-known is exempt as the FIRST segment only
// (rfc 8615: a well-known uri begins with /.well-known/) and exact, not folded:
// the rfc's paths are case-sensitive and every acme client writes it lower-case
export function inHiddenDirectory(urlPath: string): boolean {
  const segments = urlPath.split("/");
  for (let i = 1; i < segments.length - 1; i++) {
    const s = segments[i];
    if (s.startsWith(".") && !(i === 1 && s === ".well-known")) return true;
  }
  return false;
}

// where a build wrote, and the byte length of each output whose name carries
// its content hash: a list, not a pattern (readBuildOutputs in build.ts), and a
// length, not a bare name, because `immutable` is a claim about bytes
export type BuildOutputs = { dir: string; sizes: ReadonlyMap<string, number> };

// no build has vouched for anything, so nothing is pinned: every default here points at it
export const NO_BUILD_OUTPUTS: BuildOutputs = { dir: "", sizes: new Map() };

const IMMUTABLE = "public, max-age=31536000, immutable";

const asUrl = (path: string) => path.replaceAll("\\", "/");

const isServiceWorker = (url: string) => url === "public/sw.js" || url.endsWith("/public/sw.js");

// the byte length the build recorded for this exact path, or null. the
// directory is compared whole, not by segment name: gating on `assets/`
// pinned /copy/assets/index-n12gjnyv.js and /deep/nested/assets/... for a year
// on bytes the bundler never saw, and every bundle an app copies into public/ ships such a folder
export function recordedSize(path: string, outputs: BuildOutputs): number | null {
  const dir = asUrl(outputs.dir).replace(/\/+$/, "");
  if (!dir) return null;
  const url = asUrl(path);
  if (!url.startsWith(dir + "/")) return null;
  const name = url.slice(dir.length + 1);
  // directly in the output directory: the manifest keys are filenames
  if (!name || name.includes("/")) return null;
  return outputs.sizes.get(name) ?? null;
}

// null when the build never vouched for this path. a service worker is never
// pinned: it controls every url in its scope, whatever the rules around it become
export const pinnedSizeFor = (path: string, outputs: BuildOutputs): number | null =>
  isServiceWorker(asUrl(path)) ? null : recordedSize(path, outputs);

// the one place a year is granted, and against the disk twice: the manifest
// vouches for a name, and whatever occupies it would inherit the year (a
// recorded chunk recreated after boot was served `immutable`). two lengths:
// the identity alone pinned a replaced sibling (749 -> 75 stale bytes to
// every client sending Accept-Encoding), the sent one alone would let a
// partial deploy keep pinning a leftover .gz, and `immutable` is a promise
// about the url. length, not a digest (a read per hit) and not mtime (moves
// on every copying deploy, unpinning the whole bundle). residual: a same-
// length replacement under a hashed name. DECLARED LIMITATION: compare then
// send is not atomic; under a loop rewriting public/assets in place, 22
// responses in 10,628 indexed and 7 in 11,230 live went out under the previous
// contents' directive. not closable by the handle: an in-place rewrite
// truncates the same inode and an open fd reports the new length (1000 -> 20
// through one fd); closing it means reading every asset into memory. deploying
// into a new directory and swapping, as the Dockerfile does, never reaches the window
const vouched = (pinnedSize: number | null, sizeOnDisk: number | null): boolean =>
  pinnedSize !== null && pinnedSize === sizeOnDisk;

export const pinPolicy = (
  sent: number | null,
  sentSize: number | null,
  // defaults collapse to one check when the representation sent IS the identity
  identity: number | null = sent,
  identitySize: number | null = sentSize,
): string =>
  vouched(sent, sentSize) && vouched(identity, identitySize) ? IMMUTABLE : "no-cache";

// the first server-preferred encoding the client accepts (q > 0). the
// parameter name folds case: rfc 9110 5.6.6 makes it case-insensitive, so
// "gzip;Q=0" is a refusal, and reading only "q" sent gzip to a client that
// said it cannot decode it. gzip.go's refusesCoding folds the same way
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
    // what serveAsset refuses is only build time here: the same rule, not a copy of it
    if (!entry.isFile() || !isCompressiblePath(entry.name) || isHiddenAsset(entry.name)) continue;
    const path = join(entry.parentPath, entry.name);
    // the listing is a snapshot: `borgo dev` deletes stale hashed chunks, and a
    // file gone between scan and read is not a reason to fail the build
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

// size and mtime, base36; the suffix keeps one url's encodings from
// revalidating each other. weak because the pair is: equal lengths share the
// size half and cp -p, rsync -t, tar, docker COPY carry the mtime across, so
// one byte substituted at constant length under a preserved mtime gave a
// byte-equal tag on public/sw.js. W/ does not make the 304 exact, nothing per
// request can; it stops claiming an equality it cannot check and disqualifies
// the tag from If-Range, where a wrong match splices bytes. the build's hash
// vouches for a name at build time, not for the disk per request (assetCacheControl)
export const assetEtag = (size: number, mtimeMs: number, suffix: string): string =>
  `W/"${size.toString(36)}-${Math.floor(mtimeMs).toString(36)}${suffix}"`;

const WEAK = /^W\//;
const isWeak = (validator: string) => WEAK.test(validator);
const strong = (validator: string) => validator.replace(WEAK, "");

// pinnedSize is per variant, not per url: the directive travels on the
// response, and the response carries these bytes. `etag` and `size` are what
// boot saw: nothing is served from them (serveIndexed re-stats), the asset
// tests compare live headers against them
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
  lastModified: string;
  type: string;
};

// one walk at boot, so a request never stats the disk for a file or its
// .br/.gz sibling. production only: dev rebuilds under stable names, where a
// cached etag would pin yesterday's bundle. written after boot means a live lookup
export function buildAssetIndex(
  dir: string,
  caseInsensitive?: boolean,
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
    if (!entry.isFile() || isHiddenAsset(entry.name)) continue;
    const path = join(entry.parentPath, entry.name).replaceAll("\\", "/");
    try {
      const stat = statSync(path);
      files.set(path, { size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {}
  }

  // measured on the names just read, not guessed from the platform: the
  // directory indexed is not always the one the process runs on
  const folds = caseInsensitive ?? foldsCase(files.keys());

  const base = dir.replaceAll("\\", "/").replace(/\/+$/, "");
  const tag = (path: string, suffix: string) => {
    const file = files.get(path)!;
    // same formula as the request path, or the snapshot etag and the served one disagree
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
      lastModified: new Date(file.mtimeMs).toUTCString(),
      type: Bun.file(path).type,
    };
    index.set(url, info);
    // the folded alias findAsset falls back to, never over a real url
    if (folds) {
      const folded = url.toLowerCase();
      if (folded !== url && !index.has(folded)) index.set(folded, info);
    }
  }
  // a lookup must not read this index under the opposite rule from the one it was built with
  foldingOf.set(index, folds);
  return index;
}

// rfc 9111 §4.2.2 lets a cache invent a freshness lifetime, and browsers take
// ~10% of (now - Last-Modified): an asset untouched for 100 days is fresh for
// ~10, so a returning browser runs yesterday's /assets/client.js against
// today's ssr markup without asking. no-cache is "revalidate before reuse",
// and the etag turns each revalidation into a 304. a year needs three facts
// at once, none of which a name supplies: the bundler put this file's content
// hash in its name (`-[a-z0-9]{8}` pinned /assets/stripe-checkout.js), it sits
// in the one directory the build wrote, compared whole (a segment called
// "assets" pinned /copy/assets/...), and the file ABOUT TO BE SENT still has
// the recorded length, per representation (a replaced .gz pinned 75 stale bytes
// where 749 were vouched for). failure direction: a content-addressed asset
// losing its year (`.borgo/` not in the image, an older manifest) costs one
// conditional request per load and shows only in a measurement; what survives
// is a same-length replacement under a hashed name, and the rewrite window on pinPolicy
export function assetCacheControl(
  sentPath: string,
  outputs: BuildOutputs = NO_BUILD_OUTPUTS,
  sentSize: number | null = null,
  // the identity file behind the representation sent; itself when no sibling was chosen
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
    // §8.8.3.2: if-none-match compares weakly, so the marker comes off both
    // sides, or a client echoing our own W/"..." never matches
    for (const candidate of ifNoneMatch.split(",")) {
      if (strong(candidate.trim()) === strong(etag)) return true;
    }
    return false;
  }
  const ifModifiedSince = req.headers.get("if-modified-since");
  if (!ifModifiedSince) return false;
  const since = Date.parse(ifModifiedSince);
  // DECLARED LIMITATION: http dates resolve to one second, so a rewrite inside
  // the second of the date sent 304s over changed bytes (500 -> 9999 bytes at
  // +997ms). reachable only without an etag, bounded to that second, self-healing
  // on the next revalidation. rfc 9110 §8.8.2.2's mitigation (refuse a date 304
  // while mtime is in the current second) is declined: it makes the answer depend on the wall clock
  return !Number.isNaN(since) && Math.floor(mtimeMs / 1000) * 1000 <= since;
}

// rfc 9110 §13.1.5: a range conditional on the client still holding the
// representation it started; on mismatch the whole representation goes, or
// the client splices new bytes onto an old prefix. not exotic here: the same
// url negotiates to a different encoding per Accept-Encoding. the rfc wants
// the strong comparison, so a weak validator on either side never authorises
// a range: ours are all weak (assetEtag), so every If-Range on an asset pays a
// full body; a bare Range is untouched. only the etag, never the date: a url's
// representations routinely land inside the same second (measured: a 416
// declaring a 6400-byte resource 35 bytes long, a 206 handing brotli bytes to a client assembling css)
export function isRangeStale(req: Request, etag: string): boolean {
  const ifRange = req.headers.get("if-range");
  if (ifRange === null || !req.headers.has("range")) return false;
  const given = ifRange.trim();
  return isWeak(etag) || isWeak(given) || given !== etag;
}

const statOf = (path: string) => {
  try {
    return statSync(path);
  } catch {
    return null;
  }
};

// the platform is only the fallback, not the question: an APFS volume
// formatted case-sensitive, a case-sensitive NTFS directory and a network share
// all make it wrong. measured on a case-sensitive directory with only
// assets/Logo.png on disk: folding invents /assets/logo.png and /assets/LOGO.PNG,
// both 200 with Logo.png's bytes where the filesystem says nothing is there
export const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";

// ascii only: ß uppercases to two characters and a dotless ı is not the fold
// any filesystem applies
const flipAscii = (name: string): string | null => {
  let flipped = "";
  let moved = false;
  for (const ch of name) {
    if (ch >= "a" && ch <= "z") {
      flipped += ch.toUpperCase();
      moved = true;
    } else if (ch >= "A" && ch <= "Z") {
      flipped += ch.toLowerCase();
      moved = true;
    } else flipped += ch;
  }
  return moved ? flipped : null;
};

// asked of the disk, read-only: a checkout mounted ro is where a write probe
// would fail. one statSync, 0.018 ms against 0.229 ms for write+stat+unlink.
// two spellings that fold together are proof: no folding filesystem can hold
// both. otherwise one name is flipped and stat'ed, last segment only, so the
// answer is about this directory and not an ancestor on another mount.
// failure direction chosen: "case-sensitive" on a folding disk only loses the
// indexed path (the live Bun.file() still answers 200), "case-insensitive" on
// one that does not fold serves another file's bytes, so doubt resolves toward not folding
export function foldsCase(
  paths: Iterable<string>,
  fallback: boolean = CASE_INSENSITIVE_FS,
): boolean {
  const seen = new Set<string>();
  let probe: string | null = null;
  for (const path of paths) {
    const folded = path.toLowerCase();
    if (seen.has(folded)) return false;
    seen.add(folded);
    if (probe === null) {
      const cut = path.lastIndexOf("/") + 1;
      const other = flipAscii(path.slice(cut));
      if (other) probe = path.slice(0, cut) + other;
    }
  }
  if (probe === null) return fallback;
  return statOf(probe) !== null;
}

// an index and the lookups over it have to fold the same way, or /LOGO.PNG is
// answered with logo.png's bytes where the two are kept apart; a copy of an index falls back to the guess
const foldingOf = new WeakMap<Map<string, AssetInfo>, boolean>();

export const indexFoldsCase = (index: Map<string, AssetInfo>): boolean =>
  foldingOf.get(index) ?? CASE_INSENSITIVE_FS;

export function findAsset(
  index: Map<string, AssetInfo>,
  url: string,
  caseInsensitive: boolean = indexFoldsCase(index),
): AssetInfo | undefined {
  const exact = index.get(url);
  if (exact || !caseInsensitive) return exact;
  return index.get(url.toLowerCase());
}

// the indexed path: variants chosen from the snapshot, etag, date and length
// from a live stat
export function serveIndexed(req: Request, info: AssetInfo): Response {
  let variant = info.identity;
  if (info.variants.length) {
    // negotiate against the encodings this asset has: offering br for a file
    // with only a .gz makes "br, gzip" resolve to br, miss, and ship identity
    // past the sibling. the order here is server preference, not the index's
    const available = ["br", "gzip"].filter((e) => info.variants.some((v) => v.encoding === e));
    const encoding = pickEncoding(req.headers.get("accept-encoding"), available);
    if (encoding) variant = info.variants.find((v) => v.encoding === encoding) ?? variant;
  }
  // the index was taken at boot and the disk moved on (`borgo dev` writing
  // over public/assets, a deploy swapping files in place): one stat settles a
  // gone sibling (degrade to identity), a gone identity (404, where
  // `new Response(Bun.file(missing))` is bun's own 67,016-byte fallback page
  // whose base64 payload decodes to the file's absolute path), and the length
  // below (bun recomputes Content-Length from the file on a GET and ignores
  // ours, so a stale index made HEAD and GET disagree, 1400 against 5600)
  let live = statOf(variant.path);
  if (!live && variant.encoding) {
    variant = info.identity;
    live = statOf(variant.path);
  }
  if (!live) return new Response("not found", { status: 404 });
  // a sibling whose identity file is gone is refused, as serveAsset and a
  // restart would: serving it made one url answer 200 or 404 by Accept-Encoding alone
  const identityLive = variant.encoding ? statOf(info.identity.path) : live;
  if (!identityLive) return new Response("not found", { status: 404 });

  const headers = new Headers();
  // the recorded length is the build's claim; whether the file on disk is still
  // that file only this stat can say, both halves: a .gz replaced 749 -> 75
  // beside an untouched identity went out `immutable`. unconditional, for unhashed assets too
  headers.set(
    "Cache-Control",
    pinPolicy(variant.pinnedSize, live.size, info.identity.pinnedSize, identityLive.size),
  );
  if (info.compressible) headers.set("Vary", "Accept-Encoding");
  // set before the 304 return: a 304 updates a cache's stored headers
  if (variant.encoding) {
    headers.set("Content-Encoding", variant.encoding);
    headers.set("Content-Type", info.type);
  }
  // both validators off `live`, the file whose bytes are going out, never off
  // the index or the identity: wrong in this direction it is silent, stale
  // bytes 304 forever (a .gz replaced 323 -> 95 answered 304 at +0s, +2s, +5s)
  const etag = assetEtag(live.size, live.mtimeMs, variant.encoding ? `-${variant.encoding}` : "");
  headers.set("ETag", etag);
  headers.set("Last-Modified", new Date(live.mtimeMs).toUTCString());
  if (isNotModified(req, etag, live.mtimeMs)) {
    return new Response(null, { status: 304, headers });
  }
  // a HEAD is answered from the headers alone, and dropping the body drops the
  // length bun computes from the file: without this every HEAD says Content-Length: 0
  headers.set("Content-Length", String(live.size));
  // bun turns a Range into a 206 off a Bun.file body and never consults
  // If-Range: a stream body is how the refusal is spelled, bun ranges files,
  // not streams, so the whole representation goes out as a 200, still off the disk
  if (isRangeStale(req, etag)) {
    // a stream body loses the type bun derives from a file, and under nosniff a
    // typeless stylesheet is a refused stylesheet. it loses the Content-Length
    // too (bun 1.3.14 drops an explicit one on a stream and goes chunked): a
    // legal framing difference, accepted over a Content-Range on a 200 (rfc
    // 9110 §14.4 gives it meaning on 206 and 416 alone) or reading the asset through memory
    headers.set("Content-Type", info.type);
    return new Response(Bun.file(variant.path).stream(), { headers });
  }
  return new Response(Bun.file(variant.path), { headers });
}

// dev, and anything written into public/ after boot: the same br/gz
// negotiation off the same url, so the same cross-encoding range splice
// serveIndexed refuses, from a live stat instead of the snapshot
export function serveAsset(
  req: Request,
  path: string,
  asset: ReturnType<typeof Bun.file>,
  { dev, outputs = NO_BUILD_OUTPUTS }: { dev: boolean; outputs?: BuildOutputs },
): Response {
  // here too, not only in the index: dropping a dotfile from the boot snapshot
  // alone removes it from no url, the fallback opens the same file live
  if (isHiddenAsset(path)) return new Response("not found", { status: 404 });

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

  // after negotiation: what is vouched for is the representation going out,
  // and in dev too, where a stale asset costs an afternoon
  headers.set(
    "Cache-Control",
    assetCacheControl(sentPath, outputs, size, { path, size: base.size }),
  );

  // the sent representation's, like the etag: the identity's date on a
  // sibling's bytes 304s a replaced .gz until someone touches the identity
  headers.set("ETag", etag);
  headers.set("Last-Modified", new Date(mtimeMs).toUTCString());
  if (isNotModified(req, etag, mtimeMs)) {
    return new Response(null, { status: 304, headers });
  }
  // a HEAD keeps the headers and loses the body bun would have measured
  headers.set("Content-Length", String(size));
  if (isRangeStale(req, etag)) {
    // a stream body is how a range is refused (bun ranges files, not streams,
    // and never consults If-Range); the type goes back on, a stream loses it
    headers.set("Content-Type", asset.type);
    return new Response(file.stream(), { headers });
  }
  return new Response(file, { headers });
}

const encoder = new TextEncoder();

// pull-based: react is asked for the next chunk only when the consumer has
// room, so a slow client throttles the render, and a client that goes away
// ends it through the iterator's return()
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

// a sync flush per chunk, so every react flush reaches the client and streamed ssr stays progressive
export function gzipStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const gzip = createGzip({ flush: constants.Z_SYNC_FLUSH });
  // the pump holds the source's lock, so a disconnect must cancel through the
  // reader: cancelling a locked stream throws, and from bun's cancel callback
  // that took the whole server process down
  const reader = source.getReader();
  let cancelled = false;
  // gzip pushes its output from a 'data' handler, which cannot consult the
  // consumer's queue, so the pump is the one that waits; otherwise react is
  // pulled as fast as zlib takes the writes and documentStream's backpressure
  // is lost on every compressed response. resumed from pull() and from cancel()
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
