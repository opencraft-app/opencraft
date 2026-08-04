package state

import (
	"errors"
	"testing"
)

func TestTaskDeliveryStorePersistsMonotonicRevisionAndPrunesInactive(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	store, err := OpenTaskDeliveryStore(root)
	if err != nil {
		t.Fatal(err)
	}
	taskA := "01900000-0000-7000-8000-000000000101"
	taskB := "01900000-0000-7000-8000-000000000102"
	if err := store.RecordDelivered(taskA, 2); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordDelivered(taskA, 2); err != nil {
		t.Fatalf("idempotent delivery: %v", err)
	}
	if err := store.RecordDelivered(taskA, 1); !errors.Is(err, ErrTaskRevisionRegression) {
		t.Fatalf("revision regression = %v", err)
	}
	if err := store.RecordDelivered(taskB, 7); err != nil {
		t.Fatal(err)
	}

	reopened, err := OpenTaskDeliveryStore(root)
	if err != nil {
		t.Fatal(err)
	}
	if revision, ok := reopened.DeliveredRevision(taskA); !ok || revision != 2 {
		t.Fatalf("task A = %d, %v", revision, ok)
	}
	if err := reopened.PruneActive(map[string]struct{}{taskB: {}}); err != nil {
		t.Fatal(err)
	}
	if _, ok := reopened.DeliveredRevision(taskA); ok {
		t.Fatal("inactive task watermark retained")
	}
	if revision, ok := reopened.DeliveredRevision(taskB); !ok || revision != 7 {
		t.Fatalf("task B = %d, %v", revision, ok)
	}
}

func TestTaskDeliveryStoreRejectsNewActiveTaskAtCapacity(t *testing.T) {
	t.Parallel()

	store, err := openTaskDeliveryStore(t.TempDir(), 1)
	if err != nil {
		t.Fatal(err)
	}
	first := "01900000-0000-7000-8000-000000000111"
	second := "01900000-0000-7000-8000-000000000112"
	if err := store.RecordDelivered(first, 1); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordDelivered(second, 1); !errors.Is(err, ErrTaskDeliveryCapacity) {
		t.Fatalf("capacity error = %v", err)
	}
	if revision, ok := store.DeliveredRevision(first); !ok || revision != 1 {
		t.Fatal("capacity handling evicted active task")
	}
}
