package api

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

// the store keeps the newest keptAttachments files and removes the rest
func TestPruneAttachmentsKeepsTheNewest(t *testing.T) {
	old := attachmentsDir
	attachmentsDir = t.TempDir()
	defer func() { attachmentsDir = old }()
	base := time.Now().Add(-time.Hour)
	var want []string
	for i := range keptAttachments + 3 {
		name := fmt.Sprintf("f%02d", i)
		path := filepath.Join(attachmentsDir, name)
		if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		at := base.Add(time.Duration(i) * time.Minute)
		if err := os.Chtimes(path, at, at); err != nil {
			t.Fatal(err)
		}
		if i >= 3 {
			want = append(want, name)
		}
	}
	pruneAttachments()
	entries, err := os.ReadDir(attachmentsDir)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, e := range entries {
		got = append(got, e.Name())
	}
	if !slices.Equal(got, want) {
		t.Errorf("kept %v, want %v", got, want)
	}
}
