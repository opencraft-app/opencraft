package discovery

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/config"
)

func TestPolarisResolverUsesStaleCacheOnSidecarFailure(t *testing.T) {
	fail := false
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fail {
			http.Error(w, "sidecar down", http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":0,"info":"ok","instances":[{"host":"10.0.0.7","port":8080}]}`))
	}))
	defer sidecar.Close()

	staleOnError := true
	resolver, err := NewPolarisResolver(config.PolarisDiscoveryConfig{
		SidecarURL:   sidecar.URL,
		CacheTTL:     "1ns",
		StaleOnError: &staleOnError,
	}, sidecar.Client().Transport)
	if err != nil {
		t.Fatalf("new resolver: %v", err)
	}

	addr, err := resolver.Resolve(t.Context(), "billing", "Production")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if addr != "10.0.0.7:8080" {
		t.Fatalf("unexpected addr %q", addr)
	}

	fail = true
	addr, err = resolver.Resolve(t.Context(), "billing", "Production")
	if err != nil {
		t.Fatalf("resolve stale: %v", err)
	}
	if addr != "10.0.0.7:8080" {
		t.Fatalf("unexpected stale addr %q", addr)
	}
}
