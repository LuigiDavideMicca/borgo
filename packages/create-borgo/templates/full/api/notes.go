package api

import (
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/LuigiDavideMicca/borgo"

	"{{name}}/db"
)

// the notes table is db/migrations/0001_init.sql; a column added there is a
// field here, and the typed bridge carries it to the pages
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

//borgo:route GET /api/notes
func ListNotes(w http.ResponseWriter, r *http.Request) {
	rows, err := db.DB.QueryContext(r.Context(), `SELECT id, title, body, created_at FROM notes ORDER BY id DESC`)
	if err != nil {
		storeFailed(w, "list notes", err)
		return
	}
	defer rows.Close()
	list := []Note{}
	for rows.Next() {
		var n Note
		if err := rows.Scan(&n.ID, &n.Title, &n.Body, &n.CreatedAt); err != nil {
			storeFailed(w, "list notes", err)
			return
		}
		list = append(list, n)
	}
	if err := rows.Err(); err != nil {
		storeFailed(w, "list notes", err)
		return
	}
	borgo.JSON(w, http.StatusOK, NoteList{Notes: list})
}

//borgo:route POST /api/notes
func CreateNote(w http.ResponseWriter, r *http.Request) {
	body, err := borgo.Bind[NoteCreate](r)
	if err != nil {
		borgo.BindError(w, err)
		return
	}
	note := Note{Title: body.Title, Body: body.Body, CreatedAt: time.Now().Format(time.RFC3339)}
	res, err := db.DB.ExecContext(r.Context(), `INSERT INTO notes (title, body, created_at) VALUES (?, ?, ?)`, note.Title, note.Body, note.CreatedAt)
	if err != nil {
		storeFailed(w, "create note", err)
		return
	}
	id, err := res.LastInsertId()
	if err != nil {
		storeFailed(w, "create note", err)
		return
	}
	note.ID = int(id)

	// realtime fan-out: sse subscribers refresh, the ws topic gets a typed event
	events.Publish("note-created", note)
	go borgo.Push("live", "note-created", note.Title)
	// pages/news.tsx caches its html under this tag; a write is the moment
	// that copy stops being true
	go func() {
		// the go keyword must not swallow the one signal that the shared
		// copy is now stale: a failed invalidation logged is a retry away,
		// swallowed it is staleness that survives restarts
		if err := borgo.RevalidateTag("notes"); err != nil {
			log.Printf("revalidate notes: %v", err)
		}
	}()
	borgo.JSON(w, http.StatusCreated, NoteItem{Note: note})
}

//borgo:route DELETE /api/notes/{id}
func DeleteNote(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	if _, err := db.DB.ExecContext(r.Context(), `DELETE FROM notes WHERE id = ?`, id); err != nil {
		storeFailed(w, "delete note", err)
		return
	}
	events.Publish("note-deleted", id)
	go func() {
		// the go keyword must not swallow the one signal that the shared
		// copy is now stale: a failed invalidation logged is a retry away,
		// swallowed it is staleness that survives restarts
		if err := borgo.RevalidateTag("notes"); err != nil {
			log.Printf("revalidate notes: %v", err)
		}
	}()
	borgo.WriteJSON(w, http.StatusOK, Deleted{Deleted: true})
}

// a database error is the server's: logged with what was being done, and
// answered in plain text so the generated response types stay the 2xx ones
func storeFailed(w http.ResponseWriter, doing string, err error) {
	log.Printf("%s: %v", doing, err)
	http.Error(w, "the store is unavailable", http.StatusInternalServerError)
}
