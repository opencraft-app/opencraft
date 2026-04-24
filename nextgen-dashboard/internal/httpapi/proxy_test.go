package httpapi

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/openclaw/openclaw/mono/nextgen-dashboard/internal/command"
	"github.com/openclaw/openclaw/mono/nextgen-dashboard/internal/data"
	"github.com/openclaw/openclaw/mono/nextgen-dashboard/internal/proxyauth"
)

func TestProxyExecuteAcceptsBearerToken(t *testing.T) {
	t.Parallel()

	server := NewServer(Config{
		Username:         "admin",
		Password:         "secret",
		Registry:         command.NewRegistry(data.StaticProvider{}),
		ProxyTokenSecret: "proxy-secret",
	})

	token, err := proxyauth.New("proxy-secret").Mint("skipzhang", time.Hour)
	if err != nil {
		t.Fatalf("mint token: %v", err)
	}

	body := bytes.NewBufferString(`{"command":"users list --json"}`)
	req := httptest.NewRequest(http.MethodPost, "/admin/api/commands/proxy", body)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"mode":"command"`) {
		t.Fatalf("expected command response, got %s", rec.Body.String())
	}
}

func TestProxyExecuteRejectsShellCommand(t *testing.T) {
	t.Parallel()

	server := NewServer(Config{
		Username:         "admin",
		Password:         "secret",
		Registry:         command.NewRegistry(data.StaticProvider{}),
		ProxyTokenSecret: "proxy-secret",
	})

	token, err := proxyauth.New("proxy-secret").Mint("skipzhang", time.Hour)
	if err != nil {
		t.Fatalf("mint token: %v", err)
	}

	payload, _ := json.Marshal(map[string]string{"command": "shell"})
	req := httptest.NewRequest(http.MethodPost, "/admin/api/commands/proxy", bytes.NewReader(payload))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestSessionEndpointStillRequiresBasicAuth(t *testing.T) {
	t.Parallel()

	server := NewServer(Config{
		Username:         "admin",
		Password:         "secret",
		Registry:         command.NewRegistry(data.StaticProvider{}),
		ProxyTokenSecret: "proxy-secret",
	})

	req := httptest.NewRequest(http.MethodGet, "/admin/api/session", nil)
	req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte("admin:secret")))

	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
}
