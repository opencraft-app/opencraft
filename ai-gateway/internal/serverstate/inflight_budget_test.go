package serverstate

import "testing"

func TestInflightBudget_AcquireAndRelease(t *testing.T) {
	budget := NewInflightBudget(4)

	release, ok := budget.TryAcquire(3)
	if !ok {
		t.Fatal("expected first acquire to succeed")
	}
	if _, ok := budget.TryAcquire(2); ok {
		t.Fatal("expected second acquire to be rejected while budget is exhausted")
	}

	release()

	if _, ok := budget.TryAcquire(4); !ok {
		t.Fatal("expected acquire to succeed after release")
	}
}
