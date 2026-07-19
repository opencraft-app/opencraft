package pacer

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestHandlerPacesUpstreamSSEWithoutChangingEvents(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"part\":1}\n\ndata: {\"part\":2}\n\ndata: [DONE]\n\n")
	}))
	defer upstream.Close()
	handler, err := NewHandler(upstream.URL, 60*time.Millisecond, "llmgw-regression-long", nil)
	if err != nil {
		t.Fatal(err)
	}
	pacer := httptest.NewServer(handler)
	defer pacer.Close()

	started := time.Now()
	resp, err := http.Post(pacer.URL+"/v1/chat/completions", "application/json", strings.NewReader(`{"model":"llmgw-regression-long","stream":true}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(started); elapsed < 55*time.Millisecond {
		t.Fatalf("elapsed = %s", elapsed)
	}
	body := string(raw)
	if strings.Count(body, "llmgateway-regression-keepalive") < 4 {
		t.Fatalf("body did not contain periodic keepalives: %q", body)
	}
	if !strings.Contains(body, `"delta":{"content":" "}`) {
		t.Fatalf("keepalive is not a relay-visible content delta: %q", body)
	}
	first := strings.Index(body, `data: {"part":1}`)
	second := strings.Index(body, `data: {"part":2}`)
	done := strings.Index(body, "data: [DONE]")
	if first < 0 || second <= first || done <= second || !strings.HasSuffix(body, "data: [DONE]\n\n") {
		t.Fatalf("upstream events were not preserved in order: %q", body)
	}
}

func TestFaultControlRequiresTokenAndFailsRelayDeterministically(t *testing.T) {
	upstreamCalls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		upstreamCalls++
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"ok"}}]}`)
	}))
	defer upstream.Close()
	handler, err := NewHandlerWithFaultControl(upstream.URL, time.Minute, "long", "fault-token", nil)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	defer server.Close()

	policy, _ := json.Marshal(FaultPolicy{Enabled: true, Model: "upgrade-probe", StatusCode: http.StatusServiceUnavailable, Message: "green probe failed"})
	unauthorized, err := http.Post(server.URL+"/__regression/fault", "application/json", bytes.NewReader(policy))
	if err != nil {
		t.Fatal(err)
	}
	_ = unauthorized.Body.Close()
	if unauthorized.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d", unauthorized.StatusCode)
	}

	req, _ := http.NewRequest(http.MethodPost, server.URL+"/__regression/fault", bytes.NewReader(policy))
	req.Header.Set("Authorization", "Bearer fault-token")
	req.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("fault update status = %d", response.StatusCode)
	}

	ordinary, err := http.Post(server.URL+"/v1/chat/completions", "application/json", strings.NewReader(`{"model":"ordinary"}`))
	if err != nil {
		t.Fatal(err)
	}
	_ = ordinary.Body.Close()
	if ordinary.StatusCode != http.StatusOK || upstreamCalls != 1 {
		t.Fatalf("ordinary status=%d upstream_calls=%d", ordinary.StatusCode, upstreamCalls)
	}

	failed, err := http.Post(server.URL+"/v1/chat/completions", "application/json", strings.NewReader(`{"model":"upgrade-probe"}`))
	if err != nil {
		t.Fatal(err)
	}
	_ = failed.Body.Close()
	if failed.StatusCode != http.StatusServiceUnavailable || upstreamCalls != 1 {
		t.Fatalf("failed status=%d upstream_calls=%d", failed.StatusCode, upstreamCalls)
	}

	disable, _ := json.Marshal(FaultPolicy{Enabled: false})
	req, _ = http.NewRequest(http.MethodPost, server.URL+"/__regression/fault", bytes.NewReader(disable))
	req.Header.Set("Authorization", "Bearer fault-token")
	req.Header.Set("Content-Type", "application/json")
	response, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("disable status = %d", response.StatusCode)
	}
	passed, err := http.Post(server.URL+"/v1/chat/completions", "application/json", strings.NewReader(`{"model":"upgrade-probe"}`))
	if err != nil {
		t.Fatal(err)
	}
	_ = passed.Body.Close()
	if passed.StatusCode != http.StatusOK || upstreamCalls != 2 {
		t.Fatalf("passed status=%d upstream_calls=%d", passed.StatusCode, upstreamCalls)
	}
}

func TestHandlerHealthDoesNotCallUpstream(t *testing.T) {
	handler, err := NewHandler("http://127.0.0.1:1", time.Minute, "llmgw-regression-long", nil)
	if err != nil {
		t.Fatal(err)
	}
	pacer := httptest.NewServer(handler)
	defer pacer.Close()
	resp, err := http.Get(pacer.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
}

func TestHandlerDoesNotPaceOrdinaryStreamingModel(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"part\":1}\n\ndata: [DONE]\n\n")
	}))
	defer upstream.Close()
	handler, err := NewHandler(upstream.URL, time.Minute, "llmgw-regression-long", nil)
	if err != nil {
		t.Fatal(err)
	}
	pacer := httptest.NewServer(handler)
	defer pacer.Close()

	started := time.Now()
	resp, err := http.Post(pacer.URL+"/v1/chat/completions", "application/json", strings.NewReader(`{"model":"llmgw-regression-chat","stream":true}`))
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("ordinary stream was paced: %s", elapsed)
	}
}

func TestNewHandlerRejectsInvalidUpstreamURL(t *testing.T) {
	if _, err := NewHandler("not-a-url", time.Minute, "long", nil); err == nil {
		t.Fatal("expected invalid upstream URL error")
	}
}
