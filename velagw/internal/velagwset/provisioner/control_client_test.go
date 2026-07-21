package provisioner

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/internal/gateway"
)

func TestHTTPControlClientUsesFencedProvisionerEndpoints(t *testing.T) {
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.Method+" "+r.URL.RequestURI())
		if r.Header.Get("Authorization") != "Bearer internal" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet:
			_, _ = w.Write([]byte(`{"success":true,"data":[{"id":"native","runtime_backend":"velagwset","writer_epoch":1,"lifecycle_revision":1,"version":1,"status":"pending"}]}`))
		default:
			_, _ = w.Write([]byte(`{"success":true,"data":{"id":"native","runtime_backend":"velagwset","writer_epoch":1,"lifecycle_revision":1,"version":2,"claim_token":"token","status":"provisioning"}}`))
		}
	}))
	defer server.Close()
	client := NewHTTPControlClient(server.URL, "internal", server.Client())
	requests, err := client.ListRequests(t.Context(), "prod", "llmgateway", "prod", gateway.SetProvisionStatusPending, 10)
	if err != nil || len(requests) != 1 {
		t.Fatalf("list requests=%+v err=%v", requests, err)
	}
	claimed, ok, err := client.Claim(t.Context(), requests[0], "p1", time.Minute)
	if err != nil || !ok || claimed.ClaimToken != "token" {
		t.Fatalf("claim=%+v ok=%v err=%v", claimed, ok, err)
	}
	if err := client.Release(t.Context(), claimed); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"GET /api/internal/velagwset-provisioner/set-provision-requests?fleet=prod&limit=10&namespace=llmgateway&source=prod&status=pending",
		"POST /api/internal/velagwset-provisioner/set-provision-requests/native/claim",
		"POST /api/internal/velagwset-provisioner/set-provision-requests/native/release",
	}
	if len(paths) != len(want) {
		t.Fatalf("paths=%v", paths)
	}
	for i := range want {
		if paths[i] != want[i] {
			t.Fatalf("path[%d]=%q want %q", i, paths[i], want[i])
		}
	}
}
