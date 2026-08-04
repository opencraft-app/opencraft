package hermes

import (
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/runtimeapi"
)

func TestRegistrationDeclaresPersistentDirectDelivery(t *testing.T) {
	t.Parallel()

	registration := Registration(Options{Version: "test"})
	if registration.ID != "hermes-acp" ||
		registration.WireID != "opencode" ||
		registration.DisplayName != "Hermes ACP" {
		t.Fatalf("registration = %#v", registration)
	}
	if !registration.Policy.SupportsStdin ||
		registration.Policy.BusyMode != runtimeapi.BusyDeliveryDirect ||
		registration.Policy.Completion != runtimeapi.CompletionEvent {
		t.Fatalf("policy = %#v", registration.Policy)
	}
	plan, err := registration.LaunchPlanner.PlanLaunch(runtimeapi.LaunchInput{
		AgentID: "agent-1",
		Runtime: "hermes-acp",
	})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Prompt != "Start." ||
		!strings.Contains(plan.StandingPrompt, "agent-1") ||
		!strings.Contains(plan.StandingPrompt, "`raft inbox check`") {
		t.Fatalf("launch plan = %#v", plan)
	}
}
