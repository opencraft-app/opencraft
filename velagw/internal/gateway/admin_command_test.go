package gateway

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestCreateExternalKeyManagedRejectsPurposeTooLongBeforeQueueing(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	if err := store.SaveSet(t.Context(), Set{ID: "set-a", Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserBinding(t.Context(), UserBinding{ExternalUserID: "user-1", SetID: "set-a"}); err != nil {
		t.Fatal(err)
	}
	if err := store.SetAdminWritesPaused(t.Context(), "set-a", true, "upgrade run-a", time.Now().UTC()); err != nil {
		t.Fatal(err)
	}

	_, command, err := svc.CreateExternalKeyManaged(t.Context(), "user-1", strings.Repeat("用", 33))
	if err == nil || !strings.Contains(err.Error(), "at most 32 characters") {
		t.Fatalf("error = %v, want purpose length validation", err)
	}
	if command != nil {
		t.Fatalf("command = %+v, want no queued command", command)
	}
}

func TestCreateExternalKeyManagedReusesActiveKeyWhileAdminWritesPaused(t *testing.T) {
	upstream := newKeyIssuanceUpstream(t, nil)
	defer upstream.Close()

	store := NewMemoryStore()
	prepareReadyKeyIssuanceUser(t, store, upstream.URL)
	svc := NewService(store, nil, Options{KeyRouteCache: NewMemoryAPIKeyRouteCache(0, 100)})
	first, err := svc.createExternalKey(t.Context(), "user-1", "default")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetAdminWritesPaused(t.Context(), "set-a", true, "upgrade run-a", time.Now().UTC()); err != nil {
		t.Fatal(err)
	}

	reused, command, err := svc.CreateExternalKeyManaged(t.Context(), "user-1", "default")
	if err != nil {
		t.Fatal(err)
	}
	if command != nil {
		t.Fatalf("command = %+v, want active key reuse without queue", command)
	}
	if reused.ExternalKeyID != first.ExternalKeyID || reused.ExternalKey != first.ExternalKey {
		t.Fatalf("reused key = %+v, want original key id=%q", reused, first.ExternalKeyID)
	}
}

func TestManagedSubscriptionQueuesWhileAdminWritesPausedAndExecutesOnce(t *testing.T) {
	fixture := newSubscriptionFixture(t)
	defer fixture.server.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	fixture.registerBootstrappedSet(t, svc, store)
	set, ok, err := store.GetSet(t.Context(), "set-a")
	if err != nil || !ok {
		t.Fatalf("get set: ok=%v err=%v", ok, err)
	}
	if err := store.SetAdminWritesPaused(t.Context(), set.ID, true, "upgrade run-a", time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserBinding(t.Context(), UserBinding{
		ExternalUserID: "user-1", SetID: "set-a", UpstreamUserID: 42,
		Username: "sgw-user-1", Password: "user-pass-123", ProvisionStatus: BindingProvisionStatusUserReady,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SavePlanMapping(t.Context(), PlanMapping{
		ID: "plan-pro", Name: "Pro", MonthlyTokens: 1000, PeriodValue: 1, PeriodUnit: "months",
		IsActive: true, UpstreamPlanIDs: map[string]int{"set-a": 7},
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SavePlanPeriod(t.Context(), PlanPeriod{PlanID: "plan-pro", PeriodValue: 14, PeriodUnit: "days"}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveSetPlanPeriod(t.Context(), SetPlanPeriod{
		PlanID: "plan-pro", PeriodValue: 14, PeriodUnit: "days", SetID: "set-a",
		UpstreamPlanID: 37, Status: SetPlanStatusReady,
	}); err != nil {
		t.Fatal(err)
	}

	req := ApplySubscriptionRequest{
		IdempotencyKey: "trade:deal-paused", UserID: "user-1", PlanID: "plan-pro",
		IsUnique: true, PeriodValue: 14, PeriodUnit: "days",
	}
	_, first, err := svc.ApplySubscriptionManaged(t.Context(), req)
	if err != nil || first == nil || first.Status != AdminCommandStatusPending {
		t.Fatalf("first queued command = %+v err=%v", first, err)
	}
	_, second, err := svc.ApplySubscriptionManaged(t.Context(), req)
	if err != nil || second == nil || second.ID != first.ID {
		t.Fatalf("deduplicated command = %+v err=%v, want id %q", second, err, first.ID)
	}
	if len(fixture.createdPlanIDs) != 0 {
		t.Fatalf("upstream subscription writes during pause = %d, want 0", len(fixture.createdPlanIDs))
	}
	if processed, err := svc.ProcessAdminCommandOnce(t.Context(), "worker-a", time.Minute); err != nil || processed {
		t.Fatalf("paused command processed=%v err=%v", processed, err)
	}

	if err := store.SetAdminWritesPaused(t.Context(), set.ID, false, "", time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	if processed, err := svc.ProcessAdminCommandOnce(t.Context(), "worker-a", time.Minute); err != nil || !processed {
		t.Fatalf("unpaused command processed=%v err=%v", processed, err)
	}
	if processed, err := svc.ProcessAdminCommandOnce(t.Context(), "worker-b", time.Minute); err != nil || processed {
		t.Fatalf("completed command processed again=%v err=%v", processed, err)
	}
	if len(fixture.createdPlanIDs) != 0 {
		t.Fatalf("existing subscription should be reused, writes=%v", fixture.createdPlanIDs)
	}
	completed, ok, err := store.GetAdminCommand(t.Context(), first.ID)
	if err != nil || !ok || completed.Status != AdminCommandStatusSucceeded {
		t.Fatalf("completed command = %+v ok=%v err=%v", completed, ok, err)
	}
}

func TestAdminCommandLeasePreventsTwoWorkersFromExecutingSameWrite(t *testing.T) {
	store := NewMemoryStore()
	now := time.Date(2026, 7, 16, 1, 2, 3, 0, time.UTC)
	command, _, err := store.EnqueueAdminCommand(context.Background(), AdminCommand{
		ID: "cmd-a", DedupeKey: "subscription:deal-a", SetID: "set-a",
		ExternalUserID: "user-1", Kind: AdminCommandKindApplySubscription,
		Payload: `{"user_id":"user-1","plan_id":"plan-pro","idempotency_key":"deal-a"}`,
		Status:  AdminCommandStatusPending, NextRunAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	first, acquired, err := store.TryAcquireAdminCommand(context.Background(), command.ID, "worker-a", time.Minute, now)
	if err != nil || !acquired {
		t.Fatalf("first acquire = %+v acquired=%v err=%v", first, acquired, err)
	}
	if _, acquired, err := store.TryAcquireAdminCommand(context.Background(), command.ID, "worker-b", time.Minute, now.Add(time.Second)); err != nil || acquired {
		t.Fatalf("second acquire acquired=%v err=%v", acquired, err)
	}
}

func TestPendingAdminCommandBlocksSetDecommission(t *testing.T) {
	store := NewMemoryStore()
	if err := store.SaveSet(t.Context(), Set{ID: "set-a", Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.EnqueueAdminCommand(t.Context(), AdminCommand{
		ID: "cmd-a", DedupeKey: "subscription:deal-a", SetID: "set-a",
		ExternalUserID: "user-1", Kind: AdminCommandKindApplySubscription,
		Payload: `{"user_id":"user-1","plan_id":"plan-pro"}`,
		Status:  AdminCommandStatusPending,
	}); err != nil {
		t.Fatal(err)
	}
	preview, err := store.GetSetDecommissionPreview(t.Context(), "set-a", time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	if preview.Empty || preview.Blockers.AdminCommands != 1 {
		t.Fatalf("decommission preview = %+v", preview)
	}
}
