package borgo

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// a hung front server must not block the api handler that called Push
var pushClient = &http.Client{Timeout: 5 * time.Second, Transport: pushTransport()}

// every push goes to the same host, and DefaultTransport parks only two idle
// connections per host: concurrent pushes would open a socket per call and
// burn through the ephemeral port range
func pushTransport() *http.Transport {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.MaxIdleConnsPerHost = 64
	return t
}

// Push publishes an event to every browser subscribed to a websocket topic
// on the front server (see the subscribe helper in the borgo npm package).
// The front server is assumed on localhost; set FRONT_URL when it is not,
// and BORGO_PUSH_KEY on both sides when pushing across hosts.
//
// The payload type is visible to static analysis, so the plain name is the
// typed one - as with borgo.JSON[T] against WriteJSON. Called with literal
// topic and event strings, borgogen records T in the generated event map and
// the browser's subscribe callback for that topic is typed with it. Go infers
// T from data, so no call site has to spell it out. A dynamic topic or event
// name simply stays out of the map: the push still happens, the browser side
// stays untyped.
func Push[T any](topic, event string, data T) error {
	payload, err := json.Marshal(map[string]any{"topic": topic, "event": event, "data": data})
	if err != nil {
		return err
	}

	base := os.Getenv("FRONT_URL")
	if base == "" {
		port := os.Getenv("PORT")
		if port == "" {
			port = "3000"
		}
		base = "http://localhost:" + port
	}

	url := strings.TrimRight(base, "/") + "/__borgo/publish"
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if key := os.Getenv("BORGO_PUSH_KEY"); key != "" {
		req.Header.Set("X-Borgo-Key", key)
	}

	resp, err := pushClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	// drain so the keep-alive connection is reusable
	io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
	if resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("borgo.Push: front server responded %d", resp.StatusCode)
	}
	return nil
}
