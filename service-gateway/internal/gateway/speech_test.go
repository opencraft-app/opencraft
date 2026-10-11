package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSpeechRouteAuthenticationAndStreaming(t *testing.T) {
	t.Setenv("TEST_SPEECH_TOKEN", "test-admin")
	var lookups atomic.Int32
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer session" {
			w.WriteHeader(401)
			return
		}
		io.WriteString(w, `{"session":{"user":{"id":"user-a"}}}`)
	}))
	defer auth.Close()
	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		lookups.Add(1)
		if r.Method != "POST" || r.URL.Path != "/api/admin/users/user-a/api-keys" || r.Header.Get("Authorization") != "Bearer test-admin" {
			t.Error("invalid key lookup authority")
		}
		var input struct {
			Name string `json:"name"`
		}
		json.NewDecoder(r.Body).Decode(&input)
		if input.Name != "default" {
			t.Error("not reusing default purpose")
		}
		io.WriteString(w, `{"success":true,"data":{"api_key":"sk-test-user-a"}}`)
	}))
	defer control.Close()
	var trafficCalls atomic.Int32
	traffic := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		trafficCalls.Add(1)
		if r.URL.Path != "/v1/audio/transcriptions" || r.Header.Get("Authorization") != "Bearer sk-test-user-a" {
			t.Error("wrong traffic authorization")
		}
		if r.Header.Get("Cookie") != "" || r.Header.Get("X-Lightclaw-User-ID") != "" || r.URL.RawQuery != "" {
			t.Error("caller authority leaked")
		}
		reader, err := r.MultipartReader()
		if err != nil {
			t.Error(err)
			return
		}
		var fields = map[string]string{}
		for {
			part, err := reader.NextPart()
			if err == io.EOF {
				break
			}
			if err != nil {
				t.Error(err)
				return
			}
			value, _ := io.ReadAll(part)
			fields[part.FormName()] = string(value)
		}
		if fields["model"] != "ep-hyasr3" || fields["file"] != "synthetic-audio" {
			t.Error("multipart bytes changed")
		}
		io.WriteString(w, `{"text":"你好","ignored":"diagnostic"}`)
	}))
	defer traffic.Close()
	handler, err := NewHandler(Config{AuthServiceURL: auth.URL, Speech: &SpeechConfig{ControlURL: control.URL, TrafficURL: traffic.URL, AdminTokenEnv: "TEST_SPEECH_TOKEN", AllowedOrigins: []string{"https://console.test"}}})
	if err != nil {
		t.Fatal(err)
	}
	request := func(path, token string) *httptest.ResponseRecorder {
		var body bytes.Buffer
		writer := multipart.NewWriter(&body)
		writer.WriteField("model", "ep-hyasr3")
		part, _ := writer.CreateFormFile("file", "speech.wav")
		io.WriteString(part, "synthetic-audio")
		writer.Close()
		req := httptest.NewRequest("POST", path, &body)
		req.Header.Set("Content-Type", writer.FormDataContentType())
		req.Header.Set("Authorization", token)
		req.Header.Set("Cookie", "private=secret")
		req.Header.Set("X-Lightclaw-User-ID", "forged")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}
	if rec := request("/api/speech/transcriptions", ""); rec.Code != 401 {
		t.Fatal(rec.Code)
	}
	if lookups.Load() != 0 || trafficCalls.Load() != 0 {
		t.Fatal("anonymous request reached backend")
	}
	for range 2 {
		rec := request("/api/speech/transcriptions?user_id=attacker", "Bearer session")
		if rec.Code != 200 || rec.Body.String() != "{\"text\":\"你好\"}\n" || rec.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("invalid transcription response: %d", rec.Code)
		}
	}
	if lookups.Load() != 1 || trafficCalls.Load() != 2 {
		t.Fatal("default key not cached")
	}
	capReq := httptest.NewRequest("GET", "/api/speech/capabilities", nil)
	capReq.Header.Set("Authorization", "Bearer session")
	capReq.Header.Set("Origin", "https://console.test")
	capRec := httptest.NewRecorder()
	handler.ServeHTTP(capRec, capReq)
	if capRec.Code != 200 || strings.Contains(capRec.Body.String(), "sk-test") || capRec.Header().Get("Access-Control-Allow-Origin") != "https://console.test" {
		t.Fatal("capability credentials leaked or CORS missing")
	}
	preflight := httptest.NewRequest("OPTIONS", "/api/speech/transcriptions", nil)
	preflight.Header.Set("Origin", "https://untrusted.test")
	preflight.Header.Set("Access-Control-Request-Method", "POST")
	preRec := httptest.NewRecorder()
	handler.ServeHTTP(preRec, preflight)
	// Existing gateway CORS rejects an origin by omitting permission headers,
	// even when its preflight status is 204. The browser cannot send/read it.
	if preRec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("untrusted preflight admitted")
	}
	if rec := request("/api/speech/other", "Bearer session"); rec.Code != 404 {
		t.Fatal("unrestricted speech route")
	}
	if rec := request("/api/speech/transcriptions", "Bearer invalid"); rec.Code != 401 {
		t.Fatal("invalid session admitted")
	}
}

func TestSpeechChunkedUploadBoundedWithoutDisk(t *testing.T) {
	t.Setenv("TEST_SPEECH_TOKEN", "test-admin")
	var received atomic.Int64
	traffic := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n, _ := io.Copy(io.Discard, r.Body)
		received.Store(n)
		w.WriteHeader(400)
	}))
	defer traffic.Close()
	s, err := newSpeechService(SpeechConfig{ControlURL: traffic.URL, TrafficURL: traffic.URL, AdminTokenEnv: "TEST_SPEECH_TOKEN"})
	if err != nil {
		t.Fatal(err)
	}
	s.keys.entries["a"] = cachedSpeechKey{key: "sk-test", expires: time.Now().Add(time.Minute)}
	req := httptest.NewRequest("POST", "/api/speech/transcriptions", strings.NewReader(strings.Repeat("a", speechMaxBodyBytes+1024)))
	req.ContentLength = -1
	req.Header.Set("Content-Type", "multipart/form-data; boundary=test")
	rec := httptest.NewRecorder()
	s.serve(rec, req, "a")
	if rec.Code == 200 || received.Load() > speechMaxBodyBytes {
		t.Fatal("chunked upload bypassed body limit")
	}
}

func TestSpeechKeyCacheBoundedExpiryAndInvalidation(t *testing.T) {
	var calls int
	c := &speechKeyCache{entries: map[string]cachedSpeechKey{}, flights: map[string]*speechKeyFlight{}, ttl: time.Minute, capacity: 2, resolve: func(ctx context.Context, user string) (string, error) { calls++; return "sk-" + user, nil }}
	for _, user := range []string{"a", "b", "c"} {
		if _, err := c.get(t.Context(), user); err != nil {
			t.Fatal(err)
		}
	}
	if len(c.entries) != 2 {
		t.Fatal("cache exceeded capacity")
	}
	c.invalidate("c", "stale-key")
	if _, ok := c.entries["c"]; !ok {
		t.Fatal("stale failure evicted newer key")
	}
	c.invalidate("c", "sk-c")
	c.get(t.Context(), "c")
	c.mu.Lock()
	c.entries["c"] = cachedSpeechKey{key: "sk-c", expires: time.Now().Add(-time.Second)}
	c.mu.Unlock()
	c.get(t.Context(), "c")
	if calls != 5 {
		t.Fatal("expiry/invalidation did not refresh")
	}
}

func TestSpeechKeyCacheCoalescesAndCallerCancellationIsolated(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	c := &speechKeyCache{entries: map[string]cachedSpeechKey{}, flights: map[string]*speechKeyFlight{}, ttl: time.Minute, capacity: 2, resolve: func(ctx context.Context, user string) (string, error) {
		calls.Add(1)
		close(started)
		select {
		case <-release:
			return "sk-test", nil
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}}
	ctx, cancel := context.WithCancel(t.Context())
	first := make(chan error, 1)
	go func() { _, err := c.get(ctx, "a"); first <- err }()
	<-started
	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			key, err := c.get(t.Context(), "a")
			if err != nil || key != "sk-test" {
				t.Error("shared lookup failed")
			}
		}()
	}
	cancel()
	if !errors.Is(<-first, context.Canceled) {
		t.Fatal("caller cancellation ignored")
	}
	close(release)
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatal("lookups not coalesced")
	}
}

func TestSpeechUpstreamErrorsSanitizedAndKeyInvalidated(t *testing.T) {
	t.Setenv("TEST_SPEECH_TOKEN", "test-admin")
	traffic := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		w.WriteHeader(401)
		io.WriteString(w, "supplier-secret-diagnostic")
	}))
	defer traffic.Close()
	s, err := newSpeechService(SpeechConfig{ControlURL: traffic.URL, TrafficURL: traffic.URL, AdminTokenEnv: "TEST_SPEECH_TOKEN"})
	if err != nil {
		t.Fatal(err)
	}
	s.keys.entries["a"] = cachedSpeechKey{key: "sk-test", expires: time.Now().Add(time.Minute)}
	req := httptest.NewRequest("POST", "/api/speech/transcriptions", strings.NewReader("audio"))
	req.Header.Set("Content-Type", "multipart/form-data; boundary=test")
	rec := httptest.NewRecorder()
	s.serve(rec, req, "a")
	if rec.Code != 503 || strings.Contains(rec.Body.String(), "supplier-secret") {
		t.Fatal("upstream error leaked or mistaken for session expiry")
	}
	if len(s.keys.entries) != 0 {
		t.Fatal("rejected key retained")
	}
	req = httptest.NewRequest("POST", "/api/speech/transcriptions", strings.NewReader("audio"))
	req.Header.Set("Content-Type", "multipart/form-data; boundary=test")
	req.ContentLength = speechMaxBodyBytes + 1
	rec = httptest.NewRecorder()
	s.serve(rec, req, "a")
	if rec.Code != 413 {
		t.Fatal("large audio admitted")
	}
}

func TestSpeechConfigFailsClosedAndPendingKeyNotReposted(t *testing.T) {
	if _, err := newSpeechService(SpeechConfig{ControlURL: "http://control.test", TrafficURL: "http://traffic.test", AdminTokenEnv: "ABSENT_SPEECH_TEST_TOKEN"}); err == nil {
		t.Fatal("missing token admitted")
	}
	t.Setenv("TEST_SPEECH_TOKEN", "test-admin")
	var calls atomic.Int32
	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(202)
		io.WriteString(w, `{"success":true,"data":{"id":"cmd-test"}}`)
	}))
	defer control.Close()
	s, err := newSpeechService(SpeechConfig{ControlURL: control.URL, TrafficURL: control.URL, AdminTokenEnv: "TEST_SPEECH_TOKEN"})
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, err := s.keys.get(t.Context(), "a"); !errors.Is(err, errSpeechKeyPending) {
			t.Fatal("pending key interpreted as ready")
		}
	}
	if calls.Load() != 1 {
		t.Fatal("queued key request blindly reposted")
	}
}
