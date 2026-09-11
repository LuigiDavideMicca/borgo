// The floor for the 0.23 topology decision: what borgo's /api, static and SSE
// scenarios cost with the Go binary answering the public port itself. No
// framework, no dependencies - net/http and encoding/json, which is exactly
// what borgo's runtime is built on.
package main

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"
)

type Item struct {
	ID        int    `json:"id"`
	Title     string `json:"title"`
	Done      bool   `json:"done"`
	Tag       string `json:"tag"`
	CreatedAt string `json:"createdAt"`
}

type ItemList struct {
	Items []Item `json:"items"`
	Count int    `json:"count"`
}

var tags = [4]string{"alpha", "beta", "gamma", "delta"}

const createdAt = "2026-01-01T00:00:00Z"

// per request, as CONTRACT.md demands: a cached slice would benchmark the cache
func buildItems(n int) []Item {
	out := make([]Item, n)
	for i := range out {
		id := i + 1
		out[i] = Item{
			ID:        id,
			Title:     "Item " + strconv.Itoa(id),
			Done:      id%3 == 0,
			Tag:       tags[id%4],
			CreatedAt: createdAt,
		}
	}
	return out
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("encode: %v", err)
	}
}

func hello(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, map[string]string{"message": "hello, world"})
}

func items(w http.ResponseWriter, r *http.Request) {
	n := 100
	if raw := r.URL.Query().Get("n"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			n = parsed
		}
	}
	n = min(max(n, 1), 1000)
	list := buildItems(n)
	writeJSON(w, ItemList{Items: list, Count: len(list)})
}

// from disk on every request - a stat and a sendfile - because that is what a
// naive Go front would do for public/, and the number should say what that
// costs. GO_RAW_STATIC=memory serves the bytes read once at boot instead,
// which is what a front that knows its build inventory would do, and what
// some router apps here do; the contract allows both, and the spike needs
// both numbers.
var staticFromMemory []byte
var staticModTime time.Time

func static(w http.ResponseWriter, r *http.Request) {
	if staticFromMemory != nil {
		w.Header().Set("Content-Type", "application/json")
		http.ServeContent(w, r, "payload.json", staticModTime, bytes.NewReader(staticFromMemory))
		return
	}
	http.ServeFile(w, r, "public/static/payload.json")
}

// GO_RAW_SSE=hijack: the stream without net/http's per-connection machinery.
// The server's bufio pair and the request structs are dropped after the
// handshake; what stays alive is one small goroutine and the socket. This is
// the shape an SSE hub inside borgo's Go front would take, and the number
// says what that costs against the plain handler below.
var sseHijack bool

func eventsHijacked(w http.ResponseWriter, r *http.Request) {
	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijack unsupported", http.StatusInternalServerError)
		return
	}
	conn, _, err := hj.Hijack()
	if err != nil {
		return
	}
	go func() {
		defer conn.Close()
		if _, err := conn.Write([]byte("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n: ping\n\n")); err != nil {
			return
		}
		// a read that returns is the client hanging up; nothing else arrives
		var one [1]byte
		for {
			if _, err := conn.Read(one[:]); err != nil {
				return
			}
		}
	}()
}

func events(w http.ResponseWriter, r *http.Request) {
	if sseHijack {
		eventsHijacked(w, r)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	// the contract's immediate first flush
	if _, err := w.Write([]byte(": ping\n\n")); err != nil {
		return
	}
	flusher.Flush()
	<-r.Context().Done()
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "43030"
	}
	if os.Getenv("GO_RAW_STATIC") == "memory" {
		data, err := os.ReadFile("public/static/payload.json")
		if err != nil {
			log.Fatal(err)
		}
		staticFromMemory = data
		staticModTime = time.Now()
		log.Print("static: serving payload.json from memory")
	}
	if os.Getenv("GO_RAW_SSE") == "hijack" {
		sseHijack = true
		log.Print("sse: hijacked connections")
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/hello", hello)
	mux.HandleFunc("GET /api/items", items)
	mux.HandleFunc("GET /static/payload.json", static)
	mux.HandleFunc("GET /api/events", events)
	mux.HandleFunc("GET /", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte("go-raw bench app"))
	})

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("go-raw listening on :%s", port)
	if err := srv.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}
