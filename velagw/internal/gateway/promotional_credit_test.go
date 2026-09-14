package gateway

import (
	"errors"
	"testing"
)

func TestResolveAmountBasedSubscriptionPlanIsStableAndQueuesActiveSets(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	if err := store.SaveSet(t.Context(), Set{ID: "set-a", Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}

	first, err := svc.resolveAmountBasedSubscriptionPlan(t.Context(), ApplySubscriptionRequest{UserID: "usr-1", TokenAmount: 5_000_000})
	if err != nil {
		t.Fatal(err)
	}
	second, err := svc.resolveAmountBasedSubscriptionPlan(t.Context(), ApplySubscriptionRequest{UserID: "usr-1", TokenAmount: 5_000_000})
	if err != nil {
		t.Fatal(err)
	}
	if first.PlanID == "" || first.PlanID != second.PlanID || first.TokenAmount != 0 {
		t.Fatalf("unstable resolution: first=%+v second=%+v", first, second)
	}
	plan, err := svc.GetPlan(t.Context(), first.PlanID)
	if err != nil {
		t.Fatal(err)
	}
	if plan.MonthlyTokens != 5_000_000 || plan.QuotaResetPeriod != "never" || !plan.IsActive {
		t.Fatalf("unexpected plan: %+v", plan)
	}
	state, ok, err := store.GetSetPlan(t.Context(), plan.ID, "set-a")
	if err != nil || !ok || state.Status != SetPlanStatusPending {
		t.Fatalf("set plan state ok=%v state=%+v err=%v", ok, state, err)
	}
}

func TestApplySubscriptionWithTokenAmountQueuesPlanUntilSetReady(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	if err := store.SaveSet(t.Context(), Set{ID: "set-a", Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	_, err := svc.ApplySubscription(t.Context(), ApplySubscriptionRequest{
		UserID: "usr-1", TokenAmount: 5_000_000,
		IdempotencyKey:   "referral:campaign:invitee:inviter",
		SubscriptionName: "free-credit:referral:campaign:invitee:inviter",
	})
	if !errors.Is(err, ErrPlanNotReady) {
		t.Fatalf("err=%v, want ErrPlanNotReady while generated plan syncs", err)
	}
	plans, err := svc.ListPlans(t.Context())
	if err != nil || len(plans) != 1 || plans[0].MonthlyTokens != 5_000_000 || plans[0].QuotaResetPeriod != "never" {
		t.Fatalf("generated plans=%+v err=%v", plans, err)
	}
}

func TestResolveAmountBasedSubscriptionPlanRejectsAmbiguousOrInvalidAmount(t *testing.T) {
	svc := NewService(NewMemoryStore(), nil, Options{})
	for _, req := range []ApplySubscriptionRequest{
		{PlanID: "plan-existing", TokenAmount: 100},
		{},
		{TokenAmount: maxPromotionalTokenAmount + 1},
	} {
		if _, err := svc.resolveAmountBasedSubscriptionPlan(t.Context(), req); err == nil {
			t.Fatalf("request %+v should fail", req)
		}
	}
	resolved, err := svc.resolveAmountBasedSubscriptionPlan(t.Context(), ApplySubscriptionRequest{PlanID: "plan-existing"})
	if err != nil || resolved.PlanID != "plan-existing" {
		t.Fatalf("existing plan path changed: resolved=%+v err=%v", resolved, err)
	}
}
