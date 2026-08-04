package state

import (
	"errors"
	"testing"
	"time"
)

func TestOccurrenceStorePersistsPendingAckAndDeletesAcknowledged(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	store, err := OpenOccurrenceStore(root)
	if err != nil {
		t.Fatal(err)
	}
	input := OccurrenceInput{
		AgentID:      "01900000-0000-7000-8000-000000000002",
		OccurrenceID: "01900000-0000-7000-8000-000000000011",
		ReminderID:   "01900000-0000-7000-8000-000000000012",
		ScheduledAt:  time.Date(2026, 8, 3, 8, 0, 0, 0, time.UTC),
	}
	record, created, err := store.Observe(input)
	if err != nil || !created || record.State != OccurrenceDue {
		t.Fatalf("Observe() = (%#v, %v, %v)", record, created, err)
	}
	if _, err := store.Start(input.OccurrenceID, "launch-1", input.ScheduledAt); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Complete(input.OccurrenceID, "launch-1"); err != nil {
		t.Fatal(err)
	}

	reopened, err := OpenOccurrenceStore(root)
	if err != nil {
		t.Fatal(err)
	}
	pending, ok := reopened.Get(input.OccurrenceID)
	if !ok || pending.State != OccurrenceCompletedPendingAck {
		t.Fatalf("pending = %#v, %v", pending, ok)
	}
	acknowledged, err := reopened.Acknowledge(input.OccurrenceID)
	if err != nil || acknowledged.State != OccurrenceCompletedPendingAck {
		t.Fatalf("Acknowledge() = (%#v, %v)", acknowledged, err)
	}
	if _, ok := reopened.Get(input.OccurrenceID); ok || len(reopened.Snapshot()) != 0 {
		t.Fatal("acknowledged occurrence was retained")
	}
}

func TestOccurrenceStoreRecoversOldExecutingEpochWithBackoff(t *testing.T) {
	t.Parallel()

	store, err := OpenOccurrenceStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 3, 9, 0, 0, 0, time.UTC)
	input := OccurrenceInput{
		AgentID:      "01900000-0000-7000-8000-000000000002",
		OccurrenceID: "01900000-0000-7000-8000-000000000021",
		ReminderID:   "01900000-0000-7000-8000-000000000022",
		ScheduledAt:  now.Add(-time.Minute),
	}
	record, _, err := store.Observe(input)
	if err != nil {
		t.Fatal(err)
	}
	for attempt := 1; attempt <= 4; attempt++ {
		if _, err := store.Start(record.OccurrenceID, "launch-old", now); err != nil {
			t.Fatal(err)
		}
		failed, err := store.Fail(record.OccurrenceID, "launch-old", now.Add(time.Minute), false)
		if err != nil || failed.FailureCount != attempt || failed.State != OccurrenceDue {
			t.Fatalf("attempt %d = (%#v, %v)", attempt, failed, err)
		}
		now = now.Add(2 * time.Minute)
	}
	if _, err := store.Start(record.OccurrenceID, "launch-crashed", now); err != nil {
		t.Fatal(err)
	}
	count, err := store.RecoverExecuting("launch-new", now.Add(time.Minute))
	if err != nil || count != 1 {
		t.Fatalf("RecoverExecuting() = (%d, %v)", count, err)
	}
	recovered, _ := store.Get(record.OccurrenceID)
	if recovered.State != OccurrenceNeedsAttention || recovered.FailureCount != 5 ||
		recovered.NextAttemptAt.Before(now.Add(time.Minute)) {
		t.Fatalf("recovered = %#v", recovered)
	}
}

func TestOccurrenceStoreNeverEvictsUnacknowledgedAtCapacity(t *testing.T) {
	t.Parallel()

	store, err := openOccurrenceStore(t.TempDir(), 1)
	if err != nil {
		t.Fatal(err)
	}
	first := OccurrenceInput{
		AgentID:      "01900000-0000-7000-8000-000000000002",
		OccurrenceID: "01900000-0000-7000-8000-000000000031",
		ReminderID:   "01900000-0000-7000-8000-000000000032",
		ScheduledAt:  time.Date(2026, 8, 3, 10, 0, 0, 0, time.UTC),
	}
	if _, _, err := store.Observe(first); err != nil {
		t.Fatal(err)
	}
	second := first
	second.OccurrenceID = "01900000-0000-7000-8000-000000000041"
	second.ReminderID = "01900000-0000-7000-8000-000000000042"
	if _, _, err := store.Observe(second); !errors.Is(err, ErrOccurrenceCapacity) {
		t.Fatalf("capacity error = %v", err)
	}
	if _, ok := store.Get(first.OccurrenceID); !ok {
		t.Fatal("capacity handling evicted unacknowledged occurrence")
	}
}
