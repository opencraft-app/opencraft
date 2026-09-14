package pass_test

import (
	"testing"
	"time"

	"ctl/pkg/model/eventoutbox"
	"ctl/pkg/model/pass"
	"ctl/pkg/resource"
	"ctl/test/testutil"
)

func TestTryAcquireSlotForIsolatePersistsRefundEventAtomically(t *testing.T) {
	testutil.NewSQLiteDB(t, &pass.Entity{}, &eventoutbox.Entity{})
	now := time.Date(2026, 9, 14, 10, 0, 0, 0, time.UTC)
	if err := pass.NewDao().Create(&pass.Entity{
		PassID: "pass-refund", UserID: "usr-invitee", BundleID: "bundle-paid",
		Status: pass.StatusActive, ExpiredTime: now.Add(30 * 24 * time.Hour),
	}); err != nil {
		t.Fatalf("seed pass: %v", err)
	}
	event := &eventoutbox.Event{
		EventID: "pass.refunded:pass-refund", EventType: "pass.refunded.v1",
		AggregateID: "pass-refund", PayloadJSON: []byte(`{"event_type":"pass.refunded.v1"}`), OccurredAt: now,
	}

	acquired, err := pass.NewDao().TryAcquireSlotForIsolateWithEvent("pass-refund", event)
	if err != nil || !acquired {
		t.Fatalf("TryAcquireSlotForIsolateWithEvent acquired=%v err=%v", acquired, err)
	}
	var stored eventoutbox.Entity
	if err := resource.GormDB.First(&stored, "event_id = ?", event.EventID).Error; err != nil {
		t.Fatalf("read outbox event: %v", err)
	}
	if stored.EventType != event.EventType || stored.Status != "pending" {
		t.Fatalf("unexpected outbox event: %+v", stored)
	}

	acquired, err = pass.NewDao().TryAcquireSlotForIsolateWithEvent("pass-refund", event)
	if err != nil || acquired {
		t.Fatalf("second acquire acquired=%v err=%v", acquired, err)
	}
	var count int64
	if err := resource.GormDB.Model(&eventoutbox.Entity{}).Where("event_id = ?", event.EventID).Count(&count).Error; err != nil {
		t.Fatalf("count outbox events: %v", err)
	}
	if count != 1 {
		t.Fatalf("outbox event count=%d, want 1", count)
	}
}
