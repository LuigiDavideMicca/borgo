package api

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/LuigiDavideMicca/borgo"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"

	"tasks/db"
)

func withAttachmentStore(t *testing.T) {
	t.Helper()
	conn, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := conn.AutoMigrate(&Attachment{}); err != nil {
		t.Fatal(err)
	}
	oldDB, oldUploads := db.DB, uploads
	db.DB, uploads = conn, &borgo.Uploads{Dir: t.TempDir()}
	t.Cleanup(func() { db.DB, uploads = oldDB, oldUploads })
}

func keyOf(owner uint, i int) string {
	return fmt.Sprintf("%016x%016x", owner, i)
}

// one user's attachments past the newest keptAttachments go, rows and
// files; another user's are not counted against them
func TestPruneAttachmentsKeepsEachOwnersNewest(t *testing.T) {
	withAttachmentStore(t)
	for owner := uint(1); owner <= 2; owner++ {
		count := keptAttachments + 3
		if owner == 2 {
			count = 2
		}
		for i := range count {
			key := keyOf(owner, i)
			if err := os.WriteFile(filepath.Join(uploads.Dir, key), []byte("x"), 0o600); err != nil {
				t.Fatal(err)
			}
			db.DB.Create(&Attachment{OwnerID: owner, Stored: borgo.Stored{Key: key}})
		}
	}
	pruneAttachments(1)

	var kept []Attachment
	db.DB.Order("id").Find(&kept)
	var keys []string
	for _, a := range kept {
		keys = append(keys, a.Key)
	}
	var want []string
	for i := 3; i < keptAttachments+3; i++ {
		want = append(want, keyOf(1, i))
	}
	want = append(want, keyOf(2, 0), keyOf(2, 1))
	if fmt.Sprint(keys) != fmt.Sprint(want) {
		t.Errorf("rows kept:\n%v\nwant\n%v", keys, want)
	}
	for i := range 3 {
		if _, err := os.Stat(filepath.Join(uploads.Dir, keyOf(1, i))); !os.IsNotExist(err) {
			t.Errorf("file %d of owner 1 still there: %v", i, err)
		}
	}
	// gone from the table, not marked deleted: a pruned row kept forever is
	// the growth pruning exists to stop
	var all int64
	db.DB.Unscoped().Model(&Attachment{}).Count(&all)
	if all != int64(keptAttachments+2) {
		t.Errorf("%d rows in the table, want %d", all, keptAttachments+2)
	}
	entries, _ := os.ReadDir(uploads.Dir)
	if len(entries) != keptAttachments+2 {
		t.Errorf("%d files left, want %d", len(entries), keptAttachments+2)
	}
}

// a row whose file will not go stays, so the next upload tries again
func TestPruneAttachmentsKeepsTheRowOfAFileItCannotRemove(t *testing.T) {
	withAttachmentStore(t)
	for i := range keptAttachments + 1 {
		key := keyOf(1, i)
		if i == 0 {
			// not a key Save makes: Remove refuses it
			key = "not-a-key"
		}
		db.DB.Create(&Attachment{OwnerID: 1, Stored: borgo.Stored{Key: key}})
	}
	pruneAttachments(1)
	var n int64
	db.DB.Model(&Attachment{}).Count(&n)
	if n != keptAttachments+1 {
		t.Errorf("%d rows, want %d", n, keptAttachments+1)
	}
}
