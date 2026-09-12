package borgo

import (
	"bytes"
	"encoding/json"
	"io"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Static assets on the go front: public/, served with the policy the bun
// front server has always applied (compress.ts), ported line for line so
// /assets stops paying the process hop. Measured before it was built
// (bench/results/spikes): a 31 kB file answered from disk on every request
// queued badly on windows at 64 connections (7k req/s, p99 170 ms); the same
// file from memory answered 26.8k. So what the build vouched for - the
// hashed outputs the inventory names, a bounded set - is read once at boot
// and served from memory; everything else is a file, opened per request.
//
// The rules that cost the most to learn are kept with their reasons:
// `immutable` for a year needs three facts at once and none of them is a
// name's shape; a dotfile is not public content; the etag is weak because the
// pair it is built from can be preserved across a byte-for-byte substitution;
// the sibling actually sent is the one vouched for, not the identity beside
// it.

const (
	publicDir     = "public"
	inventoryFile = ".borgo/build-output.json"
	immutable     = "public, max-age=31536000, immutable"
	// what the boot reads into memory, in total: the hashed outputs of a
	// build are a few megabytes; an app that puts a video in public/assets
	// with a hashed name is served from disk past this
	memoryBudget = 64 << 20
)

// types worth compressing; images, fonts and media are already compressed
var compressibleExt = map[string]bool{
	".js": true, ".mjs": true, ".css": true, ".html": true, ".htm": true, ".svg": true,
	".json": true, ".map": true, ".txt": true, ".xml": true, ".webmanifest": true,
}

func isCompressiblePath(p string) bool {
	return compressibleExt[strings.ToLower(path.Ext(p))]
}

// a file whose own name starts with a dot is not public content: .DS_Store,
// .swp, a dropped .env all answered 200 once. Last segment only, never a
// directory: .well-known/ (rfc 8615) must stay served.
func isHiddenAsset(p string) bool {
	return strings.HasPrefix(path.Base(p), ".")
}

// the other half, judged against the url: a hidden directory anywhere in
// the path, except .well-known as the FIRST segment, exact and not folded -
// the rfc's paths are case-sensitive and every acme client writes it lower-case.
func inHiddenDirectory(urlPath string) bool {
	segments := strings.Split(urlPath, "/")
	for i := 1; i < len(segments)-1; i++ {
		s := segments[i]
		if strings.HasPrefix(s, ".") && !(i == 1 && s == ".well-known") {
			return true
		}
	}
	return false
}

// own table first: mime.TypeByExtension reads the windows registry, where a
// box with a broken .js association answers text/plain and every script is
// then refused under nosniff. The fallback covers what the table does not.
var assetTypes = map[string]string{
	".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
	".json": "application/json; charset=utf-8", ".map": "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json", ".xml": "application/xml; charset=utf-8",
	".txt": "text/plain; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
	".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
	".avif": "image/avif", ".ico": "image/x-icon", ".wasm": "application/wasm",
	".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
	".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".pdf": "application/pdf",
}

func assetType(p string) string {
	ext := strings.ToLower(path.Ext(p))
	if t, ok := assetTypes[ext]; ok {
		return t
	}
	if t := mime.TypeByExtension(ext); t != "" {
		return t
	}
	return "application/octet-stream"
}

// buildOutputs is what a build recorded: where it wrote, and the byte length
// of each output whose name carries its content hash - a list, not a
// pattern, and a length, not a bare name, because `immutable` is a claim
// about bytes (readBuildOutputs in build.ts).
type buildOutputs struct {
	dir   string
	sizes map[string]int64
}

func readBuildOutputs(file string) buildOutputs {
	none := buildOutputs{}
	raw, err := os.ReadFile(file)
	if err != nil {
		return none
	}
	var parsed struct {
		Dir    string                     `json:"dir"`
		Hashed map[string]json.RawMessage `json:"hashed"`
	}
	if json.Unmarshal(raw, &parsed) != nil || parsed.Dir == "" || parsed.Hashed == nil {
		return none
	}
	sizes := map[string]int64{}
	for name, v := range parsed.Hashed {
		if name == "" || strings.ContainsAny(name, `/\`) {
			continue
		}
		var size int64
		// a recorded 0 would pin any truncated file at that name
		if json.Unmarshal(v, &size) != nil || size <= 0 {
			continue
		}
		sizes[name] = size
	}
	if len(sizes) == 0 {
		return none
	}
	return buildOutputs{dir: strings.TrimRight(filepath.ToSlash(parsed.Dir), "/"), sizes: sizes}
}

// recordedSize is the byte length the build recorded for this exact path.
// The directory is compared whole, not by segment name: gating on `assets/`
// pinned /copy/assets/... for a year on bytes the bundler never saw. A
// service worker is never pinned: it controls every url in its scope.
func (o buildOutputs) recordedSize(p string) (int64, bool) {
	if o.dir == "" {
		return 0, false
	}
	u := filepath.ToSlash(p)
	if u == "public/sw.js" || strings.HasSuffix(u, "/public/sw.js") {
		return 0, false
	}
	if !strings.HasPrefix(u, o.dir+"/") {
		return 0, false
	}
	name := u[len(o.dir)+1:]
	if name == "" || strings.Contains(name, "/") {
		return 0, false
	}
	size, ok := o.sizes[name]
	return size, ok
}

// the one place a year is granted, and against the disk twice: the manifest
// vouches for a name, and whatever occupies it would inherit the year. Two
// lengths: the representation sent (a replaced .gz pinned 75 stale bytes
// where 749 were vouched for) and the identity behind it (a partial deploy
// must not keep pinning a leftover sibling).
func pinPolicy(sent, identity pinned) string {
	if sent.vouched() && identity.vouched() {
		return immutable
	}
	return "no-cache"
}

type pinned struct {
	recorded int64
	ok       bool
	onDisk   int64
}

func (p pinned) vouched() bool { return p.ok && p.recorded == p.onDisk }

// size and mtime, base36; the suffix keeps one url's encodings from
// revalidating each other. Weak because the pair is: equal lengths share the
// size half and cp -p, rsync -t, tar and docker COPY carry the mtime across.
// W/ disqualifies the tag from If-Range, where a wrong match splices bytes.
func assetEtag(size int64, mtime time.Time, suffix string) string {
	return `W/"` + strconv.FormatInt(size, 36) + "-" + strconv.FormatInt(mtime.UnixMilli(), 36) + suffix + `"`
}

// pickEncoding is the first server-preferred encoding the client accepts
// with q > 0; the parameter name folds case (rfc 9110 §5.6.6).
func pickEncoding(acceptEncoding string, preferred []string) string {
	if acceptEncoding == "" {
		return ""
	}
	q := map[string]float64{}
	for _, part := range strings.Split(acceptEncoding, ",") {
		fields := strings.Split(strings.TrimSpace(part), ";")
		token := strings.ToLower(strings.TrimSpace(fields[0]))
		if token == "" {
			continue
		}
		quality := 1.0
		for _, param := range fields[1:] {
			key, value, _ := strings.Cut(strings.TrimSpace(param), "=")
			if strings.ToLower(strings.TrimSpace(key)) == "q" {
				if f, err := strconv.ParseFloat(strings.TrimSpace(value), 64); err == nil {
					quality = f
				} else {
					quality = 0
				}
			}
		}
		q[token] = quality
	}
	for _, enc := range preferred {
		quality, ok := q[enc]
		if !ok {
			quality, ok = q["*"]
		}
		if ok && quality > 0 {
			return enc
		}
	}
	return ""
}

type assetVariant struct {
	path     string // on disk
	encoding string // "" for the identity, else "br" or "gzip"
	recorded int64
	pinnedOK bool
	// the bytes, when the build vouched for them and the budget allowed;
	// nil means the file is opened per request
	data []byte
}

type assetInfo struct {
	identity     assetVariant
	variants     []assetVariant // server preference order: br, gzip
	compressible bool
	contentType  string
}

type assetIndex struct {
	root    string
	byURL   map[string]*assetInfo
	folds   bool
	outputs buildOutputs
	// dev rebuilds under stable names: nothing is indexed and no sibling is
	// offered, every request is a live look at the disk
	dev bool
}

// newAssetIndex walks root once. Production only in substance: in dev the
// index is empty and every request is answered live.
func newAssetIndex(root string, outputs buildOutputs, dev bool) *assetIndex {
	ix := &assetIndex{root: root, byURL: map[string]*assetInfo{}, outputs: outputs, dev: dev}
	if dev {
		return ix
	}
	type stat struct {
		size  int64
		mtime time.Time
	}
	files := map[string]stat{}
	var names []string
	filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		u := filepath.ToSlash(p)
		rel := strings.TrimPrefix(u, filepath.ToSlash(root))
		if d.IsDir() {
			// hidden ancestors are never entered: the index must not carry
			// what no request can reach
			if p != root && inHiddenDirectory(rel+"/x") {
				return fs.SkipDir
			}
			return nil
		}
		if isHiddenAsset(u) {
			return nil
		}
		// a symlink present at boot is judged as a file found after it is:
		// by the name the disk resolves, under the root, not hidden. The live
		// branch refuses a link to outside public/, and the two must agree
		// (found by the verifier of this step). The stat recorded is the
		// target's: a link's own is a few bytes of path
		var info fs.FileInfo
		if d.Type()&fs.ModeSymlink != 0 {
			if !ix.linkStaysInside(p) {
				return nil
			}
			info, err = os.Stat(p)
		} else {
			info, err = d.Info()
		}
		if err != nil || info.IsDir() {
			return nil
		}
		files[u] = stat{size: info.Size(), mtime: info.ModTime()}
		names = append(names, u)
		return nil
	})
	ix.folds = foldsCase(names, runtime.GOOS == "windows" || runtime.GOOS == "darwin")

	var budget int64 = memoryBudget
	load := func(v *assetVariant) {
		if !v.pinnedOK || v.recorded > budget {
			return
		}
		data, err := os.ReadFile(v.path)
		if err != nil || int64(len(data)) != v.recorded {
			return
		}
		v.data = data
		budget -= v.recorded
	}
	base := filepath.ToSlash(root)
	for u, f := range files {
		if strings.HasSuffix(u, ".br") || strings.HasSuffix(u, ".gz") {
			// a sibling is reached through its identity, never indexed on its own
			continue
		}
		_ = f
		info := &assetInfo{compressible: isCompressiblePath(u), contentType: assetType(u)}
		info.identity = assetVariant{path: u}
		info.identity.recorded, info.identity.pinnedOK = outputs.recordedSize(u)
		load(&info.identity)
		if info.compressible {
			for _, enc := range [][2]string{{"br", ".br"}, {"gzip", ".gz"}} {
				if _, ok := files[u+enc[1]]; !ok {
					continue
				}
				v := assetVariant{path: u + enc[1], encoding: enc[0]}
				v.recorded, v.pinnedOK = outputs.recordedSize(u + enc[1])
				load(&v)
				info.variants = append(info.variants, v)
			}
		}
		url := strings.TrimPrefix(u, base)
		ix.byURL[url] = info
		// the folded alias the lookup falls back to, never over a real url
		if ix.folds {
			if folded := strings.ToLower(url); folded != url {
				if _, taken := ix.byURL[folded]; !taken {
					ix.byURL[folded] = info
				}
			}
		}
	}
	return ix
}

// foldsCase is measured on the names just read, not guessed from the
// platform: two spellings that fold together are proof of a case-sensitive
// disk; otherwise one name is flipped and stat'ed. Doubt resolves toward
// not folding - "case-sensitive" on a folding disk only loses the indexed
// path (the live look still answers), "case-insensitive" on one that does
// not fold serves another file's bytes.
func foldsCase(names []string, fallback bool) bool {
	seen := map[string]bool{}
	probe := ""
	for _, n := range names {
		folded := strings.ToLower(n)
		if seen[folded] {
			return false
		}
		seen[folded] = true
		if probe == "" {
			if flipped := flipASCII(path.Base(n)); flipped != "" {
				probe = path.Dir(n) + "/" + flipped
			}
		}
	}
	if probe == "" {
		return fallback
	}
	_, err := os.Stat(filepath.FromSlash(probe))
	return err == nil
}

// ascii only: ß uppercases to two characters and a dotless ı is not the fold
// any filesystem applies
func flipASCII(name string) string {
	moved := false
	out := []rune(name)
	for i, r := range out {
		switch {
		case r >= 'a' && r <= 'z':
			out[i] = r - 'a' + 'A'
			moved = true
		case r >= 'A' && r <= 'Z':
			out[i] = r - 'A' + 'a'
			moved = true
		}
	}
	if !moved {
		return ""
	}
	return string(out)
}

// linkStaysInside is liveFile's containment and hidden rule for a symlink
// the walk met: the canonical target must lie under the resolved root and
// carry no hidden segment under its real name.
func (ix *assetIndex) linkStaysInside(p string) bool {
	real, err := filepath.EvalSymlinks(p)
	if err != nil {
		return false
	}
	root, err := filepath.EvalSymlinks(ix.root)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(root, real)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return false
	}
	relURL := "/" + filepath.ToSlash(rel)
	return !isHiddenAsset(relURL) && !inHiddenDirectory(relURL)
}

func (ix *assetIndex) lookup(url string) *assetInfo {
	if info := ix.byURL[url]; info != nil || !ix.folds {
		return info
	}
	return ix.byURL[strings.ToLower(url)]
}

// windows aliases a file under names the path checks never saw: an ntfs
// alternate stream (file.css::$DATA) and the reserved characters
var windowsReserved = `:*?"<>|`

// tryServe answers a request for a file under public/ and reports whether it
// did. GET and HEAD only: a public/ file must not shadow a post. The path is
// the decoded one, so traversal is checked on what would be opened. An
// extension-less path is almost always a page and stays the router's: the
// render service keeps its late probe for a plain file that collides with no
// route.
func (ix *assetIndex) tryServe(w http.ResponseWriter, r *http.Request) bool {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	p := r.URL.Path
	if p == "/" || strings.Contains(p, "..") || strings.ContainsAny(p, "\\\x00") || inHiddenDirectory(p) {
		return false
	}
	if runtime.GOOS == "windows" && strings.ContainsAny(p, windowsReserved) {
		return false
	}
	if info := ix.lookup(p); info != nil {
		ix.serveIndexed(w, r, info)
		return true
	}
	if !strings.Contains(path.Base(p), ".") {
		return false
	}
	if isHiddenAsset(p) {
		return false
	}
	file, st, ok := ix.liveFile(p)
	if !ok {
		return false
	}
	ix.serveLive(w, r, file, st)
	return true
}

// liveFile resolves a url to the file the disk actually has under root, and
// judges the guards on THAT name. The spelling asked is what the checks
// above saw; the disk may answer it with another file: on windows an 8.3
// short name (ENV~1.LOC) resolves to .env.local and never starts with a dot,
// a trailing dot or space is dropped, and a symlink inside public/ may point
// outside it (found by the verifier of this step). EvalSymlinks returns the
// canonical long path; anything not under root, hidden under its real name,
// or spelled differently from what was asked (case aside, where the disk
// folds) is not served.
func (ix *assetIndex) liveFile(p string) (string, os.FileInfo, bool) {
	asked := filepath.Join(ix.root, filepath.FromSlash(p))
	real, err := filepath.EvalSymlinks(asked)
	if err != nil {
		return "", nil, false
	}
	root, err := filepath.EvalSymlinks(ix.root)
	if err != nil {
		return "", nil, false
	}
	rel, err := filepath.Rel(root, real)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", nil, false
	}
	relURL := "/" + filepath.ToSlash(rel)
	if isHiddenAsset(relURL) || inHiddenDirectory(relURL) {
		return "", nil, false
	}
	if relURL != p && !(ix.folds && strings.EqualFold(relURL, p)) {
		return "", nil, false
	}
	st, err := os.Stat(real)
	if err != nil || st.IsDir() {
		return "", nil, false
	}
	return real, st, true
}

func statLive(p string) (os.FileInfo, bool) {
	st, err := os.Stat(filepath.FromSlash(p))
	if err != nil || st.IsDir() {
		return nil, false
	}
	return st, true
}

// serveIndexed: the variant chosen from the snapshot, everything sent from a
// live stat. The index was taken at boot and the disk moved on (a deploy
// swapping files in place): one stat settles a gone sibling (degrade to
// identity), a gone identity (404), and the length the pin is judged on.
func (ix *assetIndex) serveIndexed(w http.ResponseWriter, r *http.Request, info *assetInfo) {
	variant := info.identity
	if len(info.variants) > 0 {
		// negotiate against the encodings this asset has: offering br for
		// a file with only a .gz makes "br, gzip" resolve to br, miss, and
		// ship identity past the sibling
		var available []string
		for _, v := range info.variants {
			available = append(available, v.encoding)
		}
		if enc := pickEncoding(r.Header.Get("Accept-Encoding"), available); enc != "" {
			for _, v := range info.variants {
				if v.encoding == enc {
					variant = v
				}
			}
		}
	}
	identityLive, ok := statLive(info.identity.path)
	if !ok {
		// a sibling whose identity file is gone is refused too: serving it
		// made one url answer 200 or 404 by Accept-Encoding alone
		http.NotFound(w, r)
		return
	}
	live := identityLive
	if variant.encoding != "" {
		if sibling, ok := statLive(variant.path); ok {
			live = sibling
		} else {
			variant = info.identity
		}
	}
	h := w.Header()
	h.Set("Cache-Control", pinPolicy(
		pinned{variant.recorded, variant.pinnedOK, live.Size()},
		pinned{info.identity.recorded, info.identity.pinnedOK, identityLive.Size()},
	))
	if info.compressible {
		h.Set("Vary", "Accept-Encoding")
	}
	h.Set("Content-Type", info.contentType)
	suffix := ""
	if variant.encoding != "" {
		h.Set("Content-Encoding", variant.encoding)
		suffix = "-" + variant.encoding
	}
	h.Set("ETag", assetEtag(live.Size(), live.ModTime(), suffix))
	ix.send(w, r, variant, live)
}

// serveLive is the path for what the index never saw - dev, and anything
// written into public/ after boot: the same negotiation off the disk.
func (ix *assetIndex) serveLive(w http.ResponseWriter, r *http.Request, file string, st os.FileInfo) {
	sent := file
	live := st
	suffix := ""
	h := w.Header()
	compressible := isCompressiblePath(file)
	encoding := ""
	if compressible {
		h.Set("Vary", "Accept-Encoding")
		if !ix.dev {
			encoding = pickEncoding(r.Header.Get("Accept-Encoding"), []string{"br", "gzip"})
		}
	}
	if encoding != "" {
		ext := ".gz"
		if encoding == "br" {
			ext = ".br"
		}
		if sibling, ok := statLive(file + ext); ok {
			sent, live, suffix = file+ext, sibling, "-"+encoding
			h.Set("Content-Encoding", encoding)
		}
	}
	sentRecorded, sentOK := ix.outputs.recordedSize(sent)
	idRecorded, idOK := ix.outputs.recordedSize(file)
	h.Set("Cache-Control", pinPolicy(pinned{sentRecorded, sentOK, live.Size()}, pinned{idRecorded, idOK, st.Size()}))
	h.Set("Content-Type", assetType(file))
	h.Set("ETag", assetEtag(live.Size(), live.ModTime(), suffix))
	ix.send(w, r, assetVariant{path: filepath.ToSlash(sent)}, live)
}

// send hands the body to http.ServeContent, which owns the conditionals
// with the rules bun applied by hand: If-None-Match compares weakly, so a
// client echoing our W/"..." gets its 304; If-Range compares strongly, so a
// weak tag never authorises a range and the whole representation goes
// rather than new bytes spliced onto an old prefix; a bare Range is a 206.
func (ix *assetIndex) send(w http.ResponseWriter, r *http.Request, variant assetVariant, live os.FileInfo) {
	name := path.Base(variant.path)
	if variant.data != nil && int64(len(variant.data)) == live.Size() {
		http.ServeContent(w, r, name, live.ModTime(), bytes.NewReader(variant.data))
		return
	}
	f, err := os.Open(filepath.FromSlash(variant.path))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	http.ServeContent(w, r, name, live.ModTime(), f)
}

// newAssetIndexLogged is what serveFront calls: the walk, and one line
// saying what was taken into memory.
func newAssetIndexLogged(outputs buildOutputs, dev bool) *assetIndex {
	ix := newAssetIndex(publicDir, outputs, dev)
	if dev {
		return ix
	}
	var inMemory, files int
	var bytesHeld int64
	seen := map[*assetInfo]bool{}
	for _, info := range ix.byURL {
		if seen[info] {
			continue
		}
		seen[info] = true
		files++
		for _, v := range append([]assetVariant{info.identity}, info.variants...) {
			if v.data != nil {
				inMemory++
				bytesHeld += int64(len(v.data))
			}
		}
	}
	log.Printf("borgo: %d files under %s indexed, %d vouched by the build held in memory (%d KiB)", files, publicDir, inMemory, bytesHeld>>10)
	return ix
}

// discardBody is what a HEAD answered by ServeContent never needs; kept so
// the io import states the one thing it is for
var _ = io.Discard
