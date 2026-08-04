package hermesgateway

import (
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/runtimeapi"
)

func TestRegistrationUsesDedicatedInternalIdentityAndPiWireAlias(t *testing.T) {
	t.Parallel()

	registration := Registration(Options{Version: "v-test"})
	if registration.ID != "hermes-gateway" ||
		registration.WireID != "pi" ||
		registration.DisplayName != "Hermes Gateway" {
		t.Fatalf("Registration() = %#v", registration)
	}
	if registration.NewDriver == nil || registration.LaunchPlanner == nil {
		t.Fatalf("Registration() is incomplete: %#v", registration)
	}
	if !registration.Policy.SupportsStdin ||
		registration.Policy.BusyMode != runtimeapi.BusyDeliveryDirect ||
		registration.Policy.Completion != runtimeapi.CompletionEvent {
		t.Fatalf("Runtime policy = %#v", registration.Policy)
	}
}

func TestProcessEnvironmentFirewallStripsPiControlledCredentials(t *testing.T) {
	t.Parallel()

	input := map[string]string{
		"DEEPSEEK_API_KEY": "secret-pi-value",
		"PATH":             "/trusted/bin",
		"RAFT_AGENT_ID":    "agent-1",
	}
	sanitized := sanitizeProcessEnvironment(input)
	if _, ok := sanitized["DEEPSEEK_API_KEY"]; ok {
		t.Fatal("Pi-controlled DEEPSEEK_API_KEY crossed the Gateway boundary")
	}
	if sanitized["PATH"] != input["PATH"] ||
		sanitized["RAFT_AGENT_ID"] != input["RAFT_AGENT_ID"] {
		t.Fatalf("unrelated environment changed: %#v", sanitized)
	}
	if input["DEEPSEEK_API_KEY"] != "secret-pi-value" {
		t.Fatal("firewall mutated the caller's environment")
	}
}

func TestGatewayModelSelectionAcceptsDefaultOrExactDetectedModel(t *testing.T) {
	t.Parallel()

	models := runtimeapi.ModelResult{
		Default: "minimax-m2.7",
		Models: []runtimeapi.Model{
			{ID: "minimax-m2.7"},
			{ID: "claude-sonnet-4"},
		},
	}
	for _, requested := range []string{"", "default", "minimax-m2.7", "claude-sonnet-4"} {
		if err := validateModelSelection(requested, models); err != nil {
			t.Fatalf("validateModelSelection(%q) = %v", requested, err)
		}
	}
}

func TestGatewayModelSelectionRejectsUnknownWithoutLeakingValues(t *testing.T) {
	t.Parallel()

	const secret = "sk-sensitive-runtime-value"
	err := validateModelSelection(
		"pi-only-model",
		runtimeapi.ModelResult{Models: []runtimeapi.Model{{ID: "hermes-model"}}},
	)
	if err == nil || !strings.Contains(err.Error(), "model") {
		t.Fatalf("validateModelSelection() error = %v", err)
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("diagnostic leaked credential value: %v", err)
	}
}
