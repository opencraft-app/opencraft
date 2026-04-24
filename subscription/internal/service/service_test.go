package service

import (
	"context"
	"testing"
	"time"
)

func TestCheckoutFreeIsIdempotent(t *testing.T) {
	t.Helper()

	store := newMemoryStore()
	store.plans["free"] = &Plan{Code: "free", Description: "Free", MaxBotCount: 1}
	paymentClient := &fakePaymentClient{}
	aiClient := &fakeAIGatewayClient{}

	svc := New(Config{
		PlanMappings: map[string]string{
			"free": "free-plan",
		},
		Now: func() time.Time {
			return time.Date(2026, 3, 24, 12, 0, 0, 0, time.UTC)
		},
	}, store, paymentClient, aiClient)

	first, err := svc.Checkout(context.Background(), "usr_1", "free")
	if err != nil {
		t.Fatalf("first checkout: %v", err)
	}
	if first.Mode != CheckoutModeActive {
		t.Fatalf("expected active mode, got %q", first.Mode)
	}
	if first.Subscription == nil {
		t.Fatal("expected subscription")
	}
	if aiClient.setCalls != 1 {
		t.Fatalf("expected one ai-gateway sync, got %d", aiClient.setCalls)
	}
	if got := first.Subscription.CurrentPeriodEnd.UTC(); !got.Equal(time.Date(2026, 3, 31, 12, 0, 0, 0, time.UTC)) {
		t.Fatalf("expected free subscription to last 7 days, got %s", got)
	}

	second, err := svc.Checkout(context.Background(), "usr_1", "free")
	if err != nil {
		t.Fatalf("second checkout: %v", err)
	}
	if second.Mode != CheckoutModeActive {
		t.Fatalf("expected active mode, got %q", second.Mode)
	}
	if second.Subscription == nil {
		t.Fatal("expected subscription on second checkout")
	}
	if second.Subscription.ID != first.Subscription.ID {
		t.Fatalf("expected stable local subscription id, got %q and %q", first.Subscription.ID, second.Subscription.ID)
	}
	if aiClient.setCalls != 1 {
		t.Fatalf("expected no extra ai-gateway sync, got %d calls", aiClient.setCalls)
	}
}

func TestCheckoutPaidCreatesPendingOrder(t *testing.T) {
	t.Helper()

	store := newMemoryStore()
	store.plans["pro"] = &Plan{Code: "pro", Description: "Pro", MaxBotCount: 10}
	paymentClient := &fakePaymentClient{
		createOrderResult: &PaymentOrder{
			ID:             "ord_1",
			ExternalUserID: "usr_1",
			Code:           "pro",
			Status:         PaymentOrderStatusPending,
			Provider:       "mock",
		},
	}
	aiClient := &fakeAIGatewayClient{}

	svc := New(Config{
		PlanMappings: map[string]string{
			"pro": "pro-plan",
		},
	}, store, paymentClient, aiClient)

	result, err := svc.Checkout(context.Background(), "usr_1", "pro")
	if err != nil {
		t.Fatalf("checkout paid: %v", err)
	}
	if result.Mode != CheckoutModePaymentRequired {
		t.Fatalf("expected payment_required, got %q", result.Mode)
	}
	if result.Order == nil || result.Order.ID != "ord_1" {
		t.Fatalf("expected created order, got %#v", result.Order)
	}
	if aiClient.setCalls != 0 {
		t.Fatalf("did not expect ai-gateway sync before payment, got %d", aiClient.setCalls)
	}
}

func TestApplyPaymentActivatesSubscription(t *testing.T) {
	t.Helper()

	store := newMemoryStore()
	store.plans["lite"] = &Plan{Code: "lite", Description: "Lite", MaxBotCount: 3}
	paymentClient := &fakePaymentClient{}
	aiClient := &fakeAIGatewayClient{}

	svc := New(Config{
		PlanMappings: map[string]string{
			"lite": "lite-plan",
		},
		Now: func() time.Time {
			return time.Date(2026, 3, 24, 12, 0, 0, 0, time.UTC)
		},
	}, store, paymentClient, aiClient)

	subscription, err := svc.ApplyPayment(context.Background(), "ord_1", "usr_1", "lite", "provider-1")
	if err != nil {
		t.Fatalf("apply payment: %v", err)
	}
	if subscription.Status != SubscriptionStatusActive {
		t.Fatalf("expected active subscription, got %q", subscription.Status)
	}
	if subscription.SourceOrderID != "ord_1" {
		t.Fatalf("expected source order id ord_1, got %q", subscription.SourceOrderID)
	}
	if aiClient.setCalls != 1 {
		t.Fatalf("expected one ai-gateway sync, got %d", aiClient.setCalls)
	}
	if got := subscription.CurrentPeriodEnd.UTC(); !got.Equal(time.Date(2026, 4, 24, 12, 0, 0, 0, time.UTC)) {
		t.Fatalf("expected lite subscription to last 1 month, got %s", got)
	}
}

func TestAdminResyncUsesCurrentSubscription(t *testing.T) {
	t.Helper()

	store := newMemoryStore()
	store.current = &Subscription{
		ID:             "sub_1",
		ExternalUserID: "usr_1",
		Code:           "free",
		Status:         SubscriptionStatusActive,
	}
	store.plans["free"] = &Plan{Code: "free", Description: "Free", MaxBotCount: 1}
	paymentClient := &fakePaymentClient{}
	aiClient := &fakeAIGatewayClient{}

	svc := New(Config{
		PlanMappings: map[string]string{
			"free": "free-plan",
		},
		Now: func() time.Time {
			return time.Date(2026, 3, 30, 12, 0, 0, 0, time.UTC)
		},
	}, store, paymentClient, aiClient)

	subscription, err := svc.AdminResync(context.Background(), "usr_1")
	if err != nil {
		t.Fatalf("admin resync: %v", err)
	}
	if subscription == nil {
		t.Fatal("expected subscription")
	}
	if aiClient.setCalls != 1 {
		t.Fatalf("expected one ai-gateway sync, got %d", aiClient.setCalls)
	}
	if aiClient.lastPlanID != "free-plan" {
		t.Fatalf("expected free plan sync, got %q", aiClient.lastPlanID)
	}
	if subscription.AIGatewaySubscriptionID == "" {
		t.Fatal("expected ai gateway subscription id to be refreshed")
	}
}

func TestAdminSetSubscriptionAppliesCodeImmediately(t *testing.T) {
	t.Helper()

	store := newMemoryStore()
	store.plans["lite"] = &Plan{Code: "lite", Description: "Lite", MaxBotCount: 3}
	paymentClient := &fakePaymentClient{}
	aiClient := &fakeAIGatewayClient{}

	svc := New(Config{
		PlanMappings: map[string]string{
			"lite": "lite-plan",
		},
		Now: func() time.Time {
			return time.Date(2026, 3, 30, 12, 0, 0, 0, time.UTC)
		},
	}, store, paymentClient, aiClient)

	subscription, err := svc.AdminSetSubscription(context.Background(), "usr_1", "lite")
	if err != nil {
		t.Fatalf("admin set subscription: %v", err)
	}
	if subscription.Code != "lite" {
		t.Fatalf("expected lite code, got %q", subscription.Code)
	}
	if subscription.SourceOrderID != "admin-manual" {
		t.Fatalf("expected admin-manual source, got %q", subscription.SourceOrderID)
	}
	if aiClient.setCalls != 1 {
		t.Fatalf("expected ai-gateway sync, got %d", aiClient.setCalls)
	}
}

func TestAdminCancelCancelsRemoteAndMarksLocalCancelled(t *testing.T) {
	t.Helper()

	store := newMemoryStore()
	store.current = &Subscription{
		ID:             "sub_1",
		ExternalUserID: "usr_1",
		Code:           "pro",
		Status:         SubscriptionStatusActive,
	}
	paymentClient := &fakePaymentClient{}
	aiClient := &fakeAIGatewayClient{}

	svc := New(Config{
		PlanMappings: map[string]string{
			"pro": "pro-plan",
		},
		Now: func() time.Time {
			return time.Date(2026, 3, 30, 12, 0, 0, 0, time.UTC)
		},
	}, store, paymentClient, aiClient)

	subscription, err := svc.AdminCancel(context.Background(), "usr_1")
	if err != nil {
		t.Fatalf("admin cancel: %v", err)
	}
	if subscription == nil {
		t.Fatal("expected cancelled subscription")
	}
	if subscription.Status != SubscriptionStatusCancelled {
		t.Fatalf("expected cancelled status, got %q", subscription.Status)
	}
	if aiClient.cancelCalls != 1 {
		t.Fatalf("expected one remote cancel call, got %d", aiClient.cancelCalls)
	}
}

func TestAdminEventsReturnsStoredEvents(t *testing.T) {
	t.Helper()

	store := newMemoryStore()
	store.current = &Subscription{
		ID:             "sub_1",
		ExternalUserID: "usr_1",
		Code:           "free",
		Status:         SubscriptionStatusActive,
	}
	store.events = []*SubscriptionEvent{
		{
			ID:             "evt_1",
			SubscriptionID: "sub_1",
			EventType:      "created",
			Code:           "free",
			Status:         SubscriptionStatusActive,
		},
	}
	svc := New(Config{
		PlanMappings: map[string]string{
			"free": "free-plan",
		},
	}, store, &fakePaymentClient{}, &fakeAIGatewayClient{})

	events, err := svc.AdminEvents(context.Background(), "usr_1", 20)
	if err != nil {
		t.Fatalf("admin events: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("expected one event, got %d", len(events))
	}
	if events[0].ID != "evt_1" {
		t.Fatalf("expected evt_1, got %q", events[0].ID)
	}
}

func TestCheckoutRejectsUnknownPlanWithoutCatalogEntry(t *testing.T) {
	t.Helper()

	store := newMemoryStore()
	svc := New(Config{
		PlanMappings: map[string]string{
			"free": "free-plan",
		},
	}, store, &fakePaymentClient{}, &fakeAIGatewayClient{})

	if _, err := svc.Checkout(context.Background(), "usr_1", "free"); err == nil {
		t.Fatal("expected checkout to reject missing plan catalog entry")
	}
}

func TestAdminPlanCrudUsesDatabaseState(t *testing.T) {
	t.Helper()

	store := newMemoryStore()
	now := time.Date(2026, 3, 31, 9, 0, 0, 0, time.UTC)
	svc := New(Config{
		PlanMappings: map[string]string{},
		Now: func() time.Time {
			return now
		},
	}, store, &fakePaymentClient{}, &fakeAIGatewayClient{})

	plan, err := svc.AdminUpsertPlan(context.Background(), " PRO ", "Pro tier", 5)
	if err != nil {
		t.Fatalf("admin upsert plan: %v", err)
	}
	if plan.Code != "pro" {
		t.Fatalf("expected normalized code, got %q", plan.Code)
	}
	if plan.MaxBotCount != 5 {
		t.Fatalf("expected max bot count 5, got %d", plan.MaxBotCount)
	}

	items, err := svc.AdminListPlans(context.Background())
	if err != nil {
		t.Fatalf("admin list plans: %v", err)
	}
	if len(items) != 1 || items[0].Code != "pro" {
		t.Fatalf("expected one pro plan, got %#v", items)
	}

	if err := svc.AdminDeletePlan(context.Background(), "pro"); err != nil {
		t.Fatalf("admin delete plan: %v", err)
	}
	items, err = svc.AdminListPlans(context.Background())
	if err != nil {
		t.Fatalf("admin list plans after delete: %v", err)
	}
	if len(items) != 0 {
		t.Fatalf("expected no plans after delete, got %#v", items)
	}
}
