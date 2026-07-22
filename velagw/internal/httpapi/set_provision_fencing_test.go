package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"git.woa.com/wisp/mono2/llmgateway/internal/gateway"
)

func TestVelaGWSetProvisionerClaimAndMaterializedAPI(t *testing.T) {
	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	request := gateway.SetProvisionRequest{
		ID: "prod:llmgateway:prod:set-a", Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: "set-a",
		RuntimeBackend: gateway.SetRuntimeBackendVelaGWSet, WriterEpoch: 3, LifecycleRevision: 1,
		Status: gateway.SetProvisionStatusPending, Version: 1,
	}
	if err := store.SaveSetProvisionRequest(t.Context(), request); err != nil {
		t.Fatal(err)
	}
	handler := NewControlServer(svc, Config{InternalToken: "internal-token"})
	post := func(path, body string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(body))
		req.Header.Set("Authorization", "Bearer internal-token")
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}

	claim := post("/api/internal/velagwset-provisioner/set-provision-requests/"+request.ID+"/claim", `{
		"writer_epoch":3,"lifecycle_revision":1,"owner":"provisioner-a","lease_seconds":60
	}`)
	if claim.Code != http.StatusOK {
		t.Fatalf("claim status=%d body=%s", claim.Code, claim.Body.String())
	}
	var claimResponse struct {
		Data gateway.SetProvisionRequest `json:"data"`
	}
	if err := json.NewDecoder(claim.Body).Decode(&claimResponse); err != nil {
		t.Fatal(err)
	}
	claimed := claimResponse.Data
	if claimed.ClaimToken == "" || claimed.Status != gateway.SetProvisionStatusProvisioning {
		t.Fatalf("claimed request = %+v", claimed)
	}

	materializedBody, err := json.Marshal(map[string]any{
		"writer_epoch": 3, "lifecycle_revision": 1,
		"expected_status": gateway.SetProvisionStatusProvisioning, "expected_version": claimed.Version,
		"claim_token": claimed.ClaimToken, "cr_uid": "cr-uid", "cr_generation": 2,
		"runtime_secret_uid": "secret-uid", "runtime_identity_digest": "identity",
		"bootstrap_job_uid": "job-uid",
		"fact":              map[string]any{"set_id": "set-a", "base_url": "http://prod-set-a-newapi-admin:3000", "shard_ref": "shard-a", "database_name": "newapi_set_a", "redis_db": "3"},
	})
	if err != nil {
		t.Fatal(err)
	}
	materialized := post("/api/internal/velagwset-provisioner/set-provision-requests/"+request.ID+"/materialized", string(materializedBody))
	if materialized.Code != http.StatusOK {
		t.Fatalf("materialized status=%d body=%s", materialized.Code, materialized.Body.String())
	}
	stored, ok, err := store.GetSetProvisionRequest(t.Context(), request.ID)
	if err != nil || !ok || stored.Status != gateway.SetProvisionStatusCreated || stored.AdminFactHash == "" {
		t.Fatalf("stored ok=%v err=%v request=%+v", ok, err, stored)
	}

	stale := post("/api/internal/velagwset-provisioner/set-provision-requests/"+request.ID+"/materialized", string(materializedBody))
	if stale.Code != http.StatusConflict {
		t.Fatalf("stale status=%d body=%s", stale.Code, stale.Body.String())
	}
}

func TestVelaGWSetProvisionerCanReleaseClaimWhileWaiting(t *testing.T) {
	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	request := gateway.SetProvisionRequest{
		ID: "native", Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: "set-a",
		RuntimeBackend: gateway.SetRuntimeBackendVelaGWSet, WriterEpoch: 1, LifecycleRevision: 1,
		Status: gateway.SetProvisionStatusPending, Version: 1,
	}
	if err := store.SaveSetProvisionRequest(t.Context(), request); err != nil {
		t.Fatal(err)
	}
	handler := NewControlServer(svc, Config{InternalToken: "internal-token"})
	post := func(path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(body))
		req.Header.Set("Authorization", "Bearer internal-token")
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}
	claim := post("/api/internal/velagwset-provisioner/set-provision-requests/native/claim", `{"writer_epoch":1,"lifecycle_revision":1,"owner":"p1","lease_seconds":60}`)
	if claim.Code != http.StatusOK {
		t.Fatalf("claim status=%d body=%s", claim.Code, claim.Body.String())
	}
	var claimed struct {
		Data gateway.SetProvisionRequest `json:"data"`
	}
	if err := json.NewDecoder(claim.Body).Decode(&claimed); err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(map[string]any{
		"writer_epoch": 1, "lifecycle_revision": 1,
		"expected_version": claimed.Data.Version, "claim_token": claimed.Data.ClaimToken,
	})
	if err != nil {
		t.Fatal(err)
	}
	release := post("/api/internal/velagwset-provisioner/set-provision-requests/native/release", string(body))
	if release.Code != http.StatusOK {
		t.Fatalf("release status=%d body=%s", release.Code, release.Body.String())
	}
	stored, _, _ := store.GetSetProvisionRequest(t.Context(), request.ID)
	if stored.ClaimToken != "" || stored.Version != claimed.Data.Version+1 {
		t.Fatalf("stored request = %+v", stored)
	}
}
