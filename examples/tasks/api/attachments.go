package api

import (
	"errors"
	"log"
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
	"gorm.io/gorm"

	"tasks/db"
	"tasks/env"
)

// the form of an upload: a note and a file, read with borgo.BindMultipart,
// so the page's call to this route sends a FormData and its body is typed
type AttachmentForm struct {
	Note string     `json:"note"`
	File borgo.File `json:"file"`
}

// what the app keeps about a file: its owner, which decides who may download
// it, and what borgo.Uploads learned when it stored it
type Attachment struct {
	gorm.Model
	OwnerID uint   `gorm:"index"`
	Note    string `json:"note"`
	borgo.Stored
}

// what the page is told about a stored file
type AttachmentView struct {
	Key  string `json:"key"`
	Note string `json:"note"`
	Name string `json:"name"`
	Size int64  `json:"size"`
	Type string `json:"type"`
}

// gitignored in development, so the dev watcher never rebuilds on an upload;
// in a container, a volume at /data (see the Dockerfile)
var uploads = &borgo.Uploads{Dir: env.Must().UPLOADS_DIR}

// how many files one user keeps: the oldest go when an upload passes it
const keptAttachments = 20

func init() {
	// writing to the server's disk is for signed-in users only, and a file
	// is downloaded by its owner only
	borgo.Handle("POST /api/attachments", borgo.Authed(UploadAttachment))
	borgo.Handle("GET /api/attachments/{key}", borgo.Authed(DownloadAttachment))
}

func UploadAttachment(w http.ResponseWriter, r *http.Request) {
	me, ok := signedInWithID(w, r)
	if !ok {
		return
	}
	form, err := borgo.BindMultipart[AttachmentForm](r)
	if err != nil {
		borgo.BindError(w, err)
		return
	}
	stored, err := uploads.Save(form.File)
	switch {
	case errors.Is(err, borgo.ErrNoUpload):
		http.Error(w, "a file is required", http.StatusBadRequest)
		return
	case err != nil:
		log.Printf("storing an attachment: %v", err)
		http.Error(w, "storage failed", http.StatusInternalServerError)
		return
	}
	row := Attachment{OwnerID: me.ID, Note: form.Note, Stored: stored}
	if err := db.DB.Create(&row).Error; err != nil {
		uploads.Remove(stored.Key)
		log.Printf("recording an attachment: %v", err)
		http.Error(w, "storage failed", http.StatusInternalServerError)
		return
	}
	pruneAttachments(me.ID)
	borgo.JSON(w, http.StatusCreated, viewOf(row))
}

// the owner's file, or 404 for anyone else's: a 403 would confirm the key
func DownloadAttachment(w http.ResponseWriter, r *http.Request) {
	me, ok := signedInWithID(w, r)
	if !ok {
		return
	}
	var row Attachment
	if err := db.DB.Where("`key` = ? AND owner_id = ?", r.PathValue("key"), me.ID).First(&row).Error; err != nil {
		http.NotFound(w, r)
		return
	}
	uploads.Serve(w, r, row.Stored)
}

// signedInWithID is the session a file can be owned by. A session issued
// before Me carried an id reads ID 0, and every such session would share
// one owner - one user reading and pruning another's files (found by the
// verifier of phase 6): it signs in again instead
func signedInWithID(w http.ResponseWriter, r *http.Request) (Me, bool) {
	me, ok := borgo.GetSession[Me](r)
	if !ok || me.ID == 0 {
		http.Error(w, "sign in again", http.StatusUnauthorized)
		return Me{}, false
	}
	return me, true
}

func viewOf(a Attachment) AttachmentView {
	return AttachmentView{Key: a.Key, Note: a.Note, Name: a.Name, Size: a.Size, Type: a.Type}
}

// pruneAttachments removes the owner's attachments past the newest
// keptAttachments, rows and files. A file that will not go is logged and
// its row kept, so it is tried again on the next upload
func pruneAttachments(owner uint) {
	var old []Attachment
	db.DB.Where("owner_id = ?", owner).Order("id desc").Offset(keptAttachments).Find(&old)
	for _, a := range old {
		if err := uploads.Remove(a.Key); err != nil {
			log.Printf("pruning an attachment: %v", err)
			continue
		}
		db.DB.Unscoped().Delete(&a)
	}
}
