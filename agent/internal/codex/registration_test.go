package codex

import (
	"testing"

	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/runtimeapi"
)

func TestRegistrationDeclaresCodexAndCreatesFreshDrivers(t *testing.T) {
	t.Parallel()

	registration := Registration(Options{Version: "v-test"})
	if registration.ID != "codex" || registration.DisplayName != "Codex CLI" {
		t.Fatalf("registration identity = %#v", registration)
	}
	if !registration.Policy.SupportsStdin ||
		registration.Policy.BusyMode != runtimeapi.BusyDeliveryDirect ||
		registration.Policy.Completion != runtimeapi.CompletionEvent {
		t.Fatalf("registration policy = %#v", registration.Policy)
	}
	if registration.LaunchPlanner == nil {
		t.Fatal("registration has no launch planner")
	}
	first, err := registration.NewDriver()
	if err != nil {
		t.Fatal(err)
	}
	second, err := registration.NewDriver()
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("registration factory reused a Driver")
	}
	firstDriver, ok := first.(*Driver)
	if !ok || firstDriver.version != "v-test" {
		t.Fatalf("first Driver = %#v", first)
	}
}
