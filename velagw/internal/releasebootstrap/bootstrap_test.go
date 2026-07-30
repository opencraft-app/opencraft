package releasebootstrap

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"git.woa.com/wisp/mono2/llmgateway/internal/gateway"
)

func TestEnsureCreatesMissingReleaseBeforeRings(t *testing.T) {
	var writes []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer admin-token" {
			t.Fatalf("authorization = %q", r.Header.Get("Authorization"))
		}
		switch r.Method + " " + r.URL.Path {
		case "GET /api/admin/newapi-releases", "GET /api/admin/release-rings":
			_, _ = w.Write([]byte(`{"success":true,"data":[]}`))
		case "POST /api/admin/newapi-releases":
			writes = append(writes, "release")
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"success":true}`))
		case "POST /api/admin/release-rings":
			writes = append(writes, "ring")
			_, _ = w.Write([]byte(`{"success":true}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	err := Ensure(context.Background(), server.Client(), Config{
		ControlURL: server.URL, AdminToken: "admin-token",
		Release: gateway.CreateNewAPIReleaseInput{
			ID: "release-v1", Source: "prod", Namespace: "llmgateway", Fleet: "prod",
			Version: "v1", Image: "registry/new-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			Compatibility: "expand_compatible", Status: gateway.NewAPIReleaseStatusStable,
		},
		Rings: []Ring{{Input: gateway.UpsertReleaseRingInput{
			ID: "stable", Source: "prod", Namespace: "llmgateway", Fleet: "prod", Name: "Stable",
			Ordinal: 30, ServingReleaseID: "release-v1", AdmissionEnabled: true, MaxParallel: 1,
		}, SoakSeconds: 60}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(writes, []string{"release", "ring"}) {
		t.Fatalf("writes = %v, want release then ring", writes)
	}
}

func TestEnsureLeavesMatchingReleaseAndRollingRingUntouched(t *testing.T) {
	writes := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writes++
		}
		switch r.URL.Path {
		case "/api/admin/newapi-releases":
			_, _ = w.Write([]byte(`{"success":true,"data":[{"id":"release-v1","source":"prod","namespace":"llmgateway","fleet":"prod","version":"v1","image":"registry/new-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","compatibility":"expand_compatible","status":"stable"}]}`))
		case "/api/admin/release-rings":
			_, _ = w.Write([]byte(`{"success":true,"data":[{"id":"stable","source":"prod","namespace":"llmgateway","fleet":"prod","name":"Stable","ordinal":30,"serving_release_id":"release-v1","status":"rolling","admission_enabled":true,"max_parallel":1,"soak_seconds":60}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	err := Ensure(context.Background(), server.Client(), testConfig(server.URL))
	if err != nil {
		t.Fatal(err)
	}
	if writes != 0 {
		t.Fatalf("writes = %d, want no mutation of existing release state", writes)
	}
}

func TestEnsureAllowsCosmeticRingNameDrift(t *testing.T) {
	writes := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writes++
		}
		switch r.URL.Path {
		case "/api/admin/newapi-releases":
			_, _ = w.Write([]byte(`{"success":true,"data":[{"id":"release-v1","source":"prod","namespace":"llmgateway","fleet":"prod","version":"v1","image":"registry/new-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","compatibility":"expand_compatible","status":"stable"}]}`))
		case "/api/admin/release-rings":
			_, _ = w.Write([]byte(`{"success":true,"data":[{"id":"stable","source":"prod","namespace":"llmgateway","fleet":"prod","name":"生产稳定环","ordinal":30,"serving_release_id":"release-v1","status":"steady","admission_enabled":true,"max_parallel":1,"soak_seconds":60}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	if err := Ensure(context.Background(), server.Client(), testConfig(server.URL)); err != nil {
		t.Fatalf("cosmetic ring name drift must not block bootstrap: %v", err)
	}
	if writes != 0 {
		t.Fatalf("writes = %d, want cosmetic drift left untouched", writes)
	}
}

func TestEnsureAllowsServingReleaseToAdvance(t *testing.T) {
	writes := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writes++
		}
		switch r.URL.Path {
		case "/api/admin/newapi-releases":
			_, _ = w.Write([]byte(`{"success":true,"data":[{"id":"release-v1","source":"prod","namespace":"llmgateway","fleet":"prod","version":"v1","image":"registry/new-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","compatibility":"expand_compatible","status":"stable"}]}`))
		case "/api/admin/release-rings":
			_, _ = w.Write([]byte(`{"success":true,"data":[{"id":"stable","source":"prod","namespace":"llmgateway","fleet":"prod","name":"Stable","ordinal":30,"serving_release_id":"release-v2","status":"steady","admission_enabled":true,"max_parallel":1,"soak_seconds":60}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	if err := Ensure(context.Background(), server.Client(), testConfig(server.URL)); err != nil {
		t.Fatalf("advanced serving release must not block bootstrap: %v", err)
	}
	if writes != 0 {
		t.Fatalf("writes = %d, want advanced serving release left untouched", writes)
	}
}

func TestEnsureRejectsExistingReleaseDrift(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"success":true,"data":[{"id":"release-v1","source":"prod","namespace":"llmgateway","fleet":"prod","version":"v1","image":"registry/new-api@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","compatibility":"expand_compatible","status":"stable"}]}`))
	}))
	defer server.Close()

	err := Ensure(context.Background(), server.Client(), testConfig(server.URL))
	if err == nil || !strings.Contains(err.Error(), "drift") {
		t.Fatalf("error = %v, want release drift", err)
	}
}

func testConfig(controlURL string) Config {
	return Config{
		ControlURL: controlURL, AdminToken: "admin-token",
		Release: gateway.CreateNewAPIReleaseInput{
			ID: "release-v1", Source: "prod", Namespace: "llmgateway", Fleet: "prod", Version: "v1",
			Image:         "registry/new-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			Compatibility: "expand_compatible", Status: gateway.NewAPIReleaseStatusStable,
		},
		Rings: []Ring{{Input: gateway.UpsertReleaseRingInput{
			ID: "stable", Source: "prod", Namespace: "llmgateway", Fleet: "prod", Name: "Stable",
			Ordinal: 30, ServingReleaseID: "release-v1", AdmissionEnabled: true, MaxParallel: 1,
		}, SoakSeconds: 60}},
	}
}
