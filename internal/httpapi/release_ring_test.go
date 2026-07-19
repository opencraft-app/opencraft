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
	for _, path := range []string{"/api/admin/newapi-releases", "/api/admin/release-rings", "/api/admin/release-rollouts", "/api/admin/release-campaigns"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("path=%s status=%d", path, rec.Code)
		}
	}
}

func TestAdminReleaseCampaignLifecycleAPI(t *testing.T) {
	store := gateway.NewMemoryStore()
	if err := store.SaveSet(t.Context(), gateway.Set{ID: "set-canary", Status: gateway.SetStatusActive, CurrentReleaseID: "release-v1", ActiveRuntimeGeneration: 1}); err != nil {
		t.Fatal(err)
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
	for _, body := range []string{
		`{"id":"release-v1","version":"v1","image":"example.com/new-api@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","status":"stable"}`,
		`{"id":"release-v2","version":"v2","image":"example.com/new-api@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","status":"verified"}`,
	} {
		if rec := adminJSON(http.MethodPost, "/api/admin/newapi-releases", body); rec.Code != http.StatusCreated {
			t.Fatalf("create release status=%d body=%s", rec.Code, rec.Body.String())
		}
	}
	if rec := adminJSON(http.MethodPost, "/api/admin/release-rings", `{"id":"canary","name":"Canary","ordinal":0,"serving_release_id":"release-v1","set_ids":["set-canary"],"soak_seconds":60}`); rec.Code != http.StatusOK {
		t.Fatalf("create ring status=%d body=%s", rec.Code, rec.Body.String())
	}
	created := adminJSON(http.MethodPost, "/api/admin/release-campaigns", `{"target_release_id":"release-v2"}`)
	if created.Code != http.StatusAccepted {
		t.Fatalf("create campaign status=%d body=%s", created.Code, created.Body.String())
	}
	var payload struct {
		Data gateway.ReleaseCampaign `json:"data"`
	}
	if err := json.NewDecoder(created.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.Data.Status != gateway.ReleaseCampaignStatusPending || len(payload.Data.Rings) != 1 {
		t.Fatalf("campaign=%+v", payload.Data)
	}
	if list := adminJSON(http.MethodGet, "/api/admin/release-campaigns", ""); list.Code != http.StatusOK || !bytes.Contains(list.Body.Bytes(), []byte(payload.Data.ID)) {
		t.Fatalf("list status=%d body=%s", list.Code, list.Body.String())
	}
	if get := adminJSON(http.MethodGet, "/api/admin/release-campaigns/"+payload.Data.ID, ""); get.Code != http.StatusOK || !bytes.Contains(get.Body.Bytes(), []byte(`"target_release_id":"release-v2"`)) {
		t.Fatalf("get status=%d body=%s", get.Code, get.Body.String())
	}
	if paused := adminJSON(http.MethodPost, "/api/admin/release-campaigns/"+payload.Data.ID+"/pause", `{}`); paused.Code != http.StatusOK || !bytes.Contains(paused.Body.Bytes(), []byte(`"status":"paused"`)) {
		t.Fatalf("pause status=%d body=%s", paused.Code, paused.Body.String())
	}
	if resumed := adminJSON(http.MethodPost, "/api/admin/release-campaigns/"+payload.Data.ID+"/resume", `{}`); resumed.Code != http.StatusOK || !bytes.Contains(resumed.Body.Bytes(), []byte(`"status":"pending"`)) {
		t.Fatalf("resume status=%d body=%s", resumed.Code, resumed.Body.String())
	}
}
