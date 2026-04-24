package gateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/openclaw/openclaw/mono/service-gateway/internal/accesslog"
)

type recordingLogger struct {
	entries []accesslog.Entry
}

func (r *recordingLogger) Log(entry accesslog.Entry) {
	r.entries = append(r.entries, entry)
}

func TestGatewayEmitsAccessLogEntry(t *testing.T) {
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"session": map[string]any{
				"user": map[string]any{
					"id":    "usr_123",
					"email": "user@example.com",
				},
			},
		})
	}))
	defer auth.Close()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
	}))
	defer upstream.Close()

	logger := &recordingLogger{}
	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		Routes: []Route{
			{
				Name:     "sandbox",
				Prefix:   "/sandboxes",
				Upstream: upstream.URL,
				Access:   AccessAuthenticated,
			},
		},
	}, WithAccessLogger(logger))
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/sandboxes", nil)
	req.Header.Set("Authorization", "Bearer tok-123")
	req.Header.Set("User-Agent", "curl/8.7.1")
	req.RemoteAddr = "203.0.113.10:12345"
	rec := httptest.NewRecorder()

	start := time.Now()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d", rec.Code)
	}
	if len(logger.entries) != 1 {
		t.Fatalf("expected 1 access log entry, got %d", len(logger.entries))
	}

	entry := logger.entries[0]
	if entry.RouteName != "sandbox" {
		t.Fatalf("expected route sandbox, got %q", entry.RouteName)
	}
	if entry.Status != http.StatusCreated {
		t.Fatalf("expected status 201, got %d", entry.Status)
	}
	if entry.UserID != "usr_123" || entry.PlanTier != "" {
		t.Fatalf("expected identity headers in log, got %+v", entry)
	}
	if entry.DurationMS < 0 || entry.Timestamp.Before(start.Add(-time.Second)) {
		t.Fatalf("unexpected timing fields: %+v", entry)
	}
}

func TestGatewaySkipsCLBHealthcheckLogs(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer upstream.Close()

	logger := &recordingLogger{}
	handler, err := NewHandler(Config{
		AuthServiceURL: "http://auth.invalid",
		Routes: []Route{
			{
				Name:     "root",
				Prefix:   "/",
				Upstream: upstream.URL,
				Access:   AccessPublic,
			},
		},
	}, WithAccessLogger(logger))
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodHead, "/", nil)
	req.Header.Set("User-Agent", "clb-healthcheck")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if len(logger.entries) != 0 {
		t.Fatalf("expected clb healthcheck to be skipped, got %d entries", len(logger.entries))
	}
}
