package borgo

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// devChannel is borgo dev's fast-refresh channel, served by the front in dev
// as server-sent events on /__borgo/dev. The browser only receives. What it
// receives is posted to the internal listener, key in hand: by the
// orchestrator (a reload once the rebuilt api answers, a css swap once the
// render service compiled) and by the render service at its boot (js: the
// files that changed and the page -> chunk map, for the hot apply).
//
// The last reload and the last js are replayed to a browser that connects
// later. A .go save restarts this process and every stream with it, and the
// reload for it is posted when the new api answers - a browser still
// reconnecting is told on arrival. Each carries a stamp, so a page loaded
// after the change ignores what it already has.
type devChannel struct {
	mu   sync.Mutex
	subs map[chan []byte]struct{}
	// replayed on connect: nil until posted
	reload []byte
	js     []byte
}

// what a js poke carries; the field names are the render service's
type devJS struct {
	Files  []string          `json:"files"`
	Chunks map[string]string `json:"chunks"`
	Stamp  int64             `json:"stamp"`
}

const (
	// a browser told to wait this long between reconnections: an editor
	// save is 100ms of debounce away from the next one
	devRetryMillis = 300
	// a js poke names a build's files and chunks, not its contents
	devPokeMaxBody = 1 << 20
)

func newDevChannel() *devChannel {
	return &devChannel{subs: map[chan []byte]struct{}{}}
}

// one frame the three browser clients parse alike: the message event, its
// data one JSON object with a type. The name is left off on purpose, so
// EventSource delivers it to onmessage as the websocket did
func devFrame(msg any) []byte {
	payload, _ := json.Marshal(msg)
	frame := make([]byte, 0, len(payload)+10)
	frame = append(frame, "data: "...)
	frame = append(frame, payload...)
	return append(frame, '\n', '\n')
}

// publish hands the frame to every stream open now; a stream too slow to
// take it skips it, as SSEHub's do. The reload and the js are kept for the
// streams that open next
func (d *devChannel) publish(kind string, frame []byte) {
	d.mu.Lock()
	defer d.mu.Unlock()
	switch kind {
	case "reload":
		d.reload = frame
	case "js":
		d.js = frame
	}
	for ch := range d.subs {
		select {
		case ch <- frame:
		default:
		}
	}
}

// ServeHTTP is the browser's side: the stream, opened with the retry the
// browser is to use and whatever it missed
func (d *devChannel) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	stream, err := SSE(w, r)
	if err != nil {
		return
	}
	defer stream.Close()
	ch := make(chan []byte, 8)
	d.mu.Lock()
	d.subs[ch] = struct{}{}
	js, reload := d.js, d.reload
	d.mu.Unlock()
	defer func() {
		d.mu.Lock()
		defer d.mu.Unlock()
		delete(d.subs, ch)
	}()
	if stream.write([]byte("retry: "+strconv.Itoa(devRetryMillis)+"\n\n")) != nil {
		return
	}
	for _, frame := range [][]byte{js, reload} {
		if frame != nil && stream.write(frame) != nil {
			return
		}
	}
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-stream.Done():
			return
		case <-ping.C:
			if stream.Ping() != nil {
				return
			}
		case frame := <-ch:
			if stream.write(frame) != nil {
				return
			}
		}
	}
}

// pokes is the internal listener's side, behind the key: what the
// orchestrator and the render service post, answered 204 and broadcast
func (d *devChannel) pokes() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		kind := strings.TrimPrefix(r.URL.Path, devChannelPath+"/")
		switch kind {
		case "reload", "css", "js":
		default:
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var frame []byte
		switch kind {
		case "reload":
			frame = devFrame(map[string]any{"type": "reload", "stamp": time.Now().UnixMilli()})
		case "css":
			frame = devFrame(map[string]any{"type": "css"})
		case "js":
			body, err := io.ReadAll(io.LimitReader(r.Body, devPokeMaxBody+1))
			if err != nil || len(body) > devPokeMaxBody {
				http.Error(w, "js poke: body unreadable or over 1 MiB", http.StatusBadRequest)
				return
			}
			var poke devJS
			if err := json.Unmarshal(body, &poke); err != nil || poke.Stamp <= 0 {
				http.Error(w, "js poke: want a JSON object with files, chunks and a positive stamp", http.StatusBadRequest)
				return
			}
			// a null where the browser indexes: an empty set, never a null
			if poke.Files == nil {
				poke.Files = []string{}
			}
			if poke.Chunks == nil {
				poke.Chunks = map[string]string{}
			}
			frame = devFrame(map[string]any{"type": "js", "files": poke.Files, "chunks": poke.Chunks, "stamp": poke.Stamp})
		}
		d.publish(kind, frame)
		w.WriteHeader(http.StatusNoContent)
	})
}

// withDevPokes puts the pokes in front of the internal listener's api in
// dev; with no channel (production) the names fall through to the api,
// which has no route for them
func withDevPokes(pokes http.Handler, next http.Handler) http.Handler {
	if pokes == nil {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, devChannelPath+"/") {
			pokes.ServeHTTP(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}
