package borgo

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"
	"sort"
)

// Values a request carries down the chain, and the few that cross to the
// render service.
//
// borgo.With and borgo.Value are for the go side: api/middleware.go decides
// something - a role, a workspace, a tenant - and the handler behind it reads
// the decision instead of deciding again. borgo.Forward is the same, and also
// hands the value to middleware.ts and to loaders and actions as ctx.locals.
//
// Forwarding is explicit on purpose. Forwarding the whole context would mean
// serialising database handles and loggers; forwarding nothing would bring
// back the api("GET /api/me") every loader made to learn what the middleware
// already knew. A call that names the value makes visible in the code what
// crosses the process boundary.
const (
	localsHeader = "X-Borgo-Locals"
	// a header, and the proxies in front of borgo cut long ones without
	// saying so: forward an id, not a record
	maxLocalsBytes = 16 << 10
)

type valuesKey struct{}

type encodedLocalsKey struct{}

// requestValues is copied on every write: a request derived with With must
// not change what the request it came from reads
type requestValues struct {
	values    map[string]any
	forwarded map[string]bool
}

func valuesOf(r *http.Request) *requestValues {
	v, _ := r.Context().Value(valuesKey{}).(*requestValues)
	return v
}

func withValue(r *http.Request, key string, value any, forward bool) *http.Request {
	next := &requestValues{values: map[string]any{}, forwarded: map[string]bool{}}
	if prev := valuesOf(r); prev != nil {
		for k, v := range prev.values {
			next.values[k] = v
		}
		for k := range prev.forwarded {
			next.forwarded[k] = true
		}
	}
	next.values[key] = value
	if forward {
		next.forwarded[key] = true
	} else {
		delete(next.forwarded, key)
	}
	return r.WithContext(context.WithValue(r.Context(), valuesKey{}, next))
}

// With returns r carrying value under key, for the handlers behind the
// middleware that set it. The value stays in this process.
func With(r *http.Request, key string, value any) *http.Request {
	return withValue(r, key, value, false)
}

// Forward is With, and the value also reaches the render service: middleware.ts
// and every loader and action of the page see it as ctx.locals. It must encode
// as JSON; a value that does not answers 500 rather than rendering the page
// without it.
func Forward(r *http.Request, key string, value any) *http.Request {
	return withValue(r, key, value, true)
}

// Value reads what With or Forward set under key. The second result is false
// when nothing was set, or when what was set is not a T.
func Value[T any](r *http.Request, key string) (T, bool) {
	var zero T
	v := valuesOf(r)
	if v == nil {
		return zero, false
	}
	raw, ok := v.values[key]
	if !ok {
		return zero, false
	}
	typed, ok := raw.(T)
	return typed, ok
}

// withEncodedLocals encodes the forwarded values once, before the request
// crosses to the render service. It is done here and not in the proxy's
// Rewrite because Rewrite cannot answer an error, and the failure direction
// is a 500 - never a render whose middleware decision silently went missing.
func withEncodedLocals(w http.ResponseWriter, r *http.Request) (*http.Request, bool) {
	v := valuesOf(r)
	if v == nil || len(v.forwarded) == 0 {
		return r, true
	}
	keys := make([]string, 0, len(v.forwarded))
	for key := range v.forwarded {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make(map[string]json.RawMessage, len(keys))
	for _, key := range keys {
		raw, err := json.Marshal(v.values[key])
		if err != nil {
			log.Printf("borgo: borgo.Forward(%q) holds a value that does not encode as json (%v): %s %s answered 500 rather than rendered without it", key, err, r.Method, r.URL.Path)
			http.Error(w, "internal server error", http.StatusInternalServerError)
			return r, false
		}
		out[key] = raw
	}
	raw, _ := json.Marshal(out)
	encoded := base64.RawURLEncoding.EncodeToString(raw)
	if len(encoded) > maxLocalsBytes {
		log.Printf("borgo: values forwarded with borgo.Forward encode to %d bytes, over the %d a header crosses a proxy with: forward an id, not a record (%s %s answered 500)", len(encoded), maxLocalsBytes, r.Method, r.URL.Path)
		http.Error(w, "internal server error", http.StatusInternalServerError)
		return r, false
	}
	return r.WithContext(context.WithValue(r.Context(), encodedLocalsKey{}, encoded)), true
}

func encodedLocals(r *http.Request) string {
	s, _ := r.Context().Value(encodedLocalsKey{}).(string)
	return s
}
