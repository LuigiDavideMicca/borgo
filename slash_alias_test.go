package borgo

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

var crlf = string(rune(13)) + string(rune(10))

func adminMux() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/admin/{id}", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "ADMIN id="+r.PathValue("id"))
	})
	mux.HandleFunc("GET /api/public", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "public")
	})
	return mux
}

func denyAdmin() *appMiddleware {
	return &appMiddleware{matcher: []string{"/api/admin/*"}, wrap: func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "members only", http.StatusUnauthorized)
		})
	}}
}

// sent as written: a client library would clean or re-encode the target
func rawGet(t *testing.T, base, target string, headers ...string) (int, string) {
	t.Helper()
	c, err := net.Dial("tcp", strings.TrimPrefix(base, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(5 * time.Second))
	req := "GET " + target + " HTTP/1.1" + crlf + "Host: app.example" + crlf + "Connection: close" + crlf
	for _, h := range headers {
		req += h + crlf
	}
	io.WriteString(c, req+crlf)
	res, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(body)
}

// the app's middleware decided on the decoded, cleaned path and ServeMux
// matched the escaped one: /api/admin/x%2F..%2F..%2Fpublic was /api/public to
// the guard and /api/admin/{id} to the mux, on every port (found by the
// verifier of hunt 3's fixes)
func TestAnEncodedSlashCannotGoAroundTheApiGuardOnAnyPort(t *testing.T) {
	renderer := httptest.NewServer(routerLikeRenderer())
	t.Cleanup(renderer.Close)
	u, _ := url.Parse(renderer.URL)
	front := httptest.NewServer(newFrontHandler(Middleware(adminMux()), frontOptions{trusted: trustAll, app: denyAdmin()}, u, testInternalKey, time.Second))
	t.Cleanup(front.Close)
	alone := httptest.NewServer(apiOnlyHandler(nil, 1<<20, denyAdmin(), adminMux(), nil))
	t.Cleanup(alone.Close)
	internal := httptest.NewServer(internalHandler(testInternalKey, denyAdmin(), adminMux(), nil))
	t.Cleanup(internal.Close)
	ports := []struct {
		name, base string
		headers    []string
	}{
		{"front", front.URL, nil},
		{"api alone", alone.URL, nil},
		{"internal", internal.URL, []string{internalKeyHeader + ": " + testInternalKey}},
	}
	for _, port := range ports {
		for _, target := range []string{
			"/api/admin/x%2F..%2F..%2Fpublic",
			"/api/admin/x%2f..%2f..%2fpublic",
			"/api/admin/..%2F..%2Fpublic",
			"/api/admin/%2E%2E%2F..%2Fpublic",
			"/api/admin/x%2F%2F",
		} {
			code, body := rawGet(t, port.base, target, port.headers...)
			if strings.HasPrefix(body, "ADMIN") || code != http.StatusBadRequest {
				t.Errorf("%s %s: %d %q, want the 400", port.name, target, code, strings.TrimSpace(body))
			}
		}
		// an encoded slash inside one param's value decodes clean: the
		// param's own, and the guard still sees /api/admin/...
		if code, body := rawGet(t, port.base, "/api/admin/a%2Fb", port.headers...); code != http.StatusUnauthorized {
			t.Errorf("%s /api/admin/a%%2Fb: %d %q, want the guard's 401", port.name, code, strings.TrimSpace(body))
		}
	}
}

// a route table not read yet claimed nothing, and a public/ file of a page's
// name was served in its place until it was (found by the verifier of hunt
// 3's fixes)
func TestAPageIsNotShadowedWhileTheRouteTableIsUnread(t *testing.T) {
	root := t.TempDir()
	os.WriteFile(root+"/news", []byte("SHADOW FILE"), 0o644)
	renderer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == routesPath {
			http.Error(w, "starting", http.StatusServiceUnavailable)
			return
		}
		io.WriteString(w, "<html>the page</html>")
	}))
	t.Cleanup(renderer.Close)
	u, _ := url.Parse(renderer.URL)
	front := newFrontHandler(apiUnderTest(), frontOptions{trusted: trustAll, assets: newAssetIndex(root, buildOutputs{}, false)}, u, testInternalKey, time.Second)
	if w := agreementGet(front, "/news"); w.Body.String() != "<html>the page</html>" {
		t.Fatalf("/news with no route table: %d %q", w.Code, w.Body.String())
	}
}

// the key took the first value lowercased, the render was handed the header
// as sent: one rule now (found by the verifier of hunt 3's fixes)
func TestTheRenderIsToldTheSchemeTheKeyWasBuiltOn(t *testing.T) {
	var told string
	renderer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == routesPath {
			json.NewEncoder(w).Encode(map[string]any{"boot": 1, "routes": []map[string]any{}})
			return
		}
		told = r.Header.Get("X-Forwarded-Proto")
		io.WriteString(w, "<html></html>")
	}))
	t.Cleanup(renderer.Close)
	u, _ := url.Parse(renderer.URL)
	front := newFrontHandler(apiUnderTest(), frontOptions{trusted: trustAll}, u, testInternalKey, time.Second)
	for sent, want := range map[string]string{"HTTPS, http": "https", "gopher": "http", "http": "http"} {
		req := httptest.NewRequest("GET", "http://app.example/x", nil)
		req.Header.Set("X-Forwarded-Proto", sent)
		front.ServeHTTP(httptest.NewRecorder(), req)
		if told != want {
			t.Errorf("X-Forwarded-Proto %q: the render was told %q, want %q", sent, told, want)
		}
	}
}

// borgo.Middleware on a server of the app's own: a layer of the app's that
// hands on a copy left the upload's files behind (found by the verifier of
// hunt 3's fixes)
func TestMiddlewareCleansUploadsOnAServerOfTheAppsOwn(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TMP", dir)
	t.Setenv("TEMP", dir)
	t.Setenv("TMPDIR", dir)
	mux := cleanupMux(t)
	copying := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mux.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), struct{ name string }{"app"}, 1)))
	})
	postBigUpload(t, Middleware(copying))
	if n := tempFilesLeft(t, dir); n != 0 {
		t.Errorf("%d temporary files left", n)
	}
}

// the upload collector in borgo.Middleware handed the mux a copy, the mux
// wrote the pattern it matched on the copy, and the front counted every api
// request under /api/* (found by the e2e)
func TestTheApiIsCountedUnderItsPatternBehindMiddleware(t *testing.T) {
	counters := newMetrics(time.Now())
	renderer := httptest.NewServer(routerLikeRenderer())
	t.Cleanup(renderer.Close)
	u, _ := url.Parse(renderer.URL)
	front := newFrontHandler(Middleware(adminMux()), frontOptions{trusted: trustAll, metrics: counters}, u, testInternalKey, time.Second)
	front.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "http://app.example/api/public", nil))
	w := httptest.NewRecorder()
	front.ServeHTTP(w, httptest.NewRequest("GET", "http://app.example/metrics", nil))
	if !strings.Contains(w.Body.String(), `route="GET /api/public"`) {
		t.Fatalf("the api request was not counted under its pattern:%s%s", crlf, w.Body.String())
	}
}
