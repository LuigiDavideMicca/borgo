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
