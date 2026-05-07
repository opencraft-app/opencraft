package bypass

import "testing"

func TestCheckTasksLookbackWindow(t *testing.T) {
	if checkTasksLookbackDays != -90 {
		t.Fatalf("checkTasks lookback window = %d days, want -90", checkTasksLookbackDays)
	}
}
