package ingressproxy

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"cvm-mock-e2b/internal/serverstate"
)

func TestReadyHandler(t *testing.T) {
	t.Parallel()

	drain := serverstate.NewDrainState()
	handler := ReadyHandler(drain)

	req := httptest.NewRequest(http.MethodGet, "/ready", nil)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200 when not draining, got %d", rr.Code)
	}

	drain.BeginDraining()

	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 when draining, got %d", rr.Code)
	}
}

func TestDrainHandlerAllowsLoopbackOnly(t *testing.T) {
	t.Parallel()

	drain := serverstate.NewDrainState()
	handler := DrainHandler(drain)

	req := httptest.NewRequest(http.MethodPost, "/drain", nil)
	req.RemoteAddr = "10.0.0.2:12345"
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for non-loopback drain request, got %d", rr.Code)
	}
	if drain.IsDraining() {
		t.Fatal("drain state should remain false after forbidden request")
	}

	req = httptest.NewRequest(http.MethodPost, "/drain", nil)
	req.RemoteAddr = "127.0.0.1:23456"
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200 for loopback drain request, got %d", rr.Code)
	}
	if !drain.IsDraining() {
		t.Fatal("drain state should be true after loopback drain request")
	}
}
