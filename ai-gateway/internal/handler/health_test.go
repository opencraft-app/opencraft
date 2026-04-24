package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"git.woa.com/wisp/mono/ai-gateway/internal/serverstate"
	"github.com/gin-gonic/gin"
)

func TestHealth_OK(t *testing.T) {
	gin.SetMode(gin.TestMode)

	h := NewHealthHandler(nil, nil)
	r := gin.New()
	r.GET("/health", h.Health)

	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/health", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var resp map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["status"] != "ok" {
		t.Errorf("expected status 'ok', got %v", resp["status"])
	}
}

func TestReady_NilDeps(t *testing.T) {
	gin.SetMode(gin.TestMode)

	h := NewHealthHandler(nil, nil)
	r := gin.New()
	r.GET("/ready", h.Ready)

	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/ready", nil)
	r.ServeHTTP(w, req)

	// With nil deps, should return 503
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d, body: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["status"] != "not ready" {
		t.Errorf("expected status 'not ready', got %v", resp["status"])
	}
}

func TestReady_DrainingReturns503(t *testing.T) {
	gin.SetMode(gin.TestMode)

	state := serverstate.NewDrainState()
	state.SetDraining(true)

	h := NewHealthHandlerWithDrainState(nil, nil, state)
	r := gin.New()
	r.GET("/ready", h.Ready)

	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/ready", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d, body: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["status"] != "draining" {
		t.Errorf("expected status 'draining', got %v", resp["status"])
	}
}
