package httpapi

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestFederationBodyCaptureRejectsOversizedBody(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(federationBodyCaptureMiddleware())
	router.POST("/auth/federation/exchange", func(ctx *gin.Context) {
		ctx.Status(http.StatusNoContent)
	})
	req := httptest.NewRequest(http.MethodPost, "/auth/federation/exchange", bytes.NewReader(bytes.Repeat([]byte("x"), (1<<20)+1)))
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized federation body status = %d, want 413", recorder.Code)
	}
}

func TestCORSPreflightDoesNotExposeCORSHeaders(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouter()
	req := httptest.NewRequest(http.MethodOptions, "/auth/profile", nil)
	req.Header.Set("Origin", "https://lightclaw.pages.dev")
	req.Header.Set("Access-Control-Request-Method", http.MethodPut)
	req.Header.Set("Access-Control-Request-Headers", "content-type")

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, req)

	if recorder.Code == http.StatusNoContent {
		t.Fatalf("expected auth service to stop handling CORS preflight directly, got %d", recorder.Code)
	}
	if got := recorder.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("expected no allow-origin header, got %q", got)
	}
	if got := recorder.Header().Get("Access-Control-Allow-Credentials"); got != "" {
		t.Fatalf("expected no allow-credentials header, got %q", got)
	}
}

func TestHealthResponseDoesNotReflectOrigin(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouter()
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	req.Header.Set("Origin", "https://unknown.example.com")

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200 from /healthz, got %d", recorder.Code)
	}
	if got := recorder.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("expected no reflected allow-origin header, got %q", got)
	}
}

func TestRequestIDHeaderIsGeneratedWhenMissing(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouter()
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200 from /healthz, got %d", recorder.Code)
	}
	if got := recorder.Header().Get("X-Request-ID"); got == "" {
		t.Fatal("expected X-Request-ID header to be generated")
	}
}

func TestRequestIDHeaderPreservesIncomingValue(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouter()
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	req.Header.Set("X-Request-ID", "req-fixed-123")

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200 from /healthz, got %d", recorder.Code)
	}
	if got := recorder.Header().Get("X-Request-ID"); got != "req-fixed-123" {
		t.Fatalf("expected X-Request-ID to preserve incoming value, got %q", got)
	}
}
