package httpapi

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"git.woa.com/wisp/mono2/llmgateway/internal/gateway"
)

func TestAdminShellRequiresBuiltConsole(t *testing.T) {
	handler := NewServer(gateway.NewService(gateway.NewMemoryStore(), nil, gateway.Options{}), Config{})

	req := httptest.NewRequest(http.MethodGet, "/admin", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "LLMGateway console is not built") {
		t.Fatalf("unexpected body: %s", rec.Body.String())
	}
}

func TestAdminServesBuiltConsoleWhenDistIsConfigured(t *testing.T) {
	dist := t.TempDir()
	if err := os.Mkdir(filepath.Join(dist, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dist, "index.html"), []byte(`<div id="root"></div><script src="/assets/app.js"></script>`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dist, "assets", "app.js"), []byte(`console.log("llmgateway console")`), 0o644); err != nil {
		t.Fatal(err)
	}

	handler := NewServer(gateway.NewService(gateway.NewMemoryStore(), nil, gateway.Options{}), Config{
		ConsoleDist: dist,
	})

	adminReq := httptest.NewRequest(http.MethodGet, "/admin", nil)
	adminRec := httptest.NewRecorder()
	handler.ServeHTTP(adminRec, adminReq)
	if adminRec.Code != http.StatusOK {
		t.Fatalf("admin status = %d body = %s", adminRec.Code, adminRec.Body.String())
	}
	if !strings.Contains(adminRec.Body.String(), `/assets/app.js`) {
		t.Fatalf("built index not served: %s", adminRec.Body.String())
	}

	assetReq := httptest.NewRequest(http.MethodGet, "/assets/app.js", nil)
	assetRec := httptest.NewRecorder()
	handler.ServeHTTP(assetRec, assetReq)
	if assetRec.Code != http.StatusOK {
		t.Fatalf("asset status = %d body = %s", assetRec.Code, assetRec.Body.String())
	}
	if !strings.Contains(assetRec.Body.String(), "llmgateway console") {
		t.Fatalf("asset not served: %s", assetRec.Body.String())
	}
}

func TestAdminServesBuiltConsoleForNestedOperatorRoutes(t *testing.T) {
	dist := t.TempDir()
	if err := os.WriteFile(filepath.Join(dist, "index.html"), []byte(`<div id="root"></div><script src="/assets/app.js"></script>`), 0o644); err != nil {
		t.Fatal(err)
	}
	handler := NewServer(gateway.NewService(gateway.NewMemoryStore(), nil, gateway.Options{}), Config{ConsoleDist: dist})

	for _, path := range []string{
		"/admin/tenants/user-1",
		"/admin/model-configs/golden/releases/run-1",
		"/admin/infrastructure/shards/mysql-a",
		"/admin/operations/jobs",
		"/admin/diagnostics/data",
	} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s status = %d body = %s", path, rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), `/assets/app.js`) {
			t.Fatalf("%s did not serve console index: %s", path, rec.Body.String())
		}
	}
}
