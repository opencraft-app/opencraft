package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSSEPacerKeepsStreamOpenForConfiguredDuration(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"part\":1}\n\ndata: {\"part\":2}\n\ndata: [DONE]\n\n")
	}))
	defer upstream.Close()

	pacer := httptest.NewServer(newPacerHandler(upstream.URL, 120*time.Millisecond))
	defer pacer.Close()
	start := time.Now()
	resp, err := http.Post(pacer.URL+"/v1/chat/completions", "application/json", strings.NewReader(`{"stream":true}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(start); elapsed < 110*time.Millisecond {
		t.Fatalf("stream elapsed=%s, want at least 110ms", elapsed)
	}
	if !strings.Contains(string(body), "data: [DONE]") {
		t.Fatalf("stream body=%q", body)
	}
}

func TestSSEPacerDoesNotDelayNonStreamingResponse(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer upstream.Close()
	pacer := httptest.NewServer(newPacerHandler(upstream.URL, time.Second))
	defer pacer.Close()

	start := time.Now()
	resp, err := http.Post(pacer.URL+"/v1/chat/completions", "application/json", strings.NewReader(`{"stream":false}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if elapsed := time.Since(start); elapsed > 500*time.Millisecond {
		t.Fatalf("non-stream response was delayed: %s", elapsed)
	}
}
