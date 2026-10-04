package workersapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type secretError struct{}

func (secretError) Error() string { panic("raw error must not be formatted") }

func TestPlatformLoggerSanitizesErrorsAndPreservesFiniteClasses(t *testing.T) {
	for _, test := range []struct {
		name  string
		value any
		class string
	}{
		{"typed", &url.Error{Op: "Post", URL: "https://private-host/private-query", Err: io.EOF}, "eof"},
		{"opaque", secretError{}, "transport_error"},
		{"upstream", &upstreamError{Code: "private-code", Message: "private-message"}, "upstream_error"},
		{"unknown-string", "private-message", "unclassified_error"},
		{"finite-string", "connection_reset", "connection_reset"},
		{"deadline", context.DeadlineExceeded, "deadline"},
		{"number", 123, "unclassified_error"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var logs bytes.Buffer
			NewPlatformLogger(&logs).WithGroup("diagnostic").Error("constant platform event", "error", test.value, "request_id", "safe-correlation")
			var record struct {
				Diagnostic struct {
					Error     string `json:"error"`
					RequestID string `json:"request_id"`
				} `json:"diagnostic"`
			}
			if err := json.Unmarshal(logs.Bytes(), &record); err != nil {
				t.Fatal(err)
			}
			if record.Diagnostic.Error != test.class || record.Diagnostic.RequestID != "safe-correlation" {
				t.Fatalf("unexpected record: %#v", record)
			}
			if strings.Contains(logs.String(), "private-") {
				t.Fatal("raw error crossed the JSON handler")
			}
		})
	}
}

func TestPlatformHTTPLoggerDropsPayloadAndKeepsFiniteEventClasses(t *testing.T) {
	for _, test := range []struct{ prefix, class string }{
		{"http: panic serving ", "http_server_panic"},
		{"http: TLS handshake error from ", "tls_handshake_failed"},
		{"unknown server diagnostic ", "http_server_error"},
	} {
		var logs bytes.Buffer
		PlatformHTTPErrorLog(NewPlatformLogger(&logs), "private-listener-name").Print(test.prefix + "private-message\nprivate-stack")
		var record map[string]any
		if err := json.Unmarshal(logs.Bytes(), &record); err != nil {
			t.Fatal(err)
		}
		if record["error"] != test.class || record["listener"] != "unknown" || strings.Contains(logs.String(), "private-") {
			t.Fatalf("unsafe server record: %v", record)
		}
	}
}

func TestPlatformHTTPLoggerSanitizesARealHandlerPanic(t *testing.T) {
	logs := &diagnosticLogBuffer{written: make(chan struct{}, 1)}
	var executions atomic.Int32
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		executions.Add(1)
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
			return
		}
		panic(errors.New("private-panic:" + string(body)))
	}))
	server.Config.ErrorLog = PlatformHTTPErrorLog(NewPlatformLogger(logs), "public")
	server.Start()
	defer server.Close()
	response, err := server.Client().Post(server.URL, "text/plain", strings.NewReader("private-body"))
	if response != nil {
		response.Body.Close()
	}
	if err == nil || executions.Load() != 1 {
		t.Fatal("panic did not terminate the one real POST")
	}
	select {
	case <-logs.written:
	case <-time.After(time.Second):
		t.Fatal("HTTP server did not report its panic")
	}
	var record map[string]any
	if err := json.Unmarshal([]byte(logs.String()), &record); err != nil {
		t.Fatal(err)
	}
	if record["error"] != "http_server_panic" || record["listener"] != "public" {
		t.Fatalf("lost panic event: %v", record)
	}
	if strings.Contains(logs.String(), "private-") || strings.Contains(logs.String(), "goroutine") || strings.Contains(logs.String(), "platform_logger_test.go") {
		t.Fatal("panic value or stack escaped into platform logs")
	}
}
