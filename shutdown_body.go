package borgo

import (
	"io"
	"mime"
	"strings"
	"sync"
)

// isEventStream answers whether a response is a server-sent-events stream:
// the one proxied response that is meant to never end on its own.
func isEventStream(contentType string) bool {
	media, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		media = strings.TrimSpace(strings.SplitN(contentType, ";", 2)[0])
	}
	return strings.EqualFold(media, "text/event-stream")
}

// endOnShutdown closes body when the server shuts down, so the copy loop
// reading it returns and the request is no longer active. A nil signal (no
// server in the request's context) leaves the body alone.
func endOnShutdown(body io.ReadCloser, signal <-chan struct{}) io.ReadCloser {
	if signal == nil || body == nil {
		return body
	}
	b := &shutdownBody{ReadCloser: body, closed: make(chan struct{})}
	go func() {
		select {
		case <-signal:
			b.Close()
		case <-b.closed:
		}
	}()
	return b
}

type shutdownBody struct {
	io.ReadCloser
	once   sync.Once
	closed chan struct{}
	err    error
}

// Close is idempotent: the watcher and the copy loop both call it.
func (b *shutdownBody) Close() error {
	b.once.Do(func() {
		close(b.closed)
		b.err = b.ReadCloser.Close()
	})
	return b.err
}
