package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/internal/gateway"
)

func TestTenantDeletionAdminAPIRequiresPreviewAndExpectedDigest(t *testing.T) {
	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	if err := store.SaveTenant(t.Context(), gateway.Tenant{ExternalUserID: "test-user-1", Status: gateway.TenantStatusActive}); err != nil {
		t.Fatal(err)
	}
	handler := NewControlServer(svc, Config{AdminToken: "admin-token"})

	previewReq := httptest.NewRequest(http.MethodPost, "/api/admin/tenant-deletions/preview", bytes.NewBufferString(`{"user_ids":["test-user-1"]}`))
	previewReq.Header.Set("Authorization", "Bearer admin-token")
	previewRes := httptest.NewRecorder()
	handler.ServeHTTP(previewRes, previewReq)
	if previewRes.Code != http.StatusAccepted {
		t.Fatalf("preview status=%d body=%s", previewRes.Code, previewRes.Body.String())
	}
	var preview struct {
		Success bool                      `json:"success"`
		Data    gateway.TenantDeletionJob `json:"data"`
	}
	if err := json.Unmarshal(previewRes.Body.Bytes(), &preview); err != nil {
		t.Fatal(err)
	}
	job, err := svc.RunTenantDeletionMaintenanceOnce(t.Context(), preview.Data.ID, 100)
	if err != nil {
		t.Fatal(err)
	}

	startBody, _ := json.Marshal(gateway.TenantDeletionStartInput{
		ExpectedTargetCount:  job.TargetCount,
		ExpectedTargetDigest: job.TargetDigest,
		IdempotencyKey:       "delete-test-user-1",
	})
	startReq := httptest.NewRequest(http.MethodPost, "/api/admin/tenant-deletions/"+job.ID+"/start", bytes.NewReader(startBody))
	startReq.Header.Set("Authorization", "Bearer admin-token")
	startRes := httptest.NewRecorder()
	handler.ServeHTTP(startRes, startReq)
	if startRes.Code != http.StatusAccepted {
		t.Fatalf("start status=%d body=%s", startRes.Code, startRes.Body.String())
	}

	listReq := httptest.NewRequest(http.MethodGet, "/api/admin/tenant-deletions", nil)
	listReq.Header.Set("Authorization", "Bearer admin-token")
	listRes := httptest.NewRecorder()
	handler.ServeHTTP(listRes, listReq)
	if listRes.Code != http.StatusOK || !bytes.Contains(listRes.Body.Bytes(), []byte(job.ID)) {
		t.Fatalf("list status=%d body=%s", listRes.Code, listRes.Body.String())
	}
}

func TestSetDecommissionAdminAPIPreviewsAndStartsEmptySet(t *testing.T) {
	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	if err := store.SaveSet(t.Context(), gateway.Set{ID: "set-a", Status: gateway.SetStatusActive, Setup: true}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveSetRuntimeLease(t.Context(), gateway.SetRuntimeLease{
		Source: "kro", Namespace: "llmgateway", Fleet: "prod", SetID: "set-a",
		ShardRef: "shard-a", DatabaseName: "newapi_set_a", RedisDB: "17",
	}); err != nil {
		t.Fatal(err)
	}
	handler := NewControlServer(svc, Config{AdminToken: "admin-token"})

	previewReq := httptest.NewRequest(http.MethodPost, "/api/admin/set-decommissions/preview", bytes.NewBufferString(`{"set_id":"set-a"}`))
	previewReq.Header.Set("Authorization", "Bearer admin-token")
	previewRes := httptest.NewRecorder()
	handler.ServeHTTP(previewRes, previewReq)
	if previewRes.Code != http.StatusOK {
		t.Fatalf("preview status=%d body=%s", previewRes.Code, previewRes.Body.String())
	}
	var preview struct {
		Data gateway.SetDecommissionPreview `json:"data"`
	}
	if err := json.Unmarshal(previewRes.Body.Bytes(), &preview); err != nil {
		t.Fatal(err)
	}
	startBody, _ := json.Marshal(gateway.SetDecommissionStartInput{
		SetID: "set-a", ExpectedDigest: preview.Data.Digest, IdempotencyKey: "delete-set-a",
	})
	startReq := httptest.NewRequest(http.MethodPost, "/api/admin/set-decommissions", bytes.NewReader(startBody))
	startReq.Header.Set("Authorization", "Bearer admin-token")
	startRes := httptest.NewRecorder()
	handler.ServeHTTP(startRes, startReq)
	if startRes.Code != http.StatusAccepted {
		t.Fatalf("start status=%d body=%s", startRes.Code, startRes.Body.String())
	}

	detailReq := httptest.NewRequest(http.MethodGet, "/api/admin/set-decommissions", nil)
	detailReq.Header.Set("Authorization", "Bearer admin-token")
	detailRes := httptest.NewRecorder()
	handler.ServeHTTP(detailRes, detailReq)
	if detailRes.Code != http.StatusOK || !bytes.Contains(detailRes.Body.Bytes(), []byte("set-a")) {
		t.Fatalf("list status=%d body=%s", detailRes.Code, detailRes.Body.String())
	}
}

func TestSetDecommissionAdminAPIRequiresExplicitCascadeForNonEmptySet(t *testing.T) {
	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	if err := store.SaveSet(t.Context(), gateway.Set{ID: "set-a", Status: gateway.SetStatusActive, Setup: true}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveSetRuntimeLease(t.Context(), gateway.SetRuntimeLease{
		Source: "kro", Namespace: "llmgateway", Fleet: "prod", SetID: "set-a",
		ShardRef: "shard-a", DatabaseName: "newapi_set_a", RedisDB: "17",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveTenant(t.Context(), gateway.Tenant{
		ExternalUserID: "user-1", Backend: gateway.UserBackendNew, SetID: "set-a", Status: gateway.TenantStatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	handler := NewControlServer(svc, Config{AdminToken: "admin-token"})

	previewReq := httptest.NewRequest(http.MethodPost, "/api/admin/set-decommissions/preview", bytes.NewBufferString(`{"set_id":"set-a"}`))
	previewReq.Header.Set("Authorization", "Bearer admin-token")
	previewRes := httptest.NewRecorder()
	handler.ServeHTTP(previewRes, previewReq)
	if previewRes.Code != http.StatusOK {
		t.Fatalf("preview status=%d body=%s", previewRes.Code, previewRes.Body.String())
	}
	var preview struct {
		Data gateway.SetDecommissionPreview `json:"data"`
	}
	if err := json.Unmarshal(previewRes.Body.Bytes(), &preview); err != nil {
		t.Fatal(err)
	}
	if preview.Data.Empty {
		t.Fatal("non-empty Set was reported as empty")
	}

	withoutCascadeBody, _ := json.Marshal(gateway.SetDecommissionStartInput{
		SetID: "set-a", ExpectedDigest: preview.Data.Digest, IdempotencyKey: "delete-set-a-without-cascade",
	})
	withoutCascadeReq := httptest.NewRequest(http.MethodPost, "/api/admin/set-decommissions", bytes.NewReader(withoutCascadeBody))
	withoutCascadeReq.Header.Set("Authorization", "Bearer admin-token")
	withoutCascadeRes := httptest.NewRecorder()
	handler.ServeHTTP(withoutCascadeRes, withoutCascadeReq)
	if withoutCascadeRes.Code != http.StatusConflict {
		t.Fatalf("non-cascade status=%d body=%s", withoutCascadeRes.Code, withoutCascadeRes.Body.String())
	}

	cascadeBody, _ := json.Marshal(gateway.SetDecommissionStartInput{
		SetID: "set-a", ExpectedDigest: preview.Data.Digest, IdempotencyKey: "cascade-set-a", CascadeTenants: true,
	})
	cascadeReq := httptest.NewRequest(http.MethodPost, "/api/admin/set-decommissions", bytes.NewReader(cascadeBody))
	cascadeReq.Header.Set("Authorization", "Bearer admin-token")
	cascadeRes := httptest.NewRecorder()
	handler.ServeHTTP(cascadeRes, cascadeReq)
	if cascadeRes.Code != http.StatusAccepted {
		t.Fatalf("cascade status=%d body=%s", cascadeRes.Code, cascadeRes.Body.String())
	}
	var started struct {
		Data gateway.SetDecommissionJob `json:"data"`
	}
	if err := json.Unmarshal(cascadeRes.Body.Bytes(), &started); err != nil {
		t.Fatal(err)
	}
	if started.Data.Status != gateway.SetDecommissionStatusPurgingTenants || !started.Data.CascadeTenants {
		t.Fatalf("cascade job=%+v", started.Data)
	}
}

func TestSetManagerInternalAPIExcludesCascadePreparationJobs(t *testing.T) {
	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	for _, setID := range []string{"set-ready", "set-cascade"} {
		if err := store.SaveSet(t.Context(), gateway.Set{ID: setID, Status: gateway.SetStatusActive, Setup: true}); err != nil {
			t.Fatal(err)
		}
		if err := store.SaveSetRuntimeLease(t.Context(), gateway.SetRuntimeLease{
			Source: "kro", Namespace: "llmgateway", Fleet: "prod", SetID: setID,
			ShardRef: "shard-a", DatabaseName: "newapi_" + setID, RedisDB: map[string]string{"set-ready": "17", "set-cascade": "18"}[setID],
		}); err != nil {
			t.Fatal(err)
		}
	}
	readyPreview, err := svc.PreviewSetDecommission(t.Context(), "set-ready")
	if err != nil {
		t.Fatal(err)
	}
	readyJob, err := svc.StartSetDecommission(t.Context(), gateway.SetDecommissionStartInput{
		SetID: "set-ready", ExpectedDigest: readyPreview.Digest, IdempotencyKey: "delete-ready",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveTenant(t.Context(), gateway.Tenant{
		ExternalUserID: "user-1", Backend: gateway.UserBackendNew, SetID: "set-cascade", Status: gateway.TenantStatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	cascadePreview, err := svc.PreviewSetDecommission(t.Context(), "set-cascade")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.StartSetDecommission(t.Context(), gateway.SetDecommissionStartInput{
		SetID: "set-cascade", ExpectedDigest: cascadePreview.Digest, IdempotencyKey: "delete-cascade", CascadeTenants: true,
	}); err != nil {
		t.Fatal(err)
	}

	handler := NewControlServer(svc, Config{AdminToken: "admin-token", InternalToken: "set-manager-token"})
	req := httptest.NewRequest(http.MethodGet, "/api/internal/set-manager/set-decommissions?phase=non_terminal&limit=1", nil)
	req.Header.Set("Authorization", "Bearer set-manager-token")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("list status=%d body=%s", res.Code, res.Body.String())
	}
	var listed struct {
		Data []gateway.SetDecommissionJob `json:"data"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Data) != 1 || listed.Data[0].ID != readyJob.ID {
		t.Fatalf("set-manager jobs=%+v, want only runtime-ready job %s", listed.Data, readyJob.ID)
	}
}

func TestSetManagerInternalAPIClaimsDecommissionWithScopedToken(t *testing.T) {
	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	if err := store.SaveSet(t.Context(), gateway.Set{ID: "set-a", Status: gateway.SetStatusActive, Setup: true}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveSetRuntimeLease(t.Context(), gateway.SetRuntimeLease{
		Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: "set-a",
		ShardRef: "shard-a", DatabaseName: "newapi_set_a", RedisDB: "17",
	}); err != nil {
		t.Fatal(err)
	}
	preview, _ := svc.PreviewSetDecommission(t.Context(), "set-a")
	job, err := svc.StartSetDecommission(t.Context(), gateway.SetDecommissionStartInput{
		SetID: "set-a", ExpectedDigest: preview.Digest, IdempotencyKey: "delete-set-a",
	})
	if err != nil {
		t.Fatal(err)
	}
	handler := NewControlServer(svc, Config{AdminToken: "admin-token", InternalToken: "set-manager-token"})

	unauthorized := httptest.NewRequest(http.MethodPost, "/api/internal/set-manager/set-decommissions/"+job.ID+"/claim", bytes.NewBufferString(`{"owner":"manager-a","lease_seconds":60}`))
	unauthorized.Header.Set("Authorization", "Bearer admin-token")
	unauthorizedRes := httptest.NewRecorder()
	handler.ServeHTTP(unauthorizedRes, unauthorized)
	if unauthorizedRes.Code != http.StatusUnauthorized {
		t.Fatalf("admin token claim status=%d body=%s", unauthorizedRes.Code, unauthorizedRes.Body.String())
	}

	claimReq := httptest.NewRequest(http.MethodPost, "/api/internal/set-manager/set-decommissions/"+job.ID+"/claim", bytes.NewBufferString(`{"owner":"manager-a","lease_seconds":60}`))
	claimReq.Header.Set("Authorization", "Bearer set-manager-token")
	claimRes := httptest.NewRecorder()
	handler.ServeHTTP(claimRes, claimReq)
	if claimRes.Code != http.StatusOK {
		t.Fatalf("claim status=%d body=%s", claimRes.Code, claimRes.Body.String())
	}
	if !bytes.Contains(claimRes.Body.Bytes(), []byte(`"cleanup_capability"`)) || !bytes.Contains(claimRes.Body.Bytes(), []byte(`"database_name":"newapi_set_a"`)) {
		t.Fatalf("claim body=%s", claimRes.Body.String())
	}
}

func TestSetDecommissionFailureCanBeRetriedThroughAdminAPI(t *testing.T) {
	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	if err := store.SaveSet(t.Context(), gateway.Set{ID: "set-a", Status: gateway.SetStatusActive, Setup: true}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveSetRuntimeLease(t.Context(), gateway.SetRuntimeLease{
		Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: "set-a",
		ShardRef: "shard-a", DatabaseName: "newapi_set_a", RedisDB: "17",
	}); err != nil {
		t.Fatal(err)
	}
	preview, _ := svc.PreviewSetDecommission(t.Context(), "set-a")
	job, err := svc.StartSetDecommission(t.Context(), gateway.SetDecommissionStartInput{
		SetID: "set-a", ExpectedDigest: preview.Digest, IdempotencyKey: "delete-set-a",
	})
	if err != nil {
		t.Fatal(err)
	}
	job, _, err = svc.ClaimSetDecommission(t.Context(), job.ID, "manager-a", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	handler := NewControlServer(svc, Config{AdminToken: "admin-token", InternalToken: "set-manager-token"})

	failBody, _ := json.Marshal(gateway.SetDecommissionFailInput{
		Attempt: job.Attempt, ClaimToken: job.ClaimToken, LeaseFingerprint: job.LeaseFingerprint,
		JobUID: "job-uid-a", LastError: "cleanup job failed",
	})
	failReq := httptest.NewRequest(http.MethodPost, "/api/internal/set-manager/set-decommissions/"+job.ID+"/fail", bytes.NewReader(failBody))
	failReq.Header.Set("Authorization", "Bearer set-manager-token")
	failRes := httptest.NewRecorder()
	handler.ServeHTTP(failRes, failReq)
	if failRes.Code != http.StatusOK {
		t.Fatalf("fail status=%d body=%s", failRes.Code, failRes.Body.String())
	}
	var failed struct {
		Data gateway.SetDecommissionJob `json:"data"`
	}
	if err := json.Unmarshal(failRes.Body.Bytes(), &failed); err != nil {
		t.Fatal(err)
	}

	retryBody, _ := json.Marshal(gateway.SetDecommissionRetryInput{ExpectedVersion: failed.Data.Version, IdempotencyKey: "retry-set-a"})
	retryReq := httptest.NewRequest(http.MethodPost, "/api/admin/set-decommissions/"+job.ID+"/retry", bytes.NewReader(retryBody))
	retryReq.Header.Set("Authorization", "Bearer admin-token")
	retryRes := httptest.NewRecorder()
	handler.ServeHTTP(retryRes, retryReq)
	if retryRes.Code != http.StatusAccepted || !bytes.Contains(retryRes.Body.Bytes(), []byte(`"status":"pending"`)) {
		t.Fatalf("retry status=%d body=%s", retryRes.Code, retryRes.Body.String())
	}
}
