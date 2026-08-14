package website

import (
	"testing"
	"time"
)

func TestOperationClaimability(t *testing.T) {
	now := time.Now().UTC()
	expired := now.Add(-time.Second)
	future := now.Add(time.Second)

	tests := []struct {
		name   string
		status string
		lease  *time.Time
		want   bool
	}{
		{name: "created", status: "created", want: true},
		{name: "running with expired lease", status: "running", lease: &expired, want: true},
		{name: "running with valid lease", status: "running", lease: &future, want: false},
		{name: "completed", status: "success", want: false},
		{name: "failed", status: "failed", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isOperationClaimable(tt.status, tt.lease, now); got != tt.want {
				t.Fatalf("isOperationClaimable(%q) = %v, want %v", tt.status, got, tt.want)
			}
		})
	}
}

func TestOperationGenerationFencing(t *testing.T) {
	if !isCurrentOperationGeneration(3, 3) {
		t.Fatal("matching generations must be current")
	}
	if isCurrentOperationGeneration(2, 3) {
		t.Fatal("older operation must not overwrite a newer site state")
	}
}
