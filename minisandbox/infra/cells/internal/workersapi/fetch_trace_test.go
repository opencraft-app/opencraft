package workersapi

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func traceAttributes(trace *fetchTransportTrace) map[string]slog.Value {
	values := make(map[string]slog.Value)
	for _, attr := range trace.attributes() {
		values[attr.Key] = attr.Value
	}
	return values
}

func TestFetchTraceHeaderTimeoutDoesNotReplay(t *testing.T) {
	release := make(chan struct{})
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		<-release
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	defer close(release)
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DisableKeepAlives = true
	transport.ResponseHeaderTimeout = 20 * time.Millisecond
	defer transport.CloseIdleConnections()
	request, err := http.NewRequest(http.MethodPost, server.URL+"/?secret=query-value", strings.NewReader("private-body"))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer private-token")
	request, trace := traceFetchRequest(request)
	response, err := (&http.Client{Transport: transport}).Do(request)
	if response != nil {
		response.Body.Close()
	}
	if err == nil {
		t.Fatal("expected the real transport header timeout")
	}
	attrs := traceAttributes(trace)
	if got := attrs["transport_phase"].String(); got != "awaiting_response_headers" {
		t.Fatalf("phase=%s, attrs=%v", got, attrs)
	}
	if calls.Load() != 1 || attrs["transport_connection_reused"].Bool() {
		t.Fatalf("request was replayed or connection reused: calls=%d attrs=%v", calls.Load(), attrs)
	}
	for _, key := range []string{"transport_connected_ms", "transport_written_ms", "transport_local_addr", "transport_peer_addr"} {
		if _, ok := attrs[key]; !ok {
			t.Fatalf("missing milestone %s", key)
		}
	}
	if _, ok := attrs["transport_first_byte_ms"]; ok {
		t.Fatal("recorded a response byte that never arrived")
	}
	for _, secret := range []string{"private-token", "private-body", "query-value", "Authorization"} {
		if strings.Contains(fmt.Sprint(attrs), secret) {
			t.Fatalf("trace exposes request data %q", secret)
		}
	}
}

func TestFetchTracePartialHeaders(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, buffered, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		if _, err := buffered.WriteString("HTTP/1.1 200 OK\r\nX-Test: incomplete"); err != nil {
			t.Error(err)
			return
		}
		if err := buffered.Flush(); err != nil {
			t.Error(err)
			return
		}
		<-release
	}))
	defer server.Close()
	defer close(release)
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = 50 * time.Millisecond
	defer transport.CloseIdleConnections()
	request, _ := http.NewRequest(http.MethodPost, server.URL, nil)
	request, trace := traceFetchRequest(request)
	response, err := (&http.Client{Transport: transport}).Do(request)
	if response != nil {
		response.Body.Close()
	}
	if err == nil {
		t.Fatal("expected timeout with incomplete response headers")
	}
	attrs := traceAttributes(trace)
	if attrs["transport_phase"].String() != "reading_response_headers" {
		t.Fatalf("partial header phase=%v", attrs)
	}
	if _, ok := attrs["transport_first_byte_ms"]; !ok {
		t.Fatal("missing the real first-byte milestone")
	}
}

func TestFetchTraceCancellationBeforeConnection(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	request, _ := http.NewRequestWithContext(ctx, http.MethodPost, "http://127.0.0.1:1/", nil)
	request, trace := traceFetchRequest(request)
	response, err := http.DefaultClient.Do(request)
	if response != nil {
		response.Body.Close()
	}
	if err == nil {
		t.Fatal("expected caller cancellation")
	}
	attrs := traceAttributes(trace)
	if attrs["transport_phase"].String() != "acquiring_connection" || len(attrs) != 2 {
		t.Fatalf("fabricated connection or write: %v", attrs)
	}
}

func TestFetchTracePreservesStreamingAndCallerCancellation(t *testing.T) {
	stopped := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(stopped)
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = time.Second
	defer transport.CloseIdleConnections()
	request, _ := http.NewRequestWithContext(ctx, http.MethodPost, server.URL, nil)
	request, trace := traceFetchRequest(request)
	response, err := (&http.Client{Transport: transport}).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if _, ok := request.Context().Deadline(); ok {
		t.Fatal("trace introduced an execution deadline")
	}
	if traceAttributes(trace)["transport_phase"].String() != "reading_response_headers" {
		t.Fatal("missing real streaming response headers")
	}
	cancel()
	if _, err := io.ReadAll(response.Body); err == nil {
		t.Fatal("caller cancellation did not terminate the body")
	}
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("upstream did not observe caller cancellation")
	}
}
