package borgo

import (
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The memory copy of a vouched output was trusted by length alone. A file
// replaced in place with the same length kept being served from the boot
// bytes, while the ETag - built from the live size and mtime - advertised the
// new file: a client revalidated, got a new tag, and still received the old
// body. Found by the verifier of phase 1.
func TestStaticServesAReplacedFileNotTheBootCopy(t *testing.T) {
	root, outputs := publicTree(t)
	ix := newAssetIndex(root, outputs, false)
	const url = "/assets/app-abc12345.js"
	if ix.byURL[url] == nil || ix.byURL[url].identity.data == nil {
		t.Fatal("the fixture's vouched output was not held in memory, so this test proves nothing")
	}
	path := filepath.Join(root, "assets", "app-abc12345.js")
	old, _ := os.ReadFile(path)
	replaced := bytes.Repeat([]byte("x"), len(old))
	if err := os.WriteFile(path, replaced, 0o644); err != nil {
		t.Fatal(err)
	}
	// a filesystem with coarse mtimes could land the write in the same tick
	later := time.Now().Add(2 * time.Second)
	os.Chtimes(path, later, later)

	w, _ := get(t, ix, url)
	if !bytes.Equal(w.Body.Bytes(), replaced) {
		t.Errorf("a same-length replacement was served from the boot copy")
	}
}

// Offering br for a file with only a .gz made "br, gzip" resolve to br, miss
// the sibling, and ship identity. The guard existed with that reason written
// beside it, and nothing tested it: the fixture had a file with both
// siblings and one with none. Found by the verifier of phase 1.
func TestStaticNegotiatesTheGzipSiblingWhenThereIsNoBrotli(t *testing.T) {
	root, outputs := publicTree(t)
	lib := []byte(strings.Repeat("export const x = 1;\n", 40))
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	zw.Write(lib)
	zw.Close()
	os.WriteFile(filepath.Join(root, "assets", "lib-def67890.js"), lib, 0o644)
	os.WriteFile(filepath.Join(root, "assets", "lib-def67890.js.gz"), gz.Bytes(), 0o644)
	outputs.sizes["lib-def67890.js"] = int64(len(lib))
	outputs.sizes["lib-def67890.js.gz"] = int64(gz.Len())
	ix := newAssetIndex(root, outputs, false)

	w, _ := get(t, ix, "/assets/lib-def67890.js", "Accept-Encoding", "br, gzip")
	if w.Header().Get("Content-Encoding") != "gzip" {
		t.Errorf("a client accepting br and gzip got %q for a file with only a gzip sibling", w.Header().Get("Content-Encoding"))
	}
	if !bytes.Equal(w.Body.Bytes(), gz.Bytes()) {
		t.Error("the body is not the gzip sibling")
	}
}

// The memory budget is first come first served in name order, admits an exact
// fit, and refuses the file that would cross it - which is then served from
// disk, correctly. None of it was tested. Found by the verifier of phase 1.
func TestStaticHoldsOutputsInMemoryWithinTheBudget(t *testing.T) {
	root, outputs := publicTree(t)
	identity := outputs.sizes["app-abc12345.js"]

	saved := memoryBudget
	defer func() { memoryBudget = saved }()

	// exactly the identity: admitted, and nothing after it fits
	memoryBudget = identity
	ix := newAssetIndex(root, outputs, false)
	info := ix.byURL["/assets/app-abc12345.js"]
	if info.identity.data == nil {
		t.Error("an output exactly the size of the budget was not admitted")
	}
	for _, v := range info.variants {
		if v.data != nil {
			t.Errorf("the %s sibling was held past a spent budget", v.encoding)
		}
	}

	// one byte short: nothing held, and the file is still served whole
	memoryBudget = identity - 1
	ix = newAssetIndex(root, outputs, false)
	info = ix.byURL["/assets/app-abc12345.js"]
	if info.identity.data != nil {
		t.Error("an output larger than the budget was held in memory")
	}
	want, _ := os.ReadFile(filepath.Join(root, "assets", "app-abc12345.js"))
	if w, _ := get(t, ix, "/assets/app-abc12345.js"); !bytes.Equal(w.Body.Bytes(), want) {
		t.Error("an output outside the budget was not served from disk")
	}

}

// Which outputs win the budget has to be the same on every boot of the same
// build. It was decided by map order, so two identical hosts could hold
// different files in memory and measure different p99s. With room for one
// file of eight, the one held must be the first by name, every time - under
// map order that is right one boot in eight.
func TestStaticSpendsTheBudgetInNameOrder(t *testing.T) {
	root := filepath.Join(t.TempDir(), "public")
	os.MkdirAll(filepath.Join(root, "assets"), 0o755)
	outputs := buildOutputs{dir: filepath.ToSlash(filepath.Join(root, "assets")), sizes: map[string]int64{}}
	body := bytes.Repeat([]byte("b"), 100)
	for _, name := range []string{"m5.png", "m2.png", "m8.png", "m1.png", "m7.png", "m3.png", "m6.png", "m4.png"} {
		os.WriteFile(filepath.Join(root, "assets", name), body, 0o644)
		outputs.sizes[name] = int64(len(body))
	}

	saved := memoryBudget
	defer func() { memoryBudget = saved }()
	memoryBudget = int64(len(body))

	for boot := 0; boot < 20; boot++ {
		ix := newAssetIndex(root, outputs, false)
		var held []string
		for url, info := range ix.byURL {
			if info.identity.data != nil {
				held = append(held, url)
			}
		}
		if len(held) != 1 || held[0] != "/assets/m1.png" {
			t.Fatalf("boot %d held %v in memory, want only the first by name", boot, held)
		}
	}
}
