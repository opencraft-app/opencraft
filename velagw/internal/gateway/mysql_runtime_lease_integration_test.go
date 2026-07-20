//go:build integration

package gateway

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	mysql "github.com/go-sql-driver/mysql"
)

func TestMySQLAdminCommandDedupeAndLease(t *testing.T) {
	store := newIsolatedMySQLStore(t)
	defer func() { _ = store.Close() }()
	now := time.Now().UTC()
	input := AdminCommand{
		ID: "cmd-a", DedupeKey: "subscription:trade:deal-a", SetID: "set-a",
		ExternalUserID: "user-1", Kind: AdminCommandKindApplySubscription,
		Payload: `{"user_id":"user-1","plan_id":"plan-pro","idempotency_key":"trade:deal-a"}`,
		Status:  AdminCommandStatusPending, NextRunAt: now,
	}
	first, created, err := store.EnqueueAdminCommand(t.Context(), input)
	if err != nil || !created {
		t.Fatalf("first enqueue = %+v created=%v err=%v", first, created, err)
	}
	duplicate := input
	duplicate.ID = "cmd-b"
	second, created, err := store.EnqueueAdminCommand(t.Context(), duplicate)
	if err != nil || created || second.ID != first.ID {
		t.Fatalf("dedupe enqueue = %+v created=%v err=%v", second, created, err)
	}
	claimed, acquired, err := store.TryAcquireAdminCommand(t.Context(), first.ID, "worker-a", time.Minute, now.Add(time.Second))
	if err != nil || !acquired {
		t.Fatalf("first claim = %+v acquired=%v err=%v", claimed, acquired, err)
	}
	if _, acquired, err := store.TryAcquireAdminCommand(t.Context(), first.ID, "worker-b", time.Minute, now.Add(2*time.Second)); err != nil || acquired {
		t.Fatalf("second claim acquired=%v err=%v", acquired, err)
	}
	completed, err := store.CompleteAdminCommand(t.Context(), claimed, AdminCommandStatusSucceeded, `{"id":"sub-a"}`, "", time.Time{}, now.Add(3*time.Second))
	if err != nil || completed.Status != AdminCommandStatusSucceeded {
		t.Fatalf("complete = %+v err=%v", completed, err)
	}
}

func TestMySQLSetScanAcceptsNullPauseReasonFromExistingRows(t *testing.T) {
	store := newIsolatedMySQLStore(t)
	defer func() { _ = store.Close() }()
	ctx := t.Context()
	if err := store.SaveSet(ctx, Set{ID: "set-existing", BaseURL: "http://set-existing", Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(ctx, `
		ALTER TABLE llmgateway_sets
			MODIFY admin_writes_pause_reason TEXT NULL,
			MODIFY admin_image TEXT NULL
	`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(ctx, `UPDATE llmgateway_sets SET admin_writes_pause_reason=NULL,admin_image=NULL WHERE id='set-existing'`); err != nil {
		t.Fatal(err)
	}

	set, ok, err := store.GetSet(ctx, "set-existing")
	if err != nil || !ok {
		t.Fatalf("GetSet ok=%v err=%v", ok, err)
	}
	if set.AdminWritesPauseReason != "" {
		t.Fatalf("pause reason=%q, want empty", set.AdminWritesPauseReason)
	}
	if set.AdminImage != "" {
		t.Fatalf("admin image=%q, want empty", set.AdminImage)
	}
}

func TestMySQLSetRuntimeLeaseRejectsConcurrentRedisDBReuse(t *testing.T) {
	store := newIsolatedMySQLStore(t)
	defer func() { _ = store.Close() }()

	first := SetProvisionRequest{
		ID:           "req-a",
		Source:       "prod",
		Namespace:    "llmgateway",
		Fleet:        "prod",
		SetID:        "set-a",
		ShardRef:     "shard-a",
		DatabaseName: "newapi_set_a",
		RedisDB:      "12",
		Status:       SetProvisionStatusPending,
	}
	second := first
	second.ID = "req-b"
	second.SetID = "set-b"
	second.DatabaseName = "newapi_set_b"

	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for _, request := range []SetProvisionRequest{first, second} {
		wg.Add(1)
		go func(request SetProvisionRequest) {
			defer wg.Done()
			errs <- store.SaveSetProvisionRequest(context.Background(), request)
		}(request)
	}
	wg.Wait()
	close(errs)

	successes := 0
	failures := 0
	for err := range errs {
		if err == nil {
			successes++
			continue
		}
		failures++
		if !strings.Contains(err.Error(), "redis db 12 on shard shard-a is already leased") {
			t.Fatalf("unexpected conflict error: %v", err)
		}
	}
	if successes != 1 || failures != 1 {
		t.Fatalf("successes=%d failures=%d, want exactly one winner and one rejected duplicate", successes, failures)
	}
}

func TestMySQLCleanupStaleSetRuntimeLeasesPreservesLiveSetAndOpenRequest(t *testing.T) {
	store := newIsolatedMySQLStore(t)
	defer func() { _ = store.Close() }()
	ctx := t.Context()
	for _, lease := range []SetRuntimeLease{
		{Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: "set-live", ShardRef: "shard-a", DatabaseName: "newapi_live", RedisDB: "1"},
		{Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: "set-pending", ShardRef: "shard-a", DatabaseName: "newapi_pending", RedisDB: "2"},
		{Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: "set-stale", ShardRef: "shard-a", DatabaseName: "newapi_stale", RedisDB: "3"},
	} {
		if err := store.SaveSetRuntimeLease(ctx, lease); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.SaveSet(ctx, Set{ID: "set-live", BaseURL: "http://set-live", Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveSetProvisionRequest(ctx, SetProvisionRequest{
		ID: "req-pending", Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: "set-pending",
		ShardRef: "shard-a", DatabaseName: "newapi_pending", RedisDB: "2", Status: SetProvisionStatusPending,
	}); err != nil {
		t.Fatal(err)
	}

	cleaned, err := store.CleanupStaleSetRuntimeLeases(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if cleaned != 1 {
		t.Fatalf("cleaned = %d, want 1", cleaned)
	}
	remaining, err := store.ListSetRuntimeLeases(ctx, SetRuntimeLeaseListOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(remaining) != 2 || remaining[0].SetID != "set-live" || remaining[1].SetID != "set-pending" {
		t.Fatalf("remaining leases = %+v, want live Set and open request", remaining)
	}
}

func TestMySQLCleanupStaleSetRuntimeLeasesReleasesTerminalLeaseDespiteSetIDCollision(t *testing.T) {
	store := newIsolatedMySQLStore(t)
	defer func() { _ = store.Close() }()
	ctx := t.Context()
	if err := store.SaveSet(ctx, Set{ID: "set-a", BaseURL: "http://set-a", Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	request := SetProvisionRequest{
		ID: "req-old-scope", Source: "old-load", Namespace: "llmgateway", Fleet: "load", SetID: "set-a",
		ShardRef: "shard-a", DatabaseName: "newapi_old_set_a", RedisDB: "10", Status: SetProvisionStatusPending,
	}
	if err := store.SaveSetProvisionRequest(ctx, request); err != nil {
		t.Fatal(err)
	}
	request.Status = SetProvisionStatusCancelled
	if err := store.SaveSetProvisionRequest(ctx, request); err != nil {
		t.Fatal(err)
	}
	leases, err := store.ListSetRuntimeLeases(ctx, SetRuntimeLeaseListOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(leases) != 0 {
		t.Fatalf("runtime leases = %+v, want terminal lease released despite global Set ID collision", leases)
	}
}

func TestMySQLSubscriptionIdempotencyClaimsAndReplaysDeterministically(t *testing.T) {
	store := newIsolatedMySQLStore(t)
	defer func() { _ = store.Close() }()

	now := time.Now().UTC()
	candidate := SubscriptionIdempotency{
		IdempotencyKey: "trade:deal-mysql-001",
		RequestHash:    string(make([]byte, 32)),
		Status:         SubscriptionIdempotencyProcessing,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	first, acquired, err := store.TryBeginSubscriptionIdempotency(t.Context(), candidate)
	if err != nil || !acquired {
		t.Fatalf("first claim: acquired=%v record=%+v err=%v", acquired, first, err)
	}
	if err := store.FinishSubscriptionIdempotency(t.Context(), candidate.IdempotencyKey, SubscriptionIdempotencySucceeded, "", now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	second, acquired, err := store.TryBeginSubscriptionIdempotency(t.Context(), candidate)
	if err != nil {
		t.Fatal(err)
	}
	if acquired || second.Status != SubscriptionIdempotencySucceeded || second.RequestHash != candidate.RequestHash {
		t.Fatalf("replay = %+v acquired=%v, want succeeded without acquisition", second, acquired)
	}
}

func TestMySQLUserTaskQueuesSupportReleaseRetryAndWorkerStats(t *testing.T) {
	store := newIsolatedMySQLStore(t)
	defer func() { _ = store.Close() }()
	ctx := t.Context()
	now := time.Now().UTC().Truncate(time.Microsecond)

	if _, err := store.EnqueueBYOKSyncTask(ctx, BYOKSyncTask{ExternalUserID: "byok-release", SetID: "set-a", NextRunAt: now}); err != nil {
		t.Fatal(err)
	}
	releasedTask, acquired, err := store.TryAcquireBYOKSyncTask(ctx, "byok-release", "worker-a", time.Minute, now)
	if err != nil || !acquired {
		t.Fatalf("acquire BYOK release task=%v err=%v", acquired, err)
	}
	if released, err := store.ReleaseBYOKSyncTaskLease(ctx, releasedTask, now.Add(time.Second)); err != nil || !released {
		t.Fatalf("release BYOK task=%v err=%v", released, err)
	}

	for _, userID := range []string{"byok-success", "byok-failure"} {
		if _, err := store.EnqueueBYOKSyncTask(ctx, BYOKSyncTask{ExternalUserID: userID, SetID: "set-a", NextRunAt: now}); err != nil {
			t.Fatal(err)
		}
		task, acquired, err := store.TryAcquireBYOKSyncTask(ctx, userID, "worker-a", time.Minute, now)
		if err != nil || !acquired {
			t.Fatalf("acquire %s=%v err=%v", userID, acquired, err)
		}
		success := userID == "byok-success"
		message := ""
		if !success {
			message = "remote failure"
		}
		if _, err := store.CompleteBYOKSyncTask(ctx, task, success, message, now.Add(2*time.Second)); err != nil {
			t.Fatal(err)
		}
	}
	if requeued, err := store.RequeueFailedBYOKSyncTasks(ctx, 100, now.Add(3*time.Second)); err != nil || requeued != 1 {
		t.Fatalf("requeue failed BYOK=%d err=%v", requeued, err)
	}
	byokStats, err := store.GetBYOKSyncTaskStats(ctx, now.Add(4*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if byokStats.Pending != 2 || byokStats.Succeeded != 1 || byokStats.LastSuccessAt.IsZero() {
		t.Fatalf("unexpected BYOK stats: %+v", byokStats)
	}
	if _, err := store.EnqueueBYOKSyncTask(ctx, BYOKSyncTask{ExternalUserID: "byok-set-b", SetID: "set-b", NextRunAt: now}); err != nil {
		t.Fatal(err)
	}
	byokSetB, err := store.ListBYOKSyncTasks(ctx, BYOKSyncTaskListOptions{ExcludeSetIDs: []string{"set-a"}, Now: now.Add(4 * time.Second), Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	if len(byokSetB) != 1 || byokSetB[0].SetID != "set-b" {
		t.Fatalf("BYOK Set exclusion returned %+v, want only set-b", byokSetB)
	}

	if _, err := store.EnqueueTenantObservationTask(ctx, TenantObservationTask{ExternalUserID: "observe-release", NextRunAt: now}); err != nil {
		t.Fatal(err)
	}
	observationTask, acquired, err := store.TryAcquireTenantObservationTask(ctx, "observe-release", "observer-a", time.Minute, now)
	if err != nil || !acquired {
		t.Fatalf("acquire observation release task=%v err=%v", acquired, err)
	}
	if released, err := store.ReleaseTenantObservationTaskLease(ctx, observationTask, now.Add(time.Second)); err != nil || !released {
		t.Fatalf("release observation task=%v err=%v", released, err)
	}
	for _, item := range []struct {
		userID  string
		success bool
	}{
		{userID: "observe-success", success: true},
		{userID: "observe-failure", success: false},
	} {
		if _, err := store.EnqueueTenantObservationTask(ctx, TenantObservationTask{ExternalUserID: item.userID, NextRunAt: now}); err != nil {
			t.Fatal(err)
		}
		task, acquired, err := store.TryAcquireTenantObservationTask(ctx, item.userID, "observer-a", time.Minute, now)
		if err != nil || !acquired {
			t.Fatalf("acquire %s=%v err=%v", item.userID, acquired, err)
		}
		completion := TenantObservationTaskCompletion{Succeeded: item.success, NextRunAt: now.Add(time.Hour)}
		if !item.success {
			completion.Message = "remote failure"
		}
		if _, err := store.CompleteTenantObservationTask(ctx, task, completion, now.Add(2*time.Second)); err != nil {
			t.Fatal(err)
		}
	}
	observationStats, err := store.GetTenantObservationTaskStats(ctx, now.Add(4*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if observationStats.Pending != 2 || observationStats.Error != 1 || observationStats.LastSuccessAt.IsZero() || observationStats.LastFailureAt.IsZero() {
		t.Fatalf("unexpected observation stats: %+v", observationStats)
	}
	if _, err := store.EnqueueTenantObservationTask(ctx, TenantObservationTask{ExternalUserID: "observe-set-b", SetID: "set-b", NextRunAt: now}); err != nil {
		t.Fatal(err)
	}
	observationSetB, err := store.ListTenantObservationTasks(ctx, TenantObservationTaskListOptions{ExcludeSetIDs: []string{""}, Now: now.Add(4 * time.Second), Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	if len(observationSetB) != 1 || observationSetB[0].SetID != "set-b" {
		t.Fatalf("observation Set exclusion returned %+v, want only set-b", observationSetB)
	}
}

func TestMySQLSetRuntimeLeaseSurvivesStoreRestart(t *testing.T) {
	store := newIsolatedMySQLStore(t)
	dsn := isolatedMySQLDSN(t)
	request := SetProvisionRequest{
		ID:           "req-a",
		Source:       "prod",
		Namespace:    "llmgateway",
		Fleet:        "prod",
		SetID:        "set-a",
		ShardRef:     "shard-a",
		DatabaseName: "newapi_set_a",
		RedisDB:      "12",
		Status:       SetProvisionStatusManaged,
	}
	if err := store.SaveSetProvisionRequest(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := NewMySQLStore(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reopened.Close() }()
	duplicate := request
	duplicate.ID = "req-b"
	duplicate.SetID = "set-b"
	duplicate.DatabaseName = "newapi_set_b"
	err = reopened.SaveSetProvisionRequest(context.Background(), duplicate)
	if err == nil {
		t.Fatal("expected persisted lease to reject duplicate redis db after restart")
	}
	if !strings.Contains(err.Error(), "redis db 12 on shard shard-a is already leased by set set-a") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestMySQLStoreRestartIgnoresCancelledProvisionRequestLeaseHistory(t *testing.T) {
	store := newIsolatedMySQLStore(t)
	dsn := isolatedMySQLDSN(t)
	first := SetProvisionRequest{
		ID:           "req-retired",
		Source:       "prod",
		Namespace:    "llmgateway",
		Fleet:        "prod",
		SetID:        "set-retired",
		ShardRef:     "shard-a",
		DatabaseName: "newapi_set_retired",
		RedisDB:      "25",
		Status:       SetProvisionStatusPending,
	}
	if err := store.SaveSetProvisionRequest(t.Context(), first); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(t.Context(), `UPDATE llmgateway_set_provision_requests SET status = 'cancelled' WHERE id = ?`, first.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(t.Context(), `DELETE FROM llmgateway_set_runtime_leases WHERE set_id = ?`, first.SetID); err != nil {
		t.Fatal(err)
	}
	second := first
	second.ID = "req-current"
	second.SetID = "set-current"
	second.DatabaseName = "newapi_set_current"
	second.Status = SetProvisionStatusPending
	if err := store.SaveSetProvisionRequest(t.Context(), second); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := NewMySQLStore(t.Context(), dsn)
	if err != nil {
		t.Fatalf("reopen with cancelled lease history: %v", err)
	}
	defer func() { _ = reopened.Close() }()
	leases, err := reopened.ListSetRuntimeLeases(t.Context(), SetRuntimeLeaseListOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(leases) != 1 || leases[0].SetID != second.SetID {
		t.Fatalf("runtime leases = %+v, want only current set", leases)
	}
}

func TestMySQLGroupRatioMigrationBackfillsExistingBYOKSettings(t *testing.T) {
	store := newIsolatedMySQLStore(t)
	dsn := isolatedMySQLDSN(t)
	now := time.Now().UTC()
	for _, set := range []Set{
		{ID: "set-a", BaseURL: "http://set-a", Status: SetStatusActive, Setup: true, AdminUserID: 1, AdminAccessToken: "admin"},
		{ID: "set-disabled", BaseURL: "http://set-disabled", Status: SetStatusDisabled, Setup: true, AdminUserID: 1, AdminAccessToken: "admin"},
	} {
		if err := store.SaveSet(t.Context(), set); err != nil {
			t.Fatal(err)
		}
	}
	for _, fixture := range []struct {
		userID string
		group  string
		setID  string
	}{
		{userID: "legacy-user", group: "byok_legacy_user", setID: "set-a"},
		{userID: "invalid-legacy-user", group: "default", setID: "set-a"},
		{userID: "disabled-set-user", group: "byok_disabled_user", setID: "set-disabled"},
	} {
		if err := store.SaveUserBinding(t.Context(), UserBinding{
			ExternalUserID: fixture.userID, SetID: fixture.setID, Username: fixture.userID,
			ProvisionStatus: BindingProvisionStatusTokenReady, CreatedAt: now, UpdatedAt: now,
		}); err != nil {
			t.Fatal(err)
		}
		if err := store.SaveUserLLMSettings(t.Context(), UserLLMSettings{
			ExternalUserID: fixture.userID,
			Routing:        UserLLMRouting{Mode: LLMRouteBYOKFirst},
			BYOKGroup:      fixture.group,
			Providers: []UserLLMProvider{{
				ID: "private", Protocol: LLMProviderProtocolOpenAICompatible, BaseURL: "https://example.invalid/v1",
				APIKey: "sk-private", ModelMappings: map[string]string{"auto": "upstream-model"}, Enabled: true,
			}},
			CreatedAt: now,
		}); err != nil {
			t.Fatal(err)
		}
	}
	before, err := store.GetGroupRatioSnapshot(t.Context(), "set-a")
	if err != nil {
		t.Fatal(err)
	}
	if len(before.Entries) != 0 {
		t.Fatalf("legacy fixture unexpectedly has projection: %+v", before)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := NewMySQLStore(t.Context(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reopened.Close() }()
	after, err := reopened.GetGroupRatioSnapshot(t.Context(), "set-a")
	if err != nil {
		t.Fatal(err)
	}
	if len(after.Entries) != 1 || after.Entries[0].GroupName != "byok_legacy_user" || after.Entries[0].ExternalUserID != "legacy-user" {
		t.Fatalf("legacy BYOK projection was not backfilled: %+v", after)
	}
	if after.State.Status != GroupRatioApplyStatusPending || after.State.DesiredVersion != 1 {
		t.Fatalf("backfilled Set was not marked pending: %+v", after.State)
	}
	disabled, err := reopened.GetGroupRatioSnapshot(t.Context(), "set-disabled")
	if err != nil {
		t.Fatal(err)
	}
	if len(disabled.Entries) != 0 {
		t.Fatalf("disabled Set must not be backfilled during migration: %+v", disabled)
	}
}

func TestMySQLGroupRatioIntentMoveKeepsSingleOwnerAndDirtiesBothSets(t *testing.T) {
	store := newIsolatedMySQLStore(t)
	defer func() { _ = store.Close() }()

	if _, err := store.SaveBYOKSyncIntent(t.Context(), testBYOKSyncIntent("user-a", "set-a", true)); err != nil {
		t.Fatal(err)
	}
	beforeA, ok, err := store.GetGroupRatioApplyState(t.Context(), "set-a")
	if err != nil || !ok {
		t.Fatalf("get initial Set state ok=%v err=%v", ok, err)
	}
	if _, err := store.SaveBYOKSyncIntent(t.Context(), testBYOKSyncIntent("user-a", "set-b", true)); err != nil {
		t.Fatal(err)
	}
	afterA, _, err := store.GetGroupRatioApplyState(t.Context(), "set-a")
	if err != nil {
		t.Fatal(err)
	}
	afterB, _, err := store.GetGroupRatioApplyState(t.Context(), "set-b")
	if err != nil {
		t.Fatal(err)
	}
	if afterA.DesiredVersion != beforeA.DesiredVersion+1 || afterA.Status != GroupRatioApplyStatusPending {
		t.Fatalf("old Set was not dirtied: before=%+v after=%+v", beforeA, afterA)
	}
	if afterB.DesiredVersion != 1 || afterB.Status != GroupRatioApplyStatusPending {
		t.Fatalf("new Set was not dirtied: %+v", afterB)
	}
	oldSnapshot, err := store.GetGroupRatioSnapshot(t.Context(), "set-a")
	if err != nil {
		t.Fatal(err)
	}
	newSnapshot, err := store.GetGroupRatioSnapshot(t.Context(), "set-b")
	if err != nil {
		t.Fatal(err)
	}
	if len(oldSnapshot.Entries) != 0 || len(newSnapshot.Entries) != 1 || newSnapshot.Entries[0].ExternalUserID != "user-a" {
		t.Fatalf("unexpected moved projection: old=%+v new=%+v", oldSnapshot, newSnapshot)
	}
}

func TestMySQLSetOperationLeaseIsBoundedAndFenced(t *testing.T) {
	store := newIsolatedMySQLStore(t)
	defer func() { _ = store.Close() }()
	if err := store.SaveSet(t.Context(), Set{
		ID: "set-a", Status: SetStatusActive, Setup: true, AdmissionStatus: SetAdmissionStatusPassed,
		AdminUserID: 1, AdminAccessToken: "admin-token",
	}); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	leases := make([]SetOperationLease, 0, 4)
	for i := 0; i < 4; i++ {
		lease, ok, err := store.TryAcquireSetOperationLease(t.Context(), "set-a", SetOperationSubscriptionWrite, "owner-"+string(rune('a'+i)), 4, time.Minute, now)
		if err != nil || !ok {
			t.Fatalf("acquire %d ok=%v err=%v", i, ok, err)
		}
		leases = append(leases, lease)
	}
	if _, ok, err := store.TryAcquireSetOperationLease(t.Context(), "set-a", SetOperationSubscriptionWrite, "blocked", 4, time.Minute, now); err != nil || ok {
		t.Fatalf("fifth acquire ok=%v err=%v", ok, err)
	}

	expired := leases[0]
	replacement, ok, err := store.TryAcquireSetOperationLease(t.Context(), "set-a", SetOperationSubscriptionWrite, "replacement", 4, time.Minute, now.Add(2*time.Minute))
	if err != nil || !ok || replacement.Slot != expired.Slot {
		t.Fatalf("replacement=%+v ok=%v err=%v", replacement, ok, err)
	}
	if released, err := store.ReleaseSetOperationLease(t.Context(), expired); err != nil || released {
		t.Fatalf("stale owner release=%v err=%v", released, err)
	}
	if released, err := store.ReleaseSetOperationLease(t.Context(), replacement); err != nil || !released {
		t.Fatalf("current owner release=%v err=%v", released, err)
	}
}

func TestMySQLSetOperationLeaseAllowsGroupRatioBootstrapBeforeAdmission(t *testing.T) {
	store := newIsolatedMySQLStore(t)
	defer func() { _ = store.Close() }()
	if err := store.SaveSet(t.Context(), Set{
		ID: "set-pending", Status: SetStatusActive, Setup: true, AdmissionStatus: SetAdmissionStatusPending,
		AdminUserID: 1, AdminAccessToken: "admin-token",
	}); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	lease, acquired, err := store.TryAcquireSetOperationLease(t.Context(), "set-pending", SetOperationGroupRatioWrite, "group-ratio", 1, time.Minute, now)
	if err != nil || !acquired {
		t.Fatalf("group ratio bootstrap lease acquired=%v err=%v", acquired, err)
	}
	if renewed, err := store.RenewSetOperationLease(t.Context(), lease, time.Minute, now.Add(10*time.Second)); err != nil || !renewed {
		t.Fatalf("group ratio bootstrap lease renewed=%v err=%v", renewed, err)
	}
	if _, acquired, err := store.TryAcquireSetOperationLease(t.Context(), "set-pending", SetOperationSubscriptionWrite, "subscription", 1, time.Minute, now); err != nil || acquired {
		t.Fatalf("subscription lease before admission acquired=%v err=%v", acquired, err)
	}
}

func TestMySQLSetRuntimeProjectionRoundTrips(t *testing.T) {
	store := newIsolatedMySQLStore(t)
	defer func() { _ = store.Close() }()
	now := time.Now().UTC().Truncate(time.Microsecond)
	want := Set{
		ID: "set-a", Name: "Set A", BaseURL: "http://set-a", TrafficBaseURL: "http://set-a-traffic", Status: SetStatusActive,
		ShardID: "shard-a", SQLMaxOpenConns: 32, SQLMaxIdleConns: 2, SQLMaxLifetimeSeconds: 60,
		TrafficSQLMaxOpenConns: 24, TrafficSQLMaxIdleConns: 2, TrafficSQLMaxLifetimeSeconds: 90,
		SubscriptionWriteConcurrency: 8, AdminHealthStatus: SetAdminHealthHealthy,
		RuntimeHAStatus: SetRuntimeHAHealthy, RuntimeHADesiredReplicas: 2, RuntimeHAReadyReplicas: 2,
		RuntimeHAPDBHealthy: true, RuntimeHATopologyKey: "topology.kubernetes.io/zone", RuntimeHACheckedAt: now,
		AdminHealthCheckedAt: now, AdminHealthLastSuccessAt: now,
		AdminWritesPaused: true, AdminWritesPauseReason: "set upgrade run-a", AdminWritesPausedAt: now,
	}
	if err := store.SaveSet(t.Context(), want); err != nil {
		t.Fatal(err)
	}
	got, ok, err := store.GetSet(t.Context(), want.ID)
	if err != nil || !ok {
		t.Fatalf("get set ok=%v err=%v", ok, err)
	}
	if got.SQLMaxOpenConns != 32 || got.SQLMaxLifetimeSeconds != 60 || got.TrafficSQLMaxOpenConns != 24 || got.TrafficSQLMaxLifetimeSeconds != 90 || got.SubscriptionWriteConcurrency != 8 {
		t.Fatalf("runtime projection = %+v", got)
	}
	if got.AdminHealthStatus != SetAdminHealthHealthy || !got.AdminHealthCheckedAt.Equal(now) || !got.AdminHealthLastSuccessAt.Equal(now) {
		t.Fatalf("health projection = %+v", got)
	}
	if got.RuntimeHAStatus != SetRuntimeHAHealthy || got.RuntimeHADesiredReplicas != 2 || got.RuntimeHAReadyReplicas != 2 || !got.RuntimeHAPDBHealthy || got.RuntimeHATopologyKey != "topology.kubernetes.io/zone" || !got.RuntimeHACheckedAt.Equal(now) {
		t.Fatalf("runtime HA projection = %+v", got)
	}
	if !got.AdminWritesPaused || got.AdminWritesPauseReason != "set upgrade run-a" || !got.AdminWritesPausedAt.Equal(now) {
		t.Fatalf("admin write pause projection = %+v", got)
	}
}

func TestMySQLFleetRuntimeFactsAndShardProjectionRoundTrip(t *testing.T) {
	store := newIsolatedMySQLStore(t)
	defer func() { _ = store.Close() }()
	shard := Shard{
		ID: "shard-a", Name: "Shard A", Kind: ShardKindMySQL, Status: ShardStatusActive, MaxSets: 32,
		Endpoint: "mysql-a.internal:3306", RedisEndpoint: "redis-a.internal:6379", SecretName: "newapi-shard-a",
		RedisDBStart: 256, RedisDBLimit: 512,
		AdminSQLMaxOpenConns: 32, AdminSQLMaxIdleConns: 2, AdminSQLMaxLifetimeSeconds: 60,
		TrafficSQLMaxOpenConns: 24, TrafficSQLMaxIdleConns: 2, TrafficSQLMaxLifetimeSeconds: 90,
		SubscriptionWriteConcurrency: 8,
	}
	if err := store.SaveShard(t.Context(), shard); err != nil {
		t.Fatal(err)
	}
	gotShard, ok, err := store.GetShard(t.Context(), shard.ID)
	if err != nil || !ok {
		t.Fatalf("get shard ok=%v err=%v", ok, err)
	}
	if gotShard.MaxSets != 32 || gotShard.AdminSQLMaxOpenConns != 32 || gotShard.TrafficSQLMaxOpenConns != 24 || gotShard.SubscriptionWriteConcurrency != 8 ||
		gotShard.RedisEndpoint != "redis-a.internal:6379" || gotShard.RedisDBStart != 256 || gotShard.RedisDBLimit != 512 {
		t.Fatalf("shard projection = %+v", gotShard)
	}

	expansion := ShardExpansion{
		ID: "expand-c", IdempotencyKey: "ops-expand-c", RequestHash: strings.Repeat("b", 64),
		ShardID: "shard-c", Name: "Shard C", Status: ShardExpansionStatusRequested,
		MaxSets: 32, RedisDBStart: 512, RedisDBLimit: 768, Version: 1,
		CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}
	createdExpansion, created, err := store.CreateShardExpansion(t.Context(), expansion)
	if err != nil || !created {
		t.Fatalf("create expansion = %+v created=%t err=%v", createdExpansion, created, err)
	}
	replayedExpansion, created, err := store.CreateShardExpansion(t.Context(), expansion)
	if err != nil || created || replayedExpansion.ID != expansion.ID {
		t.Fatalf("replay expansion = %+v created=%t err=%v", replayedExpansion, created, err)
	}
	expansion.Status = ShardExpansionStatusWaitingInfrastructure
	updatedExpansion, updated, err := store.UpdateShardExpansion(t.Context(), expansion, 1)
	if err != nil || !updated || updatedExpansion.Version != 2 {
		t.Fatalf("update expansion = %+v updated=%t err=%v", updatedExpansion, updated, err)
	}
	concurrent := expansion
	concurrent.ID = "expand-c-duplicate"
	concurrent.IdempotencyKey = "ops-expand-c-duplicate"
	if _, _, err := store.CreateShardExpansion(t.Context(), concurrent); !errors.Is(err, ErrShardExpansionAlreadyActive) {
		t.Fatalf("concurrent expansion error = %v", err)
	}
	updatedExpansion.Status = ShardExpansionStatusCancelled
	if _, updated, err := store.UpdateShardExpansion(t.Context(), updatedExpansion, 2); err != nil || !updated {
		t.Fatalf("cancel expansion updated=%t err=%v", updated, err)
	}
	if _, created, err := store.CreateShardExpansion(t.Context(), concurrent); err != nil || !created {
		t.Fatalf("replacement expansion created=%t err=%v", created, err)
	}

	fact := SetReconcileFact{
		Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: "set-a", Name: "Set A",
		BaseURL: "http://set-a", TrafficBaseURL: "http://set-a-traffic", ShardRef: "shard-a",
		SQLMaxOpenConns: 32, SQLMaxIdleConns: 2, SQLMaxLifetimeSeconds: 60,
		TrafficSQLMaxOpenConns: 24, TrafficSQLMaxIdleConns: 2, TrafficSQLMaxLifetimeSeconds: 90,
		SubscriptionWriteConcurrency: 8,
		RuntimeHAStatus:              SetRuntimeHAHealthy, RuntimeHADesiredReplicas: 2, RuntimeHAReadyReplicas: 2,
		RuntimeHAPDBHealthy: true, RuntimeHATopologyKey: "topology.kubernetes.io/zone", RuntimeHACheckedAt: time.Now().UTC().Truncate(time.Microsecond),
		DesiredHash: strings.Repeat("a", 64), Status: SetReconcileStatusPending,
	}
	if err := store.SaveSetReconcileFact(t.Context(), fact); err != nil {
		t.Fatal(err)
	}
	gotFact, ok, err := store.GetSetReconcileFact(t.Context(), fact.Source, fact.Namespace, fact.Fleet, fact.SetID)
	if err != nil || !ok {
		t.Fatalf("get fact ok=%v err=%v", ok, err)
	}
	if gotFact.SQLMaxOpenConns != 32 || gotFact.TrafficSQLMaxOpenConns != 24 || gotFact.SubscriptionWriteConcurrency != 8 {
		t.Fatalf("fact projection = %+v", gotFact)
	}
	if gotFact.RuntimeHAStatus != SetRuntimeHAHealthy || gotFact.RuntimeHAReadyReplicas != 2 || !gotFact.RuntimeHAPDBHealthy || gotFact.RuntimeHATopologyKey != "topology.kubernetes.io/zone" || !gotFact.RuntimeHACheckedAt.Equal(fact.RuntimeHACheckedAt) {
		t.Fatalf("runtime HA fact projection = %+v", gotFact)
	}
}

func TestMySQLCascadeSetDecommissionPurgesTenantStateBeforeRuntimeCleanup(t *testing.T) {
	store := newIsolatedMySQLStore(t)
	defer func() { _ = store.Close() }()
	ctx := t.Context()
	now := time.Now().UTC().Truncate(time.Microsecond)
	if err := store.SaveSet(ctx, Set{
		ID: "set-a", Name: "Set A", BaseURL: "http://set-a", Status: SetStatusActive,
		Setup: true, AdminUserID: 1, AdminAccessToken: "admin-token", ObservedUserCount: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveSetRuntimeLease(ctx, SetRuntimeLease{
		Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: "set-a",
		ShardRef: "shard-a", DatabaseName: "newapi_set_a", RedisDB: "12",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveTenant(ctx, Tenant{
		ExternalUserID: "user-1", Backend: UserBackendNew, SetID: "set-a", Status: TenantStatusActive,
		CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserBinding(ctx, UserBinding{
		ExternalUserID: "user-1", SetID: "set-a", UpstreamUserID: 42, Username: "user-1",
		Password: "password", ProvisionStatus: BindingProvisionStatusTokenReady, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveAPIKeyBinding(ctx, APIKeyBinding{
		ExternalKey: "sk-cascade-test", ExternalKeyID: "key-1", SetID: "set-a", UserID: "user-1",
		UpstreamKey: "sk-upstream", UpstreamKeyID: 7, CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserLLMSettings(ctx, UserLLMSettings{
		ExternalUserID: "user-1", Routing: UserLLMRouting{Mode: LLMRouteBYOKFirst}, BYOKGroup: "byok_user_1",
		Providers: []UserLLMProvider{{ID: "private", Enabled: true}}, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	// 模拟历史同步留下的轻微投影差异：binding 属于 Set，但 tenant 投影缺失。
	if err := store.SaveUserBinding(ctx, UserBinding{
		ExternalUserID: "binding-only-user", SetID: "set-a", UpstreamUserID: 43, Username: "binding-only-user",
		Password: "password", ProvisionStatus: BindingProvisionStatusTokenReady, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserLLMSettings(ctx, UserLLMSettings{
		ExternalUserID: "binding-only-user", Routing: UserLLMRouting{Mode: LLMRouteBYOKFirst}, BYOKGroup: "byok_binding_only",
		Providers: []UserLLMProvider{{ID: "private", Enabled: true}}, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	svc := NewService(store, nil, Options{KeyRouteCache: NewMemoryAPIKeyRouteCache(time.Minute, 100)})
	preview, err := svc.PreviewSetDecommission(ctx, "set-a")
	if err != nil {
		t.Fatal(err)
	}
	job, err := svc.StartSetDecommission(ctx, SetDecommissionStartInput{
		SetID: "set-a", ExpectedDigest: preview.Digest, IdempotencyKey: "cascade-set-a", CascadeTenants: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != SetDecommissionStatusPurgingTenants {
		t.Fatalf("start status=%q", job.Status)
	}
	processed, err := svc.ProcessSetDecommissionCascadeOnce(ctx, "maintenance-a", time.Minute)
	if err != nil || !processed {
		t.Fatalf("process cascade processed=%v err=%v", processed, err)
	}
	job, err = svc.GetSetDecommission(ctx, job.ID)
	if err != nil || job.Status != SetDecommissionStatusPending {
		t.Fatalf("job after purge=%+v err=%v", job, err)
	}
	after, err := svc.PreviewSetDecommission(ctx, "set-a")
	if err != nil {
		t.Fatal(err)
	}
	if !after.Empty || after.Blockers.RuntimeLeases != 1 {
		t.Fatalf("preview after purge=%+v", after)
	}
	if tenant, ok, err := store.GetTenant(ctx, "user-1"); err != nil || !ok || tenant.Status != TenantStatusDeleted {
		t.Fatalf("tenant after purge=%+v ok=%v err=%v", tenant, ok, err)
	}
	if _, ok, err := store.GetUserBinding(ctx, "user-1"); err != nil || ok {
		t.Fatalf("binding remains after purge ok=%v err=%v", ok, err)
	}
	if keys, err := store.ListAPIKeyBindingsBySet(ctx, "set-a"); err != nil || len(keys) != 0 {
		t.Fatalf("keys after purge=%+v err=%v", keys, err)
	}
	if _, ok, err := store.GetUserLLMSettings(ctx, "binding-only-user"); err != nil || ok {
		t.Fatalf("binding-only BYOK settings remain after purge ok=%v err=%v", ok, err)
	}
	if leases, err := store.ListSetRuntimeLeases(ctx, SetRuntimeLeaseListOptions{}); err != nil || len(leases) != 1 {
		t.Fatalf("runtime leases after purge=%+v err=%v", leases, err)
	}
}

func TestMySQLAPIKeyReservationOmitsPlaintextAndPersistsRecoverableRoute(t *testing.T) {
	store := newIsolatedMySQLStore(t)
	defer func() { _ = store.Close() }()
	ctx := t.Context()
	if err := store.SaveSet(ctx, Set{ID: "set-a", BaseURL: "http://set-a", TrafficBaseURL: "http://set-a", Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	material, err := generateExternalKeyV2(bytes.NewReader(bytes.Repeat([]byte{17}, externalKeyRandomBytes)))
	if err != nil {
		t.Fatal(err)
	}
	binding := APIKeyBinding{
		ExternalKey: material.ExternalKey, ExternalKeyHash: material.ExternalKeyHash, ExternalKeyID: material.ExternalKeyID,
		SecretHash: material.SecretHash, KeyVersion: material.Version, RouteSlot: material.RouteSlot,
		Purpose: APIKeyPurposeTrafficProbe, SetID: "set-a", UserID: "user-1",
	}
	if err := store.ReserveAPIKeyBinding(ctx, binding); err != nil {
		t.Fatal(err)
	}
	if _, err := store.TransitionAPIKeyBinding(ctx, binding.ExternalKeyID, APIKeyStatusReserved, APIKeyStatusUpstreamReady, "sk-upstream", 7, "", time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	if _, err := store.TransitionAPIKeyBinding(ctx, binding.ExternalKeyID, APIKeyStatusUpstreamReady, APIKeyStatusRoutePending, "", 0, "", time.Now().UTC()); err != nil {
		t.Fatal(err)
	}

	restored, ok, err := store.GetAPIKeyBindingByExternalKeyID(ctx, material.ExternalKeyID)
	if err != nil || !ok {
		t.Fatalf("restored binding: ok=%v err=%v", ok, err)
	}
	if restored.ExternalKey != "" {
		t.Fatalf("external key plaintext was persisted: %q", restored.ExternalKey)
	}
	if restored.ExternalKeyHash != material.ExternalKeyHash || restored.SecretHash != material.SecretHash {
		t.Fatalf("external key route hashes are wrong: %+v", restored)
	}
	if restored.Purpose != APIKeyPurposeTrafficProbe {
		t.Fatalf("purpose = %q", restored.Purpose)
	}
	cache := NewMemoryAPIKeyRouteCache(time.Minute, 10)
	svc := NewService(store, nil, Options{KeyRouteCache: cache})
	if err := svc.refreshSetTrafficRoutes(ctx, "set-a"); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := cache.GetRoute(ctx, parseTrafficRouteLookup(material.ExternalKey)); err != nil || !ok {
		t.Fatalf("rebuilt route from recovered key: ok=%v err=%v", ok, err)
	}
}

func TestMySQLAPIKeyRouteRecoveryUsesKeysetPageAndJoinsTrafficPolicy(t *testing.T) {
	store := newIsolatedMySQLStore(t)
	defer func() { _ = store.Close() }()
	ctx := t.Context()
	if err := store.SaveTenant(ctx, Tenant{ExternalUserID: "user-1", Backend: UserBackendNew, SetID: "set-a", Status: TenantStatusActive}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserLLMSettings(ctx, UserLLMSettings{
		ExternalUserID: "user-1", Routing: UserLLMRouting{Mode: LLMRouteBYOKFirst},
		BYOKUpstreamKey: "sk-byok", BYOKUpstreamKeyID: 31,
	}); err != nil {
		t.Fatal(err)
	}
	bindings := []APIKeyBinding{
		saveRecoverableAPIKey(t, store, 31, "user-1", "set-a", APIKeyStatusActive),
		saveRecoverableAPIKey(t, store, 32, "user-1", "set-a", APIKeyStatusActive),
		saveRecoverableAPIKey(t, store, 33, "user-1", "set-a", APIKeyStatusRoutePending),
	}
	sort.Slice(bindings[:2], func(i, j int) bool { return bindings[i].ExternalKeyID < bindings[j].ExternalKeyID })
	watermark, err := store.GetAPIKeyRouteRecoveryWatermark(ctx)
	if err != nil || watermark != bindings[1].ExternalKeyID {
		t.Fatalf("watermark=%q err=%v, want %q", watermark, err, bindings[1].ExternalKeyID)
	}
	first, err := store.ListAPIKeyRouteRecoveryRecords(ctx, "", watermark, 1)
	if err != nil || len(first) != 1 {
		t.Fatalf("first page=%+v err=%v", first, err)
	}
	second, err := store.ListAPIKeyRouteRecoveryRecords(ctx, first[0].Binding.ExternalKeyID, watermark, 1)
	if err != nil || len(second) != 1 || second[0].Binding.ExternalKeyID != bindings[1].ExternalKeyID {
		t.Fatalf("second page=%+v err=%v", second, err)
	}
	for _, record := range append(first, second...) {
		if record.TenantStatus != TenantStatusActive || record.BYOKRoutingMode != LLMRouteBYOKFirst || record.BYOKUpstreamKey != "sk-byok" || record.BYOKUpstreamKeyID != 31 {
			t.Fatalf("joined recovery record=%+v", record)
		}
	}
}

func TestMySQLClaimSetDecommissionQuarantinesLifecycleConflict(t *testing.T) {
	store := newIsolatedMySQLStore(t)
	defer func() { _ = store.Close() }()
	ctx := t.Context()
	now := time.Now().UTC().Truncate(time.Microsecond)
	if err := store.SaveSet(ctx, Set{ID: "set-a", BaseURL: "http://set-a", Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveSetRuntimeLease(ctx, SetRuntimeLease{
		Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: "set-a",
		ShardRef: "shard-a", DatabaseName: "newapi_set_a", RedisDB: "12",
	}); err != nil {
		t.Fatal(err)
	}
	preview, err := store.GetSetDecommissionPreview(ctx, "set-a", now)
	if err != nil {
		t.Fatal(err)
	}
	job, err := store.StartSetDecommission(ctx, SetDecommissionStartInput{
		SetID: "set-a", ExpectedDigest: preview.Digest, IdempotencyKey: "start-set-a",
	}, "decom-a", now)
	if err != nil {
		t.Fatal(err)
	}
	set, _, err := store.GetSet(ctx, "set-a")
	if err != nil {
		t.Fatal(err)
	}
	set.Status = SetStatusActive
	if err := store.SaveSet(ctx, set); err != nil {
		t.Fatal(err)
	}

	if _, _, err := store.ClaimSetDecommission(ctx, SetDecommissionClaimInput{
		JobID: job.ID, Owner: "set-manager-a", ClaimToken: "claim-a", CapabilityHash: "hash-a", LeaseTTL: time.Minute,
	}, now.Add(time.Second)); err == nil {
		t.Fatal("expected lifecycle conflict")
	}
	failed, ok, err := store.GetSetDecommissionJob(ctx, job.ID)
	if err != nil || !ok {
		t.Fatalf("job lookup ok=%v err=%v", ok, err)
	}
	if failed.Status != SetDecommissionStatusError || !strings.Contains(failed.LastError, "lifecycle changed") {
		t.Fatalf("conflicting job was not quarantined: %+v", failed)
	}
}

func TestMySQLAcquireSetDecommissionCascadeQuarantinesLifecycleConflict(t *testing.T) {
	store := newIsolatedMySQLStore(t)
	defer func() { _ = store.Close() }()
	ctx := t.Context()
	now := time.Now().UTC().Truncate(time.Microsecond)
	if err := store.SaveSet(ctx, Set{ID: "set-a", BaseURL: "http://set-a", Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveSetRuntimeLease(ctx, SetRuntimeLease{
		Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: "set-a",
		ShardRef: "shard-a", DatabaseName: "newapi_set_a", RedisDB: "12",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveTenant(ctx, Tenant{
		ExternalUserID: "user-a", Backend: UserBackendNew, SetID: "set-a", Status: TenantStatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	preview, err := store.GetSetDecommissionPreview(ctx, "set-a", now)
	if err != nil {
		t.Fatal(err)
	}
	job, err := store.StartSetDecommission(ctx, SetDecommissionStartInput{
		SetID: "set-a", ExpectedDigest: preview.Digest, IdempotencyKey: "cascade-set-a", CascadeTenants: true,
	}, "decom-a", now)
	if err != nil {
		t.Fatal(err)
	}
	set, _, err := store.GetSet(ctx, "set-a")
	if err != nil {
		t.Fatal(err)
	}
	set.Status = SetStatusActive
	if err := store.SaveSet(ctx, set); err != nil {
		t.Fatal(err)
	}

	if _, acquired, err := store.AcquireSetDecommissionCascade(ctx, "maintenance-a", time.Minute, now.Add(time.Second)); err == nil || acquired {
		t.Fatalf("acquired=%v err=%v, want quarantined lifecycle conflict", acquired, err)
	}
	failed, ok, err := store.GetSetDecommissionJob(ctx, job.ID)
	if err != nil || !ok {
		t.Fatalf("job lookup ok=%v err=%v", ok, err)
	}
	if failed.Status != SetDecommissionStatusError || !strings.Contains(failed.LastError, "lifecycle changed") {
		t.Fatalf("conflicting cascade was not quarantined: %+v", failed)
	}
}

func TestMySQLRetryCascadeSetCleanupReturnsToTenantPurgeWhenSetIsNotEmpty(t *testing.T) {
	store := newIsolatedMySQLStore(t)
	defer func() { _ = store.Close() }()
	ctx := t.Context()
	now := time.Now().UTC().Truncate(time.Microsecond)
	if err := store.SaveSet(ctx, Set{ID: "set-a", BaseURL: "http://set-a", Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveSetRuntimeLease(ctx, SetRuntimeLease{
		Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: "set-a",
		ShardRef: "shard-a", DatabaseName: "newapi_set_a", RedisDB: "12",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveTenant(ctx, Tenant{ExternalUserID: "user-a", Backend: UserBackendNew, SetID: "set-a", Status: TenantStatusActive}); err != nil {
		t.Fatal(err)
	}
	preview, err := store.GetSetDecommissionPreview(ctx, "set-a", now)
	if err != nil {
		t.Fatal(err)
	}
	job, err := store.StartSetDecommission(ctx, SetDecommissionStartInput{
		SetID: "set-a", ExpectedDigest: preview.Digest, IdempotencyKey: "cascade-set-a", CascadeTenants: true,
	}, "decom-a", now)
	if err != nil {
		t.Fatal(err)
	}
	set, _, err := store.GetSet(ctx, "set-a")
	if err != nil {
		t.Fatal(err)
	}
	set.Status = SetStatusActive
	if err := store.SaveSet(ctx, set); err != nil {
		t.Fatal(err)
	}
	if _, acquired, err := store.AcquireSetDecommissionCascade(ctx, "maintenance-a", time.Minute, now.Add(time.Second)); err == nil || acquired {
		t.Fatalf("acquired=%v err=%v, want lifecycle conflict", acquired, err)
	}
	failed, ok, err := store.GetSetDecommissionJob(ctx, job.ID)
	if err != nil || !ok {
		t.Fatalf("job lookup ok=%v err=%v", ok, err)
	}
	set.Status = SetStatusDraining
	if err := store.SaveSet(ctx, set); err != nil {
		t.Fatal(err)
	}
	retried, err := store.RetrySetDecommission(ctx, SetDecommissionRetryInput{
		JobID: failed.ID, ExpectedVersion: failed.Version, IdempotencyKey: "retry-cascade-set-a",
	}, now.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if retried.Status != SetDecommissionStatusPurgingTenants {
		t.Fatalf("retried status = %q, want %q", retried.Status, SetDecommissionStatusPurgingTenants)
	}
}

func newIsolatedMySQLStore(t *testing.T) *MySQLStore {
	t.Helper()
	dsn := isolatedMySQLDSN(t)
	cfg, err := mysql.ParseDSN(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DBName == "" || !strings.HasPrefix(cfg.DBName, "llmgateway_it_") {
		t.Fatalf("LLMGATEWAY_MYSQL_TEST_DSN must use an isolated database named llmgateway_it_*, got %q", cfg.DBName)
	}
	if !safeIntegrationDatabaseName.MatchString(cfg.DBName) {
		t.Fatalf("unsafe integration database name %q", cfg.DBName)
	}
	rootCfg := *cfg
	rootCfg.DBName = ""
	rootDB, err := sql.Open("mysql", rootCfg.FormatDSN())
	if err != nil {
		t.Fatal(err)
	}
	defer rootDB.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if _, err := rootDB.ExecContext(ctx, "DROP DATABASE IF EXISTS `"+cfg.DBName+"`"); err != nil {
		t.Fatal(err)
	}
	if _, err := rootDB.ExecContext(ctx, "CREATE DATABASE `"+cfg.DBName+"` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"); err != nil {
		t.Fatal(err)
	}
	store, err := NewMySQLStore(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	return store
}

func isolatedMySQLDSN(t *testing.T) string {
	t.Helper()
	dsn := strings.TrimSpace(os.Getenv("LLMGATEWAY_MYSQL_TEST_DSN"))
	if dsn == "" {
		t.Skip("LLMGATEWAY_MYSQL_TEST_DSN is required for MySQL integration tests")
	}
	cfg, err := mysql.ParseDSN(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DBName == "" {
		t.Fatalf("LLMGATEWAY_MYSQL_TEST_DSN must include an isolated database named llmgateway_it_*")
	}
	return dsn
}

var safeIntegrationDatabaseName = regexp.MustCompile(`^llmgateway_it_[a-zA-Z0-9_]+$`)
