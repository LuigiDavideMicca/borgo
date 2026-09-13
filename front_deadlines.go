package borgo

import (
	"io"
	"net/http"
	"time"
)

// progressDeadlines turns the server's read and write deadlines from bounds on
// the whole exchange into bounds on progress.
//
// net/http arms ReadTimeout and WriteTimeout once, when the request starts,
// and they cut whatever is still happening when they pass. The public port
// sets both to a minute by default, so a render still streaming after a
// minute, an upload still arriving, a large file going to a slow link - all
// healthy - were cut mid-body, while the docs promised a streaming render was
// exempt (found reproducing it: 2 of 4 chunks, then EOF).
//
// Here the deadline moves forward by the server's own timeout before every
// read of the body and every write of the response. A peer that stops sending
// or stops reading is cut as before; one that is making progress never is.
// The values come from the server serving the request, so an operator's 0
// stays 0 and nothing is plumbed.
//
// An event stream owns its deadlines: its first write clears the one net/http
// armed and nothing here touches them again. borgo.SSE bounds each of its own
// writes at 10 seconds, which a wider deadline set from out here would undo; a
// stream the front carries from the render service has quiet stretches no
// write deadline should measure.
func progressDeadlines(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		srv, _ := r.Context().Value(http.ServerContextKey).(*http.Server)
		if srv == nil || (srv.ReadTimeout <= 0 && srv.WriteTimeout <= 0) {
			next.ServeHTTP(w, r)
			return
		}
		rc := http.NewResponseController(w)
		if srv.ReadTimeout > 0 && r.Body != nil && r.Body != http.NoBody {
			r.Body = &progressBody{ReadCloser: r.Body, rc: rc, timeout: srv.ReadTimeout}
		}
		if srv.WriteTimeout > 0 {
			w = &progressWriter{ResponseWriter: w, rc: rc, timeout: srv.WriteTimeout}
		}
		next.ServeHTTP(w, r)
	})
}

type progressBody struct {
	io.ReadCloser
	rc      *http.ResponseController
	timeout time.Duration
}

// a Read returns when bytes arrived or the deadline passed, so moving the
// deadline before each one bounds the silence, not the length
func (b *progressBody) Read(p []byte) (int, error) {
	b.rc.SetReadDeadline(time.Now().Add(b.timeout))
	return b.ReadCloser.Read(p)
}

type progressWriter struct {
	http.ResponseWriter
	rc      *http.ResponseController
	timeout time.Duration
	// decided at the first commit: an event stream keeps its own deadlines
	decided, stream bool
}

func (p *progressWriter) progress() {
	if !p.decided {
		p.decided = true
		p.stream = isEventStream(p.Header().Get("Content-Type"))
		if p.stream {
			p.rc.SetWriteDeadline(time.Time{})
		}
	}
	if !p.stream {
		p.rc.SetWriteDeadline(time.Now().Add(p.timeout))
	}
}

func (p *progressWriter) WriteHeader(code int) {
	// a 1xx is not the response: the content type that decides is not set yet
	if code >= 200 {
		p.progress()
	}
	p.ResponseWriter.WriteHeader(code)
}

func (p *progressWriter) Write(b []byte) (int, error) {
	p.progress()
	return p.ResponseWriter.Write(b)
}

func (p *progressWriter) FlushError() error {
	p.progress()
	return http.NewResponseController(p.ResponseWriter).Flush()
}

func (p *progressWriter) Flush() { p.FlushError() }

// ResponseController reaches the connection through here: SetReadDeadline,
// Hijack for a websocket, EnableFullDuplex
func (p *progressWriter) Unwrap() http.ResponseWriter { return p.ResponseWriter }
