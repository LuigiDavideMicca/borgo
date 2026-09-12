package borgo

import (
	"encoding/json"
	"net/http"
	"net/url"
	"sync"
	"time"
)

// /healthz on the public port in front mode: the same shape the bun front
// server answered - status, uptime, and the other half's reachability -
// with the halves swapped. Answers anyone, so a flood of probes must not
// become a flood against the render service: the probe's result is shared
// for a second, the in-flight probe included, or a concurrent burst would
// all miss the memo together.

type renderProbe struct {
	mu       sync.Mutex
	at       time.Time
	state    string
	inflight chan struct{}
	probe    func() string
	now      func() time.Time
}

func newRenderProbe(renderer *url.URL, key string, transport http.RoundTripper) *renderProbe {
	client := &http.Client{Transport: transport, Timeout: 1500 * time.Millisecond}
	return &renderProbe{
		now: time.Now,
		probe: func() string {
			req, err := http.NewRequest(http.MethodGet, renderer.String()+"/healthz", nil)
			if err != nil {
				return "down"
			}
			req.Header.Set(internalKeyHeader, key)
			res, err := client.Do(req)
			if err != nil {
				return "down"
			}
			res.Body.Close()
			if res.StatusCode != http.StatusOK {
				return "down"
			}
			return "reachable"
		},
	}
}

func (p *renderProbe) reachability() string {
	p.mu.Lock()
	if p.inflight == nil && p.now().Sub(p.at) < time.Second && p.state != "" {
		state := p.state
		p.mu.Unlock()
		return state
	}
	if p.inflight != nil {
		wait := p.inflight
		p.mu.Unlock()
		<-wait
		p.mu.Lock()
		state := p.state
		p.mu.Unlock()
		return state
	}
	done := make(chan struct{})
	p.inflight = done
	p.mu.Unlock()

	state := p.probe()

	p.mu.Lock()
	p.state, p.at, p.inflight = state, p.now(), nil
	p.mu.Unlock()
	close(done)
	return state
}

// frontHealthz is the public /healthz: ok when the render service answers,
// degraded when it does not - the api itself is answering by definition
func frontHealthz(probe *renderProbe) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		render := probe.reachability()
		status := "ok"
		if render != "reachable" {
			status = "degraded"
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		json.NewEncoder(w).Encode(map[string]any{
			"status": status,
			"uptime": time.Since(startTime).Seconds(),
			"render": render,
		})
	})
}
