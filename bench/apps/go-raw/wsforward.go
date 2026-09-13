package main

// GO_RAW_WS_FORWARD=<host:port>: the lean websocket forwarder of the phase 3
// spike - road A as it would ship, not as it runs today. Today the go front
// carries a websocket to bun through httputil.ReverseProxy, which keeps two
// connections, the request's goroutine and two 32 KB copiers alive for every
// socket (136 KiB measured). This is the least a forwarder can hold: the
// upgrade request replayed to the backend with the boot key the front adds,
// the 101 handed back, and then two byte copies with small buffers - no
// websocket parsing, the http server's buffers dropped after the handshake.

import (
	"bufio"
	"bytes"
	"io"
	"net"
	"net/http"
	"strings"
)

// per direction: frames of the relay are small, and the buffer only bounds
// how much one Read hands one Write
const forwardBuffer = 2 << 10

func wsForwardHandler(backend, key string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			http.Error(w, "upgrade required", http.StatusUpgradeRequired)
			return
		}
		upstream, err := net.Dial("tcp", backend)
		if err != nil {
			http.Error(w, "render service unreachable", http.StatusBadGateway)
			return
		}
		var req bytes.Buffer
		req.WriteString("GET " + r.URL.RequestURI() + " HTTP/1.1\r\nHost: " + r.Host + "\r\n")
		for name, values := range r.Header {
			if strings.EqualFold(name, "X-Borgo-Internal") {
				continue
			}
			for _, v := range values {
				req.WriteString(name + ": " + v + "\r\n")
			}
		}
		if key != "" {
			req.WriteString("X-Borgo-Internal: " + key + "\r\n")
		}
		req.WriteString("\r\n")
		if _, err := upstream.Write(req.Bytes()); err != nil {
			upstream.Close()
			http.Error(w, "render service write failed", http.StatusBadGateway)
			return
		}

		// the backend's response head, read through a small reader that is
		// dropped with whatever it buffered past the head carried along
		upReader := bufio.NewReaderSize(upstream, 512)
		var head bytes.Buffer
		for {
			line, err := upReader.ReadString('\n')
			if err != nil {
				upstream.Close()
				http.Error(w, "render service closed the handshake", http.StatusBadGateway)
				return
			}
			head.WriteString(line)
			if line == "\r\n" {
				break
			}
		}
		switchedProtocols := strings.HasPrefix(head.String(), "HTTP/1.1 101")

		hj, ok := w.(http.Hijacker)
		if !ok {
			upstream.Close()
			http.Error(w, "hijack unsupported", http.StatusInternalServerError)
			return
		}
		client, clientRW, err := hj.Hijack()
		if err != nil {
			upstream.Close()
			return
		}
		if _, err := client.Write(head.Bytes()); err != nil || !switchedProtocols {
			client.Close()
			upstream.Close()
			return
		}

		var fromUpstream io.Reader = upstream
		if n := upReader.Buffered(); n > 0 {
			pre, _ := upReader.Peek(n)
			fromUpstream = io.MultiReader(bytes.NewReader(append([]byte(nil), pre...)), upstream)
		}
		var fromClient io.Reader = client
		if n := clientRW.Reader.Buffered(); n > 0 {
			pre, _ := clientRW.Reader.Peek(n)
			fromClient = io.MultiReader(bytes.NewReader(append([]byte(nil), pre...)), client)
		}

		// wrapped so the copy uses the small buffer: *net.TCPConn implements
		// ReadFrom, io.CopyBuffer hands it the copy and ignores the buffer, and
		// on windows ReadFrom falls back to a copy of its own with 32 KB - the
		// first run of this forwarder held 94 KiB per socket, the proxy's
		// waste back in by the side door
		go func() {
			io.CopyBuffer(struct{ io.Writer }{client}, struct{ io.Reader }{fromUpstream}, make([]byte, forwardBuffer))
			client.Close()
			upstream.Close()
		}()
		go func() {
			io.CopyBuffer(struct{ io.Writer }{upstream}, struct{ io.Reader }{fromClient}, make([]byte, forwardBuffer))
			client.Close()
			upstream.Close()
		}()
	}
}
