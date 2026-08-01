// The fixture package the generated-typescript golden is produced from. It is
// deliberately small and deliberately covers one instance of every shape the
// emitted .d.ts is allowed to have: a plain field, an omitempty field (which
// must become "?"), a pointer field (which must become "| null"), a map, a
// slice, an unexported and a json:"-" field (both must be absent), a route
// with a request body, a route whose handler answers with two different types
// (which must become a union), a route reached only through a helper, and a
// Push topic (which must land in WsEvents, not in ApiRoutes).
//
// It lives under testdata/ so the go tool never builds or vets it as part of
// the repo module; golden.test.ts copies it into a throwaway module that
// replaces github.com/LuigiDavideMicca/borgo with this checkout, and runs
// borgogen there.
package api

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
)

type Note struct {
	ID       int               `json:"id"`
	Title    string            `json:"title"`
	Body     *string           `json:"body"`
	Tags     []string          `json:"tags,omitempty"`
	Meta     map[string]string `json:"meta"`
	Archived bool              `json:"archived,omitempty"`
	Secret   string            `json:"-"`
	hidden   bool
}

type NoteList struct {
	Notes []Note `json:"notes"`
	Total int    `json:"total"`
}

type NoteCreate struct {
	Title string  `json:"title"`
	Body  *string `json:"body,omitempty"`
}

type Deleted struct {
	OK bool `json:"ok"`
}

// the response type is discovered through this helper, not at the handler
func respondNote(w http.ResponseWriter, status int, note Note) {
	borgo.JSON(w, status, note)
}

//borgo:route GET /api/notes
func ListNotes(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, NoteList{})
}

//borgo:route POST /api/notes
func CreateNote(w http.ResponseWriter, r *http.Request) {
	body, err := borgo.Bind[NoteCreate](r)
	if err != nil {
		borgo.BindError(w, err)
		return
	}
	note := Note{Title: body.Title}
	borgo.Push("notes", "created", note)
	respondNote(w, http.StatusCreated, note)
}

//borgo:route GET /api/notes/{id}
func GetNote(w http.ResponseWriter, r *http.Request) {
	if r.PathValue("id") == "" {
		borgo.JSON(w, http.StatusOK, Deleted{OK: false})
		return
	}
	respondNote(w, http.StatusOK, Note{})
}

//borgo:route DELETE /api/notes/{id}
func DeleteNote(w http.ResponseWriter, r *http.Request) {
	borgo.Push("notes", "deleted", 1)
	borgo.WriteJSON(w, http.StatusOK, Deleted{OK: true})
}
