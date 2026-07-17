package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"git.woa.com/wisp/mono2/llmgateway/internal/gateway"
)

func TestAdminReleaseRingRolloutLifecycleAPI(t *testing.T) {
	store := gateway.NewMemoryStore()
	for _, set := range []gateway.Set{
		{ID: "set-a", Status: gateway.SetStatusActive, ObservedUserCount: 20},
		{ID: "set-b", Status: gateway.SetStatusActive, ObservedUserCount: 5},
	} {
		if err := store.SaveSet(t.Context(), set); err != nil {
			t.Fatal(err)
		}
	}
	handler := NewServer(gateway.NewService(store, nil, gateway.Options{}), Config{AdminToken: "cluster-token"})
	adminJSON := func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
		req.Header.Set("Authorization", "Bearer cluster-token")
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}
	oldRelease := `{"id":"release-v1","version":"v1","image":"example.com/new-api@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","status":"stable"}`
	newRelease := `{"id":"release-v2","version":"v2","image":"example.com/new-api@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","status":"verified"}`
	for _, body := range []string{oldRelease, newRelease} {
		if rec := adminJSON(http.MethodPost, "/api/admin/newapi-releases", body); rec.Code != http.StatusCreated {
			t.Fatalf("create release status=%d body=%s", rec.Code, rec.Body.String())
		}
	}
	ringBody := `{"id":"stable","name":"Stable","ordinal":20,"serving_release_id":"release-v1","admission_enabled":true,"set_ids":["set-a","set-b"]}`
	if rec := adminJSON(http.MethodPost, "/api/admin/release-rings", ringBody); rec.Code != http.StatusOK {
		t.Fatalf("create ring status=%d body=%s", rec.Code, rec.Body.String())
	}
	rec := adminJSON(http.MethodPost, "/api/admin/release-rollouts", `{"ring_id":"stable","target_release_id":"release-v2","drain_timeout_seconds":15}`)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("create rollout status=%d body=%s", rec.Code, rec.Body.String())
	}
	var created struct {
		Data gateway.ReleaseRollout `json:"data"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	if created.Data.TotalSets != 2 || created.Data.Batch.Runs[0].SetID != "set-b" {
		t.Fatalf("rollout=%+v", created.Data)
	}
	get := adminJSON(http.MethodGet, "/api/admin/release-rollouts/"+created.Data.ID, "")
	if get.Code != http.StatusOK || !bytes.Contains(get.Body.Bytes(), []byte(`"status":"running"`)) {
		t.Fatalf("get rollout status=%d body=%s", get.Code, get.Body.String())
	}
	list := adminJSON(http.MethodGet, "/api/admin/release-rings", "")
	if list.Code != http.StatusOK || !bytes.Contains(list.Body.Bytes(), []byte(`"set_count":2`)) {
		t.Fatalf("list rings status=%d body=%s", list.Code, list.Body.String())
	}
}

func TestAdminReleaseEndpointsRequireAdmin(t *testing.T) {
	handler := NewServer(gateway.NewService(gateway.NewMemoryStore(), nil, gateway.Options{}), Config{AdminToken: "cluster-token"})
	for _, path := range []string{"/api/admin/newapi-releases", "/api/admin/release-rings", "/api/admin/release-rollouts"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("path=%s status=%d", path, rec.Code)
		}
	}
}
