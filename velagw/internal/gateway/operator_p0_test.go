package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestOperationalOverviewAggregatesLocalState(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	now := time.Date(2026, 7, 7, 10, 0, 0, 0, time.UTC)
	svc.now = func() time.Time { return now }

	mustSaveSet(t, store, Set{ID: "set-a", Name: "Set A", BaseURL: "http://set-a", Status: SetStatusActive, Setup: true, AdminUserID: 1, AdminAccessToken: "admin-token", ObservedUserCount: 1})
	mustSaveSet(t, store, Set{ID: "set-b", Name: "Set B", BaseURL: "http://set-b", Status: SetStatusDisabled})
	if err := store.SaveSetReconcileFact(context.Background(), SetReconcileFact{
		Source: "kro", Namespace: "prod", Fleet: "main", SetID: "set-b", Status: SetReconcileStatusError, LastError: "bootstrap failed", LastObservedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveSetProvisionRequest(context.Background(), SetProvisionRequest{
		ID: "req-1", Source: "kro", Namespace: "prod", Fleet: "main", SetID: "set-c", Status: SetProvisionStatusError, LastError: "pod failed", LastStatusAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveChannelBundle(context.Background(), ChannelBundle{ID: "golden", Name: "Golden", Fingerprint: "fp-1", Spec: ChannelBundleSpec{Version: 1, Kind: ChannelBundleKind}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveChannelBundleSyncState(context.Background(), ChannelBundleSyncState{
		BundleID: "golden", SetID: "set-a", Status: ChannelSyncStatusDrift, LastError: "remote drift", DesiredFingerprint: "fp-1", LastCheckedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveChannelBundleSyncState(context.Background(), ChannelBundleSyncState{
		BundleID: "golden", SetID: "set-b", Status: ChannelSyncStatusError, LastError: "disabled set token expired", DesiredFingerprint: "fp-1", LastCheckedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveWorkerJob(context.Background(), WorkerJob{Name: "check_channel_drift", Enabled: true, LastError: "last run failed", FailureCount: 2, LastFinishedAt: now.Add(-time.Minute)}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveWorkerJob(context.Background(), WorkerJob{Name: "refresh_tenant_observations", Enabled: true, Status: WorkerJobStatusSuccess, FailureCount: 9, LastFinishedAt: now}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.EnqueueBYOKSyncTask(context.Background(), BYOKSyncTask{
		ExternalUserID: "byok-pending",
		SetID:          "set-a",
		Status:         BYOKSyncTaskStatusPending,
		NextRunAt:      now.Add(-2 * time.Minute),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.EnqueueBYOKSyncTask(context.Background(), BYOKSyncTask{
		ExternalUserID: "byok-error",
		SetID:          "set-a",
		Status:         BYOKSyncTaskStatusError,
		NextRunAt:      now.Add(-time.Minute),
		LastError:      "remote channel failed",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.EnqueueBYOKSyncTask(context.Background(), BYOKSyncTask{
		ExternalUserID: "byok-running",
		SetID:          "set-a",
		Status:         BYOKSyncTaskStatusPending,
		NextRunAt:      now,
	}); err != nil {
		t.Fatal(err)
	}
	if _, acquired, err := store.TryAcquireBYOKSyncTask(context.Background(), "byok-running", "worker-a", 5*time.Minute, now); err != nil || !acquired {
		t.Fatalf("acquire byok-running acquired=%v err=%v", acquired, err)
	}
	if _, err := store.EnqueueTenantObservationTask(context.Background(), TenantObservationTask{
		ExternalUserID: "observation-pending", SetID: "set-a", NextRunAt: now.Add(-3 * time.Minute),
	}); err != nil {
		t.Fatal(err)
	}

	overview, err := svc.GetOperationalOverview(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if overview.Totals.Sets != 2 || overview.Totals.ActiveSets != 1 || overview.Totals.Users != 1 {
		t.Fatalf("unexpected overview totals: %+v", overview.Totals)
	}
	if got := overview.Sets[0].UserCount; got != 1 {
		t.Fatalf("set-a user count = %d, want 1", got)
	}
	if len(overview.ChannelBundles) != 1 || overview.ChannelBundles[0].DriftSets != 1 {
		t.Fatalf("unexpected channel bundle summary: %+v", overview.ChannelBundles)
	}
	if overview.ChannelBundles[0].ErrorSets != 0 {
		t.Fatalf("disabled set channel errors must not trigger bundle summary: %+v", overview.ChannelBundles[0])
	}
	background, err := svc.GetBackgroundJobsOverview(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	job, ok := workerJobByName(background.Jobs, "check_channel_drift")
	if !ok || job.FailureCount != 2 {
		t.Fatalf("unexpected job summary: %+v", background.Jobs)
	}
	if !overviewHasAlert(overview, "channel_drift") || !overviewHasAlert(overview, "set_reconcile_error") {
		t.Fatalf("overview missing expected alerts: %+v", overview.Alerts)
	}
	if background.BYOKSync.Pending != 1 || background.BYOKSync.Running != 1 || background.BYOKSync.Error != 1 {
		t.Fatalf("unexpected byok queue stats: %+v", background.BYOKSync)
	}
	if background.BYOKSync.OldestPendingAgeSeconds < 120 {
		t.Fatalf("oldest pending age = %d, want at least 120s", background.BYOKSync.OldestPendingAgeSeconds)
	}
	if background.Observations.Pending != 1 || background.Observations.Due != 1 || background.Observations.OldestDueAgeSeconds < 180 {
		t.Fatalf("unexpected observation queue stats: %+v", background.Observations)
	}
	if overviewHasAlert(overview, "byok_sync_backlog") || overviewHasAlert(overview, "byok_sync_error") || overviewHasAlert(overview, "worker_job_error") {
		t.Fatalf("overview must not contain background task alerts: %+v", overview.Alerts)
	}

	metrics := svc.PrometheusMetrics()
	for _, want := range []string{
		`llmgateway_set_ready{set_id="set-a",status="active",admission="pending"} 1`,
		`llmgateway_set_users{set_id="set-a"} 1`,
		`llmgateway_channel_bundle_sync_state{bundle_id="golden",set_id="set-a",status="drift"} 1`,
		`llmgateway_worker_job_failure_total{job="check_channel_drift"} 2`,
		`llmgateway_byok_sync_tasks{status="pending"} 1`,
		`llmgateway_byok_sync_tasks{status="running"} 1`,
		`llmgateway_byok_sync_tasks{status="error"} 1`,
		`llmgateway_tenant_observation_tasks{status="pending"} 1`,
		`llmgateway_tenant_observation_due_tasks 1`,
	} {
		if !strings.Contains(metrics, want) {
			t.Fatalf("metrics missing %q:\n%s", want, metrics)
		}
	}
	if !strings.Contains(metrics, `llmgateway_byok_sync_oldest_pending_age_seconds 120`) {
		t.Fatalf("metrics missing byok oldest pending age:\n%s", metrics)
	}
}

func TestOperationalOverviewAndMetricsUseProjectedWatermarkWithoutCountingBindings(t *testing.T) {
	store := &countingCapacityStore{MemoryStore: NewMemoryStore()}
	svc := NewService(store, nil, Options{})
	mustSaveSet(t, store.MemoryStore, Set{
		ID:                "set-a",
		BaseURL:           "http://set-a",
		Status:            SetStatusActive,
		Setup:             true,
		AdminUserID:       1,
		AdminAccessToken:  "set-admin-token",
		ObservedUserCount: 7,
	})
	if err := store.SaveUserBinding(context.Background(), UserBinding{ExternalUserID: "user-1", SetID: "set-a", Username: "sgw-user-1"}); err != nil {
		t.Fatal(err)
	}

	overview, err := svc.GetOperationalOverview(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if overview.Totals.Users != 7 {
		t.Fatalf("overview users = %d, want projected watermark 7", overview.Totals.Users)
	}
	metrics := svc.PrometheusMetrics()
	if !strings.Contains(metrics, `llmgateway_set_users{set_id="set-a"} 7`) {
		t.Fatalf("metrics should expose projected watermark:\n%s", metrics)
	}
	if store.countCalls != 0 {
		t.Fatalf("CountUserBindingsBySet calls = %d, want 0 for overview and metrics", store.countCalls)
	}
}

func TestOperationalOverviewDoesNotCountAdmissionPendingSetAsReady(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	mustSaveSet(t, store, Set{
		ID:               "set-pending",
		BaseURL:          "http://set-pending",
		Status:           SetStatusActive,
		Setup:            true,
		AdminUserID:      1,
		AdminAccessToken: "admin-token",
		AdmissionStatus:  SetAdmissionStatusPending,
		AdmissionError:   "previous drift",
	})
	mustSaveSet(t, store, Set{
		ID:               "set-ready",
		BaseURL:          "http://set-ready",
		Status:           SetStatusActive,
		Setup:            true,
		AdminUserID:      1,
		AdminAccessToken: "admin-token",
		AdmissionStatus:  SetAdmissionStatusPassed,
	})

	overview, err := svc.GetOperationalOverview(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if overview.Totals.ReadySets != 1 {
		t.Fatalf("ready sets = %d, want only admission-passed set", overview.Totals.ReadySets)
	}
	pending, ok := overviewSetByID(overview, "set-pending")
	if !ok || pending.Ready {
		t.Fatalf("pending set overview = %+v, want not ready", pending)
	}
}

func TestWorkerSetAdmissionMarksSyncedSetPassed(t *testing.T) {
	upstream := newAdmissionSetupServer(t, true, true)
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, upstream.Client().Transport, Options{})
	mustSaveSet(t, store, Set{
		ID:               "set-a",
		BaseURL:          upstream.URL,
		Status:           SetStatusActive,
		Setup:            true,
		AdminUserID:      1,
		AdminAccessToken: "admin-token",
		AdmissionStatus:  SetAdmissionStatusPending,
	})
	if err := store.SaveChannelBundle(context.Background(), ChannelBundle{ID: "golden", Name: "Golden", Fingerprint: "fp-1", Spec: ChannelBundleSpec{
		Version: 1,
		Kind:    ChannelBundleKind,
		Options: []ChannelBundleOption{
			{Key: "ModelRatio", Value: `{"llmgw-mock-chat":1}`},
			{Key: "CompletionRatio", Value: `{"llmgw-mock-chat":1}`},
		},
		Channels: []ChannelBundleChannel{{
			ID: "mock", Name: "Mock", Type: 1, Key: "sk-test", BaseURL: "http://mock", Models: "llmgw-mock-chat", Group: "default", Status: ChannelSpecStatusEnabled,
		}},
	}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveChannelBundleSyncState(context.Background(), ChannelBundleSyncState{
		BundleID: "golden", SetID: "set-a", Status: ChannelSyncStatusSynced, DesiredFingerprint: "fp-1", AppliedFingerprint: "fp-1",
	}); err != nil {
		t.Fatal(err)
	}

	run, err := svc.RunWorkerJobNow(context.Background(), WorkerJobCheckSetAdmission)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(run.Detail, "passed=1") {
		t.Fatalf("run detail = %q, want passed=1", run.Detail)
	}
	set, ok, err := store.GetSet(context.Background(), "set-a")
	if err != nil || !ok {
		t.Fatalf("get set ok=%v err=%v", ok, err)
	}
	if set.AdmissionStatus != SetAdmissionStatusPassed || set.AdmissionError != "" || set.AdmissionCheckedAt.IsZero() {
		t.Fatalf("set admission = status=%q error=%q checked=%v", set.AdmissionStatus, set.AdmissionError, set.AdmissionCheckedAt)
	}
}

func TestWorkerSetAdmissionKeepsStableAppliedRevisionReadyWhileNewRevisionIsPending(t *testing.T) {
	upstream := newAdmissionSetupServer(t, true, true)
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, upstream.Client().Transport, Options{})
	mustSaveSet(t, store, Set{
		ID:                 "set-a",
		BaseURL:            upstream.URL,
		Status:             SetStatusActive,
		Setup:              true,
		AdminUserID:        1,
		AdminAccessToken:   "admin-token",
		AdmissionStatus:    SetAdmissionStatusPassed,
		AdmissionCheckedAt: time.Now().Add(-time.Minute),
	})
	stable, err := svc.UpsertChannelBundle(context.Background(), ChannelBundle{ID: "golden", Name: "Golden", Spec: ChannelBundleSpec{
		Version: 1,
		Kind:    ChannelBundleKind,
		Options: []ChannelBundleOption{
			{Key: "ModelRatio", Value: `{"stable-model":1}`},
			{Key: "CompletionRatio", Value: `{"stable-model":1}`},
		},
		Channels: []ChannelBundleChannel{{
			ID: "mock", Name: "Mock", Type: 1, Key: "sk-test", BaseURL: "http://stable", Models: "stable-model", Group: "default", Status: ChannelSpecStatusEnabled,
		}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveChannelBundleSyncState(context.Background(), ChannelBundleSyncState{
		BundleID: "golden", SetID: "set-a", Status: ChannelSyncStatusSynced, DesiredFingerprint: stable.Fingerprint, AppliedFingerprint: stable.Fingerprint,
	}); err != nil {
		t.Fatal(err)
	}
	pending, err := svc.UpsertChannelBundle(context.Background(), ChannelBundle{ID: "golden", Name: "Golden v2", Spec: ChannelBundleSpec{
		Version: 1,
		Kind:    ChannelBundleKind,
		Options: []ChannelBundleOption{
			{Key: "ModelRatio", Value: `{"next-model":1}`},
		},
		Channels: []ChannelBundleChannel{{
			ID: "mock", Name: "Mock", Type: 1, Key: "sk-test", BaseURL: "http://next", Models: "next-model", Group: "default", Status: ChannelSpecStatusEnabled,
		}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	state, ok, err := store.GetChannelBundleSyncState(context.Background(), "golden", "set-a")
	if err != nil || !ok {
		t.Fatalf("get pending bundle state ok=%v err=%v", ok, err)
	}
	if state.Status != ChannelSyncStatusPending || state.AppliedFingerprint != stable.Fingerprint || state.DesiredFingerprint != pending.Fingerprint {
		t.Fatalf("pending state = %+v, want stable applied and new desired", state)
	}

	run, err := svc.RunWorkerJobNow(context.Background(), WorkerJobCheckSetAdmission)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(run.Detail, "checked=1") || !strings.Contains(run.Detail, "passed=1") {
		t.Fatalf("run detail = %q, want checked=1 passed=1", run.Detail)
	}
	set, ok, getErr := store.GetSet(context.Background(), "set-a")
	if getErr != nil || !ok {
		t.Fatalf("get set ok=%v err=%v", ok, getErr)
	}
	if set.AdmissionStatus != SetAdmissionStatusPassed || set.AdmissionError != "" {
		t.Fatalf("set admission = status=%q error=%q, want old stable revision to remain admitted", set.AdmissionStatus, set.AdmissionError)
	}
}

func TestWorkerSetAdmissionRejectsNewSetBeforeInitialBundleSync(t *testing.T) {
	upstream := newAdmissionSetupServer(t, true, true)
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, upstream.Client().Transport, Options{})
	mustSaveSet(t, store, Set{
		ID: "set-new", BaseURL: upstream.URL, Status: SetStatusActive, Setup: true,
		AdminUserID: 1, AdminAccessToken: "admin-token", AdmissionStatus: SetAdmissionStatusPending,
	})
	bundle, err := svc.UpsertChannelBundle(context.Background(), ChannelBundle{ID: "golden", Name: "Golden", Spec: ChannelBundleSpec{
		Version: 1,
		Kind:    ChannelBundleKind,
		Options: []ChannelBundleOption{
			{Key: "ModelRatio", Value: `{"auto":1}`},
			{Key: "CompletionRatio", Value: `{"auto":1}`},
		},
		Channels: []ChannelBundleChannel{{
			ID: "mock", Name: "Mock", Type: 1, Key: "sk-test", BaseURL: "http://mock", Models: "auto", Group: "default", Status: ChannelSpecStatusEnabled,
		}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveChannelBundleSyncState(context.Background(), ChannelBundleSyncState{
		BundleID: bundle.ID, SetID: "set-new", Status: ChannelSyncStatusPending, DesiredFingerprint: bundle.Fingerprint,
	}); err != nil {
		t.Fatal(err)
	}

	run, err := svc.RunWorkerJobNow(context.Background(), WorkerJobCheckSetAdmission)
	if err == nil {
		t.Fatal("expected initial admission to fail before a complete bundle apply")
	}
	if !strings.Contains(run.Detail, "failed=1") {
		t.Fatalf("run detail = %q, want failed=1", run.Detail)
	}
	set, ok, getErr := store.GetSet(context.Background(), "set-new")
	if getErr != nil || !ok {
		t.Fatalf("get set ok=%v err=%v", ok, getErr)
	}
	if set.AdmissionStatus != SetAdmissionStatusFailed || !strings.Contains(set.AdmissionError, "initial sync") {
		t.Fatalf("set admission = status=%q error=%q, want initial sync failure", set.AdmissionStatus, set.AdmissionError)
	}
}

func TestWorkerSetAdmissionAllowsCompletedSetupEvenWhenRootInitIsOmitted(t *testing.T) {
	upstream := newAdmissionSetupServer(t, true, false)
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, upstream.Client().Transport, Options{})
	mustSaveSet(t, store, Set{
		ID:                 "set-a",
		BaseURL:            upstream.URL,
		Status:             SetStatusActive,
		Setup:              true,
		AdminUserID:        1,
		AdminAccessToken:   "admin-token",
		AdmissionStatus:    SetAdmissionStatusPassed,
		AdmissionCheckedAt: time.Now().Add(-time.Minute),
	})

	run, err := svc.RunWorkerJobNow(context.Background(), WorkerJobCheckSetAdmission)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(run.Detail, "checked=1") || !strings.Contains(run.Detail, "passed=1") {
		t.Fatalf("run detail = %q, want checked=1 passed=1", run.Detail)
	}
	set, ok, getErr := store.GetSet(context.Background(), "set-a")
	if getErr != nil || !ok {
		t.Fatalf("get set ok=%v err=%v", ok, getErr)
	}
	if set.AdmissionStatus != SetAdmissionStatusPassed || set.AdmissionError != "" {
		t.Fatalf("set admission = status=%q error=%q, want passed", set.AdmissionStatus, set.AdmissionError)
	}
}

func TestWorkerSetAdmissionAllowsRootInitializedReplicaWithStaleSetupFlag(t *testing.T) {
	upstream := newAdmissionSetupServer(t, false, true)
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, upstream.Client().Transport, Options{})
	mustSaveSet(t, store, Set{
		ID:                 "set-a",
		BaseURL:            upstream.URL,
		Status:             SetStatusActive,
		Setup:              true,
		AdminUserID:        1,
		AdminAccessToken:   "admin-token",
		AdmissionStatus:    SetAdmissionStatusPending,
		AdmissionCheckedAt: time.Now().Add(-time.Minute),
	})

	run, err := svc.RunWorkerJobNow(context.Background(), WorkerJobCheckSetAdmission)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(run.Detail, "checked=1") || !strings.Contains(run.Detail, "passed=1") {
		t.Fatalf("run detail = %q, want stale replica accepted after root initialization", run.Detail)
	}
}

func TestWorkerSetAdmissionFailsWhenRemoteSetupIsIncomplete(t *testing.T) {
	upstream := newAdmissionSetupServer(t, false, false)
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, upstream.Client().Transport, Options{})
	mustSaveSet(t, store, Set{
		ID:                 "set-a",
		BaseURL:            upstream.URL,
		Status:             SetStatusActive,
		Setup:              true,
		AdminUserID:        1,
		AdminAccessToken:   "admin-token",
		AdmissionStatus:    SetAdmissionStatusPassed,
		AdmissionCheckedAt: time.Now().Add(-time.Minute),
	})

	run, err := svc.RunWorkerJobNow(context.Background(), WorkerJobCheckSetAdmission)
	if err == nil {
		t.Fatal("expected admission job to fail when remote setup is incomplete")
	}
	if !strings.Contains(run.Detail, "checked=1") || !strings.Contains(run.Detail, "failed=1") {
		t.Fatalf("run detail = %q, want checked=1 failed=1", run.Detail)
	}
	set, ok, getErr := store.GetSet(context.Background(), "set-a")
	if getErr != nil || !ok {
		t.Fatalf("get set ok=%v err=%v", ok, getErr)
	}
	if set.AdmissionStatus != SetAdmissionStatusFailed || !strings.Contains(set.AdmissionError, "setup is not completed") {
		t.Fatalf("set admission = status=%q error=%q, want failed incomplete setup", set.AdmissionStatus, set.AdmissionError)
	}
}

func newAdmissionSetupServer(t *testing.T, status bool, rootInit bool) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/setup" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"status": status, "root_init": rootInit}})
	}))
}

func TestWorkerJobLeasePreventsConcurrentOwners(t *testing.T) {
	store := NewMemoryStore()
	now := time.Date(2026, 7, 7, 10, 0, 0, 0, time.UTC)
	if err := store.SaveWorkerJob(context.Background(), WorkerJob{Name: "refresh_tenant_observations", Enabled: true, NextRunAt: now.Add(-time.Minute)}); err != nil {
		t.Fatal(err)
	}

	first, ok, err := store.TryAcquireWorkerJobLease(context.Background(), "refresh_tenant_observations", "worker-a", time.Minute, now)
	if err != nil || !ok {
		t.Fatalf("first lease acquire ok=%v err=%v job=%+v", ok, err, first)
	}
	second, ok, err := store.TryAcquireWorkerJobLease(context.Background(), "refresh_tenant_observations", "worker-b", time.Minute, now.Add(10*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatalf("second worker unexpectedly acquired active lease: %+v", second)
	}
	third, ok, err := store.TryAcquireWorkerJobLease(context.Background(), "refresh_tenant_observations", "worker-b", time.Minute, now.Add(2*time.Minute))
	if err != nil || !ok {
		t.Fatalf("expired lease acquire ok=%v err=%v job=%+v", ok, err, third)
	}
	if third.LeaseOwner != "worker-b" {
		t.Fatalf("lease owner = %q, want worker-b", third.LeaseOwner)
	}
}

func TestWorkerJobLeaseRenewsOnlyForCurrentOwner(t *testing.T) {
	store := NewMemoryStore()
	now := time.Date(2026, 7, 11, 12, 0, 0, 0, time.UTC)
	if err := store.SaveWorkerJob(context.Background(), WorkerJob{Name: WorkerJobRetryBYOKSync, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := store.TryAcquireWorkerJobLease(context.Background(), WorkerJobRetryBYOKSync, "run-a", time.Minute, now); err != nil || !ok {
		t.Fatalf("acquire ok=%v err=%v", ok, err)
	}

	if ok, err := store.RenewWorkerJobLease(context.Background(), WorkerJobRetryBYOKSync, "run-b", time.Minute, now.Add(20*time.Second)); err != nil || ok {
		t.Fatalf("wrong-owner renewal ok=%v err=%v", ok, err)
	}
	if ok, err := store.RenewWorkerJobLease(context.Background(), WorkerJobRetryBYOKSync, "run-a", time.Minute, now.Add(20*time.Second)); err != nil || !ok {
		t.Fatalf("current-owner renewal ok=%v err=%v", ok, err)
	}
	job, ok, err := store.GetWorkerJob(context.Background(), WorkerJobRetryBYOKSync)
	if err != nil || !ok {
		t.Fatalf("get job ok=%v err=%v", ok, err)
	}
	if want := now.Add(80 * time.Second); !job.LeaseUntil.Equal(want) {
		t.Fatalf("lease until=%s want=%s", job.LeaseUntil, want)
	}
}

func TestWorkerJobFencedCompletionRejectsStaleOwner(t *testing.T) {
	store := NewMemoryStore()
	now := time.Date(2026, 7, 11, 12, 0, 0, 0, time.UTC)
	if err := store.SaveWorkerJob(context.Background(), WorkerJob{Name: WorkerJobCheckChannelDrift, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	stale, ok, err := store.TryAcquireWorkerJobLease(context.Background(), WorkerJobCheckChannelDrift, "run-a", time.Minute, now)
	if err != nil || !ok {
		t.Fatalf("first acquire ok=%v err=%v", ok, err)
	}
	current, ok, err := store.TryAcquireWorkerJobLease(context.Background(), WorkerJobCheckChannelDrift, "run-b", time.Minute, now.Add(2*time.Minute))
	if err != nil || !ok {
		t.Fatalf("second acquire ok=%v err=%v", ok, err)
	}

	stale.Cursor = "stale-cursor"
	staleRun := WorkerJobRun{ID: "run-a", JobName: stale.Name, Owner: "run-a", Status: WorkerJobStatusSuccess, StartedAt: now, FinishedAt: now.Add(time.Second)}
	if committed, err := store.CompleteWorkerJobRun(context.Background(), stale, staleRun); err != nil || committed {
		t.Fatalf("stale completion committed=%v err=%v", committed, err)
	}
	current.Cursor = "current-cursor"
	currentRun := WorkerJobRun{ID: "run-b", JobName: current.Name, Owner: "run-b", Status: WorkerJobStatusSuccess, StartedAt: now.Add(2 * time.Minute), FinishedAt: now.Add(2*time.Minute + time.Second)}
	if committed, err := store.CompleteWorkerJobRun(context.Background(), current, currentRun); err != nil || !committed {
		t.Fatalf("current completion committed=%v err=%v", committed, err)
	}
	job, ok, err := store.GetWorkerJob(context.Background(), WorkerJobCheckChannelDrift)
	if err != nil || !ok {
		t.Fatalf("get job ok=%v err=%v", ok, err)
	}
	if job.Cursor != "current-cursor" || job.LeaseOwner != "" || job.Status != WorkerJobStatusSuccess {
		t.Fatalf("completed job=%+v", job)
	}
}

func TestRefreshTenantStatisticsWorkerCreatesSnapshot(t *testing.T) {
	store := NewMemoryStore()
	for _, tenant := range []Tenant{
		{ExternalUserID: "new-active", Backend: UserBackendNew, SetID: "set-a", Status: TenantStatusActive},
		{ExternalUserID: "new-disabled", Backend: UserBackendNew, SetID: "set-a", Status: TenantStatusDisabled},
		{ExternalUserID: "old-active", Backend: UserBackendPending, Status: TenantStatusActive},
		{ExternalUserID: "deleted", Backend: UserBackendNew, SetID: "set-a", Status: TenantStatusDeleted},
	} {
		if err := store.SaveTenant(t.Context(), tenant); err != nil {
			t.Fatal(err)
		}
	}
	svc := NewService(store, nil, Options{})
	if err := svc.ensureDefaultWorkerJobs(t.Context()); err != nil {
		t.Fatal(err)
	}

	run, executed := svc.tryRunLeasedWorkerJob(t.Context(), "worker-a", WorkerJobRefreshTenantStatistics, time.Minute)
	if !executed || run.Status != WorkerJobStatusSuccess {
		t.Fatalf("statistics worker run = %+v executed=%v", run, executed)
	}
	stats, ok, err := store.GetTenantStatistics(t.Context())
	if err != nil || !ok {
		t.Fatalf("tenant statistics ok=%v err=%v", ok, err)
	}
	if stats.Total != 3 || stats.NewTotal != 2 || stats.PendingTotal != 1 || stats.ActiveTotal != 2 || stats.DisabledTotal != 1 || stats.DeletedTotal != 1 {
		t.Fatalf("unexpected tenant statistics: %+v", stats)
	}
}

func TestTenantStatisticsRejectsStaleWorkerLease(t *testing.T) {
	store := NewMemoryStore()
	now := time.Date(2026, 7, 14, 10, 0, 0, 0, time.UTC)
	if err := store.SaveWorkerJob(t.Context(), WorkerJob{Name: WorkerJobRefreshTenantStatistics, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	stale, acquired, err := store.TryAcquireWorkerJobLease(t.Context(), WorkerJobRefreshTenantStatistics, "old-owner", time.Minute, now)
	if err != nil || !acquired {
		t.Fatalf("acquire stale lease: acquired=%v err=%v", acquired, err)
	}
	current, acquired, err := store.TryAcquireWorkerJobLease(t.Context(), WorkerJobRefreshTenantStatistics, "new-owner", time.Minute, now.Add(2*time.Minute))
	if err != nil || !acquired {
		t.Fatalf("acquire current lease: acquired=%v err=%v", acquired, err)
	}
	if committed, err := store.RefreshTenantStatistics(t.Context(), stale.Name, stale.LeaseOwner, now.Add(2*time.Minute)); err != nil || committed {
		t.Fatalf("stale statistics commit = %v err=%v", committed, err)
	}
	if committed, err := store.RefreshTenantStatistics(t.Context(), current.Name, current.LeaseOwner, now.Add(2*time.Minute)); err != nil || !committed {
		t.Fatalf("current statistics commit = %v err=%v", committed, err)
	}
}

func TestTenantStatisticsMetricsExposeSnapshotFreshness(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	now := time.Date(2026, 7, 14, 10, 0, 0, 0, time.UTC)
	svc.now = func() time.Time { return now }
	if err := svc.ensureDefaultWorkerJobs(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, executed := svc.tryRunLeasedWorkerJob(t.Context(), "worker-a", WorkerJobRefreshTenantStatistics, time.Minute); !executed {
		t.Fatal("tenant statistics job was not executed")
	}

	metrics := svc.PrometheusMetrics()
	for _, want := range []string{
		"llmgateway_tenant_statistics_ready 1",
		fmt.Sprintf("llmgateway_tenant_statistics_generated_timestamp_seconds %d", now.Unix()),
	} {
		if !strings.Contains(metrics, want) {
			t.Fatalf("metrics missing %q:\n%s", want, metrics)
		}
	}
}

func TestWorkerSchedulerDoesNotLetBlockedDriftStarveOtherJobs(t *testing.T) {
	driftStarted := make(chan struct{})
	releaseDrift := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/channel/search" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		select {
		case <-driftStarted:
		default:
			close(driftStarted)
		}
		select {
		case <-releaseDrift:
			writeGatewayChannelJSON(t, w, map[string]any{"success": true, "data": map[string]any{"items": []any{}, "total": 0}})
		case <-r.Context().Done():
		}
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, upstream.Client().Transport, Options{WorkerChannelDriftTimeout: 2 * time.Second})
	saveReadySet(t, store, "set-a", upstream.URL)
	if _, err := svc.UpsertChannelBundle(context.Background(), ChannelBundle{
		ID: "golden", Name: "Golden", Spec: ChannelBundleSpec{Version: 1, Kind: ChannelBundleKind, Channels: []ChannelBundleChannel{{
			ID: "channel", Name: "Channel", Type: 1, Key: "sk-test", BaseURL: "http://mock", Models: "m1", Group: "default", Status: ChannelSpecStatusEnabled,
		}}},
	}); err != nil {
		t.Fatal(err)
	}
	for _, definition := range defaultWorkerJobs {
		definition.Enabled = definition.Name == WorkerJobCheckChannelDrift || definition.Name == WorkerJobCleanupPending
		definition.NextRunAt = time.Now().Add(-time.Minute)
		if err := store.SaveWorkerJob(context.Background(), definition); err != nil {
			t.Fatal(err)
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runs := make(chan WorkerJobRun, 32)
	done := make(chan error, 1)
	go func() {
		done <- svc.RunWorkerScheduler(ctx, "worker-a", 10*time.Millisecond, 15*time.Second, func(run WorkerJobRun) {
			runs <- run
		})
	}()

	select {
	case <-driftStarted:
	case <-time.After(time.Second):
		t.Fatal("drift job did not start")
	}
	deadline := time.After(time.Second)
	for {
		select {
		case run := <-runs:
			if run.JobName == WorkerJobCleanupPending {
				close(releaseDrift)
				cancel()
				if err := <-done; err != nil {
					t.Fatal(err)
				}
				return
			}
		case <-deadline:
			t.Fatal("independent job was starved while drift job was blocked")
		}
	}
}

type cancelAwareRenewStore struct {
	Store
	started chan struct{}
}

func (s *cancelAwareRenewStore) RenewWorkerJobLease(ctx context.Context, _ string, _ string, _ time.Duration, _ time.Time) (bool, error) {
	close(s.started)
	<-ctx.Done()
	return false, ctx.Err()
}

func TestWorkerLeaseHeartbeatTreatsNormalShutdownAsSuccess(t *testing.T) {
	store := &cancelAwareRenewStore{Store: NewMemoryStore(), started: make(chan struct{})}
	svc := NewService(store, nil, Options{})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go svc.renewWorkerJobLease(ctx, cancel, "job", "owner", 120*time.Millisecond, done)

	select {
	case <-store.started:
	case <-time.After(time.Second):
		t.Fatal("heartbeat did not attempt renewal")
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("normal heartbeat shutdown error=%v, want nil", err)
	}
}

func TestDefaultWorkerJobsDisableAndHideRetiredBYOKGlobalConsumer(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	if err := store.SaveWorkerJob(context.Background(), WorkerJob{
		Name:            WorkerJobRetryBYOKSync,
		Kind:            WorkerJobRetryBYOKSync,
		Enabled:         true,
		IntervalSeconds: 300,
		Status:          WorkerJobStatusSuccess,
	}); err != nil {
		t.Fatal(err)
	}
	jobs, err := svc.ListWorkerJobs(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := workerJobByName(jobs, WorkerJobRetryBYOKSync); ok {
		t.Fatalf("retired retry BYOK job should be hidden: %+v", jobs)
	}
	job, ok, err := store.GetWorkerJob(context.Background(), WorkerJobRetryBYOKSync)
	if err != nil || !ok {
		t.Fatalf("get retired job ok=%v err=%v", ok, err)
	}
	if job.Enabled {
		t.Fatalf("retired retry BYOK job remains enabled: %+v", job)
	}
}

func TestCoreWorkerPoolExcludesUserTaskConsumers(t *testing.T) {
	for _, job := range defaultWorkerJobs {
		got := workerJobRunsInCorePool(job.Name)
		want := job.Name != WorkerJobRetryBYOKSync && job.Name != WorkerJobRefreshTenantObservations
		if got != want {
			t.Fatalf("core selection for %s = %v, want %v", job.Name, got, want)
		}
	}
}

func TestQueueWorkerJobNowMakesJobDueWithoutRunningBody(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	future := time.Now().UTC().Add(10 * time.Minute)
	if err := store.SaveWorkerJob(context.Background(), WorkerJob{
		Name:            WorkerJobCheckChannelDrift,
		Kind:            WorkerJobCheckChannelDrift,
		Enabled:         true,
		IntervalSeconds: 60,
		Status:          WorkerJobStatusSuccess,
		NextRunAt:       future,
	}); err != nil {
		t.Fatal(err)
	}

	run, err := svc.QueueWorkerJobNow(context.Background(), WorkerJobCheckChannelDrift)
	if err != nil {
		t.Fatalf("queue job: %v", err)
	}
	if run.JobName != WorkerJobCheckChannelDrift || run.Status != WorkerJobStatusQueued {
		t.Fatalf("queued run = %+v", run)
	}
	job, ok, err := store.GetWorkerJob(context.Background(), WorkerJobCheckChannelDrift)
	if err != nil || !ok {
		t.Fatalf("get job ok=%v err=%v", ok, err)
	}
	if job.NextRunAt.After(time.Now().UTC().Add(5 * time.Second)) {
		t.Fatalf("next_run_at = %s, want due now", job.NextRunAt)
	}
}

func TestRetryBYOKSyncJobProcessesMoreThanLegacyTinyBatch(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	now := time.Now().UTC()
	svc.now = func() time.Time { return now }
	for i := 0; i < 75; i++ {
		if _, err := store.EnqueueBYOKSyncTask(context.Background(), BYOKSyncTask{
			ExternalUserID: fmt.Sprintf("byok-batch-%03d", i),
			SetID:          "set-a",
			Status:         BYOKSyncTaskStatusPending,
			NextRunAt:      now,
		}); err != nil {
			t.Fatal(err)
		}
	}
	synced, failed, err := svc.retryBYOKSyncJob(context.Background(), "worker-a")
	if err == nil {
		t.Fatal("expected missing settings errors")
	}
	if synced != 0 || failed != 75 {
		t.Fatalf("processed synced=%d failed=%d, want all 75 tasks processed", synced, failed)
	}
	stats, err := store.GetBYOKSyncTaskStats(context.Background(), now)
	if err != nil {
		t.Fatal(err)
	}
	if stats.Pending != 0 || stats.Error != 75 {
		t.Fatalf("unexpected byok stats after retry: %+v", stats)
	}
}

func TestRetryFailedBYOKSyncTasksRequeuesBackoffWithoutChangingIntent(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	now := time.Date(2026, 7, 13, 10, 0, 0, 0, time.UTC)
	svc.now = func() time.Time { return now }
	if _, err := store.EnqueueBYOKSyncTask(context.Background(), BYOKSyncTask{
		ExternalUserID: "user-retry", SetID: "set-a", NextRunAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	task, acquired, err := store.TryAcquireBYOKSyncTask(context.Background(), "user-retry", "worker-a", time.Minute, now)
	if err != nil || !acquired {
		t.Fatalf("acquire=%v err=%v", acquired, err)
	}
	failed, err := store.CompleteBYOKSyncTask(context.Background(), task, false, "upstream unavailable", now)
	if err != nil {
		t.Fatal(err)
	}
	if failed.Status != BYOKSyncTaskStatusError || !failed.NextRunAt.After(now) {
		t.Fatalf("failed task did not enter backoff: %+v", failed)
	}

	requeued, err := svc.RetryFailedBYOKSyncTasks(context.Background(), 100)
	if err != nil {
		t.Fatal(err)
	}
	if requeued != 1 {
		t.Fatalf("requeued=%d want=1", requeued)
	}
	saved, ok, err := store.GetBYOKSyncTask(context.Background(), "user-retry")
	if err != nil || !ok {
		t.Fatalf("get task ok=%v err=%v", ok, err)
	}
	if saved.Status != BYOKSyncTaskStatusPending || saved.NextRunAt.After(now) {
		t.Fatalf("task was not made immediately claimable: %+v", saved)
	}
	if saved.RequestedVersion != failed.RequestedVersion {
		t.Fatalf("retry changed intent version: got=%d want=%d", saved.RequestedVersion, failed.RequestedVersion)
	}
}

func TestUserTaskQueueStatsExposeLastWorkerSuccessAndFailure(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	ctx := context.Background()
	now := time.Date(2026, 7, 13, 12, 0, 0, 0, time.UTC)
	svc.now = func() time.Time { return now }

	for _, item := range []struct {
		userID  string
		at      time.Time
		success bool
	}{
		{userID: "byok-success", at: now.Add(-2 * time.Minute), success: true},
		{userID: "byok-failure", at: now.Add(-time.Minute), success: false},
	} {
		if _, err := store.EnqueueBYOKSyncTask(ctx, BYOKSyncTask{ExternalUserID: item.userID, SetID: "set-a", NextRunAt: item.at}); err != nil {
			t.Fatal(err)
		}
		task, acquired, err := store.TryAcquireBYOKSyncTask(ctx, item.userID, "worker-a", time.Minute, item.at)
		if err != nil || !acquired {
			t.Fatalf("acquire %s=%v err=%v", item.userID, acquired, err)
		}
		message := ""
		if !item.success {
			message = "remote failure"
		}
		if _, err := store.CompleteBYOKSyncTask(ctx, task, item.success, message, item.at); err != nil {
			t.Fatal(err)
		}
	}
	byokStats, err := store.GetBYOKSyncTaskStats(ctx, now)
	if err != nil {
		t.Fatal(err)
	}
	if !byokStats.LastSuccessAt.Equal(now.Add(-2*time.Minute)) || !byokStats.LastFailureAt.Equal(now.Add(-time.Minute)) {
		t.Fatalf("unexpected BYOK worker times: %+v", byokStats)
	}

	for _, item := range []struct {
		userID  string
		at      time.Time
		success bool
	}{
		{userID: "observation-success", at: now.Add(-3 * time.Minute), success: true},
		{userID: "observation-failure", at: now.Add(-30 * time.Second), success: false},
	} {
		if _, err := store.EnqueueTenantObservationTask(ctx, TenantObservationTask{ExternalUserID: item.userID, NextRunAt: item.at}); err != nil {
			t.Fatal(err)
		}
		task, acquired, err := store.TryAcquireTenantObservationTask(ctx, item.userID, "observer-a", time.Minute, item.at)
		if err != nil || !acquired {
			t.Fatalf("acquire %s=%v err=%v", item.userID, acquired, err)
		}
		completion := TenantObservationTaskCompletion{Succeeded: item.success, NextRunAt: now.Add(time.Hour)}
		if !item.success {
			completion.Message = "remote failure"
		}
		if _, err := store.CompleteTenantObservationTask(ctx, task, completion, item.at); err != nil {
			t.Fatal(err)
		}
	}
	observationStats, err := store.GetTenantObservationTaskStats(ctx, now)
	if err != nil {
		t.Fatal(err)
	}
	if !observationStats.LastSuccessAt.Equal(now.Add(-3*time.Minute)) || !observationStats.LastFailureAt.Equal(now.Add(-30*time.Second)) {
		t.Fatalf("unexpected observation worker times: %+v", observationStats)
	}
	metrics := svc.PrometheusMetrics()
	for _, name := range []string{
		"llmgateway_byok_sync_last_success_timestamp_seconds",
		"llmgateway_byok_sync_last_failure_timestamp_seconds",
		"llmgateway_tenant_observation_last_success_timestamp_seconds",
		"llmgateway_tenant_observation_last_failure_timestamp_seconds",
	} {
		if !strings.Contains(metrics, name) {
			t.Fatalf("metrics missing %s:\n%s", name, metrics)
		}
	}
}

func TestRefreshTenantObservationsJobSeedsTaskQueueAcrossPages(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{WorkerObservationSeedBatch: 20})
	ctx := context.Background()
	for i := 0; i < 25; i++ {
		userID := fmt.Sprintf("user-%02d", i)
		if err := store.SaveTenant(ctx, Tenant{
			ExternalUserID: userID,
			Backend:        UserBackendNew,
			SetID:          "set-a",
			Status:         TenantStatusActive,
			Source:         "test",
		}); err != nil {
			t.Fatal(err)
		}
	}

	if _, err := svc.RunWorkerJobNow(ctx, WorkerJobRefreshTenantObservations); err != nil {
		t.Fatal(err)
	}
	firstPassQueued := countTenantObservationTasks(t, store, 25)
	if firstPassQueued != 20 {
		t.Fatalf("first pass queued %d tenants, want one page of 20", firstPassQueued)
	}
	if _, err := svc.RunWorkerJobNow(ctx, WorkerJobRefreshTenantObservations); err != nil {
		t.Fatal(err)
	}
	if queued := countTenantObservationTasks(t, store, 25); queued != 25 {
		t.Fatalf("second pass queued %d tenants, want all 25 after cursor advances", queued)
	}
	job, ok, err := store.GetWorkerJob(ctx, WorkerJobRefreshTenantObservations)
	if err != nil || !ok {
		t.Fatalf("get worker job ok=%v err=%v", ok, err)
	}
	if job.Cursor != "" {
		t.Fatalf("cursor after reaching end = %q, want reset for the next full cycle", job.Cursor)
	}
}

func TestRefreshTenantObservationsJobResetsInvalidCursor(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	ctx := context.Background()
	if err := store.SaveTenant(ctx, Tenant{
		ExternalUserID: "user-00",
		Backend:        UserBackendNew,
		SetID:          "set-a",
		Status:         TenantStatusActive,
		Source:         "test",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveWorkerJob(ctx, WorkerJob{
		Name:            WorkerJobRefreshTenantObservations,
		Kind:            WorkerJobRefreshTenantObservations,
		Enabled:         true,
		IntervalSeconds: 300,
		Status:          WorkerJobStatusIdle,
		Cursor:          "not-a-valid-cursor",
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := svc.RunWorkerJobNow(ctx, WorkerJobRefreshTenantObservations); err != nil {
		t.Fatalf("run worker with invalid cursor err=%v, want reset and continue", err)
	}
	if queued := countTenantObservationTasks(t, store, 1); queued != 1 {
		t.Fatalf("queued %d tenants after invalid cursor reset, want 1", queued)
	}
}

func TestRefreshTenantObservationsJobDoesNotRescheduleExistingTask(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	if err := store.SaveTenant(t.Context(), Tenant{ExternalUserID: "user-1", Backend: UserBackendNew, SetID: "set-a", Status: TenantStatusActive}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.RunWorkerJobNow(t.Context(), WorkerJobRefreshTenantObservations); err != nil {
		t.Fatal(err)
	}
	first, _, _ := store.GetTenantObservationTask(t.Context(), "user-1")
	if _, err := svc.RunWorkerJobNow(t.Context(), WorkerJobRefreshTenantObservations); err != nil {
		t.Fatal(err)
	}
	second, _, _ := store.GetTenantObservationTask(t.Context(), "user-1")
	if second.RequestedVersion != first.RequestedVersion || !second.NextRunAt.Equal(first.NextRunAt) {
		t.Fatalf("periodic seed rescheduled existing task: first=%+v second=%+v", first, second)
	}
}

func TestChannelDriftJobUsesPersistentCursorBatches(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/channel/search" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		writeGatewayChannelJSON(t, w, map[string]any{
			"success": true,
			"data":    map[string]any{"items": []any{}, "total": 0},
		})
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, upstream.Client().Transport, Options{})
	for i := 0; i < 12; i++ {
		saveReadySet(t, store, fmt.Sprintf("set-%02d", i), upstream.URL)
	}
	if _, err := svc.UpsertChannelBundle(context.Background(), ChannelBundle{
		ID: "golden-channels", Name: "Golden", Spec: ChannelBundleSpec{Version: 1, Kind: ChannelBundleKind, Channels: []ChannelBundleChannel{{
			ID: "channel", Name: "Channel", Type: 1, Key: "sk-test", BaseURL: "http://mock", Models: "m1", Group: "default", Status: ChannelSpecStatusEnabled,
		}}},
	}); err != nil {
		t.Fatal(err)
	}

	first, err := svc.RunWorkerJobNow(context.Background(), WorkerJobCheckChannelDrift)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(first.Detail, "checked=10") {
		t.Fatalf("first run detail=%q, want one batch of 10", first.Detail)
	}
	job, ok, err := store.GetWorkerJob(context.Background(), WorkerJobCheckChannelDrift)
	if err != nil || !ok || job.Cursor == "" {
		t.Fatalf("first run cursor=%q ok=%v err=%v, want continuation", job.Cursor, ok, err)
	}

	second, err := svc.RunWorkerJobNow(context.Background(), WorkerJobCheckChannelDrift)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(second.Detail, "checked=2") {
		t.Fatalf("second run detail=%q, want remaining 2", second.Detail)
	}
	job, ok, err = store.GetWorkerJob(context.Background(), WorkerJobCheckChannelDrift)
	if err != nil || !ok || job.Cursor != "" {
		t.Fatalf("second run cursor=%q ok=%v err=%v, want reset at end", job.Cursor, ok, err)
	}
}

func TestChannelBundleReleaseRecordsRevisionAndStopsOnFailure(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "channel list failed", http.StatusBadGateway)
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	mustSaveSet(t, store, Set{ID: "set-bad", BaseURL: upstream.URL, Status: SetStatusActive, Setup: true, AdminUserID: 1, AdminAccessToken: "admin-token"})
	mustSaveSet(t, store, Set{ID: "set-good", BaseURL: upstream.URL, Status: SetStatusActive, Setup: true, AdminUserID: 1, AdminAccessToken: "admin-token"})
	bundle, err := svc.UpsertChannelBundle(context.Background(), ChannelBundle{
		ID: "golden", Name: "Golden", Spec: ChannelBundleSpec{Version: 1, Kind: ChannelBundleKind, Channels: []ChannelBundleChannel{{
			ID: "minimax", Name: "MiniMax", Type: 1, Key: "sk-test", BaseURL: "http://mock", Models: "m1", Group: "default", Status: ChannelSpecStatusEnabled,
		}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	revisions, err := svc.ListChannelBundleRevisions(context.Background(), bundle.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(revisions) != 1 || revisions[0].Fingerprint != bundle.Fingerprint {
		t.Fatalf("unexpected revisions after upsert: %+v", revisions)
	}
	if len(revisions[0].Spec.Channels) != 1 || revisions[0].Spec.Channels[0].Key != "" || revisions[0].Spec.Channels[0].KeyHash == "" {
		t.Fatalf("revision must be redacted but keep key hash: %+v", revisions[0].Spec.Channels)
	}

	run, err := svc.CreateChannelBundleRelease(context.Background(), ChannelBundleReleaseInput{
		BundleID: "golden", SetIDs: []string{"set-bad", "set-good"}, StopOnFailure: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != ChannelBundleReleaseStatusError || len(run.Items) != 1 || run.Items[0].SetID != "set-bad" {
		t.Fatalf("release should stop on first failed set: %+v", run)
	}

	if _, err := svc.UpsertChannelBundle(context.Background(), ChannelBundle{
		ID: "golden", Name: "Golden v2", Spec: ChannelBundleSpec{Version: 1, Kind: ChannelBundleKind, Channels: []ChannelBundleChannel{{
			ID: "minimax", Name: "MiniMax", Type: 1, Key: "sk-test", BaseURL: "http://mock-v2", Models: "m2", Group: "default", Status: ChannelSpecStatusEnabled,
		}}},
	}); err != nil {
		t.Fatal(err)
	}
	rolledBack, err := svc.RollbackChannelBundleToRevision(context.Background(), "golden", revisions[0].RevisionID)
	if err != nil {
		t.Fatal(err)
	}
	if rolledBack.Fingerprint != revisions[0].Fingerprint {
		t.Fatalf("rollback fingerprint = %q, want %q", rolledBack.Fingerprint, revisions[0].Fingerprint)
	}
	if len(rolledBack.Spec.Channels) != 1 || rolledBack.Spec.Channels[0].Key != "sk-test" {
		t.Fatalf("rollback must restore publishable secret from current bundle: %+v", rolledBack.Spec.Channels)
	}
	afterRollback, err := svc.ListChannelBundleRevisions(context.Background(), "golden")
	if err != nil {
		t.Fatal(err)
	}
	if len(afterRollback) != 3 {
		t.Fatalf("rollback should create a new revision, got %d: %+v", len(afterRollback), afterRollback)
	}
}

func TestChannelBundleReleaseAppliesTheRequestedHistoricalRevision(t *testing.T) {
	var remoteCreated bool
	var remoteModels string
	var remoteBaseURL string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/channel/search":
			items := []map[string]any{}
			if remoteCreated {
				items = append(items, map[string]any{
					"id": 17, "name": "llmgw:platform:Platform", "type": 1, "status": 1,
					"models": remoteModels, "group": "default", "base_url": remoteBaseURL,
				})
			}
			writeGatewayChannelJSON(t, w, map[string]any{"success": true, "data": map[string]any{"items": items, "total": len(items)}})
		case "POST /api/channel/":
			var req struct {
				Channel struct {
					Models  string  `json:"models"`
					BaseURL *string `json:"base_url"`
				} `json:"channel"`
			}
			decodeGatewayChannelJSON(t, r, &req)
			remoteModels = req.Channel.Models
			if req.Channel.BaseURL != nil {
				remoteBaseURL = *req.Channel.BaseURL
			}
			remoteCreated = true
			writeGatewayChannelJSON(t, w, map[string]any{"success": true})
		case "PUT /api/channel/":
			var req struct {
				Models  string  `json:"models"`
				BaseURL *string `json:"base_url"`
			}
			decodeGatewayChannelJSON(t, r, &req)
			remoteModels = req.Models
			if req.BaseURL != nil {
				remoteBaseURL = *req.BaseURL
			}
			writeGatewayChannelJSON(t, w, map[string]any{"success": true})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, upstream.Client().Transport, Options{})
	mustSaveSet(t, store, Set{ID: "set-a", BaseURL: upstream.URL, Status: SetStatusActive, Setup: true, AdminUserID: 1, AdminAccessToken: "admin-token"})
	first, err := svc.UpsertChannelBundle(context.Background(), ChannelBundle{
		ID: "golden", Name: "Golden v1", Spec: ChannelBundleSpec{Version: 1, Kind: ChannelBundleKind, Channels: []ChannelBundleChannel{{
			ID: "platform", Name: "Platform", Type: 1, Key: "sk-stable", BaseURL: "https://v1.example.com", Models: "model-v1", Group: "default", Status: ChannelSpecStatusEnabled,
		}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	revisions, err := svc.ListChannelBundleRevisions(context.Background(), first.ID)
	if err != nil || len(revisions) != 1 {
		t.Fatalf("list first revision len=%d err=%v", len(revisions), err)
	}
	if _, err := svc.UpsertChannelBundle(context.Background(), ChannelBundle{
		ID: "golden", Name: "Golden v2", Spec: ChannelBundleSpec{Version: 1, Kind: ChannelBundleKind, Channels: []ChannelBundleChannel{{
			ID: "platform", Name: "Platform", Type: 1, Key: "sk-stable", BaseURL: "https://v2.example.com", Models: "model-v2", Group: "default", Status: ChannelSpecStatusEnabled,
		}}},
	}); err != nil {
		t.Fatal(err)
	}

	run, err := svc.CreateChannelBundleRelease(context.Background(), ChannelBundleReleaseInput{
		BundleID: first.ID, RevisionID: revisions[0].RevisionID, SetIDs: []string{"set-a"}, StopOnFailure: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != ChannelBundleReleaseStatusSuccess || run.Fingerprint != first.Fingerprint {
		t.Fatalf("release run = %+v, want successful v1 release", run)
	}
	if remoteModels != "model-v1" || remoteBaseURL != "https://v1.example.com" {
		t.Fatalf("remote got models=%q base_url=%q, want requested historical revision", remoteModels, remoteBaseURL)
	}
	state, ok, err := store.GetChannelBundleSyncState(context.Background(), first.ID, "set-a")
	if err != nil || !ok {
		t.Fatalf("get bundle state ok=%v err=%v", ok, err)
	}
	if state.AppliedFingerprint != first.Fingerprint {
		t.Fatalf("applied fingerprint = %q, want %q", state.AppliedFingerprint, first.Fingerprint)
	}
}

func TestChannelBundleReleaseRejectsConcurrentReleaseForSameBundle(t *testing.T) {
	block := make(chan struct{})
	var unblock sync.Once
	t.Cleanup(func() { unblock.Do(func() { close(block) }) })
	firstSearchStarted := make(chan struct{}, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/channel/search" {
			writeNewAPIChannelListResponse(t, w)
			return
		}
		select {
		case firstSearchStarted <- struct{}{}:
		default:
		}
		select {
		case <-block:
		case <-r.Context().Done():
			return
		}
		writeNewAPIChannelListResponse(t, w)
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	mustSaveSet(t, store, Set{ID: "set-a", BaseURL: upstream.URL, Status: SetStatusActive, Setup: true, AdminUserID: 1, AdminAccessToken: "admin-token"})
	if _, err := svc.UpsertChannelBundle(context.Background(), ChannelBundle{
		ID: "golden", Name: "Golden", Spec: ChannelBundleSpec{Version: 1, Kind: ChannelBundleKind},
	}); err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	wg.Add(1)
	firstErr := make(chan error, 1)
	go func() {
		defer wg.Done()
		_, err := svc.CreateChannelBundleRelease(context.Background(), ChannelBundleReleaseInput{
			BundleID: "golden", SetIDs: []string{"set-a"}, StopOnFailure: true,
		})
		firstErr <- err
	}()
	select {
	case <-firstSearchStarted:
	case <-time.After(time.Second):
		t.Fatal("first release did not reach the remote channel check")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	_, err := svc.CreateChannelBundleRelease(ctx, ChannelBundleReleaseInput{
		BundleID: "golden", SetIDs: []string{"set-a"}, StopOnFailure: true,
	})
	if err == nil || !strings.Contains(err.Error(), "locked") {
		t.Fatalf("concurrent release error = %v, want channel bundle locked", err)
	}

	unblock.Do(func() { close(block) })
	wg.Wait()
	if err := <-firstErr; err != nil {
		t.Fatalf("first release failed: %v", err)
	}
}

func TestChannelBundleReleaseLockRejectsRollbackForSameBundle(t *testing.T) {
	block := make(chan struct{})
	var unblock sync.Once
	t.Cleanup(func() { unblock.Do(func() { close(block) }) })
	firstSearchStarted := make(chan struct{}, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case firstSearchStarted <- struct{}{}:
		default:
		}
		select {
		case <-block:
		case <-r.Context().Done():
			return
		}
		writeNewAPIChannelListResponse(t, w)
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	mustSaveSet(t, store, Set{ID: "set-a", BaseURL: upstream.URL, Status: SetStatusActive, Setup: true, AdminUserID: 1, AdminAccessToken: "admin-token"})
	bundle, err := svc.UpsertChannelBundle(context.Background(), ChannelBundle{
		ID: "golden", Name: "Golden", Spec: ChannelBundleSpec{Version: 1, Kind: ChannelBundleKind, Channels: []ChannelBundleChannel{{
			ID: "minimax", Name: "MiniMax", Type: 1, Key: "sk-test", BaseURL: "http://mock", Models: "m1", Group: "default", Status: ChannelSpecStatusEnabled,
		}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	revisions, err := svc.ListChannelBundleRevisions(context.Background(), bundle.ID)
	if err != nil || len(revisions) == 0 {
		t.Fatalf("expected initial revision, err=%v revisions=%+v", err, revisions)
	}

	firstErr := make(chan error, 1)
	go func() {
		_, err := svc.CreateChannelBundleRelease(context.Background(), ChannelBundleReleaseInput{
			BundleID: "golden", SetIDs: []string{"set-a"}, StopOnFailure: true,
		})
		firstErr <- err
	}()
	select {
	case <-firstSearchStarted:
	case <-time.After(time.Second):
		t.Fatal("first release did not reach the remote channel check")
	}

	_, err = svc.RollbackChannelBundleToRevision(context.Background(), "golden", revisions[0].RevisionID)
	if err == nil || !strings.Contains(err.Error(), "locked") {
		t.Fatalf("rollback during release error = %v, want channel bundle locked", err)
	}

	unblock.Do(func() { close(block) })
	<-firstErr
}

func TestTenantDetailAggregatesLocalState(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	now := time.Date(2026, 7, 7, 10, 0, 0, 0, time.UTC)
	svc.now = func() time.Time { return now }
	if err := store.SaveTenant(context.Background(), Tenant{ExternalUserID: "user-1", Backend: UserBackendNew, SetID: "set-a", Status: TenantStatusActive, DisplayName: "Demo User"}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserBinding(context.Background(), UserBinding{ExternalUserID: "user-1", SetID: "set-a", UpstreamUserID: 42, Username: "sgw-user-1", LastPlanID: "pro", ProvisionStatus: BindingProvisionStatusTokenReady}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveAPIKeyBinding(context.Background(), APIKeyBinding{ExternalKey: "sk-user-key", ExternalKeyID: "key-1", SetID: "set-a", UserID: "user-1", UpstreamKeyID: 7, CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserAssignment(context.Background(), UserAssignment{ExternalUserID: "user-1", Backend: UserBackendNew, SetID: "set-a", MigratedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserLLMSettings(context.Background(), UserLLMSettings{ExternalUserID: "user-1", Routing: UserLLMRouting{Mode: LLMRouteBYOKFirst}, LastSyncError: "provider failed"}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveTenantObservation(context.Background(), TenantObservation{ExternalUserID: "user-1", Backend: UserBackendNew, SetID: "set-a", CurrentPlanID: "pro", CreditAvailable: 100, CreditStatus: "ok", ObservedAt: now}); err != nil {
		t.Fatal(err)
	}

	detail, err := svc.GetTenantDetail(context.Background(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if detail.Tenant.UserID != "user-1" || detail.Binding.UpstreamUserID != 42 || detail.Observation.CurrentPlanID != "pro" {
		t.Fatalf("unexpected tenant detail: %+v", detail)
	}
	if len(detail.Keys) != 1 || detail.Keys[0].ExternalKeyID != "key-1" || detail.Keys[0].KeyHashPrefix == "" {
		t.Fatalf("unexpected key summaries: %+v", detail.Keys)
	}
	if detail.LLMSettings.Routing.Mode != LLMRouteBYOKFirst || detail.LLMSettings.LastSyncError != "provider failed" {
		t.Fatalf("unexpected llm settings: %+v", detail.LLMSettings)
	}
}

func TestBYOKSyncTaskEnqueueDeduplicatesByUserAndIncrementsVersion(t *testing.T) {
	store := NewMemoryStore()
	first, err := store.EnqueueBYOKSyncTask(context.Background(), BYOKSyncTask{
		ExternalUserID: "user-1",
		SetID:          "set-a",
		Status:         BYOKSyncTaskStatusPending,
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.EnqueueBYOKSyncTask(context.Background(), BYOKSyncTask{
		ExternalUserID: "user-1",
		SetID:          "set-a",
		Status:         BYOKSyncTaskStatusPending,
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.RequestedVersion != 1 || second.RequestedVersion != 2 {
		t.Fatalf("requested versions = %d, %d; want 1, 2", first.RequestedVersion, second.RequestedVersion)
	}
	tasks, err := store.ListBYOKSyncTasks(context.Background(), BYOKSyncTaskListOptions{Status: BYOKSyncTaskStatusPending, Now: time.Now().UTC(), Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 1 || tasks[0].ExternalUserID != "user-1" || tasks[0].RequestedVersion != 2 {
		t.Fatalf("unexpected task list: %+v", tasks)
	}
}

func TestBYOKSyncTaskCompletionKeepsNewerIntentPending(t *testing.T) {
	store := NewMemoryStore()
	now := time.Now().UTC()
	if _, err := store.EnqueueBYOKSyncTask(context.Background(), BYOKSyncTask{
		ExternalUserID: "user-1",
		SetID:          "set-a",
		Status:         BYOKSyncTaskStatusPending,
		NextRunAt:      now,
	}); err != nil {
		t.Fatal(err)
	}
	running, acquired, err := store.TryAcquireBYOKSyncTask(context.Background(), "user-1", "worker-a", time.Minute, now)
	if err != nil {
		t.Fatal(err)
	}
	if !acquired || running.Status != BYOKSyncTaskStatusRunning || running.ProcessingVersion != 1 {
		t.Fatalf("unexpected acquired task: acquired=%v task=%+v", acquired, running)
	}
	if _, err := store.EnqueueBYOKSyncTask(context.Background(), BYOKSyncTask{
		ExternalUserID: "user-1",
		SetID:          "set-a",
		Status:         BYOKSyncTaskStatusPending,
		NextRunAt:      now,
	}); err != nil {
		t.Fatal(err)
	}
	if queued, acquired, err := store.TryAcquireBYOKSyncTask(context.Background(), "user-1", "worker-b", time.Minute, now.Add(100*time.Millisecond)); err != nil {
		t.Fatal(err)
	} else if acquired || queued.Status != BYOKSyncTaskStatusRunning || queued.RequestedVersion != 2 || queued.ProcessingVersion != 1 {
		t.Fatalf("newer intent must not allow concurrent acquire: acquired=%v task=%+v", acquired, queued)
	}
	completed, err := store.CompleteBYOKSyncTask(context.Background(), running, true, "", now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != BYOKSyncTaskStatusPending || completed.AppliedVersion != 1 || completed.RequestedVersion != 2 {
		t.Fatalf("old completion swallowed newer intent: %+v", completed)
	}
}

func TestBYOKSyncTaskFailureDoesNotBackoffNewerIntent(t *testing.T) {
	store := NewMemoryStore()
	now := time.Now().UTC()
	if _, err := store.EnqueueBYOKSyncTask(context.Background(), BYOKSyncTask{
		ExternalUserID: "user-1",
		SetID:          "set-a",
		Status:         BYOKSyncTaskStatusPending,
		NextRunAt:      now,
	}); err != nil {
		t.Fatal(err)
	}
	running, acquired, err := store.TryAcquireBYOKSyncTask(context.Background(), "user-1", "worker-a", time.Minute, now)
	if err != nil {
		t.Fatal(err)
	}
	if !acquired {
		t.Fatalf("expected first worker acquire")
	}
	if _, err := store.EnqueueBYOKSyncTask(context.Background(), BYOKSyncTask{
		ExternalUserID: "user-1",
		SetID:          "set-a",
		Status:         BYOKSyncTaskStatusPending,
		NextRunAt:      now.Add(time.Second),
	}); err != nil {
		t.Fatal(err)
	}
	completed, err := store.CompleteBYOKSyncTask(context.Background(), running, false, "remote failed", now.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != BYOKSyncTaskStatusPending || completed.NextRunAt.After(now.Add(2*time.Second)) || completed.RequestedVersion != 2 {
		t.Fatalf("newer intent should stay pending without backoff: %+v", completed)
	}
}

func TestBYOKSyncTaskListIncludesExpiredRunningLease(t *testing.T) {
	store := NewMemoryStore()
	now := time.Now().UTC()
	if _, err := store.EnqueueBYOKSyncTask(context.Background(), BYOKSyncTask{
		ExternalUserID: "user-1",
		SetID:          "set-a",
		Status:         BYOKSyncTaskStatusPending,
		NextRunAt:      now,
	}); err != nil {
		t.Fatal(err)
	}
	if _, acquired, err := store.TryAcquireBYOKSyncTask(context.Background(), "user-1", "worker-a", time.Minute, now); err != nil || !acquired {
		t.Fatalf("acquire = %v, %v; want true", acquired, err)
	}

	tasks, err := store.ListBYOKSyncTasks(context.Background(), BYOKSyncTaskListOptions{Now: now.Add(2 * time.Minute), Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 1 || tasks[0].ExternalUserID != "user-1" || tasks[0].Status != BYOKSyncTaskStatusRunning {
		t.Fatalf("expired running task was not claimable: %+v", tasks)
	}
}

func TestBYOKSyncTaskStaleOwnerCannotCompleteAfterReacquire(t *testing.T) {
	store := NewMemoryStore()
	now := time.Now().UTC()
	if _, err := store.EnqueueBYOKSyncTask(context.Background(), BYOKSyncTask{
		ExternalUserID: "user-1",
		SetID:          "set-a",
		Status:         BYOKSyncTaskStatusPending,
		NextRunAt:      now,
	}); err != nil {
		t.Fatal(err)
	}
	stale, acquired, err := store.TryAcquireBYOKSyncTask(context.Background(), "user-1", "worker-a", time.Minute, now)
	if err != nil || !acquired {
		t.Fatalf("first acquire = %v, %v; want true", acquired, err)
	}
	current, acquired, err := store.TryAcquireBYOKSyncTask(context.Background(), "user-1", "worker-b", time.Minute, now.Add(2*time.Minute))
	if err != nil || !acquired {
		t.Fatalf("reacquire = %v, %v; want true", acquired, err)
	}
	if _, err := store.CompleteBYOKSyncTask(context.Background(), stale, true, "", now.Add(2*time.Minute+time.Second)); !errors.Is(err, ErrBYOKSyncTaskLeaseLost) {
		t.Fatalf("stale completion error = %v, want ErrBYOKSyncTaskLeaseLost", err)
	}
	after, ok, err := store.GetBYOKSyncTask(context.Background(), "user-1")
	if err != nil || !ok {
		t.Fatalf("get task = %v, %v", ok, err)
	}
	if after.Status != BYOKSyncTaskStatusRunning || after.LeaseOwner != current.LeaseOwner {
		t.Fatalf("stale completion changed current task: %+v", after)
	}
}

func TestBYOKSyncTaskLeaseRenewalPreventsTakeover(t *testing.T) {
	store := NewMemoryStore()
	now := time.Now().UTC()
	if _, err := store.EnqueueBYOKSyncTask(context.Background(), BYOKSyncTask{
		ExternalUserID: "user-1",
		SetID:          "set-a",
		Status:         BYOKSyncTaskStatusPending,
		NextRunAt:      now,
	}); err != nil {
		t.Fatal(err)
	}
	running, acquired, err := store.TryAcquireBYOKSyncTask(context.Background(), "user-1", "worker-a", time.Minute, now)
	if err != nil || !acquired {
		t.Fatalf("acquire = %v, %v; want true", acquired, err)
	}
	renewed, err := store.RenewBYOKSyncTaskLease(context.Background(), running, time.Minute, now.Add(30*time.Second))
	if err != nil || !renewed {
		t.Fatalf("renew = %v, %v; want true", renewed, err)
	}
	current, acquired, err := store.TryAcquireBYOKSyncTask(context.Background(), "user-1", "worker-b", time.Minute, now.Add(70*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if acquired || current.LeaseOwner != "worker-a" {
		t.Fatalf("renewed task was taken over: acquired=%v task=%+v", acquired, current)
	}
}

func TestTenantObservationTaskEnqueueDeduplicatesAndCompletesLatestVersion(t *testing.T) {
	store := NewMemoryStore()
	now := time.Now().UTC()
	first, err := store.EnqueueTenantObservationTask(t.Context(), TenantObservationTask{
		ExternalUserID: "user-1", SetID: "set-a", Priority: TenantObservationPriorityEvent, NextRunAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.RequestedVersion != 1 {
		t.Fatalf("first version = %d, want 1", first.RequestedVersion)
	}
	running, acquired, err := store.TryAcquireTenantObservationTask(t.Context(), "user-1", "observer-a", time.Minute, now)
	if err != nil || !acquired {
		t.Fatalf("acquire = %v, %v; want true", acquired, err)
	}
	second, err := store.EnqueueTenantObservationTask(t.Context(), TenantObservationTask{
		ExternalUserID: "user-1", SetID: "set-a", Priority: TenantObservationPriorityEvent, NextRunAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	if second.RequestedVersion != 2 || second.Status != TenantObservationTaskStatusRunning {
		t.Fatalf("newer intent did not merge into running task: %+v", second)
	}
	completed, err := store.CompleteTenantObservationTask(t.Context(), running, TenantObservationTaskCompletion{
		Succeeded: true, NextRunAt: now.Add(time.Hour),
	}, now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != TenantObservationTaskStatusPending || completed.AppliedVersion != 1 || completed.NextRunAt.After(now.Add(time.Second)) {
		t.Fatalf("newer observation intent was swallowed: %+v", completed)
	}
}

func TestTenantObservationTaskStaleOwnerCannotComplete(t *testing.T) {
	store := NewMemoryStore()
	now := time.Now().UTC()
	if _, err := store.EnqueueTenantObservationTask(t.Context(), TenantObservationTask{ExternalUserID: "user-1", SetID: "set-a", NextRunAt: now}); err != nil {
		t.Fatal(err)
	}
	stale, acquired, err := store.TryAcquireTenantObservationTask(t.Context(), "user-1", "observer-a", time.Minute, now)
	if err != nil || !acquired {
		t.Fatalf("first acquire = %v, %v", acquired, err)
	}
	current, acquired, err := store.TryAcquireTenantObservationTask(t.Context(), "user-1", "observer-b", time.Minute, now.Add(2*time.Minute))
	if err != nil || !acquired {
		t.Fatalf("second acquire = %v, %v", acquired, err)
	}
	if _, err := store.CompleteTenantObservationTask(t.Context(), stale, TenantObservationTaskCompletion{Succeeded: true}, now.Add(2*time.Minute+time.Second)); !errors.Is(err, ErrTenantObservationTaskLeaseLost) {
		t.Fatalf("stale completion error = %v, want lease lost", err)
	}
	after, _, _ := store.GetTenantObservationTask(t.Context(), "user-1")
	if after.LeaseOwner != current.LeaseOwner || after.Status != TenantObservationTaskStatusRunning {
		t.Fatalf("stale owner changed current task: %+v", after)
	}
}

func TestCheckSetAdmissionJobSkipsConfiguredRuntimeUntilSlavesAreManaged(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	mustSaveSet(t, store, Set{
		ID: "set-a", BaseURL: "http://unreachable.invalid", Status: SetStatusActive,
		Setup: true, AdminUserID: 1, AdminAccessToken: "admin-token", AdmissionStatus: SetAdmissionStatusPending,
	})
	if err := store.SaveSetProvisionRequest(t.Context(), SetProvisionRequest{
		ID: "req-a", SetID: "set-a", Status: SetProvisionStatusConfigured,
	}); err != nil {
		t.Fatal(err)
	}

	checked, passed, failed, err := svc.checkSetAdmissionJob(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if checked != 0 || passed != 0 || failed != 0 {
		t.Fatalf("checked=%d passed=%d failed=%d", checked, passed, failed)
	}
	set, ok, err := store.GetSet(t.Context(), "set-a")
	if err != nil || !ok {
		t.Fatalf("set ok=%v err=%v", ok, err)
	}
	if set.AdmissionStatus != SetAdmissionStatusPending {
		t.Fatalf("configured runtime admission = %q", set.AdmissionStatus)
	}
}

func writeNewAPIChannelListResponse(t *testing.T, w http.ResponseWriter) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]any{
		"success": true,
		"data": map[string]any{
			"items": []any{},
			"total": 0,
		},
	}); err != nil {
		t.Fatal(err)
	}
}

func countTenantObservations(t *testing.T, store Store, total int) int {
	t.Helper()
	count := 0
	for i := 0; i < total; i++ {
		userID := fmt.Sprintf("user-%02d", i)
		if _, ok, err := store.GetTenantObservation(context.Background(), userID); err != nil {
			t.Fatal(err)
		} else if ok {
			count++
		}
	}
	return count
}

func countTenantObservationTasks(t *testing.T, store Store, total int) int {
	t.Helper()
	count := 0
	for i := 0; i < total; i++ {
		userID := fmt.Sprintf("user-%02d", i)
		if _, ok, err := store.GetTenantObservationTask(context.Background(), userID); err != nil {
			t.Fatal(err)
		} else if ok {
			count++
		}
	}
	return count
}

func overviewHasAlert(overview OperationalOverview, kind string) bool {
	for _, alert := range overview.Alerts {
		if alert.Kind == kind {
			return true
		}
	}
	return false
}

func workerJobByName(jobs []WorkerJob, name string) (WorkerJob, bool) {
	for _, job := range jobs {
		if job.Name == name {
			return job, true
		}
	}
	return WorkerJob{}, false
}

func overviewSetByID(overview OperationalOverview, id string) (SetOverview, bool) {
	for _, set := range overview.Sets {
		if set.ID == id {
			return set, true
		}
	}
	return SetOverview{}, false
}

func mustSaveSet(t *testing.T, store Store, set Set) {
	t.Helper()
	if err := store.SaveSet(context.Background(), set); err != nil {
		t.Fatal(err)
	}
}

func TestListWorkerJobRunsFiltersByStartedAtWatermark(t *testing.T) {
	store := NewMemoryStore()
	jobName := WorkerJobRefreshSetCapacity
	watermark := time.Date(2026, 7, 18, 8, 0, 0, 0, time.UTC)
	for _, run := range []WorkerJobRun{
		{ID: "before", JobName: jobName, Status: WorkerJobStatusSuccess, StartedAt: watermark.Add(-time.Second)},
		{ID: "at", JobName: jobName, Status: WorkerJobStatusSuccess, StartedAt: watermark},
		{ID: "after", JobName: jobName, Status: WorkerJobStatusSuccess, StartedAt: watermark.Add(time.Second)},
		{ID: "other", JobName: WorkerJobCheckChannelDrift, Status: WorkerJobStatusSuccess, StartedAt: watermark.Add(2 * time.Second)},
	} {
		if err := store.SaveWorkerJobRun(t.Context(), run); err != nil {
			t.Fatal(err)
		}
	}

	runs, err := store.ListWorkerJobRuns(t.Context(), WorkerJobRunListOptions{
		JobName:          jobName,
		StartedAtOrAfter: watermark,
		Limit:            10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 2 || runs[0].ID != "after" || runs[1].ID != "at" {
		t.Fatalf("runs = %+v", runs)
	}
}
