package borgo

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestAcceptsGzip(t *testing.T) {
	cases := []struct {
		header string
		want   bool
	}{
		{"", false},
		{"gzip", true},
		{"gzip, deflate, br", true},
		{"deflate, gzip;q=0.5", true},
		{"gzip;q=0", false},
		{"gzip;q=0.0", false},
		{"gzip; q=0.00", false},
		{"gzip;q=0.5", true},
		// coding names are case-insensitive
		{"GZIP", true},
		{"Gzip;q=0", false},
		{"*;q=0", false},
		// and so are parameter names (RFC 9110 5.6.6): a client that spells
		// its refusal "Q=0" refused, and compressing it ships bytes it just
		// said it cannot decode
		{"gzip;Q=0", false},
		{"gzip; Q=0.00", false},
		{"GZIP;Q=0", false},
		{"*;Q=0", false},
		{"gzip;Q=0, *", false},
		{"deflate, gzip;Q=0.5", true},
		{"*;Q=0, gzip", true},
		// a q that is not a number is not a quality the client offered: NaN
		// parses fine and survives every "<= 0" test, so it used to compress
		{"gzip;q=NaN", false},
		{"gzip;q=nan", false},
		{"*;q=NaN", false},
		{"gzip;q=", false},
		{"gzip;q=high", false},
		{"gzip;q=NaN, deflate", false},
		{"br", false},
		{"*", true},
		{"identity", false},
		// "*" covers only the codings the header did not name, so an explicit
		// gzip refusal wins wherever it sits in the list
		{"gzip;q=0, *", false},
		{"*, gzip;q=0", false},
		{"gzip;q=0, *;q=1", false},
		{"identity, *;q=0", false},
		// and an explicit acceptance beats a wildcard refusal
		{"*;q=0, gzip", true},
		{"gzip;q=0.001", true},
		// a refusal wins wherever it sits, however many times the coding or
		// the parameter is spelled out: reading only the first of either
		// compressed for a client that had already said no
		{"gzip, gzip;q=0", false},
		{"gzip;q=1, gzip;q=0", false},
		{"gzip;q=0, gzip", false},
		{"gzip;q=1;q=0", false},
		{"gzip;q=0;q=1", false},
		{"*, *;q=0", false},
		{"deflate, gzip, br, gzip;q=0", false},
		{"gzip;q=1, gzip;q=1", true},
		// a parameter that names q and gives no value offers no quality
		{"gzip;q", false},
		{"gzip;Q", false},
		{"gzip;q=1;q", false},
		{"*;q", false},
		// a qvalue is "0" or "1" with at most three decimals, nothing else.
		// strconv.ParseFloat also reads Go literals, so "1_0" became ten and
		// "1e0" one - numbers no HTTP client ever sent
		{"gzip;q=1_0", false},
		{"gzip;q=1e0", false},
		{"gzip;q=0x1", false},
		{"gzip;q=+1", false},
		{"gzip;q=.5", false},
		{"gzip;q=1.5", false},
		{"gzip;q=2", false},
		{"gzip;q=0.5000", false},
		{"gzip;q=Inf", false},
		{"gzip;q=1.000", true},
		{"gzip;q=1.0", true},
		{"gzip;q=0.100", true},
	}
	for _, c := range cases {
		if got := acceptsGzip(c.header); got != c.want {
			t.Errorf("acceptsGzip(%q) = %v, want %v", c.header, got, c.want)
		}
	}
}

func serveGzip(t *testing.T, acceptEncoding string, h http.HandlerFunc) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("GET", "/api/test", nil)
	if acceptEncoding != "" {
		req.Header.Set("Accept-Encoding", acceptEncoding)
	}
	rec := httptest.NewRecorder()
	gzipMiddleware(h).ServeHTTP(rec, req)
	return rec
}

func TestGzipMiddlewareCompressesLargeJSON(t *testing.T) {
	items := make([]string, 200)
	for i := range items {
		items[i] = "a task title that repeats"
	}
	rec := serveGzip(t, "gzip", func(w http.ResponseWriter, r *http.Request) {
		WriteJSON(w, http.StatusOK, items)
	})

	if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	if got := rec.Header().Get("Vary"); got != "Accept-Encoding" {
		t.Errorf("Vary = %q, want Accept-Encoding", got)
	}
	zr, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "a task title that repeats") {
		t.Error("decompressed body lost the payload")
	}
	if rec.Body.Len() >= len(body) {
		t.Errorf("wire size %d not smaller than payload %d", rec.Body.Len(), len(body))
	}
}

func TestGzipMiddlewareLeavesSmallResponsesIdentity(t *testing.T) {
	rec := serveGzip(t, "gzip", func(w http.ResponseWriter, r *http.Request) {
		WriteJSON(w, http.StatusCreated, map[string]string{"ok": "yes"})
	})
	if got := rec.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("Content-Encoding = %q, want none", got)
	}
	if rec.Code != http.StatusCreated {
		t.Errorf("status = %d, want 201", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"ok":"yes"`) {
		t.Errorf("body = %q", rec.Body.String())
	}
}

func TestGzipMiddlewareRespectsClient(t *testing.T) {
	big := strings.Repeat("data ", 1000)
	for _, header := range []string{"", "gzip;q=0", "br", "gzip;q=0, *", "*, gzip;q=0",
		"gzip, gzip;q=0", "gzip;q=1;q=0", "gzip;q", "gzip;q=1_0", "gzip;q=1.5"} {
		rec := serveGzip(t, header, func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte(big))
		})
		if got := rec.Header().Get("Content-Encoding"); got != "" {
			t.Errorf("Accept-Encoding %q: Content-Encoding = %q, want none", header, got)
		}
		if rec.Body.String() != big {
			t.Errorf("Accept-Encoding %q: body mangled", header)
		}
		// identity responses vary by Accept-Encoding too: without this a
		// shared cache would serve the uncompressed body to everyone
		if got := rec.Header().Get("Vary"); got != "Accept-Encoding" {
			t.Errorf("Accept-Encoding %q: Vary = %q, want Accept-Encoding", header, got)
		}
	}
}

// Accept-Encoding can arrive as several field lines, which RFC 9110 5.3 makes
// equivalent to the one list they join into. Reading only the first line
// (Header.Get) shipped gzip to a client whose second line refused it.
func TestGzipReadsEveryAcceptEncodingLine(t *testing.T) {
	big := strings.Repeat("data ", 1000)
	cases := []struct {
		name  string
		lines []string
		want  string
	}{
		{"refusal on the second line", []string{"gzip", "gzip;q=0"}, ""},
		{"refusal on the first line", []string{"gzip;q=0", "gzip"}, ""},
		{"acceptance on the second line", []string{"deflate", "gzip"}, "gzip"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
			for _, line := range c.lines {
				req.Header.Add("Accept-Encoding", line)
			}
			rec := httptest.NewRecorder()
			gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Write([]byte(big))
			})).ServeHTTP(rec, req)

			if got := rec.Header().Get("Content-Encoding"); got != c.want {
				t.Fatalf("lines %q: Content-Encoding = %q, want %q", c.lines, got, c.want)
			}
			if got := decodedBody(t, rec); got != big {
				t.Errorf("lines %q: body mangled (%d bytes)", c.lines, len(got))
			}
		})
	}
}

func TestGzipMiddlewarePassesThroughSSE(t *testing.T) {
	rec := serveGzip(t, "gzip", func(w http.ResponseWriter, r *http.Request) {
		stream, err := SSE(w, r)
		if err != nil {
			t.Fatal(err)
		}
		if err := stream.Send("tick", map[string]int{"n": 1}); err != nil {
			t.Fatal(err)
		}
	})
	if got := rec.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("Content-Encoding = %q, want none on an event stream", got)
	}
	if !rec.Flushed {
		t.Error("flush did not reach the client")
	}
	if !strings.Contains(rec.Body.String(), "event: tick") {
		t.Errorf("body = %q", rec.Body.String())
	}
}

const contentType = "Content-Type"

// A response declares itself an event stream in a header map that holds a list,
// and Header.Get reads only the first entry of it: a handler that added
// text/plain before text/event-stream walked through the gate, and borgo put
// Content-Encoding: gzip over a 3 KB stream. net/http decides on Content-Type
// by presence of the key and never by the value of one line, and it puts every
// line the map holds on the wire - so nothing that *declares* itself a stream
// may be compressed or buffered, however the handler wrote that header.
//
// Direction of failure: a header declared more than once is read whole, because
// reading only one of its values chooses by order.
func TestGzipReadsEveryContentTypeValue(t *testing.T) {
	// past the buffer on its own, so a response that is not held back as a
	// stream is compressed and the table fails in both directions
	body := strings.Repeat("data: tick\n\n", 300)

	cases := []struct {
		name   string
		set    func(http.Header)
		stream bool
	}{
		{"one text/event-stream", func(h http.Header) {
			h.Set(contentType, "text/event-stream")
		}, true},
		{"Set then Set, stream last", func(h http.Header) {
			h.Set(contentType, "text/plain")
			h.Set(contentType, "text/event-stream")
		}, true},
		// Set replaces: this response really has stopped being a stream
		{"Set then Set, stream first", func(h http.Header) {
			h.Set(contentType, "text/event-stream")
			h.Set(contentType, "text/plain")
		}, false},
		// the measured one
		{"Add then Add, stream last", func(h http.Header) {
			h.Add(contentType, "text/plain")
			h.Add(contentType, "text/event-stream")
		}, true},
		{"Add then Add, stream first", func(h http.Header) {
			h.Add(contentType, "text/event-stream")
			h.Add(contentType, "text/plain")
		}, true},
		{"three values, the stream in the middle", func(h http.Header) {
			h.Add(contentType, "text/plain")
			h.Add(contentType, "text/event-stream")
			h.Add(contentType, "application/json")
		}, true},
		{"parameters on the value", func(h http.Header) {
			h.Set(contentType, "text/event-stream; charset=utf-8")
		}, true},
		// media types are case-insensitive (RFC 9110 8.3.1)
		{"mixed case", func(h http.Header) {
			h.Set(contentType, "Text/Event-Stream")
		}, true},
		{"spaces around the values", func(h http.Header) {
			h.Add(contentType, "  text/plain  ")
			h.Add(contentType, "  text/event-stream  ")
		}, true},
		// what an intermediary makes of two Content-Type lines
		{"one line, two values, comma joined", func(h http.Header) {
			h.Set(contentType, "text/plain, text/event-stream")
		}, true},
		{"no Content-Type at all", func(h http.Header) {}, false},
		{"a type that is not a stream", func(h http.Header) {
			h.Set(contentType, "text/plain")
		}, false},
	}

	for _, c := range cases {
		for _, ae := range []string{"gzip", "identity"} {
			t.Run(c.name+"/"+ae, func(t *testing.T) {
				rec := serveGzip(t, ae, func(w http.ResponseWriter, r *http.Request) {
					c.set(w.Header())
					w.WriteHeader(http.StatusOK)
					io.WriteString(w, body)
				})

				want := ""
				if !c.stream && ae == "gzip" {
					want = "gzip"
				}
				if got := rec.Header().Get("Content-Encoding"); got != want {
					t.Fatalf("Content-Type %q: Content-Encoding = %q, want %q",
						rec.Header().Values(contentType), got, want)
				}
				if got := decodedBody(t, rec); got != body {
					t.Errorf("body mangled: %d bytes, want %d", len(got), len(body))
				}
			})
		}
	}
}

// The recorder holds a header map; a socket holds the answer to the question a
// stream is asked. A compressed stream still arrives - at the end, in one piece
// - so the proof is that the first chunk reaches the client while the handler
// is still holding the second, in the plaintext the browser has to read it in.
func TestEventStreamReachesTheSocketAsItIsWritten(t *testing.T) {
	// past gzipMinBytes on its own: under the defect this first chunk is what
	// commits the response to gzip, and what the client then cannot read
	first := "event: first\n" + strings.Repeat("data: xxxxxxxx\n", 200) + "\n"
	second := "event: second\ndata: y\n\n"

	cases := []struct {
		name string
		set  func(http.Header)
	}{
		{"one text/event-stream", func(h http.Header) {
			h.Set(contentType, "text/event-stream")
		}},
		{"Add then Add, stream last", func(h http.Header) {
			h.Add(contentType, "text/plain")
			h.Add(contentType, "text/event-stream")
		}},
		{"one line, two values, comma joined", func(h http.Header) {
			h.Set(contentType, "text/plain, text/event-stream")
		}},
		{"mixed case", func(h http.Header) {
			h.Set(contentType, "Text/Event-Stream")
		}},
	}

	for _, c := range cases {
		for _, ae := range []string{"gzip", "identity"} {
			t.Run(c.name+"/"+ae, func(t *testing.T) {
				held := make(chan struct{})
				var once sync.Once
				release := func() { once.Do(func() { close(held) }) }

				srv := httptest.NewServer(gzipMiddleware(http.HandlerFunc(
					func(w http.ResponseWriter, r *http.Request) {
						c.set(w.Header())
						w.WriteHeader(http.StatusOK)
						io.WriteString(w, first)
						w.(http.Flusher).Flush()
						select {
						case <-held:
						case <-time.After(10 * time.Second):
						}
						io.WriteString(w, second)
						w.(http.Flusher).Flush()
					})))
				defer srv.Close()
				defer release()

				// the transport would ask for gzip on its own and decode it
				// again, hiding which path ran
				client := &http.Client{Transport: &http.Transport{DisableCompression: true}}
				req, err := http.NewRequest(http.MethodGet, srv.URL, nil)
				if err != nil {
					t.Fatal(err)
				}
				req.Header.Set("Accept-Encoding", ae)
				res, err := client.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				defer res.Body.Close()

				if got := res.Header.Get("Content-Encoding"); got != "" {
					t.Fatalf("Content-Encoding = %q on a declared event stream", got)
				}

				chunks, stop := readAsItArrives(res.Body)
				defer close(stop)
				var seen strings.Builder
				awaitOnTheWire(t, chunks, &seen, "event: first")
				release()
				awaitOnTheWire(t, chunks, &seen, "event: second")
			})
		}
	}
}

// readAsItArrives hands over each read as it completes, so a test can wait for
// the bytes of one write without blocking on the write after it. Closing stop
// releases the reader wherever it is.
func readAsItArrives(r io.Reader) (<-chan []byte, chan struct{}) {
	chunks := make(chan []byte)
	stop := make(chan struct{})
	go func() {
		defer close(chunks)
		buf := make([]byte, 4096)
		for {
			n, err := r.Read(buf)
			if n > 0 {
				select {
				case chunks <- append([]byte(nil), buf[:n]...):
				case <-stop:
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()
	return chunks, stop
}

func awaitOnTheWire(t *testing.T, chunks <-chan []byte, seen *strings.Builder, marker string) {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for !strings.Contains(seen.String(), marker) {
		select {
		case b, ok := <-chunks:
			if !ok {
				t.Fatalf("stream ended before %q arrived; wire held %q", marker, seen.String())
			}
			seen.Write(b)
		case <-deadline:
			t.Fatalf("%q never reached the client; %d bytes on the wire", marker, seen.Len())
		}
	}
}

// The sniffing gate had the stream gate's shape. net/http decides whether to
// sniff on the presence of the Content-Type key (`_, haveType :=
// header["Content-Type"]`), so declaring the field empty is how a handler turns
// sniffing off; reading the first value alone overrode that, and replaced a
// real value standing behind an empty one - typing the same handler one way for
// the client that asked for gzip and another for the client that did not.
func TestGzipSniffsOnTheSameGateAsNetHTTP(t *testing.T) {
	body := strings.Repeat("plain body ", 300)

	cases := []struct {
		name                   string
		set                    func(http.Header)
		wantGzip, wantIdentity []string
	}{
		// borgo has to type this one itself: net/http would sniff the gzip bytes
		{"no Content-Type", func(h http.Header) {},
			[]string{"text/plain; charset=utf-8"}, nil},
		{"sniffing suppressed the net/http way", func(h http.Header) { h[contentType] = nil },
			nil, nil},
		{"an empty value in front of a real one", func(h http.Header) {
			h.Add(contentType, "")
			h.Add(contentType, "text/plain")
		}, []string{"", "text/plain"}, []string{"", "text/plain"}},
	}

	for _, c := range cases {
		for _, ae := range []string{"gzip", "identity"} {
			t.Run(c.name+"/"+ae, func(t *testing.T) {
				rec := serveGzip(t, ae, func(w http.ResponseWriter, r *http.Request) {
					c.set(w.Header())
					w.WriteHeader(http.StatusOK)
					io.WriteString(w, body)
				})
				want := c.wantIdentity
				if ae == "gzip" {
					want = c.wantGzip
				}
				if got := rec.Header().Values(contentType); !slices.Equal(got, want) {
					t.Errorf("Content-Type = %q, want %q", got, want)
				}
				if got := decodedBody(t, rec); got != body {
					t.Errorf("body mangled: %d bytes, want %d", len(got), len(body))
				}
			})
		}
	}
}

func TestGzipMiddlewarePassesThroughPreEncoded(t *testing.T) {
	rec := serveGzip(t, "gzip", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Encoding", "br")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(strings.Repeat("pretend brotli ", 200)))
	})
	if got := rec.Header().Get("Content-Encoding"); got != "br" {
		t.Fatalf("Content-Encoding = %q, want br untouched", got)
	}
}

// A compressed response without Vary: Accept-Encoding is one a shared cache
// stores and then hands to a client that cannot decode it. The header is set
// before the handler runs, so a handler that sets its own Vary - or deletes it
// - used to take ours with it; it is re-asserted at the commit, and added
// rather than substituted so the handler's reasons for varying survive.
func TestGzipVarySurvivesTheHandler(t *testing.T) {
	big := strings.Repeat("data ", 1000)
	cases := []struct {
		name       string
		mutate     func(http.Header)
		wantFields []string
	}{
		{"handler sets its own Vary", func(h http.Header) { h.Set("Vary", "Cookie") }, []string{"Cookie", "Accept-Encoding"}},
		{"handler deletes Vary", func(h http.Header) { h.Del("Vary") }, []string{"Accept-Encoding"}},
		{"handler adds to Vary", func(h http.Header) { h.Add("Vary", "Cookie") }, []string{"Accept-Encoding", "Cookie"}},
		{"handler says Vary: *", func(h http.Header) { h.Set("Vary", "*") }, []string{"*"}},
		{"handler restates ours", func(h http.Header) { h.Set("Vary", "accept-encoding") }, []string{"accept-encoding"}},
	}
	for _, c := range cases {
		for _, ae := range []string{"gzip", "identity"} {
			t.Run(c.name+"/"+ae, func(t *testing.T) {
				rec := serveGzip(t, ae, func(w http.ResponseWriter, r *http.Request) {
					c.mutate(w.Header())
					w.Write([]byte(big))
				})
				var got []string
				for _, line := range rec.Header().Values("Vary") {
					for _, f := range strings.Split(line, ",") {
						got = append(got, strings.TrimSpace(f))
					}
				}
				if !slices.Equal(got, c.wantFields) {
					t.Errorf("Vary = %q, want %q", got, c.wantFields)
				}
			})
		}
	}
}

// net/http snapshots headers at WriteHeader and ignores later mutations; the
// response buffer must not quietly honour them, or the same handler would
// behave differently the day its response outgrows the buffer
func TestGzipHeadersFreezeAtWriteHeader(t *testing.T) {
	t.Run("buffered identity", func(t *testing.T) {
		rec := serveGzip(t, "gzip", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-Early", "kept")
			w.WriteHeader(http.StatusOK)
			w.Header().Set("X-Late", "dropped")
			w.Write([]byte("small"))
		})
		if got := rec.Header().Get("X-Early"); got != "kept" {
			t.Errorf("X-Early = %q, want kept", got)
		}
		if got := rec.Header().Get("X-Late"); got != "" {
			t.Errorf("X-Late = %q, headers after WriteHeader must not ship", got)
		}
	})
	t.Run("compressed", func(t *testing.T) {
		rec := serveGzip(t, "gzip", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-Early", "kept")
			w.WriteHeader(http.StatusOK)
			w.Header().Set("X-Late", "dropped")
			w.Write([]byte(strings.Repeat("x", 2*gzipMinBytes)))
		})
		if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
			t.Fatalf("Content-Encoding = %q, want gzip", got)
		}
		if rec.Header().Get("X-Early") != "kept" || rec.Header().Get("X-Late") != "" {
			t.Errorf("headers wrong: early=%q late=%q", rec.Header().Get("X-Early"), rec.Header().Get("X-Late"))
		}
	})
}

// Trailers are the one thing the snapshot must not freeze: they are read out of
// the header map after the handler returns, so at WriteHeader - where the
// snapshot is taken - none of them has a value yet. Restoring that snapshot at
// the commit cleared every trailer of a response short enough to commit in
// finish, while the same handler with a longer body committed mid-Write and
// kept them: the same handler answering differently once its body outgrows the
// buffer, which is the defect the snapshot exists to prevent.
//
// The recorder is the subject here rather than a socket because net/http will
// not send trailers on a response it gave a Content-Length - true with or
// without borgo, and not something this middleware decides.
func TestGzipTrailersDoNotDependOnResponseSize(t *testing.T) {
	const name, value = "X-Checksum", "abc"

	modes := []struct {
		name     string
		announce bool
		key      string
	}{
		{"announced", true, name},
		// TrailerPrefix needs no announcement: net/http and the recorder both
		// read it straight out of the map at the end of the response
		{"unannounced", false, http.TrailerPrefix + name},
	}
	sizes := []struct {
		name string
		n    int
	}{
		{"under the buffer", 5},
		{"exactly the buffer", gzipMinBytes},
		{"past the buffer", 4 * gzipMinBytes},
	}
	cases := []struct {
		name string
		want string
		// an announced trailer set before the snapshot is in the header block as
		// well, which is what net/http does with it too
		inBlock bool
		serve   func(w http.ResponseWriter, body []byte, set func())
	}{
		{"no trailer", "", false, func(w http.ResponseWriter, body []byte, set func()) {
			w.WriteHeader(http.StatusOK)
			w.Write(body)
		}},
		{"set before WriteHeader", value, true, func(w http.ResponseWriter, body []byte, set func()) {
			set()
			w.WriteHeader(http.StatusOK)
			w.Write(body)
		}},
		{"set after WriteHeader", value, false, func(w http.ResponseWriter, body []byte, set func()) {
			w.WriteHeader(http.StatusOK)
			set()
			w.Write(body)
		}},
		{"set after the first write", value, false, func(w http.ResponseWriter, body []byte, set func()) {
			w.WriteHeader(http.StatusOK)
			w.Write(body[:len(body)/2])
			set()
			w.Write(body[len(body)/2:])
		}},
		{"set after a flush", value, false, func(w http.ResponseWriter, body []byte, set func()) {
			w.WriteHeader(http.StatusOK)
			w.Write(body[:len(body)/2])
			w.(http.Flusher).Flush()
			set()
			w.Write(body[len(body)/2:])
		}},
		{"set after the whole body", value, false, func(w http.ResponseWriter, body []byte, set func()) {
			w.WriteHeader(http.StatusOK)
			w.Write(body)
			set()
		}},
	}

	for _, mode := range modes {
		for _, size := range sizes {
			for _, c := range cases {
				t.Run(mode.name+"/"+size.name+"/"+c.name, func(t *testing.T) {
					body := bytes.Repeat([]byte("t"), size.n)
					h := func(w http.ResponseWriter, r *http.Request) {
						if mode.announce {
							w.Header().Set("Trailer", name)
						}
						c.serve(w, body, func() { w.Header().Set(mode.key, value) })
					}
					identity := serveGzip(t, "identity", h).Result()
					compressed := serveGzip(t, "gzip", h).Result()

					got, zipped := identity.Trailer.Get(name), compressed.Trailer.Get(name)
					if got != zipped {
						t.Errorf("the trailer depends on Accept-Encoding: identity %q, gzip %q", got, zipped)
					}
					if got != c.want {
						t.Errorf("trailer = %q, want %q: a body of %d bytes decided it", got, c.want, size.n)
					}

					// and it must not arrive as a header instead, which would be
					// the same handler sending a different response again
					wantBlock := ""
					if c.inBlock && mode.announce {
						wantBlock = value
					}
					block, zippedBlock := identity.Header.Get(name), compressed.Header.Get(name)
					if block != zippedBlock {
						t.Errorf("the header block depends on Accept-Encoding: identity %q, gzip %q", block, zippedBlock)
					}
					if block != wantBlock {
						t.Errorf("header %s = %q, want %q", name, block, wantBlock)
					}
				})
			}
		}
	}
}

// The recorder models the header map; a socket is where a trailer either
// arrives or does not. Both rows are chunked - one because it was flushed, one
// because it outgrew net/http's own buffer - since a response net/http can give
// a Content-Length to carries no trailers at all, with or without borgo.
func TestGzipTrailersReachARealClient(t *testing.T) {
	const name, value = "X-Checksum", "abc"

	cases := []struct {
		name string
		h    http.HandlerFunc
	}{
		{"short body, trailer set before the flush", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Trailer", name)
			w.WriteHeader(http.StatusOK)
			w.Header().Set(name, value)
			w.Write([]byte("small"))
			w.(http.Flusher).Flush()
		}},
		{"body past the buffer, trailer set at the end", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Trailer", name)
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(strings.Repeat("x", 4*gzipMinBytes)))
			w.Header().Set(name, value)
		}},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv := httptest.NewServer(recoverMiddleware(gzipMiddleware(c.h)))
			defer srv.Close()
			// the transport would otherwise ask for gzip on its own and decode
			// it again, hiding which path ran
			client := &http.Client{Transport: &http.Transport{DisableCompression: true}}

			for _, ae := range []string{"identity", "gzip"} {
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL, nil)
				if err != nil {
					cancel()
					t.Fatal(err)
				}
				req.Header.Set("Accept-Encoding", ae)
				res, err := client.Do(req)
				if err != nil {
					cancel()
					t.Fatalf("Accept-Encoding %s: %v", ae, err)
				}
				// trailers exist only once the body is read to the end
				if _, err := io.Copy(io.Discard, res.Body); err != nil {
					res.Body.Close()
					cancel()
					t.Fatalf("Accept-Encoding %s: body cut short (%v)", ae, err)
				}
				res.Body.Close()
				cancel()

				if got := res.Trailer.Get(name); got != value {
					t.Errorf("Accept-Encoding %s: trailer %s = %q, want %q", ae, name, got, value)
				}
				if got := res.Header.Get(name); got != "" {
					t.Errorf("Accept-Encoding %s: %s arrived as a header (%q), not as a trailer", ae, name, got)
				}
			}
		})
	}
}

// pooled gzip writers must never leak one response's bytes into another
func TestGzipConcurrentResponsesStayIsolated(t *testing.T) {
	handler := gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		WriteJSON(w, http.StatusOK, map[string]string{"who": strings.Repeat(r.URL.Path, 200)})
	}))
	var wg sync.WaitGroup
	for i := range 32 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			want := strings.Repeat(fmt.Sprintf("/client-%d", i), 200)
			for range 8 {
				req := httptest.NewRequest("GET", fmt.Sprintf("/client-%d", i), nil)
				req.Header.Set("Accept-Encoding", "gzip")
				rec := httptest.NewRecorder()
				handler.ServeHTTP(rec, req)

				zr, err := gzip.NewReader(rec.Body)
				if err != nil {
					t.Errorf("client %d: %v", i, err)
					return
				}
				body, err := io.ReadAll(zr)
				if err != nil {
					t.Errorf("client %d: %v", i, err)
					return
				}
				var got map[string]string
				if json.Unmarshal(body, &got) != nil || got["who"] != want {
					t.Errorf("client %d got a body that is not its own", i)
					return
				}
			}
		}()
	}
	wg.Wait()
}

type discardWriter struct{ header http.Header }

func (d *discardWriter) Header() http.Header         { return d.header }
func (d *discardWriter) Write(p []byte) (int, error) { return len(p), nil }
func (d *discardWriter) WriteHeader(int)             {}

func benchGzip(b *testing.B, acceptEncoding string, body func(http.ResponseWriter)) {
	b.Helper()
	h := gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { body(w) }))
	req := httptest.NewRequest(http.MethodGet, "/api/tasks", nil)
	if acceptEncoding != "" {
		req.Header.Set("Accept-Encoding", acceptEncoding)
	}
	b.ReportAllocs()
	for b.Loop() {
		h.ServeHTTP(&discardWriter{header: http.Header{}}, req)
	}
}

func BenchmarkGzipCompressed(b *testing.B) {
	items := make([]string, 200)
	for i := range items {
		items[i] = "a task title that repeats"
	}
	benchGzip(b, "gzip", func(w http.ResponseWriter) { WriteJSON(w, http.StatusOK, items) })
}

func BenchmarkGzipSmallIdentity(b *testing.B) {
	benchGzip(b, "gzip", func(w http.ResponseWriter) {
		WriteJSON(w, http.StatusOK, map[string]string{"ok": "yes"})
	})
}

// the price of one commit point: a client that cannot take gzip now goes
// through the writer too, so the cost it pays has to stay visible
func BenchmarkGzipClientRefusesEncoding(b *testing.B) {
	benchGzip(b, "", func(w http.ResponseWriter) {
		WriteJSON(w, http.StatusOK, map[string]string{"ok": "yes"})
	})
}

// The buffer exists to decide, not to hold the response: only the first
// gzipMinBytes may ever be copied, so the cost of a large body must stay flat
// as it grows. Appending each incoming slice before testing the threshold made
// a one-Write handler allocate a second copy of its whole body - 2 MB per
// request on a 1 MB response, on the identity path too, which before the one
// commit point never touched the buffer at all. Both encodings are measured
// because both pay it.
func benchGzipLargeBody(b *testing.B, acceptEncoding string) {
	for _, size := range []int{1 << 10, 64 << 10, 1 << 20} {
		body := bytes.Repeat([]byte("borgo benchmark payload "), size/24+1)[:size]
		b.Run(fmt.Sprintf("%dKB", size>>10), func(b *testing.B) {
			benchGzip(b, acceptEncoding, func(w http.ResponseWriter) { w.Write(body) })
		})
	}
}

func BenchmarkGzipLargeBodyCompressed(b *testing.B) { benchGzipLargeBody(b, "gzip") }

func BenchmarkGzipLargeBodyIdentity(b *testing.B) { benchGzipLargeBody(b, "identity") }

// the length check costs one add per Write, and every other benchmark here
// writes its whole body in one call, where one add per response is unmeasurable.
// A handler streaming a megabyte in kilobyte writes pays it a thousand times.
func benchGzipManyWrites(b *testing.B, acceptEncoding string) {
	chunk := bytes.Repeat([]byte("borgo benchmark payload "), 43)[:1<<10]
	benchGzip(b, acceptEncoding, func(w http.ResponseWriter) {
		for range 1 << 10 {
			w.Write(chunk)
		}
	})
}

func BenchmarkGzipManyWritesCompressed(b *testing.B) { benchGzipManyWrites(b, "gzip") }

func BenchmarkGzipManyWritesIdentity(b *testing.B) { benchGzipManyWrites(b, "identity") }

// CI runs tests, not benchmarks, so the flat cost above is asserted here too:
// the guard is the growth from 64 KB to 1 MB, which is ~0 when the body is
// streamed and ~1 MB when it is copied.
func TestGzipDoesNotCopyTheBodyPastTheDecision(t *testing.T) {
	for _, ae := range []string{"gzip", "identity"} {
		t.Run(ae, func(t *testing.T) {
			small := bytesPerResponse(t, ae, 64<<10)
			large := bytesPerResponse(t, ae, 1<<20)
			if grown := int64(large) - int64(small); grown > 128<<10 {
				t.Errorf("a 1 MB response allocates %d B more than a 64 KB one (%d vs %d): the body is copied, not streamed",
					grown, large, small)
			}
		})
	}
}

// bytesPerResponse reports what one response allocates: warmed first so a
// pooled gzip writer is not charged to the window, and taken as the best of
// three so a GC draining that pool mid-window cannot fail the run.
func bytesPerResponse(t *testing.T, acceptEncoding string, size int) uint64 {
	t.Helper()
	body := bytes.Repeat([]byte("borgo benchmark payload "), size/24+1)[:size]
	h := gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write(body) }))
	req := httptest.NewRequest(http.MethodGet, "/api/tasks", nil)
	req.Header.Set("Accept-Encoding", acceptEncoding)

	const iters = 50
	serve := func() {
		for range iters {
			h.ServeHTTP(&discardWriter{header: http.Header{}}, req)
		}
	}
	best := ^uint64(0)
	for range 3 {
		var before, after runtime.MemStats
		serve()
		runtime.ReadMemStats(&before)
		serve()
		runtime.ReadMemStats(&after)
		best = min(best, (after.TotalAlloc-before.TotalAlloc)/iters)
	}
	return best
}

// serveWithin runs the full chain and refuses to hang: a handler that never
// returns names itself instead of taking the suite down with it.
func serveWithin(t *testing.T, h http.Handler, req *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	rec := httptest.NewRecorder()
	done := make(chan any, 1)
	go func() {
		defer func() { done <- recover() }()
		h.ServeHTTP(rec, req.WithContext(ctx))
	}()
	select {
	case v := <-done:
		if v != nil {
			t.Fatalf("%s: a panic escaped the middleware chain: %v", req.Header.Get("Accept-Encoding"), v)
		}
	case <-ctx.Done():
		t.Fatalf("no response after 5s for Accept-Encoding %q: the handler never returned (%v)",
			req.Header.Get("Accept-Encoding"), ctx.Err())
	}
	return rec
}

// decodedBody returns what the client would end up holding, so a compressed
// and an identity answer to the same request are comparable.
func decodedBody(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	if rec.Header().Get("Content-Encoding") != "gzip" {
		return rec.Body.String()
	}
	zr, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatalf("Content-Encoding: gzip but the body is not a gzip stream: %v", err)
	}
	body, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("gzip stream truncated mid-flight: %v", err)
	}
	return string(body)
}

// The one that counts: a panicking handler must answer the same thing whether
// or not the client asked for compression. The split used to answer 500 to a
// gzip client and a truncated 200 to everyone else - the same bug, visible
// only to half the clients, which is why nobody found it.
func TestPanicResponseDoesNotDependOnAcceptEncoding(t *testing.T) {
	log.SetOutput(io.Discard)
	defer log.SetOutput(os.Stderr)

	buffered := `{"items":[1,2,3`
	committed := strings.Repeat("x", 2*gzipMinBytes)

	cases := []struct {
		name string
		h    http.HandlerFunc
	}{
		{"before any write", func(w http.ResponseWriter, r *http.Request) {
			panic("boom")
		}},
		{"after WriteHeader, before the first write", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
			panic("boom")
		}},
		{"after a write still inside the buffer", func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte(buffered))
			panic("boom")
		}},
		{"after a write past the buffer", func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte(committed))
			panic("boom")
		}},
		{"after a flush", func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte(buffered))
			w.(http.Flusher).Flush()
			panic("boom")
		}},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			chain := recoverMiddleware(gzipMiddleware(c.h))

			plain := httptest.NewRequest(http.MethodGet, "/api/x", nil)
			identity := serveWithin(t, chain, plain)

			zipped := httptest.NewRequest(http.MethodGet, "/api/x", nil)
			zipped.Header.Set("Accept-Encoding", "gzip")
			compressed := serveWithin(t, chain, zipped)

			t.Logf("identity: %d %q | gzip: %d (%s) %q",
				identity.Code, identity.Body.String(),
				compressed.Code, compressed.Header().Get("Content-Encoding"), compressed.Body.String())

			if identity.Code != compressed.Code {
				t.Errorf("status depends on Accept-Encoding: identity %d, gzip %d",
					identity.Code, compressed.Code)
			}
			if got, want := decodedBody(t, compressed), decodedBody(t, identity); got != want {
				t.Errorf("body depends on Accept-Encoding:\n identity %q\n gzip     %q", want, got)
			}
			if got, want := compressed.Header().Get("Vary"), identity.Header().Get("Vary"); got != want {
				t.Errorf("Vary depends on Accept-Encoding: identity %q, gzip %q", want, got)
			}
		})
	}
}

// a recorder has no connection to commit to, and the defect was about what a
// real client ends up holding: same handler, same panic, one socket each
func TestPanicInsideTheBufferIsA500OverARealConnection(t *testing.T) {
	log.SetOutput(io.Discard)
	defer log.SetOutput(os.Stderr)

	srv := httptest.NewServer(recoverMiddleware(gzipMiddleware(http.HandlerFunc(
		func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"items":[1,2,3`))
			panic("mid body")
		}))))
	defer srv.Close()

	// the transport adds Accept-Encoding: gzip on its own and strips the
	// encoding again before we see it; both would hide which path ran
	client := &http.Client{Transport: &http.Transport{DisableCompression: true}}
	for _, ae := range []string{"identity", "gzip"} {
		t.Run(ae, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL, nil)
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Accept-Encoding", ae)
			res, err := client.Do(req)
			if err != nil {
				t.Fatalf("Accept-Encoding %s: no response (%v)", ae, err)
			}
			defer res.Body.Close()
			if res.StatusCode != http.StatusInternalServerError {
				t.Fatalf("Accept-Encoding %s: status = %d, want 500", ae, res.StatusCode)
			}
			payload, err := io.ReadAll(res.Body)
			if err != nil {
				t.Fatalf("Accept-Encoding %s: body cut short (%v)", ae, err)
			}
			var body map[string]string
			if json.Unmarshal(payload, &body) != nil || body["error"] == "" {
				t.Fatalf("Accept-Encoding %s: body = %q, want a whole json error", ae, payload)
			}
		})
	}
}

// past the buffer nothing can be un-sent, so the answer is the handler's own
// status with a short body - never a 500 pretending the wire was still free
func TestPanicPastTheBufferTruncatesInsteadOfRestating(t *testing.T) {
	log.SetOutput(io.Discard)
	defer log.SetOutput(os.Stderr)

	for _, ae := range []string{"", "gzip"} {
		t.Run("Accept-Encoding "+ae, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/x", nil)
			if ae != "" {
				req.Header.Set("Accept-Encoding", ae)
			}
			rec := serveWithin(t, recoverMiddleware(gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusTeapot)
				w.Write([]byte(strings.Repeat("y", 2*gzipMinBytes)))
				panic("late")
			}))), req)

			if rec.Code != http.StatusTeapot {
				t.Fatalf("status = %d, want the committed 418", rec.Code)
			}
			if body := decodedBody(t, rec); len(body) != 2*gzipMinBytes {
				t.Errorf("body is %d bytes, want the %d that were committed", len(body), 2*gzipMinBytes)
			}
		})
	}
}

func TestGzipMiddlewareEmptyResponse(t *testing.T) {
	rec := serveGzip(t, "gzip", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Errorf("body = %q, want empty", rec.Body.String())
	}
}

// Content-Encoding describes bytes. Where none can exist it describes nothing,
// and on a 304 it is copied by any cache refreshing the entry it stands for
// (RFC 9110 15.4.5): the stored body, never compressed, then carries a header
// saying it is. A HEAD is the same claim about a body the client cannot see,
// and gzipping it would also drop the Content-Length the handler set for the
// GET that HEAD stands in for.
func TestGzipDeclaresNoEncodingWhereNoBodyCanBe(t *testing.T) {
	big := strings.Repeat("data ", 1000)
	cases := []struct {
		name   string
		method string
		status int
	}{
		{"204 with a large body written anyway", http.MethodGet, http.StatusNoContent},
		{"304 with a large body written anyway", http.MethodGet, http.StatusNotModified},
		{"HEAD with a large body", http.MethodHead, http.StatusOK},
		{"HEAD with a small body", http.MethodHead, http.StatusOK},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := httptest.NewRequest(c.method, "/api/test", nil)
			req.Header.Set("Accept-Encoding", "gzip")
			rec := httptest.NewRecorder()
			gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Length", strconv.Itoa(len(big)))
				w.WriteHeader(c.status)
				w.Write([]byte(big))
			})).ServeHTTP(rec, req)

			if got := rec.Header().Get("Content-Encoding"); got != "" {
				t.Errorf("Content-Encoding = %q, want none: there are no bytes for it to describe", got)
			}
			if rec.Code != c.status {
				t.Errorf("status = %d, want %d", rec.Code, c.status)
			}
			// a HEAD answers about the GET it stands in for, so the length it
			// declares has to survive
			if c.method == http.MethodHead {
				if got := rec.Header().Get("Content-Length"); got != strconv.Itoa(len(big)) {
					t.Errorf("Content-Length = %q, want %d", got, len(big))
				}
			}
		})
	}
}

// contentLengthLog serves one request and returns only what the middleware said
// about Content-Length, so the two encodings can be compared line for line.
func contentLengthLog(t *testing.T, method, acceptEncoding string, h http.HandlerFunc) string {
	t.Helper()
	var out bytes.Buffer
	flags := log.Flags()
	log.SetOutput(&out)
	log.SetFlags(0)
	defer func() {
		log.SetOutput(os.Stderr)
		log.SetFlags(flags)
	}()

	req := httptest.NewRequest(method, "/api/test", nil)
	if acceptEncoding != "" {
		req.Header.Set("Accept-Encoding", acceptEncoding)
	}
	recoverMiddleware(gzipMiddleware(h)).ServeHTTP(httptest.NewRecorder(), req)

	var said []string
	for _, line := range strings.Split(out.String(), "\n") {
		if strings.HasPrefix(line, "borgo: Content-Length") {
			said = append(said, line)
		}
	}
	return strings.Join(said, "\n")
}

// A handler whose body is not the size it declared is a bug the two encodings
// answer differently and neither answers well: identity ships the declared
// length and the client reads "unexpected EOF", gzip drops the length - it
// describes uncompressed bytes - and repairs the bug in silence. The developer
// whose browser sends Accept-Encoding: gzip never sees what the health check,
// the proxy and curl see, which is why such a handler survives. Neither path
// can be made to send a correct response, so both are made to say the same
// thing, and the line has to be identical or the asymmetry just moves.
//
// The other half of the table is the half that matters: this is new noise in
// everyone's log, and every response that is merely unusual - streamed,
// bodyless, interrupted, written in pieces - has to pass without a word.
func TestContentLengthMismatchIsLoggedWhateverTheEncoding(t *testing.T) {
	const size = 4000
	body := strings.Repeat("x", size)
	declare := func(w http.ResponseWriter, n int) {
		w.Header().Set("Content-Length", strconv.Itoa(n))
	}

	cases := []struct {
		name   string
		method string
		h      http.HandlerFunc
		want   string
	}{
		{"no Content-Length", http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte(body))
		}, ""},
		{"Content-Length right", http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
			declare(w, size)
			w.Write([]byte(body))
		}, ""},
		{"Content-Length too small", http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
			declare(w, size-10)
			w.Write([]byte(body))
		}, "borgo: Content-Length 3990 but wrote 4000 bytes"},
		{"Content-Length too large", http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
			declare(w, size+1000)
			w.Write([]byte(body))
		}, "borgo: Content-Length 5000 but wrote 4000 bytes"},
		{"zero with a body", http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
			declare(w, 0)
			w.Write([]byte(body))
		}, "borgo: Content-Length 0 but wrote 4000 bytes"},
		{"zero without a body", http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
			declare(w, 0)
			w.WriteHeader(http.StatusOK)
		}, ""},
		// the plainest form of the bug, and the one that went unreported
		// longest: the length is read at WriteHeader, and a handler that
		// declares one and returns without writing never reaches it. net/http
		// ships the header under an implicit 200 and the client waits for a
		// body that was never coming
		{"declared, then neither writes nor commits", http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
			declare(w, size)
		}, "borgo: Content-Length 4000 but wrote 0 bytes"},
		{"zero declared, neither writes nor commits", http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
			declare(w, 0)
		}, ""},
		// the same uncommitted response on a HEAD and after a panic: both
		// guards have to hold on the path that never reached WriteHeader too
		{"declared on a HEAD, neither writes nor commits", http.MethodHead, func(w http.ResponseWriter, r *http.Request) {
			declare(w, size)
		}, ""},
		{"declared, then panic before the first byte", http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
			declare(w, size)
			panic("boom")
		}, ""},
		{"declared, then flushed half way", http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
			declare(w, size)
			w.Write([]byte(body[:size/2]))
			w.(http.Flusher).Flush()
			w.Write([]byte(body[size/2:]))
		}, ""},
		// net/http drops the body of these three, so the counter reads zero
		// against a length that correctly describes the response the client
		// asked about - a 304 carries the headers its 200 would (RFC 9110
		// 15.4.5) and a HEAD answers for the GET it stands in for
		{"declared on a 204", http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
			declare(w, size)
			w.WriteHeader(http.StatusNoContent)
		}, ""},
		{"declared on a 304", http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
			declare(w, size)
			w.WriteHeader(http.StatusNotModified)
		}, ""},
		{"declared on a HEAD", http.MethodHead, func(w http.ResponseWriter, r *http.Request) {
			declare(w, size)
			w.WriteHeader(http.StatusOK)
		}, ""},
		// a panicking handler stops mid-body by definition; the panic is
		// already logged, and the short body is its consequence, not a defect
		// of its own
		{"declared, then panic inside the buffer", http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
			declare(w, size)
			w.Write([]byte(body[:100]))
			panic("boom")
		}, ""},
		{"declared, then panic past the buffer", http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
			declare(w, size)
			w.Write([]byte(body[:size/2]))
			panic("boom")
		}, ""},
		{"declared, written in ten writes", http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
			declare(w, size)
			for i := range 10 {
				w.Write([]byte(body[i*size/10 : (i+1)*size/10]))
			}
		}, ""},
		// the same ten writes one chunk short: without this the counter could
		// be reading only the first Write and the row above would still pass
		{"declared, ten writes one short", http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
			declare(w, size)
			for i := range 9 {
				w.Write([]byte(body[i*size/10 : (i+1)*size/10]))
			}
		}, "borgo: Content-Length 4000 but wrote 3600 bytes"},
		// net/http rejects and logs this one itself; a second complaint about
		// it would say nothing the first did not
		{"Content-Length not a number", http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Length", "banana")
			w.Write([]byte(body))
		}, ""},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			identity := contentLengthLog(t, c.method, "", c.h)
			compressed := contentLengthLog(t, c.method, "gzip", c.h)

			if identity != compressed {
				t.Errorf("what the log says depends on Accept-Encoding:\n identity %q\n gzip     %q",
					identity, compressed)
			}
			if identity != c.want {
				t.Errorf("identity log = %q, want %q", identity, c.want)
			}
			if compressed != c.want {
				t.Errorf("gzip log = %q, want %q", compressed, c.want)
			}
		})
	}
}

// failingWriter stops taking bytes part way through, the way a connection does
// when the client hangs up.
type failingWriter struct {
	header http.Header
	limit  int
	taken  int
}

func (f *failingWriter) Header() http.Header { return f.header }
func (f *failingWriter) WriteHeader(int)     {}

func (f *failingWriter) Write(p []byte) (int, error) {
	if f.taken >= f.limit {
		return 0, io.ErrClosedPipe
	}
	n := min(len(p), f.limit-f.taken)
	f.taken += n
	if n < len(p) {
		return n, io.ErrClosedPipe
	}
	return n, nil
}

// The third guard, and the one worth the most: a handler that checks Write and
// returns when it fails is the well-behaved one - io.Copy and http.ServeContent
// both do - so every client that cancels a download mid-flight leaves a body
// shorter than its declared length through no fault of the handler. Reported,
// that would put a line in the log for every cancelled download and bury the
// bug this check exists to surface.
func TestShortBodyAfterAWriteErrorIsNotReportedOnEitherEncoding(t *testing.T) {
	const size = 64 << 10
	// incompressible, so the failure reaches the handler on the gzip path too
	// rather than sitting in the deflate window
	body := make([]byte, size)
	for i, s := 0, uint32(1); i < len(body); i++ {
		s = s*1664525 + 1013904223
		body[i] = byte(s >> 24)
	}

	for _, ae := range []string{"", "gzip"} {
		t.Run("Accept-Encoding "+ae, func(t *testing.T) {
			var out bytes.Buffer
			flags := log.Flags()
			log.SetOutput(&out)
			log.SetFlags(0)
			defer func() {
				log.SetOutput(os.Stderr)
				log.SetFlags(flags)
			}()

			var sent int
			req := httptest.NewRequest(http.MethodGet, "/api/download", nil)
			if ae != "" {
				req.Header.Set("Accept-Encoding", ae)
			}
			gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Length", strconv.Itoa(size))
				for sent < size {
					n, err := w.Write(body[sent : sent+1024])
					sent += n
					if err != nil {
						return
					}
				}
			})).ServeHTTP(&failingWriter{header: http.Header{}, limit: 4 * gzipMinBytes}, req)

			if sent >= size {
				t.Fatalf("the handler sent all %d bytes: the write never failed, so this proves nothing", sent)
			}
			if strings.Contains(out.String(), "borgo: Content-Length") {
				t.Errorf("a cancelled download was reported as a handler bug: %q", out.String())
			}
		})
	}
}

// finish ends the response. A handler that leaked its writer and wrote after
// returning used to re-send the buffer it had already committed, and, with the
// gzip writer cleared, open a second gzip stream nobody would close - raw
// deflate bytes under no Content-Encoding.
func TestGzipWriteAfterFinishAddsNothing(t *testing.T) {
	for _, ae := range []string{"gzip", "identity"} {
		t.Run(ae, func(t *testing.T) {
			var leaked http.ResponseWriter
			rec := serveGzip(t, ae, func(w http.ResponseWriter, r *http.Request) {
				leaked = w
				w.Write([]byte("committed"))
			})
			// past finish the writer only forwards, and a real connection
			// refuses what it forwards; what must not happen is the buffer
			// going out twice or a second gzip stream starting
			leaked.Write([]byte(strings.Repeat("late", 1000)))
			body := rec.Body.String()
			if n := strings.Count(body, "committed"); n != 1 {
				t.Errorf("the committed body went out %d times", n)
			}
			if strings.Contains(body, "\x1f\x8b\x08") {
				t.Error("a late write opened a gzip stream, under no Content-Encoding and with nobody to close it")
			}
			if got := rec.Header().Get("Content-Encoding"); got != "" {
				t.Errorf("Content-Encoding = %q, want none", got)
			}
		})
	}
}

// serveAndDiagnose runs one request over a real connection and returns both
// halves of the server's voice: what borgo logged, and what net/http logged
// through the server's own ErrorLog. A recorder cannot answer this question at
// all - it has no stdlib writer behind it, so the half of the diagnosis this
// test is about would be missing exactly where it looks for it.
//
// The buffers are read after Close, which waits for the handler and is what
// puts its writes before this goroutine's reads.
func serveAndDiagnose(t *testing.T, acceptEncoding string, h http.Handler) (borgoSaid, stdlibSaid, wire string) {
	t.Helper()
	var borgoOut, stdlibOut bytes.Buffer
	flags := log.Flags()
	log.SetOutput(&borgoOut)
	log.SetFlags(0)
	defer func() {
		log.SetOutput(os.Stderr)
		log.SetFlags(flags)
	}()

	srv := httptest.NewUnstartedServer(h)
	srv.Config.ErrorLog = log.New(&stdlibOut, "", 0)
	srv.Start()
	conn, err := net.Dial("tcp", srv.Listener.Addr().String())
	if err != nil {
		srv.Close()
		t.Fatal(err)
	}
	fmt.Fprintf(conn, "GET / HTTP/1.1\r\nHost: %s\r\nAccept-Encoding: %s\r\nConnection: close\r\n\r\n",
		srv.Listener.Addr(), acceptEncoding)
	raw, err := io.ReadAll(conn)
	conn.Close()
	srv.Close()
	if err != nil {
		t.Fatalf("reading the response: %v", err)
	}
	return borgoOut.String(), stdlibOut.String(), string(raw)
}

// A CONTENT-LENGTH TOO MALFORMED TO COMPARE WAS NAMED FOR HALF THE CLIENTS.
//
// A Content-Length that is not a number is the same handler bug as one that is
// merely wrong, and net/http names it - `http: invalid Content-Length of "..."`
// - for as long as it still holds the header. Past the buffer startGzip deletes
// it first, so on the compressed path stdlib had nothing left to complain about,
// and borgo, deferring to a complaint that was no longer being made, said
// nothing either. Below the buffer nothing is deleted and stdlib speaks on both
// paths, so the silence started exactly where the body outgrew gzipMinBytes:
// the mismatch defect this file already reports, in the one spelling that
// slipped past the comparison because it could not be compared.
//
// The assertion is not who speaks but that somebody does. On identity that is
// stdlib and on gzip past the buffer it can only be borgo, and a response whose
// diagnosis depends on Accept-Encoding is the defect itself.
func TestGzipInvalidContentLengthIsNamedOnEitherEncoding(t *testing.T) {
	for _, size := range []int{gzipMinBytes / 2, gzipMinBytes * 4} {
		for _, value := range []string{"banana", "-5", "1e3", " 4000"} {
			for _, ae := range []string{"identity", "gzip"} {
				t.Run(fmt.Sprintf("%dB/%q/%s", size, value, ae), func(t *testing.T) {
					borgoSaid, stdlibSaid, wire := serveAndDiagnose(t, ae,
						gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
							w.Header().Set("Content-Length", value)
							w.Write(bytes.Repeat([]byte("x"), size))
						})))

					if !strings.Contains(borgoSaid+stdlibSaid, value) {
						t.Errorf("nothing named the invalid Content-Length %q\n borgo:    %q\n net/http: %q",
							value, borgoSaid, stdlibSaid)
					}
					// whoever names it, it must not reach the client: a length
					// net/http refuses to parse is one no cache can trust either
					head, _, _ := strings.Cut(wire, "\r\n\r\n")
					for _, line := range strings.Split(head, "\r\n") {
						if !strings.HasPrefix(strings.ToLower(line), "content-length:") {
							continue
						}
						if strings.TrimSpace(line[len("content-length:"):]) == value {
							t.Errorf("the invalid length went out on the wire: %q", line)
						}
					}
				})
			}
		}
	}
}

// clientReads runs one request through a real Transport and returns what the
// client ends up holding. Not a recorder and not raw bytes: the question here
// is whether a client can use the response at all, and the Transport is what
// enforces RFC 9110 8.6 on the receiving side.
func clientReads(t *testing.T, acceptEncoding string, h http.Handler) (status int, body string, err error) {
	t.Helper()
	srv := httptest.NewServer(h)
	defer srv.Close()
	req, err := http.NewRequest(http.MethodGet, srv.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	// set by hand, so the Transport does not decompress behind the test's back
	req.Header.Set("Accept-Encoding", acceptEncoding)
	res, err := http.DefaultTransport.RoundTrip(req)
	if err != nil {
		return 0, "", err
	}
	defer res.Body.Close()
	var r io.Reader = res.Body
	if res.Header.Get("Content-Encoding") == "gzip" {
		zr, zerr := gzip.NewReader(res.Body)
		if zerr != nil {
			return res.StatusCode, "", zerr
		}
		defer zr.Close()
		r = zr
	}
	b, err := io.ReadAll(r)
	return res.StatusCode, string(b), err
}

// A SECOND CONTENT-LENGTH DESTROYED THE RESPONSE FOR HALF THE CLIENTS.
//
// A handler that Adds a Content-Length beside the one it already set puts both
// lines on the wire, and RFC 9110 8.6 has a recipient treat contradictory ones
// as unrecoverable: net/http's own Transport drops the connection and delivers
// no status at all. Above the buffer startGzip deletes every Content-Length
// before compressing, so the same handler with the same correct 4 KB body
// answered a gzip client perfectly and an identity client not at all - the
// split this file exists to close, decided once more by Accept-Encoding, and
// with no line logged anywhere by borgo or by net/http.
//
// Direction of failure: only the first value is ever in force - net/http sizes
// the body by it on every road - so what reaches the wire must be that one
// value alone. Keeping the last would be the option that overrules the handler,
// since it contradicts the body already being sent.
//
// The assertion is the client's, because a well-formed wire is not the point
// unless somebody can read it. Identical repeats are legal to a client and must
// pass without a word, or the remedy is noise.
func TestGzipCommitsOneContentLengthWhateverTheEncoding(t *testing.T) {
	stagings := []struct {
		name   string
		set    func(h http.Header, size int)
		logged bool
	}{
		{"one", func(h http.Header, size int) {
			h.Set("Content-Length", strconv.Itoa(size))
		}, false},
		{"two identical", func(h http.Header, size int) {
			h.Add("Content-Length", strconv.Itoa(size))
			h.Add("Content-Length", strconv.Itoa(size))
		}, false},
		{"two contradictory", func(h http.Header, size int) {
			h.Add("Content-Length", strconv.Itoa(size))
			h.Add("Content-Length", "9999")
		}, true},
		// the second line need not even be a number: net/http reads the first
		// and never sees this one, so it reached the wire unnamed by anyone
		{"second unparsable", func(h http.Header, size int) {
			h.Add("Content-Length", strconv.Itoa(size))
			h.Add("Content-Length", "banana")
		}, true},
		{"three", func(h http.Header, size int) {
			h.Add("Content-Length", strconv.Itoa(size))
			h.Add("Content-Length", "9999")
			h.Add("Content-Length", "7")
		}, true},
	}
	// 0 is not a smaller body: it is the response nobody commits, which
	// net/http ships out of the live header on an implicit 200 - the one road
	// commitHeader never reaches, and where both lines went out unchanged
	for _, size := range []int{gzipMinBytes / 2, gzipMinBytes * 4, 0} {
		for _, st := range stagings {
			t.Run(fmt.Sprintf("%dB/%s", size, st.name), func(t *testing.T) {
				want := strings.Repeat("x", size)
				handler := gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					st.set(w.Header(), size)
					if size > 0 {
						w.Write([]byte(want))
					}
				}))

				said := map[string]string{}
				for _, ae := range []string{"identity", "gzip"} {
					borgoSaid, stdlibSaid, wire := serveAndDiagnose(t, ae, handler)
					said[ae] = borgoSaid

					head, _, _ := strings.Cut(wire, "\r\n\r\n")
					var lines []string
					for _, l := range strings.Split(head, "\r\n") {
						if strings.HasPrefix(strings.ToLower(l), "content-length:") {
							lines = append(lines, l)
						}
					}
					if len(lines) > 1 {
						t.Errorf("%s: %d Content-Length lines on the wire %q: a recipient must treat that as unrecoverable (RFC 9110 8.6)", ae, len(lines), lines)
					}
					if stdlibSaid != "" {
						t.Errorf("%s: net/http complained: %q", ae, stdlibSaid)
					}

					status, body, err := clientReads(t, ae, handler)
					if err != nil {
						t.Fatalf("%s: the client got no usable response: %v", ae, err)
					}
					if status != http.StatusOK {
						t.Errorf("%s: status = %d, want 200", ae, status)
					}
					if body != want {
						t.Errorf("%s: the client read %d bytes, want %d", ae, len(body), len(want))
					}
				}

				// the same handler must be named identically on both roads, or
				// the asymmetry has only moved into the log
				if said["identity"] != said["gzip"] {
					t.Errorf("the two encodings said different things\n identity: %q\n gzip:     %q", said["identity"], said["gzip"])
				}
				switch got := said["identity"]; {
				case st.logged && !strings.Contains(got, "Content-Length lines"):
					t.Errorf("nothing named the contradiction: %q", got)
				case !st.logged && got != "":
					t.Errorf("a well-formed response was reported: %q", got)
				}
			})
		}
	}
}

// THE BUFFER TURNED A DELIVERABLE RESPONSE INTO ZERO BYTES.
//
// net/http refuses a write that would exceed the declared Content-Length whole,
// rather than truncating it, and returns ErrContentLength to the handler. Below
// the buffer borgo collects every Write and emits one: a handler declaring 300
// and writing 400 in four calls got three of them through unwrapped - 300 bytes
// and a well-formed response - and through borgo got a single 400-byte write
// that net/http refused entirely, so the client read zero bytes under a
// Content-Length of 300, and an unexpected EOF. The handler was told nothing on
// either road, which is what the buffer is for; what it cost the client was not.
//
// Direction of failure: below the buffer the whole body is in hand before the
// commit, so the length it will occupy is known, and a declared one that does
// not describe it must not go out - the rule startGzip already applies to
// compressed bytes. A short body, and a declared length with nothing written at
// all, are the same defect pointing the other way and stall the client instead.
//
// This is not the report's defect: reportLengthMismatch names the handler here
// exactly as before, and is asserted to still do it. The client is what changes.
func TestGzipDeliversTheBufferedBodyWholeWhateverTheEncoding(t *testing.T) {
	const size = gzipMinBytes / 2
	shapes := []struct {
		name  string
		write func(w http.ResponseWriter)
	}{
		{"one call", func(w http.ResponseWriter) {
			w.Write(bytes.Repeat([]byte("x"), size))
		}},
		// the io.Copy shape: unwrapped this is the one that still delivers a
		// usable prefix, which is what the buffer took away
		{"in pieces", func(w http.ResponseWriter) {
			for i := 0; i < size; i += 100 {
				if _, err := w.Write(bytes.Repeat([]byte("x"), min(100, size-i))); err != nil {
					return
				}
			}
		}},
		{"nothing at all", func(w http.ResponseWriter) {}},
	}
	for _, declared := range []int{size - 100, size + 100, 0} {
		for _, sh := range shapes {
			t.Run(fmt.Sprintf("declared=%d/%s", declared, sh.name), func(t *testing.T) {
				handler := gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Length", strconv.Itoa(declared))
					sh.write(w)
				}))
				want := size
				if sh.name == "nothing at all" {
					want = 0
				}

				said := map[string]string{}
				for _, ae := range []string{"identity", "gzip"} {
					said[ae], _, _ = serveAndDiagnose(t, ae, handler)
					status, body, err := clientReads(t, ae, handler)
					if err != nil {
						t.Fatalf("%s: the client could not read the response: %v", ae, err)
					}
					if status != http.StatusOK {
						t.Errorf("%s: status = %d, want 200", ae, status)
					}
					if len(body) != want {
						t.Errorf("%s: the client got %d bytes, want the whole %d the handler wrote", ae, len(body), want)
					}
				}
				if said["identity"] != said["gzip"] {
					t.Errorf("the two encodings said different things\n identity: %q\n gzip:     %q", said["identity"], said["gzip"])
				}
				// the handler is still named: this changes what the client gets,
				// not what the log says
				reported := strings.Contains(said["identity"], "but wrote")
				if wrong := declared != want; wrong != reported {
					t.Errorf("declared %d, wrote %d: reported = %v, want %v (%q)", declared, want, reported, wrong, said["identity"])
				}
			})
		}
	}

	// the one length that legitimately describes bytes nobody will send: a HEAD
	// stands in for the GET whose body it declares, so dropping it here would
	// answer the request with the size of nothing
	t.Run("HEAD keeps the length it stands in for", func(t *testing.T) {
		srv := httptest.NewServer(gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Length", strconv.Itoa(size))
		})))
		defer srv.Close()
		req, err := http.NewRequest(http.MethodHead, srv.URL, nil)
		if err != nil {
			t.Fatal(err)
		}
		res, err := http.DefaultTransport.RoundTrip(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if got := res.Header.Get("Content-Length"); got != strconv.Itoa(size) {
			t.Errorf("Content-Length = %q, want %q: a HEAD answers for a body it does not send", got, strconv.Itoa(size))
		}
	})
}

// wireContentLengths returns the Content-Length lines of a response, in the
// order they reached the socket, however their keys were spelled.
func wireContentLengths(head string) []string {
	var out []string
	for _, line := range strings.Split(head, "\r\n") {
		key, value, ok := strings.Cut(line, ":")
		if ok && strings.EqualFold(key, "content-length") {
			out = append(out, strings.TrimSpace(value))
		}
	}
	return out
}

// THE KEY A HEADER WAS SPELLED WITH DECIDED WHETHER THE CLIENT GOT A RESPONSE.
//
// h.Get and h.Values canonicalise the key they look up; net/http's writer
// canonicalises nothing and emits the map as it finds it. So a Content-Length
// assigned as w.Header()["content-length"] = is a line every client counts, and
// one no guard here saw - while net/http, which sizes the body by the canonical
// entry alone, put its own beside it. RFC 9110 8.6 has a recipient treat
// contradictory lengths as unrecoverable, and net/http's Transport does: no
// status, no body, nothing logged by anyone. Measured, that is all four
// crossings, not the "contradicting line" it was registered as.
//
// One shape was worse than a blind spot, and it is the one this asserts hardest
// on. A handler that sets only w.Header()["content-length"] = "4096" and writes
// 4096 bytes is delivered whole by bare net/http, which drops the length when it
// chunks. Through borgo above the buffer, startGzip deleted the canonical entry
// before compressing and left that one describing the uncompressed body, beside
// net/http's correct 42 - so borgo turned a working response into zero bytes,
// for the gzip client only, which is the split this file exists to close.
//
// Direction of failure: what reaches the wire must be one Content-Length line,
// and it must be the first value the wire would have carried - writeSubset sorts
// the keys it emits, so byte order is wire order, and the first line is what a
// recipient reads. Choosing the canonical spelling over the first line instead
// would decide the body's size by how a key was capitalised, which is the defect
// wearing the guard's coat.
//
// The assertion is the client's: a well-formed header block is not the point
// unless somebody can read the body behind it.
func TestGzipReadsContentLengthUnderEverySpellingOfItsKey(t *testing.T) {
	stagings := []struct {
		name string
		set  func(h http.Header, size int)
		want string // the value that must survive, "" for none
	}{
		{"lowercase alone", func(h http.Header, size int) {
			h["content-length"] = []string{strconv.Itoa(size)}
		}, "size"},
		{"uppercase alone", func(h http.Header, size int) {
			h["CONTENT-LENGTH"] = []string{strconv.Itoa(size)}
		}, "size"},
		{"canonical, then lowercase behind it", func(h http.Header, size int) {
			h.Set("Content-Length", strconv.Itoa(size))
			h["content-length"] = []string{"9999"}
		}, "size"},
		// "CONTENT-LENGTH" sorts before "Content-Length", so the handler's 9999
		// is the line that reaches the wire first and the one in force
		{"uppercase in front of canonical", func(h http.Header, size int) {
			h.Set("Content-Length", strconv.Itoa(size))
			h["CONTENT-LENGTH"] = []string{"9999"}
		}, "9999"},
		{"canonical twice and lowercase", func(h http.Header, size int) {
			h.Add("Content-Length", strconv.Itoa(size))
			h.Add("Content-Length", "9999")
			h["content-length"] = []string{"7777"}
		}, "size"},
	}
	for _, size := range []int{gzipMinBytes / 2, gzipMinBytes * 4} {
		for _, st := range stagings {
			t.Run(fmt.Sprintf("%dB/%s", size, st.name), func(t *testing.T) {
				body := strings.Repeat("x", size)
				handler := gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					st.set(w.Header(), size)
					w.Write([]byte(body))
				}))
				want := st.want
				if want == "size" {
					want = strconv.Itoa(size)
				}

				for _, ae := range []string{"identity", "gzip"} {
					_, stdlibSaid, wire := serveAndDiagnose(t, ae, handler)
					head, _, _ := strings.Cut(wire, "\r\n\r\n")
					if lines := wireContentLengths(head); len(lines) > 1 {
						t.Errorf("%s: %d Content-Length lines on the wire %q: a recipient must treat that as unrecoverable (RFC 9110 8.6)", ae, len(lines), lines)
					}
					if stdlibSaid != "" {
						t.Errorf("%s: net/http complained: %q", ae, stdlibSaid)
					}
					// below the buffer the wrong length is dropped before the
					// commit, so only the surviving-correct case is checked there
					if ae == "identity" && want == strconv.Itoa(size) {
						if lines := wireContentLengths(head); len(lines) == 1 && lines[0] != want {
							t.Errorf("identity: Content-Length %q went out, want %q: the first line on the wire is the one in force", lines[0], want)
						}
					}

					status, got, err := clientReads(t, ae, handler)
					if want != strconv.Itoa(size) {
						// the handler declared a length its body contradicts, past
						// the point borgo can still drop it: net/http is left to
						// stall the client, which is stdlib's own behaviour
						continue
					}
					if err != nil {
						t.Fatalf("%s: the client got no usable response: %v", ae, err)
					}
					if status != http.StatusOK {
						t.Errorf("%s: status = %d, want 200", ae, status)
					}
					if got != body {
						t.Errorf("%s: the client read %d bytes, want %d", ae, len(got), size)
					}
				}
			})
		}
	}
}

// BORGO DESTROYED, FOR THE GZIP CLIENT ONLY, A RESPONSE STDLIB DELIVERS WHOLE.
//
// The single sharpest shape of the defect above, kept separate because it is the
// one that is not a blind spot: the same handler, wrapped and bare, compared on
// what the client ends up holding.
//
// Only the two gzip rows prove it. On identity the length never contradicts
// anything, because net/http chunks and drops it - those rows are regression
// guards, and they are here to keep the comparison honest, not to count.
func TestGzipDoesNotUnmakeAResponseStdlibDelivers(t *testing.T) {
	const size = gzipMinBytes * 4
	for _, key := range []string{"content-length", "CONTENT-LENGTH"} {
		for _, ae := range []string{"identity", "gzip"} {
			t.Run(fmt.Sprintf("%s/%s", key, ae), func(t *testing.T) {
				inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header()[key] = []string{strconv.Itoa(size)}
					w.Write(bytes.Repeat([]byte("x"), size))
				})
				bareStatus, bare, bareErr := clientReads(t, ae, inner)
				status, got, err := clientReads(t, ae, gzipMiddleware(inner))
				if bareErr != nil || len(bare) != size {
					t.Skipf("bare net/http does not deliver this shape either (%d, %d bytes, %v)", bareStatus, len(bare), bareErr)
				}
				if err != nil {
					t.Fatalf("borgo unmade a response net/http delivers whole: %v", err)
				}
				if status != http.StatusOK || len(got) != size {
					t.Errorf("borgo: status %d and %d bytes, net/http: status %d and %d bytes", status, len(got), bareStatus, len(bare))
				}
			})
		}
	}
}

// A STREAM AND A PRE-ENCODED BODY WERE COMPRESSED IF THE KEY WAS NOT CANONICAL.
//
// Both gates read the header by a canonical lookup, so a handler that assigned
// text/event-stream or an encoding through the map walked through them and borgo
// put Content-Encoding: gzip over a declared event stream and over a body that
// said it was already coded. Measured on the socket, above the buffer, on both.
//
// net/http reads neither field for this question - Content-Type only to decide
// whether to sniff, Content-Encoding only to suppress that - and its answer
// never reaches the client, while the browser the stream is for and the decoder
// the coding is for both fold the key. So folding it here takes nothing away
// from the agreement c5f7713 was protecting: Content-Encoding is still read by
// its first value, which is the half of that rule net/http actually shares.
//
// Four of the twelve rows prove it: the non-canonical spellings above the
// buffer. Below it nothing is ever compressed whatever the gate answers, and
// the canonical rows passed before the fix - eight regression guards, said
// rather than counted.
func TestGzipPassesThroughStreamsAndEncodingsUnderEverySpelling(t *testing.T) {
	fields := []struct {
		canonical string
		value     string
	}{
		{"Content-Type", "text/event-stream"},
		{"Content-Encoding", "br"},
	}
	for _, f := range fields {
		for _, key := range []string{f.canonical, strings.ToLower(f.canonical), strings.ToUpper(f.canonical)} {
			for _, size := range []int{gzipMinBytes / 2, gzipMinBytes * 4} {
				t.Run(fmt.Sprintf("%s=%s/%dB", key, f.value, size), func(t *testing.T) {
					handler := gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						w.Header()[key] = []string{f.value}
						w.Write(bytes.Repeat([]byte("x"), size))
					}))
					_, _, wire := serveAndDiagnose(t, "gzip", handler)
					head, _, _ := strings.Cut(wire, "\r\n\r\n")
					for _, line := range strings.Split(head, "\r\n") {
						k, v, ok := strings.Cut(line, ":")
						if ok && strings.EqualFold(k, "content-encoding") && strings.TrimSpace(v) == "gzip" {
							t.Errorf("borgo compressed a response that declared %s: %s\n %q", key, f.value, strings.ReplaceAll(head, "\r\n", " | "))
						}
					}
				})
			}
		}
	}
}

// THE HANDLER IS STILL NAMED WHEN THE LENGTH IT DECLARED WAS NOT CANONICAL.
//
// reportLengthMismatch reads the length at WriteHeader, before the commit that
// normalises the key, so it needs the folded read of its own or the same wrong
// declaration is reported under one spelling and passed over under another.
//
// The last two rows are the ones that price the order. Two spellings holding
// different numbers put both on the wire, and the first line is the one in
// force: "CONTENT-LENGTH" sorts before "Content-Length" and "content-length"
// after it, so the same pair of numbers is a mismatch in one row and a correct
// declaration in the other. Reading the wrong end reports a handler that is
// right and passes over one that is wrong, in the same response.
func TestGzipNamesAWrongContentLengthUnderEverySpelling(t *testing.T) {
	const size = gzipMinBytes / 2
	rows := []struct {
		name   string
		set    func(h http.Header)
		report bool
	}{
		{"Content-Length", func(h http.Header) { h["Content-Length"] = []string{"9999"} }, true},
		{"content-length", func(h http.Header) { h["content-length"] = []string{"9999"} }, true},
		{"CONTENT-LENGTH", func(h http.Header) { h["CONTENT-LENGTH"] = []string{"9999"} }, true},
		{"the wrong one reaches the wire first", func(h http.Header) {
			h.Set("Content-Length", strconv.Itoa(size))
			h["CONTENT-LENGTH"] = []string{"9999"}
		}, true},
		{"the right one reaches the wire first", func(h http.Header) {
			h.Set("Content-Length", strconv.Itoa(size))
			h["content-length"] = []string{"9999"}
		}, false},
	}
	for _, row := range rows {
		t.Run(row.name, func(t *testing.T) {
			said := map[string]string{}
			for _, ae := range []string{"identity", "gzip"} {
				said[ae], _, _ = serveAndDiagnose(t, ae, gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					row.set(w.Header())
					w.Write(bytes.Repeat([]byte("x"), size))
				})))
				if got := strings.Contains(said[ae], "but wrote"); got != row.report {
					t.Errorf("%s: reported = %v, want %v (%q)", ae, got, row.report, said[ae])
				}
			}
			if said["identity"] != said["gzip"] {
				t.Errorf("the two encodings said different things\n identity: %q\n gzip:     %q", said["identity"], said["gzip"])
			}
		})
	}
}

// WHAT IS LEFT CANONICAL ON PURPOSE, ASSERTED SO IT STAYS A DECISION.
//
// Only Vary now, and the whole cost is asserted here: a second Accept-Encoding
// line naming a field the first already names, with whatever the handler varied
// on still in force beside it. Vary is a set of field names (RFC 9110 12.5.5),
// so a repeat is not a second answer - which is what separates it from the two
// fields commitHeader does fold, where the surviving line was read as a value.
// The row is not proof of a defect; it is a guard on a decision.
//
// The sniffing gate used to be defended here on the grounds that borgo and bare
// net/http answer a non-canonical content-type identically. That reason was
// false, and this test could not have caught it twice over: it sorted the lines
// before comparing them - discarding the order, which is the whole of what a
// reader taking one value sees - and it wrote gzipMinBytes/2, below the buffer,
// where startGzip never runs and the gate it names is never reached. See
// TestGzipTypesAResponseTheSameWhateverTheEncoding for the measurement.
func TestGzipLeavesTheseHeadersCanonicalOnPurpose(t *testing.T) {
	// The cost is measured under both key orders, because that is what decided
	// Content-Encoding: a spelling sorting BEFORE the canonical one puts its
	// value first. For Vary that changes nothing, and the rows say so - a set
	// has no first element. What must never happen is the handler's own field
	// going missing, so `Cookie` and `*` are asserted still in force.
	for _, row := range []struct {
		name, key, value string
		want             []string
	}{
		{"a repeat, spelling that sorts after", "vary", "Accept-Encoding", []string{"Accept-Encoding", "Accept-Encoding"}},
		{"a repeat, spelling that sorts before", "VARY", "Accept-Encoding", []string{"Accept-Encoding", "Accept-Encoding"}},
		{"the handler's own star survives", "VARY", "*", []string{"*", "Accept-Encoding"}},
		{"the handler's own Cookie survives", "VARY", "Cookie", []string{"Accept-Encoding", "Cookie"}},
	} {
		t.Run(row.name, func(t *testing.T) {
			inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Del("Vary")
				w.Header()[row.key] = []string{row.value}
				w.Write(bytes.Repeat([]byte("x"), gzipMinBytes/2))
			})
			for _, ae := range []string{"identity", "gzip"} {
				_, _, wire := serveAndDiagnose(t, ae, gzipMiddleware(inner))
				varies := wireValues(wire, "Vary")
				slices.Sort(varies)
				if !slices.Equal(varies, row.want) {
					t.Errorf("%s: Vary lines = %q, want %q", ae, varies, row.want)
				}
			}
		})
	}
}

// benchGzipHeaderCount prices a whole response by how many headers it carries,
// which is what the folded reads are paid for in.
func benchGzipHeaderCount(b *testing.B, n int, acceptEncoding string) {
	body := bytes.Repeat([]byte("x"), gzipMinBytes*2)
	h := gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hd := w.Header()
		hd.Set("Content-Type", "application/json")
		hd.Set("Cache-Control", "public, max-age=60")
		hd.Set("Content-Length", strconv.Itoa(len(body)))
		for i := 3; i < n; i++ {
			hd.Set(fmt.Sprintf("X-Pad-%d", i), "v")
		}
		w.Write(body)
	}))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Accept-Encoding", acceptEncoding)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		h.ServeHTTP(&discardWriter{header: http.Header{}}, req)
	}
}

func BenchmarkGzipHeaders4Compressed(b *testing.B)  { benchGzipHeaderCount(b, 4, "gzip") }
func BenchmarkGzipHeaders32Compressed(b *testing.B) { benchGzipHeaderCount(b, 32, "gzip") }
func BenchmarkGzipHeaders4Identity(b *testing.B)    { benchGzipHeaderCount(b, 4, "identity") }
func BenchmarkGzipHeaders32Identity(b *testing.B)   { benchGzipHeaderCount(b, 32, "identity") }

// benchGzipHeaderReads isolates the three folded reads from everything else on
// the response path.
func benchGzipHeaderReads(b *testing.B, n int) {
	h := http.Header{}
	h.Set("Content-Type", "application/json")
	h.Set("Cache-Control", "public, max-age=60")
	h.Set("Content-Length", "2048")
	for i := 3; i < n; i++ {
		h.Set(fmt.Sprintf("X-Pad-%d", i), "v")
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if declaredLength(h) < 0 || declaresEventStream(h) || declaresEncoding(h) {
			b.Fatal("unexpected")
		}
		oneContentLength(h)
	}
}

func BenchmarkGzipHeaderReads4(b *testing.B)  { benchGzipHeaderReads(b, 4) }
func BenchmarkGzipHeaderReads32(b *testing.B) { benchGzipHeaderReads(b, 32) }

// conformingClientReads returns what a client holds after undoing the codings
// the response names, reading Content-Encoding the way RFC 9110 5.3 defines it:
// repeated field lines are one list, and an empty element names no coding.
// Neither a recorder nor clientReads, whose Get stops at the first value - the
// question here is what the bytes are once the header has been obeyed.
func conformingClientReads(t *testing.T, h http.Handler) (codings []string, body []byte) {
	t.Helper()
	srv := httptest.NewServer(h)
	defer srv.Close()
	req, err := http.NewRequest(http.MethodGet, srv.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Accept-Encoding", "gzip")
	res, err := http.DefaultTransport.RoundTrip(req)
	if err != nil {
		t.Fatalf("no response at all: %v", err)
	}
	defer res.Body.Close()
	body, err = io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("reading the body: %v", err)
	}
	for _, line := range res.Header["Content-Encoding"] {
		for _, c := range strings.Split(line, ",") {
			if c = strings.TrimSpace(c); c != "" {
				codings = append(codings, c)
			}
		}
	}
	// outermost coding first, as a decoder peels them
	for i := len(codings) - 1; i >= 0 && strings.EqualFold(codings[i], "gzip"); i-- {
		zr, err := gzip.NewReader(bytes.NewReader(body))
		if err != nil {
			t.Fatalf("the response named %q and the bytes are not that: %v", codings, err)
		}
		body, err = io.ReadAll(zr)
		zr.Close()
		if err != nil {
			t.Fatalf("decoding the %q layer: %v", codings[i], err)
		}
	}
	return codings, body
}

// A BODY ALREADY CODED WAS COMPRESSED AGAIN, AND ITS DECLARATION DELETED.
//
// The gate read Content-Encoding by its first value, so Add("") before
// Add("gzip") - a slice the public API produces on its own - read "" and walked
// through it. borgo then compressed a body that was already a gzip stream and
// h.Set("Content-Encoding", "gzip") replaced BOTH values, taking the only line
// that said so off the wire. What is left is a response naming one coding and
// carrying two.
//
// Direction of failure: a client that obeys the header undoes one layer and
// stops, so it holds coded bytes it takes for plaintext - and it cannot know,
// because the evidence went out with the header borgo overwrote. The same
// handler through bare net/http delivers the plaintext whole, so this is not a
// blind spot: it is borgo unmaking a response the standard library gets right.
//
// The comparison is the assertion. gzip stands in for br because the test has to
// decode what it measures; the shape is the one measured on br, where borgo put
// Content-Encoding: gzip alone over 6000 untouched br bytes.
func TestGzipDoesNotRecompressABodyCodedBehindAnEmptyValue(t *testing.T) {
	// incompressible, so the coded body is still above the buffer
	plain := make([]byte, gzipMinBytes*40)
	x := uint32(12345)
	for i := range plain {
		x = x*1664525 + 1013904223
		plain[i] = byte(x >> 24)
	}
	copy(plain, []byte("payload-marker"))
	var coded bytes.Buffer
	zw := gzip.NewWriter(&coded)
	zw.Write(plain)
	zw.Close()
	if coded.Len() < gzipMinBytes {
		t.Fatalf("the coded body is %d bytes, below the buffer: this measures nothing", coded.Len())
	}

	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Add("Content-Encoding", "")
		w.Header().Add("Content-Encoding", "gzip")
		w.Write(coded.Bytes())
	})
	bareCodings, bare := conformingClientReads(t, inner)
	if !bytes.Equal(bare, plain) {
		t.Fatalf("bare net/http does not deliver this shape either: %q, %d bytes", bareCodings, len(bare))
	}
	codings, got := conformingClientReads(t, gzipMiddleware(inner))
	if !bytes.Equal(got, plain) {
		t.Errorf("borgo unmade a response net/http delivers whole: the client held %d bytes under %q, still a coded stream: %v\n net/http: %d bytes under %q",
			len(got), codings, bytes.HasPrefix(got, []byte{0x1f, 0x8b}), len(bare), bareCodings)
	}
}

// WHICH RESPONSES COUNT AS ALREADY CODED, ON THE WIRE, UNDER EVERY STAGING.
//
// The rule this round settles: a Content-Encoding naming a coding in ANY of its
// values, under any spelling of its key, is a declaration and blocks
// compression. An empty value names none, so a field holding only empties does
// not stop a response compressing - the other half of the constraint, and the
// half a blunter gate would break.
func TestGzipCompressesOnlyWhatNamesNoCoding(t *testing.T) {
	rows := []struct {
		name     string
		set      func(h http.Header)
		compress bool
		role     string
	}{
		// the defect: the first value is empty and a real coding stands behind it
		{"empty then br, assigned", func(h http.Header) { h["Content-Encoding"] = []string{"", "br"} }, false, "proof"},
		{"Add empty then Add br", func(h http.Header) {
			h.Add("Content-Encoding", "")
			h.Add("Content-Encoding", "br")
		}, false, "proof"},
		{"empty then br under a folded key", func(h http.Header) { h["content-encoding"] = []string{"", "br"} }, false, "proof"},
		{"empty then gzip", func(h http.Header) { h["Content-Encoding"] = []string{"", "gzip"} }, false, "proof"},
		// the constraint: nothing here names a coding, so nothing may stop it
		{"one empty value", func(h http.Header) { h["Content-Encoding"] = []string{""} }, true, "constraint"},
		{"two empty values", func(h http.Header) { h["Content-Encoding"] = []string{"", ""} }, true, "constraint"},
		{"no field at all", func(h http.Header) {}, true, "constraint"},
		// guards: the first value already blocked these before this round
		{"br then empty", func(h http.Header) { h["Content-Encoding"] = []string{"br", ""} }, false, "guard"},
		{"br alone", func(h http.Header) { h["Content-Encoding"] = []string{"br"} }, false, "guard"},
		{"space then br", func(h http.Header) { h["Content-Encoding"] = []string{" ", "br"} }, false, "guard"},
		{"a bare comma", func(h http.Header) { h["Content-Encoding"] = []string{","} }, false, "guard"},
		// identity blocked before this round and blocks after it, in both
		// positions: see TestGzipTreatsIdentityAsACodingLikeNetHTTP
		{"identity alone", func(h http.Header) { h["Content-Encoding"] = []string{"identity"} }, false, "guard"},
		{"empty then identity", func(h http.Header) { h["Content-Encoding"] = []string{"", "identity"} }, false, "guard"},
	}
	for _, row := range rows {
		// below the buffer nothing compresses whatever the gate answers, so those
		// rows are guards on the threshold and not on the gate
		for _, size := range []int{gzipMinBytes / 2, gzipMinBytes * 4} {
			t.Run(fmt.Sprintf("%s/%dB", row.name, size), func(t *testing.T) {
				_, _, wire := serveAndDiagnose(t, "gzip", gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					row.set(w.Header())
					w.Write(bytes.Repeat([]byte("x"), size))
				})))
				head, _, _ := strings.Cut(wire, "\r\n\r\n")
				var got []string
				for _, line := range strings.Split(head, "\r\n") {
					if k, v, ok := strings.Cut(line, ":"); ok && strings.EqualFold(k, "content-encoding") {
						got = append(got, strings.TrimSpace(v))
					}
				}
				// one assertion for both halves: borgo either compresses, and then
				// gzip is the whole field, or it does not, and then the field is
				// the handler's own - h.Set replacing values it never read is the
				// destructive half of the defect
				staged := http.Header{}
				row.set(staged)
				var want []string
				for _, k := range fieldKeys(staged, "Content-Encoding") {
					for _, v := range staged[k] {
						// every parser drops the optional whitespace after the
						// colon, so " " and "" are one value on the wire
						want = append(want, strings.TrimSpace(v))
					}
				}
				if row.compress && size >= gzipMinBytes {
					want = []string{"gzip"}
				}
				if !slices.Equal(got, want) {
					t.Errorf("%s: wire Content-Encoding %q, want %q", row.role, got, want)
				}
			})
		}
	}
}

// THE AGREEMENT c5f7713 DEFENDED, ASSERTED WHERE IT IS OBSERVABLE.
//
// c5f7713 kept Content-Encoding on its first value because net/http reads it
// that way, and unifying it would have made the two disagree about which
// responses are already encoded. Reading every value does not: net/http's answer
// decides one thing only, whether to sniff a Content-Type, and that is the whole
// observable surface of it. So the assertion is that surface, on every shape this
// round changed - borgo's Content-Type lines against bare net/http's.
//
// None of these rows is proof of the defect. They are the price of the decision,
// asserted so a later round cannot pay it without noticing.
func TestGzipStillTypesAResponseLikeNetHTTP(t *testing.T) {
	for _, values := range [][]string{{"", "br"}, {"br", ""}, {""}, {"", ""}, {" ", "br"}, {"identity"}, {"", "identity"}} {
		t.Run(fmt.Sprintf("%q", values), func(t *testing.T) {
			vals := values
			inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header()["Content-Encoding"] = vals
				w.Write(bytes.Repeat([]byte("x"), gzipMinBytes*4))
			})
			types := func(raw string) []string {
				head, _, _ := strings.Cut(raw, "\r\n\r\n")
				var out []string
				for _, line := range strings.Split(head, "\r\n") {
					if k, v, ok := strings.Cut(line, ":"); ok && strings.EqualFold(k, "content-type") {
						out = append(out, strings.TrimSpace(v))
					}
				}
				slices.Sort(out)
				return out
			}
			_, _, bareWire := serveAndDiagnose(t, "gzip", inner)
			_, _, wire := serveAndDiagnose(t, "gzip", gzipMiddleware(inner))
			if got, want := types(wire), types(bareWire); !slices.Equal(got, want) {
				t.Errorf("borgo typed the response %q, net/http %q", got, want)
			}
		})
	}
}

// IDENTITY IS LEFT COUNTING AS A CODING, AND THAT IS A DECISION.
//
// RFC 9110 12.5.3 makes identity a synonym for no encoding, so a response
// declaring it could be compressed. borgo does not, and net/http does not read it
// as blank either - len(header.Get(...)) > 0 is true for it, so stdlib skips
// sniffing on exactly these responses. The whole cost is bytes not saved on a
// response that spelled out it was not coded; buying them means inventing a rule
// neither side has, on the one field where being wrong ships undecodable bytes.
// Not proof of anything - a guard on a decision.
func TestGzipTreatsIdentityAsACodingLikeNetHTTP(t *testing.T) {
	for _, values := range [][]string{{"identity"}, {"", "identity"}, {"identity", "br"}} {
		t.Run(fmt.Sprintf("%q", values), func(t *testing.T) {
			h := http.Header{"Content-Encoding": values}
			if !declaresEncoding(h) {
				t.Errorf("borgo would compress a response declaring %q", values)
			}
			// stdlib's own gate, quoted from server.go: ce := header.Get(...),
			// hasCE := len(ce) > 0
			if values[0] != "" && len(h.Get("Content-Encoding")) == 0 {
				t.Errorf("net/http reads %q as blank", values)
			}
		})
	}
}

// firstWireValue returns the first value a field has in wire order, which is
// what a reader taking one value takes. Not sorted and not canonicalised: the
// order the lines arrive in is the whole of what this measures.
func firstWireValue(raw, field string) (string, bool) {
	head, _, _ := strings.Cut(raw, "\r\n\r\n")
	for _, line := range strings.Split(head, "\r\n") {
		if k, v, ok := strings.Cut(line, ":"); ok && strings.EqualFold(strings.TrimSpace(k), field) {
			return strings.TrimSpace(v), true
		}
	}
	return "", false
}

// wireValues returns every value a field carries, in wire order.
func wireValues(raw, field string) []string {
	head, _, _ := strings.Cut(raw, "\r\n\r\n")
	var out []string
	for _, line := range strings.Split(head, "\r\n") {
		if k, v, ok := strings.Cut(line, ":"); ok && strings.EqualFold(strings.TrimSpace(k), field) {
			out = append(out, strings.TrimSpace(v))
		}
	}
	return out
}

// A GUARD WRITING UNDER THE CANONICAL KEY WRITES BESIDE A SPELLING IT DID NOT
// FOLD, AND THE SURVIVOR CAN ARRIVE FIRST.
//
// Three rounds closed the reads: every header gzip.go and cache.go look at is
// read under every spelling of its key. The writes were not, and h.Set replaces
// one key. h["CONTENT-ENCODING"] = [""] is read correctly - an empty value names
// no coding, so the body is compressed, which ec6cefe settled - and then
// h.Set("Content-Encoding", "gzip") lands beside it, not over it. writeSubset
// sorts the keys it emits and CONTENT-ENCODING sorts before Content-Encoding, so
// the empty line goes out FIRST.
//
// Direction of failure: net/http reads Content-Encoding with Get, the first
// value, which is the agreement c5f7713 defended and ec6cefe kept. Measured,
// that reader found "" and did not decode, so it held 42 bytes of gzip it took
// for text. The same handler through bare net/http hands back its 4096 plaintext
// bytes whole - borgo unmaking a response the standard library delivers intact,
// which is 29428b1's worst shape, reached this time through a write.
//
// The lowercase spelling sorts after and is only a redundant trailing empty, so
// the two are not one row twice: the key decides whether this costs a line or
// the response. Both are asserted, because a fix closing only the loud half
// leaves the quiet half to be rediscovered.
func TestGzipFoldsTheKeyItWritesTheEncodingUnder(t *testing.T) {
	body := strings.Repeat("borgo compresses this ", gzipMinBytes/4)
	for _, sp := range []struct {
		name, key string
	}{
		{"canonical", "Content-Encoding"},
		{"spelling that sorts before the canonical one", "CONTENT-ENCODING"},
		{"spelling that sorts after it", "content-encoding"},
	} {
		t.Run(sp.name, func(t *testing.T) {
			inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header()[sp.key] = []string{""}
				io.WriteString(w, body)
			})

			// bare net/http first: it names what borgo has at least to match
			bareStatus, bare, bareErr := clientReads(t, "gzip", inner)
			if bareErr != nil || bareStatus != http.StatusOK || bare != body {
				t.Fatalf("bare net/http did not deliver the response: status %d, %d bytes, %v",
					bareStatus, len(bare), bareErr)
			}

			status, got, err := clientReads(t, "gzip", gzipMiddleware(inner))
			if err != nil {
				t.Fatalf("the client could not read the response: %v", err)
			}
			if status != http.StatusOK {
				t.Errorf("status = %d, want 200", status)
			}
			if got != body {
				t.Errorf("the client held %d bytes, not the %d the handler wrote; bare net/http delivers them whole",
					len(got), len(body))
			}

			// and the field it read that by: one line, naming gzip, with no
			// empty element in front of it
			_, _, wire := serveAndDiagnose(t, "gzip", gzipMiddleware(inner))
			if first, ok := firstWireValue(wire, "Content-Encoding"); !ok || first != "gzip" {
				t.Errorf("the first Content-Encoding on the wire is %q, want %q", first, "gzip")
			}
			if got := wireValues(wire, "Content-Encoding"); len(got) != 1 {
				t.Errorf("Content-Encoding lines on the wire = %q, want the one that describes the body", got)
			}
		})
	}
}

// THE SAME HANDLER WAS TYPED ONE WAY FOR A GZIP CLIENT AND ANOTHER FOR THE REST.
//
// 29428b1 left the sniffing gate reading h["Content-Type"] canonically, with a
// measured reason: borgo and bare net/http were said to answer a non-canonical
// content-type identically, so folding the gate alone would give a gzip client a
// different Content-Type than an identity client - putting back the split this
// file exists to close.
//
// THE REASON WAS FALSE, AND THE SPLIT WAS ALREADY THERE. net/http does not put
// its sniffed type in the header map: it writes it after the map's own lines, so
// a lowercase content-type reaches the client FIRST and text/html is what it
// reads. borgo writes the sniffed type INTO the map, where Content-Type sorts
// before content-type, so the sniffed text/plain went out first. Measured on a
// 4 KB HTML body: a gzip client read text/plain, an identity client text/html,
// bare net/http text/html for both.
//
// Direction of failure: a browser asking for gzip - which is every browser -
// gets an HTML page typed text/plain and renders the source. The assertion is
// the value in wire order across both encodings, because a set of lines that
// matches after sorting is exactly what hid this.
func TestGzipTypesAResponseTheSameWhateverTheEncoding(t *testing.T) {
	for _, sp := range []struct {
		name, key string
	}{
		{"canonical", "Content-Type"},
		{"spelling that sorts before the canonical one", "CONTENT-TYPE"},
		{"spelling that sorts after it", "content-type"},
	} {
		t.Run(sp.name, func(t *testing.T) {
			inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header()[sp.key] = []string{"text/html; charset=utf-8"}
				w.Write(bytes.Repeat([]byte("x"), gzipMinBytes*4))
			})
			seen := map[string]string{}
			for _, ae := range []string{"identity", "gzip"} {
				_, _, wire := serveAndDiagnose(t, ae, gzipMiddleware(inner))
				seen[ae], _ = firstWireValue(wire, "Content-Type")
				_, _, bareWire := serveAndDiagnose(t, ae, inner)
				bare, _ := firstWireValue(bareWire, "Content-Type")
				if seen[ae] != bare {
					t.Errorf("%s: borgo typed it %q, bare net/http %q", ae, seen[ae], bare)
				}
			}
			if seen["identity"] != seen["gzip"] {
				t.Errorf("Accept-Encoding decided the type: identity read %q, gzip read %q",
					seen["identity"], seen["gzip"])
			}
			if seen["gzip"] != "text/html; charset=utf-8" {
				t.Errorf("the type the handler wrote never reached the client: %q", seen["gzip"])
			}
		})
	}
}

// FOLDING A KEY MUST NOT COST A VALUE. This is the constraint the decision was
// taken against rather than proof of a defect: a blind fold - deleting every
// spelling before writing our own - would have closed the same two defects and
// thrown away what the handler wrote. These rows guard that it does not.
//
// Both fields are lists (RFC 9110 5.3), so every value stays, in wire order, and
// what the client reads is what bare net/http gives it. The Content-Encoding
// rows go through passthrough - a named coding is not ours to touch - and the
// Content-Type rows through startGzip, so both sides of the commit are covered.
func TestGzipFoldingAFieldKeepsEveryValue(t *testing.T) {
	for _, row := range []struct {
		name, field string
		set         func(h http.Header)
		want        []string
	}{
		{"two content-type spellings", "Content-Type", func(h http.Header) {
			h["Content-Type"] = []string{"application/json"}
			h["content-type"] = []string{"text/html"}
		}, []string{"application/json", "text/html"}},
		{"content-type under two non-canonical keys", "Content-Type", func(h http.Header) {
			h["CONTENT-TYPE"] = []string{"application/json"}
			h["content-type"] = []string{"text/html"}
		}, []string{"application/json", "text/html"}},
		{"a coding behind an empty value", "Content-Encoding", func(h http.Header) {
			h["CONTENT-ENCODING"] = []string{"", "br"}
		}, []string{"", "br"}},
		{"a coding under two spellings", "Content-Encoding", func(h http.Header) {
			h["CONTENT-ENCODING"] = []string{"br"}
			h["content-encoding"] = []string{"identity"}
		}, []string{"br", "identity"}},
	} {
		t.Run(row.name, func(t *testing.T) {
			inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				row.set(w.Header())
				w.Write(bytes.Repeat([]byte("x"), gzipMinBytes*4))
			})
			_, _, wire := serveAndDiagnose(t, "gzip", gzipMiddleware(inner))
			if got := wireValues(wire, row.field); !slices.Equal(got, row.want) {
				t.Errorf("%s on the wire = %q, want %q", row.field, got, row.want)
			}
		})
	}
}

// A LENGTH THE BODY HAD ALREADY OUTGROWN WENT OUT AT THE MID-BODY COMMIT.
//
// 31d37b7 dropped a Content-Length that does not describe the bytes about to
// go out, but only in finish, and declared the identity path above the buffer
// out of reach "because the commit has already gone". Measured, it had not:
// the Write that overflows the buffer runs commitHeader and only then
// sendHeader, with the whole body so far in hand. So a handler declaring 99 and
// writing 4096 had its length shipped and net/http then refused the write
// whole - status 200, zero bytes, unexpected EOF - where the same handler bare,
// under a lowercase key, was delivered whole by chunking (a frame RFC 9112 6.2
// forbids a sender to emit, and one that borgo made visible in 29428b1). Below
// the buffer the same handler already got its body. The threshold decided.
//
// A mid-body commit does not know the final size, so only a length the body
// has already passed is dropped: "correct in two writes" and "exact" are the
// rows that keep the rule at "smaller than", not "different from" - a served
// file that declares its size and writes it in pieces must keep it. "Too long"
// is the declared limit that is real: at the commit the length is not yet
// wrong, and past it the header has gone; the client stalls as under stock
// net/http, and the log still names the handler.
func TestGzipDropsALengthTheBodyOutgrewBeforeTheCommit(t *testing.T) {
	const size = gzipMinBytes * 4
	rows := []struct {
		name       string
		declared   int
		write      func(w http.ResponseWriter, body []byte)
		wantLength string // the Content-Length line an identity client sees, "" for none
		wantBytes  int
		wantEOF    bool // net/http's own outcome for a length still in force, matched not undone
	}{
		{"too short, one write", 99, func(w http.ResponseWriter, b []byte) {
			w.Write(b)
		}, "", size, false},
		{"too short, committed by Flush below the buffer", 99, func(w http.ResponseWriter, b []byte) {
			w.Write(b[:gzipMinBytes/2])
			w.(http.Flusher).Flush()
			w.Write(b[gzipMinBytes/2:])
		}, "", size, false},
		// larger than the buffer, smaller than the body: the count that decides
		// is what the handler wrote, not what the buffer holds
		{"too short, past the buffer", gzipMinBytes * 2, func(w http.ResponseWriter, b []byte) {
			w.Write(b)
		}, "", size, false},
		{"exact", size, func(w http.ResponseWriter, b []byte) {
			w.Write(b)
		}, strconv.Itoa(size), size, false},
		{"correct in two writes", 2 * size, func(w http.ResponseWriter, b []byte) {
			w.Write(b)
			w.Write(b)
		}, strconv.Itoa(2 * size), 2 * size, false},
		{"too long", 2 * size, func(w http.ResponseWriter, b []byte) {
			w.Write(b)
		}, strconv.Itoa(2 * size), size, true},
	}
	for _, row := range rows {
		for _, key := range []string{"Content-Length", "content-length"} {
			for _, ae := range []string{"identity", "gzip"} {
				t.Run(fmt.Sprintf("%s/%s/%s", row.name, key, ae), func(t *testing.T) {
					body := bytes.Repeat([]byte("x"), size)
					handler := gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						w.Header()[key] = []string{strconv.Itoa(row.declared)}
						row.write(w, body)
					}))
					status, got, err := clientReads(t, ae, handler)
					if status != http.StatusOK {
						t.Errorf("status = %d, want 200", status)
					}
					if len(got) != row.wantBytes {
						t.Errorf("the client read %d bytes, want %d", len(got), row.wantBytes)
					}
					wantEOF := row.wantEOF && ae == "identity"
					if (err != nil) != wantEOF {
						t.Errorf("client error = %v, want error: %v", err, wantEOF)
					}
					if ae != "identity" {
						return
					}
					_, _, wire := serveAndDiagnose(t, ae, handler)
					head, _, _ := strings.Cut(wire, "\r\n\r\n")
					lines := wireContentLengths(head)
					if row.wantLength == "" && len(lines) != 0 {
						t.Errorf("Content-Length %q reached the wire over a body that had already outgrown it", lines)
					}
					if row.wantLength != "" && (len(lines) != 1 || lines[0] != row.wantLength) {
						t.Errorf("Content-Length lines %q, want [%q]", lines, row.wantLength)
					}
				})
			}
		}
	}
}

// takingWriter accepts at most cap bytes of body and refuses the rest with an
// error, the way a connection that died mid-write does: a short count and an
// error on the same call.
type takingWriter struct {
	header http.Header
	cap    int
	took   int
}

func (w *takingWriter) Header() http.Header { return w.header }
func (w *takingWriter) WriteHeader(int)     {}
func (w *takingWriter) Write(p []byte) (int, error) {
	n := min(len(p), w.cap-w.took)
	w.took += n
	if n < len(p) {
		return n, io.ErrClosedPipe
	}
	return n, nil
}

// THE LOG NAMED 4000 BYTES OVER A WIRE THAT CARRIED 3900.
//
// g.written counted what the handler offered before the write ran, so a
// connection that took part of a write and refused the rest left a line that
// measured the handler's call, not the body, and a handler that retried the
// refused tail - what a connection that has died invites - was accused of
// outgrowing its length. What the body took is the count that is true on both
// sides: named when the handler is wrong, silent when the connection is.
func TestLengthReportCountsWhatTheBodyTook(t *testing.T) {
	const size = 4000
	body := strings.Repeat("x", size)
	cases := []struct {
		name     string
		declared int
		cap      int
		h        func(w http.ResponseWriter)
		want     string
	}{
		{"too small, the wire took less than offered", 3000, 3900, func(w http.ResponseWriter) {
			w.Write([]byte(body))
		}, "borgo: Content-Length 3000 but wrote 3900 bytes"},
		{"right, the handler retries the refused tail", size, 3900, func(w http.ResponseWriter) {
			n, _ := w.Write([]byte(body))
			w.Write([]byte(body[n:]))
		}, ""},
		{"right, the wire took everything", size, size, func(w http.ResponseWriter) {
			w.Write([]byte(body))
		}, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var out bytes.Buffer
			flags := log.Flags()
			log.SetOutput(&out)
			log.SetFlags(0)
			defer func() {
				log.SetOutput(os.Stderr)
				log.SetFlags(flags)
			}()
			rw := &takingWriter{header: http.Header{}, cap: c.cap}
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Length", strconv.Itoa(c.declared))
				c.h(w)
			})).ServeHTTP(rw, req)
			got := strings.TrimSpace(out.String())
			if got != c.want {
				t.Errorf("log = %q, want %q", got, c.want)
			}
		})
	}

	// the one refusal that is the handler's: net/http refuses whole the write
	// that outgrows the declared length, where startGzip deleted that length
	// and the same bytes went through. Counted as taken, identity would fall
	// silent while gzip named the handler - the split the report exists to
	// close, so these are counted as offered on both roads
	t.Run("outgrown in pieces says the same thing on both encodings", func(t *testing.T) {
		handler := gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Length", "3900")
			for i := 0; i < size; i += 100 {
				w.Write([]byte(body[i : i+100]))
			}
		}))
		said := map[string]string{}
		for _, ae := range []string{"identity", "gzip"} {
			said[ae], _, _ = serveAndDiagnose(t, ae, handler)
			said[ae] = strings.TrimSpace(said[ae])
		}
		want := "borgo: Content-Length 3900 but wrote 4000 bytes"
		for ae, got := range said {
			if got != want {
				t.Errorf("%s: log = %q, want %q", ae, got, want)
			}
		}
	})
}

// VARY STAYS CANONICAL, MEASURED AGAIN.
//
// bd65cd2 folded Content-Encoding and Content-Type in commitHeader and left
// Vary alone on a measured reason: it is a set of field names (RFC 9110
// 12.5.5), so a spelling the guard cannot see costs one repeated line and
// nothing else. Two declared limits in this file fell when re-measured, so the
// reason is measured here on the wire, across the spelling that sorts before
// the canonical key and the one that sorts after, and for a client that folds
// the lines the way a cache does.
func TestVaryUnderAnySpellingStillNamesAcceptEncoding(t *testing.T) {
	cases := []struct {
		key, value string
		wantLines  []string
	}{
		{"vary", "Cookie", []string{"Vary: Accept-Encoding", "vary: Cookie"}},
		{"VARY", "Cookie", []string{"VARY: Cookie", "Vary: Accept-Encoding"}},
		{"vary", "Accept-Encoding", []string{"Vary: Accept-Encoding", "vary: Accept-Encoding"}},
		{"VARY", "*", []string{"VARY: *", "Vary: Accept-Encoding"}},
	}
	body := strings.Repeat("x", 4096)
	for _, c := range cases {
		t.Run(c.key+"="+c.value, func(t *testing.T) {
			handler := gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				delete(w.Header(), "Vary")
				w.Header()[c.key] = []string{c.value}
				w.Write([]byte(body))
			}))
			var got []string
			for _, line := range wireHeaderLines(t, handler) {
				if sameField(strings.SplitN(line, ":", 2)[0], "Vary") {
					got = append(got, line)
				}
			}
			if !slices.Equal(got, c.wantLines) {
				t.Errorf("Vary lines on the wire = %q, want %q", got, c.wantLines)
			}
			// what a cache reads: every line, joined, under one key
			srv := httptest.NewServer(handler)
			defer srv.Close()
			res, err := http.Get(srv.URL)
			if err != nil {
				t.Fatal(err)
			}
			res.Body.Close()
			joined := strings.Join(res.Header.Values("Vary"), ",")
			if !strings.Contains(joined, "Accept-Encoding") || (c.value != "Accept-Encoding" && !strings.Contains(joined, c.value)) {
				t.Errorf("client holds Vary %q: the handler's %q or Accept-Encoding is gone", joined, c.value)
			}
		})
	}
}
