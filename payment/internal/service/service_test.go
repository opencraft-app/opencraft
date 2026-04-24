package service

import (
	"context"
	"testing"
	"time"
)

func TestCreateOrderPersistsPendingOrder(t *testing.T) {
	t.Helper()

	store := newMemoryStore()
	subscriptionClient := &fakeSubscriptionClient{}
	svc := New(Config{
		Provider: "mock",
		Now: func() time.Time {
			return time.Date(2026, 3, 24, 12, 0, 0, 0, time.UTC)
		},
	}, store, subscriptionClient)

	order, err := svc.CreateOrder(context.Background(), "usr_1", "pro")
	if err != nil {
		t.Fatalf("create order: %v", err)
	}
	if order.Status != OrderStatusPending {
		t.Fatalf("expected pending order, got %q", order.Status)
	}
	if order.ExternalUserID != "usr_1" {
		t.Fatalf("expected external user id usr_1, got %q", order.ExternalUserID)
	}
}

func TestMarkPaidIsIdempotentAndNotifiesSubscriptionOnce(t *testing.T) {
	t.Helper()

	store := newMemoryStore()
	subscriptionClient := &fakeSubscriptionClient{}
	svc := New(Config{
		Provider: "mock",
		Now: func() time.Time {
			return time.Date(2026, 3, 24, 12, 0, 0, 0, time.UTC)
		},
	}, store, subscriptionClient)

	order, err := svc.CreateOrder(context.Background(), "usr_1", "lite")
	if err != nil {
		t.Fatalf("create order: %v", err)
	}

	first, err := svc.MarkPaid(context.Background(), order.ID, "provider-1")
	if err != nil {
		t.Fatalf("mark paid first time: %v", err)
	}
	if first.Status != OrderStatusPaid {
		t.Fatalf("expected paid order, got %q", first.Status)
	}
	if subscriptionClient.applyCalls != 1 {
		t.Fatalf("expected one subscription apply call, got %d", subscriptionClient.applyCalls)
	}

	second, err := svc.MarkPaid(context.Background(), order.ID, "provider-1")
	if err != nil {
		t.Fatalf("mark paid second time: %v", err)
	}
	if second.Status != OrderStatusPaid {
		t.Fatalf("expected paid order, got %q", second.Status)
	}
	if subscriptionClient.applyCalls != 1 {
		t.Fatalf("expected idempotent apply count 1, got %d", subscriptionClient.applyCalls)
	}
}

