package workersapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
)

func TestControlTransportFailureIsSanitizedAndNotReplayed(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if _, err := io.Copy(io.Discard, r.Body); err != nil {
			t.Error(err)
		}
		conn, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		conn.Close()
	}))
	defer server.Close()
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
	defer slog.SetDefault(previous)
	target, err := url.Parse(server.URL + "/private-object?secret=private-query")
	if err != nil {
		t.Fatal(err)
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DisableKeepAlives = true
	defer transport.CloseIdleConnections()
	api := &API{client: &http.Client{Transport: transport}, internalToken: "private-token"}
	ctx := context.WithValue(context.Background(), requestIDKey{}, "control-trace-test")
	upstream := api.requestJSON(ctx, http.MethodPost, target, map[string]string{"body": "private-body"}, nil)
	if upstream == nil || upstream.Status != 503 || upstream.Code != "upstream_unavailable" || calls.Load() != 1 {
		t.Fatalf("unexpected error/replay: error=%v calls=%d", upstream, calls.Load())
	}
	var record map[string]any
	if err := json.Unmarshal(logs.Bytes(), &record); err != nil {
		t.Fatal(err)
	}
	if record["error"] != "eof" || record["transport_phase"] != "awaiting_response_headers" {
		t.Fatalf("missing real transport diagnosis: %v", record)
	}
	if record["request_id"] != "control-trace-test" {
		t.Fatalf("lost request correlation: %v", record)
	}
	for _, secret := range []string{"private-object", "private-query", "private-body", "private-token", "Authorization", server.URL} {
		if strings.Contains(logs.String(), secret) {
			t.Fatalf("diagnostic exposes request data %q", secret)
		}
	}
}

func TestDiagnosticErrorClassUsesWrappedTypesNotMessages(t *testing.T) {
	for _, test := range []struct {
		err  error
		want string
	}{
		{context.Canceled, "cancelled"},
		{context.DeadlineExceeded, "deadline"},
		{&net.DNSError{Err: "private-dns-message", Name: "private-host"}, "dns"},
		{syscall.ECONNREFUSED, "connection_refused"},
		{syscall.ECONNRESET, "connection_reset"},
		{io.ErrUnexpectedEOF, "eof"},
		{ErrNoAdmissionCapacity, "no_admission_capacity"},
		{&upstreamError{Status: 503, Code: "private-code", Message: "private-upstream-message"}, "upstream_error"},
		{fmt.Errorf("private-transport-message"), "transport_error"},
	} {
		wrapped := &url.Error{Op: "Post", URL: "https://private-host/private-path?private-query", Err: test.err}
		if got := diagnosticErrorClass(wrapped); got != test.want {
			t.Errorf("class=%s want=%s", got, test.want)
		}
	}
}
