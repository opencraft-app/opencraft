package runtime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Workers API returns 200 when another deploy already converged on the same
// targets; only 201 proves this request created the activation. Compensation
// must not overwrite that independently-owned deployment.
func TestMinisandboxDoesNotCompensateConvergedForeignActivation(t *testing.T) {
	posts := 0
	oldID, foreignID := "d_"+strings.Repeat("a", 32), "d_"+strings.Repeat("b", 32)
	oldVersion, version := "v_"+strings.Repeat("c", 64), "v_"+strings.Repeat("d", 64)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/versions"):
			_ = json.NewEncoder(w).Encode(map[string]string{"id": version})
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/deployment"):
			_ = json.NewEncoder(w).Encode(map[string]any{"id": oldID, "versions": []map[string]any{{"version_id": oldVersion, "percentage": 100}}})
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/deployments"):
			posts++
			if posts != 1 {
				t.Error("compensated another request's already-converged deployment")
			}
			// 200 is the native CAS-conflict convergence response, not an owned create.
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]any{"id": foreignID, "versions": []map[string]any{{"version_id": version, "percentage": 100}}})
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/dispatch"):
			_ = json.NewEncoder(w).Encode(map[string]string{"package_id": "not-the-requested-package"})
		default:
			t.Errorf("unexpected call %s %s", r.Method, r.URL.Path)
			w.WriteHeader(500)
		}
	}))
	defer upstream.Close()
	client, _ := newMinisandboxClient(upstream.URL, "cn-test", upstream.Client())
	_, err := client.Prepare(context.Background(), "ws-owner", map[string]Bundle{"wr-one": fixture()})
	if err == nil {
		t.Fatal("failed package readiness accepted")
	}
	if posts != 1 {
		t.Fatalf("expected only original CAS request, got %d", posts)
	}
}

func TestMinisandboxPrepareFencesStatelessVersionWatchConvergence(t *testing.T) {
	p, _ := buildMinisandboxPackage(map[string]Bundle{"wr-one": fixture()})
	statelessProbes := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/versions"):
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "v_" + strings.Repeat("a", 64)})
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/deployment"):
			w.WriteHeader(http.StatusNotFound)
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/deployments"):
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "d_" + strings.Repeat("b", 32)})
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/dispatch"):
			if r.Header.Get("X-Workers-Original-URL") != "https://website.invalid/__platform_prepare" {
				t.Error("probe invokes user code")
			}
			statelessProbes++
			id := p.PackageID
			if statelessProbes < 3 {
				id = strings.Repeat("c", 64)
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"package_id": id})
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/fetch"):
			_ = json.NewEncoder(w).Encode(map[string]string{"package_id": p.PackageID})
		default:
			t.Errorf("unexpected call %s %s", r.Method, r.URL.Path)
			w.WriteHeader(500)
		}
	}))
	defer upstream.Close()
	client, _ := newMinisandboxClient(upstream.URL, "cn-test", upstream.Client())
	_, err := client.Prepare(context.Background(), "ws-owner", map[string]Bundle{"wr-one": fixture()})
	if err != nil {
		t.Fatalf("cache convergence failed despite actual package becoming ready: %v", err)
	}
	if statelessProbes != 3 {
		t.Fatalf("actual execution fence was not verified: %d probes", statelessProbes)
	}
}
