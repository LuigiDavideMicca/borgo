package api

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
)

type Attachment struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// the form of an upload: text parts and files side by side
type AttachmentForm struct {
	Note   string       `json:"note"`
	Count  int          `json:"count"`
	File   borgo.File   `json:"file"`
	Cover  *borgo.File  `json:"cover"`
	Extras []borgo.File `json:"extras"`
}

//borgo:route POST /api/attachments
func Upload(w http.ResponseWriter, r *http.Request) {
	form, err := borgo.BindMultipart[AttachmentForm](r)
	if err != nil {
		borgo.BindError(w, err)
		return
	}
	borgo.JSON(w, http.StatusCreated, Attachment{ID: "1", Name: form.File.Name})
}

//borgo:route POST /api/big
func UploadBig(w http.ResponseWriter, r *http.Request) {
	form, err := borgo.BindMultipartMax[AttachmentForm](r, 64<<20)
	if err != nil {
		borgo.BindError(w, err)
		return
	}
	borgo.JSON(w, http.StatusCreated, Attachment{Name: form.Note})
}

// a JSON route beside them stays a JSON route
type Rename struct {
	Name string `json:"name"`
}

//borgo:route POST /api/rename
func DoRename(w http.ResponseWriter, r *http.Request) {
	body, err := borgo.Bind[Rename](r)
	if err != nil {
		borgo.BindError(w, err)
		return
	}
	borgo.JSON(w, http.StatusOK, Attachment{Name: body.Name})
}

// a type of the app's own named File is not borgo's: rendered as itself
type File struct {
	Path string `json:"path"`
}

//borgo:route POST /api/files
func Move(w http.ResponseWriter, r *http.Request) {
	body, err := borgo.Bind[File](r)
	if err != nil {
		borgo.BindError(w, err)
		return
	}
	borgo.JSON(w, http.StatusOK, body)
}

// a borgo.File written into a response is the struct encoding/json makes
// of it, not a Blob
type Echo struct {
	Upload borgo.File `json:"upload"`
}

//borgo:route GET /api/echo
func GetEcho(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, Echo{})
}
