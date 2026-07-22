package cases

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHTTPInfrastructureRequiresControlTrafficMockAndPacer(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" || r.URL.Path == "/healthz" || r.URL.Path == "/readyz" {
			w.WriteHeader(http.StatusOK)
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()
	cfg := testConfig()
	cfg.ControlURL, cfg.TrafficURL, cfg.MockURL, cfg.PacerURL = server.URL, server.URL, server.URL, server.URL

	observations, err := (HTTPInfrastructure{}).Preflight(t.Context(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if observations["control_ready"] != true || observations["traffic_ready"] != true || observations["mock_ready"] != true || observations["pacer_ready"] != true {
		t.Fatalf("observations = %+v", observations)
	}
}
