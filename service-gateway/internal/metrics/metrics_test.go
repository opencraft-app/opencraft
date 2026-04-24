package metrics

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

func TestGatewayMetrics_ExposeRequestMetrics(t *testing.T) {
	reg := prometheus.NewRegistry()
	m := NewGatewayMetrics(reg)

	m.ObserveRequest(http.MethodGet, "sandbox", "/sandboxes/acef9b31-db1b-40e1-8e23-9d5309924078", http.StatusAccepted, 25*time.Millisecond)

	metricsRec := httptest.NewRecorder()
	metricsReq := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	m.Handler().ServeHTTP(metricsRec, metricsReq)
	if metricsRec.Code != http.StatusOK {
		t.Fatalf("expected metrics status 200, got %d", metricsRec.Code)
	}

	body := metricsRec.Body.String()
	if !strings.Contains(body, "service_gateway_http_requests_total") {
		t.Fatalf("expected request counter in metrics output, got %q", body)
	}
	if !strings.Contains(body, "service_gateway_http_request_duration_seconds") {
		t.Fatalf("expected request duration histogram in metrics output, got %q", body)
	}
	if !strings.Contains(body, `route="sandbox"`) {
		t.Fatalf("expected route label in metrics output, got %q", body)
	}
	if !strings.Contains(body, `endpoint="/sandboxes/:id"`) {
		t.Fatalf("expected normalized endpoint label in metrics output, got %q", body)
	}
}

func TestNormalizeEndpoint(t *testing.T) {
	tests := map[string]string{
		"":                                           "/",
		"/auth/session":                              "/auth/session",
		"/sandboxes/123":                             "/sandboxes/:id",
		"/sandboxes/acef9b31-db1b-40e1-8e23-9d5309924078": "/sandboxes/:id",
		"/users/claw-c2":                             "/users/claw-c2",
		"/artifacts/abc123def456ghi789":              "/artifacts/:id",
	}

	for input, want := range tests {
		if got := NormalizeEndpoint(input); got != want {
			t.Fatalf("NormalizeEndpoint(%q) = %q, want %q", input, got, want)
		}
	}
}
