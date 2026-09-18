package httpapi

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/internal/gateway"
	"git.woa.com/wisp/mono2/llmgateway/internal/lifecycle"
)

func TestReadyzReportsDrainingStateWithoutFailingHealthz(t *testing.T) {
	state := lifecycle.NewState()
	handler := NewServer(gateway.NewService(gateway.NewMemoryStore(), nil, gateway.Options{}), Config{
		Lifecycle: state,
	})

	assertStatus(t, handler, "/readyz", http.StatusOK)
	assertStatus(t, handler, "/healthz", http.StatusOK)

	state.BeginDraining()

	assertStatus(t, handler, "/readyz", http.StatusServiceUnavailable)
	assertStatus(t, handler, "/healthz", http.StatusOK)
}

func TestE2EHooksAreDisabledByDefault(t *testing.T) {
	handler := NewServer(gateway.NewService(gateway.NewMemoryStore(), nil, gateway.Options{}), Config{})

	assertStatus(t, handler, "/_llmgateway_e2e/inflight", http.StatusNotFound)
}

func TestPublicServersDoNotExposePrometheusMetrics(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("{}"))
	}))
	defer upstream.Close()

	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, upstream.Client().Transport, gateway.Options{AccessLogger: func(gateway.AccessLog) {}})
	if err := svc.RegisterSet(t.Context(), gateway.RegisterSetInput{ID: "set-a", BaseURL: upstream.URL, Status: gateway.SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	externalKey := externalKeyForHTTPTest(1)
	if err := store.SaveAPIKeyBinding(t.Context(), gateway.APIKeyBinding{
		ExternalKey:   externalKey,
		ExternalKeyID: "key-abc",
		SetID:         "set-a",
		UpstreamKey:   "sk-upstream",
	}); err != nil {
		t.Fatal(err)
	}
	savedBinding, ok, err := store.GetAPIKeyBindingByExternalKey(t.Context(), externalKey)
	if err != nil || !ok {
		t.Fatalf("saved binding lookup ok=%v err=%v", ok, err)
	}
	handler := NewTrafficServer(svc, Config{})

	proxyReq := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	proxyReq.Header.Set("Authorization", "Bearer "+externalKey)
	proxyRec := httptest.NewRecorder()
	handler.ServeHTTP(proxyRec, proxyReq)
	if proxyRec.Code != http.StatusOK {
		t.Fatalf("proxy status=%d body=%s", proxyRec.Code, proxyRec.Body.String())
	}

	if metrics := svc.PrometheusMetrics(); !strings.Contains(metrics, `external_key_id="`+savedBinding.ExternalKeyID+`"`) {
		t.Fatalf("internal metrics aggregation was removed unexpectedly:\n%s", metrics)
	}

	for name, publicHandler := range map[string]http.Handler{
		"traffic":    handler,
		"control":    NewControlServer(svc, Config{}),
		"all-in-one": NewServer(svc, Config{}),
	} {
		t.Run(name, func(t *testing.T) {
			metricsReq := httptest.NewRequest(http.MethodGet, "/metrics", nil)
			metricsRec := httptest.NewRecorder()
			publicHandler.ServeHTTP(metricsRec, metricsReq)
			if metricsRec.Code != http.StatusNotFound {
				t.Fatalf("metrics status=%d body=%s, want 404", metricsRec.Code, metricsRec.Body.String())
			}
			if body := metricsRec.Body.String(); strings.Contains(body, "llmgateway_") || strings.Contains(body, savedBinding.ExternalKeyID) {
				t.Fatalf("public metrics response leaked telemetry: %s", body)
			}
		})
	}
}

func TestE2ESlowRequestHookReportsInflightUntilCompletion(t *testing.T) {
	handler := NewServer(gateway.NewService(gateway.NewMemoryStore(), nil, gateway.Options{}), Config{
		E2EHooks: true,
	})
	server := httptest.NewServer(handler)
	defer server.Close()

	done := make(chan string, 1)
	go func() {
		resp, err := http.Get(server.URL + "/_llmgateway_e2e/sleep?duration=80ms")
		if err != nil {
			done <- err.Error()
			return
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		done <- strings.TrimSpace(string(body))
	}()

	waitForInflightCount(t, server.URL, "1")

	select {
	case body := <-done:
		if body != "done" {
			t.Fatalf("slow hook body = %q, want done", body)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for slow hook")
	}
	waitForInflightCount(t, server.URL, "0")
}

func assertStatus(t *testing.T, handler http.Handler, path string, status int) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != status {
		t.Fatalf("%s status = %d body = %s, want %d", path, rec.Code, rec.Body.String(), status)
	}
}

func waitForInflightCount(t *testing.T, serverURL string, want string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(serverURL + "/_llmgateway_e2e/inflight")
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		got := strings.TrimSpace(string(body))
		if got == want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("inflight count did not become %s", want)
}
