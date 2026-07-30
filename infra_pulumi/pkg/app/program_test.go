package app

import "testing"

func TestSelectedStepsNotifyScopeRegistersOnlyNotify(t *testing.T) {
	steps, err := selectedSteps("notify")
	if err != nil {
		t.Fatalf("selectedSteps returned error: %v", err)
	}
	if len(steps) != 1 {
		t.Fatalf("notify scope registered %d steps, want 1", len(steps))
	}
}

func TestSelectedStepsRejectsUnknownScope(t *testing.T) {
	if _, err := selectedSteps("database"); err == nil {
		t.Fatal("selectedSteps accepted an unknown component scope")
	}
}
