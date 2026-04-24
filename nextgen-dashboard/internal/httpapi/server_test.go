package httpapi

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/openclaw/openclaw/mono/nextgen-dashboard/internal/command"
	"github.com/openclaw/openclaw/mono/nextgen-dashboard/internal/data"
)

func TestSessionEndpointRequiresBasicAuth(t *testing.T) {
	t.Parallel()

	server := NewServer(Config{
		Username: "admin",
		Password: "secret",
		Registry: command.NewRegistry(data.StaticProvider{}),
	})

	req := httptest.NewRequest(http.MethodGet, "/admin/api/session", nil)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
	if got := rec.Header().Get("WWW-Authenticate"); !strings.Contains(got, "Basic") {
		t.Fatalf("expected WWW-Authenticate header, got %q", got)
	}
}

func TestSessionEndpointReturnsAuthenticatedIdentity(t *testing.T) {
	t.Parallel()

	server := NewServer(Config{
		Username: "admin",
		Password: "secret",
		Registry: command.NewRegistry(data.StaticProvider{}),
	})

	req := httptest.NewRequest(http.MethodGet, "/admin/api/session", nil)
	req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte("admin:secret")))
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"username":"admin"`) {
		t.Fatalf("expected session payload with username, got %s", rec.Body.String())
	}
}

func TestHealthEndpointDoesNotRequireBasicAuth(t *testing.T) {
	t.Parallel()

	server := NewServer(Config{
		Username: "admin",
		Password: "secret",
		Registry: command.NewRegistry(data.StaticProvider{}),
	})

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	if strings.TrimSpace(rec.Body.String()) != "ok" {
		t.Fatalf("expected ok body, got %q", rec.Body.String())
	}
}
