package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"syscall"
	"testing"
	"testing/iotest"
)

func TestProxyFailureDiagnosticsDistinguishCanceledClient(t *testing.T) {
	var entry AccessLog
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	svc, key := diagnosticProxyService(t, roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if _, err := io.ReadAll(request.Body); err != nil {
			t.Fatal(err)
		}
		cancel()
		return nil, context.Canceled
	}), &entry)

	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader("hello")).WithContext(ctx)
	request.Header.Set("Authorization", "Bearer "+key)
	svc.ProxyHTTP(httptest.NewRecorder(), request)

	if entry.Status != http.StatusBadGateway || entry.ErrorType != "upstream_roundtrip_error" ||
		entry.ProxyErrorKind != "context_canceled" || entry.RequestContextError != "context_canceled" ||
		entry.UpstreamRoundTripMS == nil || entry.UpstreamResponseHeaderMS != nil || entry.UpstreamFirstByteMS != nil ||
		entry.RequestBodyErrorKind != "" || entry.RequestContentLength == nil || *entry.RequestContentLength != 5 ||
		entry.RequestBodyBytesRead == nil || *entry.RequestBodyBytesRead != 5 || entry.RequestBodyReadWaitMS == nil {
		t.Fatalf("unexpected cancellation diagnostics: %+v", entry)
	}
}

func TestProxyDiagnosticsRecordResponseHeaderAndFirstByte(t *testing.T) {
	var entry AccessLog
	svc, key := diagnosticProxyService(t, roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
			Body:       io.NopCloser(strings.NewReader("data: hello\n\n")),
		}, nil
	}), &entry)

	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader("hello"))
	request.Header.Set("Authorization", "Bearer "+key)
	svc.ProxyHTTP(httptest.NewRecorder(), request)

	if entry.Status != http.StatusOK || entry.UpstreamStatus != http.StatusOK ||
		entry.UpstreamRoundTripMS == nil || entry.UpstreamResponseHeaderMS == nil || entry.UpstreamFirstByteMS == nil ||
		*entry.UpstreamFirstByteMS < *entry.UpstreamResponseHeaderMS {
		t.Fatalf("unexpected response timing diagnostics: %+v", entry)
	}
}

func TestProxyDiagnosticsDoNotInventFirstByteForEmptyResponse(t *testing.T) {
	var entry AccessLog
	svc, key := diagnosticProxyService(t, roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusNoContent, Header: make(http.Header), Body: http.NoBody}, nil
	}), &entry)

	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	request.Header.Set("Authorization", "Bearer "+key)
	svc.ProxyHTTP(httptest.NewRecorder(), request)

	if entry.UpstreamRoundTripMS == nil || entry.UpstreamResponseHeaderMS == nil || entry.UpstreamFirstByteMS != nil {
		t.Fatalf("unexpected empty-response timing diagnostics: %+v", entry)
	}
}

func TestProxyFailureDiagnosticsRecordTruncatedInboundBody(t *testing.T) {
	var entry AccessLog
	svc, key := diagnosticProxyService(t, roundTripFunc(func(request *http.Request) (*http.Response, error) {
		_, err := io.ReadAll(request.Body)
		return nil, err
	}), &entry)

	body := io.NopCloser(io.MultiReader(strings.NewReader("abc"), iotest.ErrReader(io.ErrUnexpectedEOF)))
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", body)
	request.ContentLength = 5
	request.Header.Set("Authorization", "Bearer "+key)
	svc.ProxyHTTP(httptest.NewRecorder(), request)

	if entry.Status != http.StatusBadGateway || entry.ProxyErrorKind != "unexpected_eof" ||
		entry.RequestContextError != "" || entry.RequestBodyErrorKind != "unexpected_eof" ||
		entry.RequestContentLength == nil || *entry.RequestContentLength != 5 ||
		entry.RequestBodyBytesRead == nil || *entry.RequestBodyBytesRead != 3 || entry.RequestBodyReadWaitMS == nil {
		t.Fatalf("unexpected truncated-body diagnostics: %+v", entry)
	}
}

func TestProxyFailureDiagnosticsNeverLogRawErrorOrBody(t *testing.T) {
	var entry AccessLog
	svc, key := diagnosticProxyService(t, roundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("private-token-sk-do-not-log")
	}), &entry)

	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader("private-body-do-not-log"))
	request.Header.Set("Authorization", "Bearer "+key)
	svc.ProxyHTTP(httptest.NewRecorder(), request)
	encoded, err := json.Marshal(entry)
	if err != nil {
		t.Fatal(err)
	}
	if entry.ProxyErrorKind != "other" || strings.Contains(string(encoded), "private-token") ||
		strings.Contains(string(encoded), "private-body") || strings.Contains(string(encoded), key) {
		t.Fatalf("diagnostic log contains sensitive data: %s", encoded)
	}
}

func TestTrafficErrorKindPreservesSafeNetworkOperation(t *testing.T) {
	err := &net.OpError{Op: "write", Net: "tcp", Err: syscall.EPIPE}
	if got := trafficErrorKind(err); got != "broken_pipe" {
		t.Fatalf("error kind = %q, want broken_pipe", got)
	}
	if got := trafficErrorOp(err); got != "write" {
		t.Fatalf("error op = %q, want write", got)
	}
	unsafeOp := &net.OpError{Op: "private-token-sk-do-not-log", Err: syscall.EPIPE}
	if got := trafficErrorOp(unsafeOp); got != "" {
		t.Fatalf("unsafe error op = %q, want empty", got)
	}
}

func diagnosticProxyService(t *testing.T, transport http.RoundTripper, entry *AccessLog) (*Service, string) {
	t.Helper()
	store := NewMemoryStore()
	svc := NewService(store, transport, Options{AccessLogger: func(got AccessLog) { *entry = got }})
	if err := svc.RegisterSet(t.Context(), RegisterSetInput{ID: "set-a", BaseURL: "http://upstream", Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	key, _ := saveTestAPIKey(t, store, "diagnostic-error", APIKeyBinding{SetID: "set-a", UpstreamKey: "sk-upstream"})
	return svc, key
}
