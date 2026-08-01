package api

import (
	"net/http"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/LuigiDavideMicca/borgo"
)

// an in-memory store keeps the template dependency-free; swap it for sqlite,
// postgres or anything else - the handlers and the typed bridge stay the same
type Note struct {
	ID        int    `json:"id"`
	Title     string `json:"title"`
	Body      string `json:"body"`
	CreatedAt string `json:"createdAt"`
}

type NoteCreate struct {
	Title string `json:"title"`
	Body  string `json:"body"`
}

type NoteList struct {
	Notes []Note `json:"notes"`
}

type NoteItem struct {
	Note Note `json:"note"`
}

type Deleted struct {
	Deleted bool `json:"deleted"`
}

var (
	notesMu sync.RWMutex
	notes   = map[int]Note{}
	nextID  = 1
)

//borgo:route GET /api/notes
func ListNotes(w http.ResponseWriter, r *http.Request) {
	notesMu.RLock()
	list := make([]Note, 0, len(notes))
	for _, n := range notes {
		list = append(list, n)
	}
	notesMu.RUnlock()
	sort.Slice(list, func(i, j int) bool { return list[i].ID > list[j].ID })
	borgo.JSON(w, http.StatusOK, NoteList{Notes: list})
}

//borgo:route POST /api/notes
func CreateNote(w http.ResponseWriter, r *http.Request) {
	body, err := borgo.Bind[NoteCreate](r)
	if err != nil {
		borgo.BindError(w, err)
		return
	}
	notesMu.Lock()
	note := Note{ID: nextID, Title: body.Title, Body: body.Body, CreatedAt: time.Now().Format(time.RFC3339)}
	notes[nextID] = note
	nextID++
	notesMu.Unlock()

	// realtime fan-out: sse subscribers refresh, the ws topic gets a typed event
	events.Publish("note-created", note)
	go borgo.Push("live", "note-created", note.Title)
	borgo.JSON(w, http.StatusCreated, NoteItem{Note: note})
}

//borgo:route DELETE /api/notes/{id}
func DeleteNote(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	notesMu.Lock()
	delete(notes, id)
	notesMu.Unlock()
	events.Publish("note-deleted", id)
	borgo.WriteJSON(w, http.StatusOK, Deleted{Deleted: true})
}
