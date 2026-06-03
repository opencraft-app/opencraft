package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPublicMuxDoesNotExposeMetricsHandler(t *testing.T) {
	mux := buildPublicMux(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "route_not_found", http.StatusNotFound)
	}))

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected public /metrics to fall through to gateway handler with 404, got %d", rec.Code)
	}
	if rec.Body.String() != "route_not_found\n" {
		t.Fatalf("expected gateway fallback body, got %q", rec.Body.String())
	}
}

func TestMetricsMuxExposesMetricsHandler(t *testing.T) {
	mux := buildMetricsMux(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("metrics"))
	}))

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected metrics /metrics 200, got %d", rec.Code)
	}
	if rec.Body.String() != "metrics" {
		t.Fatalf("expected metrics handler body, got %q", rec.Body.String())
	}
}
