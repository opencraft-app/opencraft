package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/internal/gateway"
)

func TestOperatorOverviewJobsAndTenantDetailEndpoints(t *testing.T) {
	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})
	if err := store.SaveSet(context.Background(), gateway.Set{ID: "set-a", BaseURL: "http://set-a", Status: gateway.SetStatusActive, Setup: true, AdminUserID: 1}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveTenant(context.Background(), gateway.Tenant{ExternalUserID: "user-1", Backend: gateway.UserBackendNew, SetID: "set-a", Status: gateway.TenantStatusActive}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserBinding(context.Background(), gateway.UserBinding{ExternalUserID: "user-1", SetID: "set-a", UpstreamUserID: 42, Username: "sgw-user-1", ProvisionStatus: gateway.BindingProvisionStatusTokenReady}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveAPIKeyBinding(context.Background(), gateway.APIKeyBinding{ExternalKey: "sk-user-key", ExternalKeyID: "key-1", SetID: "set-a", UserID: "user-1", UpstreamKeyID: 7, CreatedAt: time.Now().UTC()}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveWorkerJob(context.Background(), gateway.WorkerJob{Name: "check_channel_drift", Enabled: true}); err != nil {
		t.Fatal(err)
	}

	for _, path := range []string{"/api/admin/overview", "/api/admin/jobs", "/api/admin/tenants/user-1"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("Authorization", "Bearer cluster-token")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s status=%d body=%s", path, rec.Code, rec.Body.String())
		}
	}

	runReq := httptest.NewRequest(http.MethodPost, "/api/admin/jobs/check_channel_drift/run", nil)
	runReq.Header.Set("Authorization", "Bearer cluster-token")
	runRec := httptest.NewRecorder()
	handler.ServeHTTP(runRec, runReq)
	if runRec.Code != http.StatusOK {
		t.Fatalf("manual job run status=%d body=%s", runRec.Code, runRec.Body.String())
	}
	if !strings.Contains(runRec.Body.String(), `"job_name":"check_channel_drift"`) {
		t.Fatalf("manual job run response missing job name: %s", runRec.Body.String())
	}
	if !strings.Contains(runRec.Body.String(), `"status":"queued"`) {
		t.Fatalf("manual job run response should queue worker job: %s", runRec.Body.String())
	}
}

func TestAdminWorkerJobRunsFiltersByWatermarkAndBoundsLimit(t *testing.T) {
	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})
	jobName := gateway.WorkerJobRefreshSetCapacity
	if err := store.SaveWorkerJob(t.Context(), gateway.WorkerJob{Name: jobName, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	watermark := time.Date(2026, 7, 18, 8, 0, 0, 0, time.UTC)
	for _, run := range []gateway.WorkerJobRun{
		{ID: "before", JobName: jobName, Status: gateway.WorkerJobStatusSuccess, StartedAt: watermark.Add(-time.Second)},
		{ID: "after", JobName: jobName, Status: gateway.WorkerJobStatusSuccess, StartedAt: watermark.Add(time.Second)},
	} {
		if err := store.SaveWorkerJobRun(t.Context(), run); err != nil {
			t.Fatal(err)
		}
	}

	path := "/api/admin/jobs/refresh_set_capacity/runs?after=" + url.QueryEscape(watermark.Format(time.RFC3339Nano)) + "&limit=500"
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Authorization", "Bearer cluster-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"id":"after"`) || strings.Contains(rec.Body.String(), `"id":"before"`) {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}

	badAfter := httptest.NewRequest(http.MethodGet, "/api/admin/jobs/refresh_set_capacity/runs?after=not-a-time", nil)
	badAfter.Header.Set("Authorization", "Bearer cluster-token")
	badAfterRec := httptest.NewRecorder()
	handler.ServeHTTP(badAfterRec, badAfter)
	if badAfterRec.Code != http.StatusBadRequest {
		t.Fatalf("bad after status=%d body=%s", badAfterRec.Code, badAfterRec.Body.String())
	}

	missing := httptest.NewRequest(http.MethodGet, "/api/admin/jobs/missing/runs", nil)
	missing.Header.Set("Authorization", "Bearer cluster-token")
	missingRec := httptest.NewRecorder()
	handler.ServeHTTP(missingRec, missing)
	if missingRec.Code != http.StatusNotFound {
		t.Fatalf("missing status=%d body=%s", missingRec.Code, missingRec.Body.String())
	}
}

func TestSetManagerScopedEndpointsRequireInternalToken(t *testing.T) {
	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	handler := NewControlServer(svc, Config{AdminToken: "admin-token", InternalToken: "internal-token"})

	unauthorized := httptest.NewRequest(http.MethodPost, "/api/internal/set-manager/shards", bytes.NewBufferString(`{"id":"shard-a"}`))
	unauthorized.Header.Set("Authorization", "Bearer admin-token")
	unauthorizedRec := httptest.NewRecorder()
	handler.ServeHTTP(unauthorizedRec, unauthorized)
	if unauthorizedRec.Code != http.StatusUnauthorized {
		t.Fatalf("admin token status=%d body=%s", unauthorizedRec.Code, unauthorizedRec.Body.String())
	}

	authorized := httptest.NewRequest(http.MethodPost, "/api/internal/set-manager/shards", bytes.NewBufferString(`{"id":"shard-a"}`))
	authorized.Header.Set("Authorization", "Bearer internal-token")
	authorizedRec := httptest.NewRecorder()
	handler.ServeHTTP(authorizedRec, authorized)
	if authorizedRec.Code != http.StatusOK {
		t.Fatalf("internal token status=%d body=%s", authorizedRec.Code, authorizedRec.Body.String())
	}
}

func TestShardManagerObservationRequiresInternalTokenAndRejectsDrift(t *testing.T) {
	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	handler := NewControlServer(svc, Config{AdminToken: "admin-token", InternalToken: "internal-token"})
	body := `{
		"id":"shard-a",
		"name":"Shard A",
		"kind":"mysql",
		"endpoint":"mysql-a.internal:3306",
		"redis_endpoint":"redis-a.internal:6379",
		"secret_name":"shard-a-runtime",
		"redis_db_start":0,
		"redis_db_limit":256,
		"status":"active",
		"max_sets":16
	}`

	unauthorized := httptest.NewRequest(http.MethodPost, "/api/internal/shard-manager/shards", bytes.NewBufferString(body))
	unauthorized.Header.Set("Authorization", "Bearer admin-token")
	unauthorizedRec := httptest.NewRecorder()
	handler.ServeHTTP(unauthorizedRec, unauthorized)
	if unauthorizedRec.Code != http.StatusUnauthorized {
		t.Fatalf("admin token status=%d body=%s", unauthorizedRec.Code, unauthorizedRec.Body.String())
	}

	authorized := httptest.NewRequest(http.MethodPost, "/api/internal/shard-manager/shards", bytes.NewBufferString(body))
	authorized.Header.Set("Authorization", "Bearer internal-token")
	authorizedRec := httptest.NewRecorder()
	handler.ServeHTTP(authorizedRec, authorized)
	if authorizedRec.Code != http.StatusOK {
		t.Fatalf("internal token status=%d body=%s", authorizedRec.Code, authorizedRec.Body.String())
	}

	drift := strings.Replace(body, "mysql-a.internal:3306", "mysql-b.internal:3306", 1)
	driftReq := httptest.NewRequest(http.MethodPost, "/api/internal/shard-manager/shards", bytes.NewBufferString(drift))
	driftReq.Header.Set("Authorization", "Bearer internal-token")
	driftRec := httptest.NewRecorder()
	handler.ServeHTTP(driftRec, driftReq)
	if driftRec.Code != http.StatusConflict {
		t.Fatalf("drift status=%d body=%s", driftRec.Code, driftRec.Body.String())
	}
}

func TestTenantStatisticsEndpointReturnsNotReadyWithoutSnapshot(t *testing.T) {
	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})

	req := httptest.NewRequest(http.MethodGet, "/api/admin/tenant-statistics", nil)
	req.Header.Set("Authorization", "Bearer cluster-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("tenant statistics status=%d body=%s", rec.Code, rec.Body.String())
	}
	var parsed struct {
		Data struct {
			Ready       bool    `json:"ready"`
			Total       *int64  `json:"total"`
			GeneratedAt *string `json:"generated_at"`
			Stale       bool    `json:"stale"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed.Data.Ready || parsed.Data.Total != nil || parsed.Data.GeneratedAt != nil || !parsed.Data.Stale {
		t.Fatalf("unexpected empty statistics response: %s", rec.Body.String())
	}
}

func TestBackgroundJobsEndpointOwnsQueuesAndOverviewOmitsThem(t *testing.T) {
	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})
	if err := store.SaveWorkerJob(t.Context(), gateway.WorkerJob{Name: gateway.WorkerJobCheckChannelDrift, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.EnqueueBYOKSyncTask(t.Context(), gateway.BYOKSyncTask{ExternalUserID: "user-1", Status: gateway.BYOKSyncTaskStatusPending, NextRunAt: time.Now().UTC()}); err != nil {
		t.Fatal(err)
	}

	backgroundReq := httptest.NewRequest(http.MethodGet, "/api/admin/background-jobs", nil)
	backgroundReq.Header.Set("Authorization", "Bearer cluster-token")
	backgroundRec := httptest.NewRecorder()
	handler.ServeHTTP(backgroundRec, backgroundReq)
	if backgroundRec.Code != http.StatusOK {
		t.Fatalf("background jobs status=%d body=%s", backgroundRec.Code, backgroundRec.Body.String())
	}
	for _, key := range []string{`"jobs"`, `"byok_sync"`, `"observations"`} {
		if !strings.Contains(backgroundRec.Body.String(), key) {
			t.Fatalf("background jobs response missing %s: %s", key, backgroundRec.Body.String())
		}
	}

	overviewReq := httptest.NewRequest(http.MethodGet, "/api/admin/overview", nil)
	overviewReq.Header.Set("Authorization", "Bearer cluster-token")
	overviewRec := httptest.NewRecorder()
	handler.ServeHTTP(overviewRec, overviewReq)
	if overviewRec.Code != http.StatusOK {
		t.Fatalf("overview status=%d body=%s", overviewRec.Code, overviewRec.Body.String())
	}
	for _, key := range []string{`"jobs"`, `"byok_sync"`, `"observations"`, `"failed_jobs"`} {
		if strings.Contains(overviewRec.Body.String(), key) {
			t.Fatalf("overview must not contain background task field %s: %s", key, overviewRec.Body.String())
		}
	}
}

func TestAdminRetryBYOKSyncRequeuesFailedTasks(t *testing.T) {
	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})
	now := time.Now().UTC()
	if _, err := store.EnqueueBYOKSyncTask(context.Background(), gateway.BYOKSyncTask{ExternalUserID: "user-retry", SetID: "set-a", NextRunAt: now}); err != nil {
		t.Fatal(err)
	}
	task, acquired, err := store.TryAcquireBYOKSyncTask(context.Background(), "user-retry", "worker-a", time.Minute, now)
	if err != nil || !acquired {
		t.Fatalf("acquire=%v err=%v", acquired, err)
	}
	if _, err := store.CompleteBYOKSyncTask(context.Background(), task, false, "upstream unavailable", now); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/admin/byok-sync/retry", nil)
	req.Header.Set("Authorization", "Bearer cluster-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("retry status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"requeued":1`) {
		t.Fatalf("retry response=%s", rec.Body.String())
	}
}

func TestChannelBundleReleaseEndpoints(t *testing.T) {
	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})
	if err := store.SaveSet(context.Background(), gateway.Set{ID: "set-a", BaseURL: "http://127.0.0.1:1", Status: gateway.SetStatusDisabled}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpsertChannelBundle(context.Background(), gateway.ChannelBundle{ID: "golden", Name: "Golden", Spec: gateway.ChannelBundleSpec{Version: 1, Kind: gateway.ChannelBundleKind}}); err != nil {
		t.Fatal(err)
	}

	listReq := httptest.NewRequest(http.MethodGet, "/api/channel-bundles/golden/revisions", nil)
	listReq.Header.Set("Authorization", "Bearer cluster-token")
	listRec := httptest.NewRecorder()
	handler.ServeHTTP(listRec, listReq)
	if listRec.Code != http.StatusOK {
		t.Fatalf("revisions status=%d body=%s", listRec.Code, listRec.Body.String())
	}

	body, _ := json.Marshal(map[string]any{"set_ids": []string{"set-a"}})
	releaseReq := httptest.NewRequest(http.MethodPost, "/api/channel-bundles/golden/releases", bytes.NewReader(body))
	releaseReq.Header.Set("Authorization", "Bearer cluster-token")
	releaseRec := httptest.NewRecorder()
	handler.ServeHTTP(releaseRec, releaseReq)
	if releaseRec.Code != http.StatusOK {
		t.Fatalf("release status=%d body=%s", releaseRec.Code, releaseRec.Body.String())
	}
	var parsed struct {
		Success bool `json:"success"`
		Data    struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(releaseRec.Body.Bytes(), &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed.Data.ID == "" {
		t.Fatalf("release response missing id: %s", releaseRec.Body.String())
	}

	getReq := httptest.NewRequest(http.MethodGet, "/api/channel-bundle-releases/"+parsed.Data.ID, nil)
	getReq.Header.Set("Authorization", "Bearer cluster-token")
	getRec := httptest.NewRecorder()
	handler.ServeHTTP(getRec, getReq)
	if getRec.Code != http.StatusOK {
		t.Fatalf("release get status=%d body=%s", getRec.Code, getRec.Body.String())
	}
}

func TestChannelBundleDeliveryStatusEndpointReadsPersistedState(t *testing.T) {
	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})
	if err := store.SaveSet(t.Context(), gateway.Set{ID: "set-a", Name: "Set A", Status: gateway.SetStatusActive, Setup: true}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveChannelBundle(t.Context(), gateway.ChannelBundle{
		ID: "golden", Name: "Golden", Fingerprint: "fp", Spec: gateway.ChannelBundleSpec{Version: 1, Kind: gateway.ChannelBundleKind},
	}); err != nil {
		t.Fatal(err)
	}
	bundle, _, _ := store.GetChannelBundle(t.Context(), "golden")
	if err := store.SaveChannelBundleSyncState(t.Context(), gateway.ChannelBundleSyncState{
		BundleID: "golden", SetID: "set-a", Status: gateway.ChannelSyncStatusSynced, DesiredFingerprint: "fp", LastCheckedAt: bundle.UpdatedAt.Add(time.Second),
	}); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/channel-bundles/golden/delivery-status", nil)
	req.Header.Set("Authorization", "Bearer cluster-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("delivery status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"status":"synced"`) || !strings.Contains(rec.Body.String(), `"eligible_sets":1`) {
		t.Fatalf("unexpected delivery status response: %s", rec.Body.String())
	}
}
