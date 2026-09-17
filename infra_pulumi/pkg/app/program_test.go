package app

import (
	"reflect"
	"testing"

	"github.com/skipzhang/mono/infra_pulumi/pkg/components/networking"
	"github.com/skipzhang/mono/infra_pulumi/pkg/components/securitygroup"
)

func TestSelectedStepsNotifyScopeRegistersOnlyNotify(t *testing.T) {
	steps, err := selectedSteps("notify")
	if err != nil {
		t.Fatalf("selectedSteps returned error: %v", err)
	}
	if len(steps) != 1 {
		t.Fatalf("notify scope registered %d steps, want 1", len(steps))
	}
}

func TestSelectedStepsPulsarScopeRegistersOnlyPulsar(t *testing.T) {
	steps, err := selectedSteps("pulsar")
	if err != nil {
		t.Fatalf("selectedSteps returned error: %v", err)
	}
	if len(steps) != 1 {
		t.Fatalf("pulsar scope registered %d steps, want 1", len(steps))
	}
}

func TestSelectedStepsSandboxNetworkScopeRegistersOnlyNetworkAndSandboxSecurity(t *testing.T) {
	steps, err := selectedSteps("sandbox-network")
	if err != nil {
		t.Fatalf("selectedSteps returned error: %v", err)
	}
	if len(steps) != 2 {
		t.Fatalf("sandbox-network scope registered %d steps, want 2", len(steps))
	}
	want := []uintptr{
		reflect.ValueOf(networking.Ensure).Pointer(),
		reflect.ValueOf(securitygroup.EnsureSandbox).Pointer(),
	}
	for i, step := range steps {
		if got := reflect.ValueOf(step).Pointer(); got != want[i] {
			t.Fatalf("sandbox-network step %d pointer = %v, want %v", i, got, want[i])
		}
	}
}

func TestSelectedStepsRejectsUnknownScope(t *testing.T) {
	if _, err := selectedSteps("database"); err == nil {
		t.Fatal("selectedSteps accepted an unknown component scope")
	}
}

func TestValidateInventoryProfileScopeRequiresNetworkOnlyMatch(t *testing.T) {
	if err := validateInventoryProfileScope("sandbox-network", ""); err == nil {
		t.Fatal("network-only inventory accepted full component scope")
	}
	if err := validateInventoryProfileScope("full", "sandbox-network"); err == nil {
		t.Fatal("full inventory accepted sandbox-network scope")
	}
	if err := validateInventoryProfileScope("sandbox-network", "sandbox-network"); err != nil {
		t.Fatalf("matching network-only profile/scope rejected: %v", err)
	}
}
