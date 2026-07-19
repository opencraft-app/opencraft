package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"git.woa.com/wisp/mono2/llmgateway/internal/gateway"
)

func TestTrafficServerDoesNotExposeControlPlaneRoutes(t *testing.T) {
	svc := gateway.NewService(gateway.NewMemoryStore(), nil, gateway.Options{})
	handler := NewTrafficServer(svc, Config{AdminToken: "cluster-token"})

	for _, path := range []string{
		"/",
		"/admin",
		"/api/admin/login",
		"/api/sets",
		"/api/channel-bundles",
		"/_llmgateway_console/set-a/",
		"/console-sw.js",
	} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("Authorization", "Bearer cluster-token")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s status = %d, want 404; body=%s", path, rec.Code, rec.Body.String())
		}
	}
}

func TestTrafficServerRoutesKnownKeysAndRejectsUnknownKeys(t *testing.T) {
	newUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sk-upstream" {
			t.Fatalf("new upstream authorization = %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("X-Backend", "new")
		_, _ = w.Write([]byte("new"))
	}))
	defer newUpstream.Close()
	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	if err := svc.RegisterSet(t.Context(), gateway.RegisterSetInput{ID: "set-a", BaseURL: newUpstream.URL, Status: gateway.SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	externalKey := externalKeyForHTTPTest(2)
	if err := store.SaveAPIKeyBinding(t.Context(), gateway.APIKeyBinding{
		ExternalKey:   externalKey,
		ExternalKeyID: "key-new",
		SetID:         "set-a",
		UserID:        "user-new",
		UpstreamKey:   "sk-upstream",
	}); err != nil {
		t.Fatal(err)
	}
	handler := NewTrafficServer(svc, Config{})

	unknownReq := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"x"}`))
	unknownReq.Header.Set("Authorization", "Bearer sk-unknown")
	unknownRec := httptest.NewRecorder()
	handler.ServeHTTP(unknownRec, unknownReq)
	if unknownRec.Code != http.StatusUnauthorized {
		t.Fatalf("unknown key status=%d body=%s, want 401", unknownRec.Code, unknownRec.Body.String())
	}

	newReq := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"x"}`))
	newReq.Header.Set("Authorization", "Bearer "+externalKey)
	newRec := httptest.NewRecorder()
	handler.ServeHTTP(newRec, newReq)
	if newRec.Code != http.StatusOK || newRec.Body.String() != "new" || newRec.Header().Get("X-Backend") != "new" {
		t.Fatalf("new route status=%d headers=%v body=%s", newRec.Code, newRec.Header(), newRec.Body.String())
	}
}

func TestControlServerDoesNotExposeTrafficRoute(t *testing.T) {
	svc := gateway.NewService(gateway.NewMemoryStore(), nil, gateway.Options{})
	handler := NewControlServer(svc, Config{AdminToken: "cluster-token"})

	apiReq := httptest.NewRequest(http.MethodGet, "/api/sets", nil)
	apiReq.Header.Set("Authorization", "Bearer cluster-token")
	apiRec := httptest.NewRecorder()
	handler.ServeHTTP(apiRec, apiReq)
	if apiRec.Code != http.StatusOK {
		t.Fatalf("control mode /api/sets status = %d, want 200; body=%s", apiRec.Code, apiRec.Body.String())
	}

	trafficReq := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	trafficReq.Header.Set("Authorization", "Bearer missing")
	trafficRec := httptest.NewRecorder()
	handler.ServeHTTP(trafficRec, trafficReq)
	if trafficRec.Code != http.StatusNotFound {
		t.Fatalf("control mode /v1/models status = %d, want 404; body=%s", trafficRec.Code, trafficRec.Body.String())
	}
}
