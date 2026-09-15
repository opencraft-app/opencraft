package runtimeprompt

import (
	"strings"
	"testing"
)

func TestComposeStandingPromptDefinesSharedConversationPolicy(t *testing.T) {
	t.Parallel()

	prompt, err := ComposeStandingPrompt("agent-policy", "")
	if err != nil {
		t.Fatal(err)
	}
	required := []string{
		SharedConversationPolicyMarker,
		"You are Vela Agent agent-policy.",
		"Shared Vela conversation policy",
		"clearly continues an active conversation already owned by you",
		"`mentioned` and other attention metadata are helpful signals, not authoritative proof",
		"remain silent",
		"Do not announce that you are remaining silent",
		"reuse the exact `target` from the received message",
		"Do not move a conversation to another channel or send a separate DM",
		"Ordinary messages and reminders do not have a universal idempotency lock",
		"the authenticated Agent that creates a reminder owns it",
		"that same Agent is awakened when it fires",
		"do not create a duplicate",
		"Claim the task before doing substantive work",
		"If claiming fails, do not perform or report that work",
	}
	for _, fragment := range required {
		if !strings.Contains(prompt, fragment) {
			t.Errorf("standing prompt does not contain %q:\n%s", fragment, prompt)
		}
	}
}

func TestComposeStandingPromptIsDeterministicAndIdempotent(t *testing.T) {
	t.Parallel()

	driverInstructions := "Driver-specific instructions.\n" +
		"## Shared Vela conversation policy\n" +
		"This similar heading is not the versioned marker."
	composed, err := ComposeStandingPrompt("agent-compose", driverInstructions)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(composed, driverInstructions+"\n\n") {
		t.Fatalf("Driver instructions were not preserved first:\n%s", composed)
	}
	if strings.Count(composed, SharedConversationPolicyMarker) != 1 {
		t.Fatalf("shared marker count = %d:\n%s",
			strings.Count(composed, SharedConversationPolicyMarker), composed)
	}
	if strings.Count(composed, "You are Vela Agent agent-compose.") != 1 {
		t.Fatalf("Agent identity count is not one:\n%s", composed)
	}

	recomposed, err := ComposeStandingPrompt("agent-compose", composed)
	if err != nil {
		t.Fatal(err)
	}
	if recomposed != composed {
		t.Fatalf("second composition changed the prompt:\nfirst:\n%s\nsecond:\n%s",
			composed, recomposed)
	}
}

func TestComposeStandingPromptRequiresAgentIdentity(t *testing.T) {
	t.Parallel()

	if _, err := ComposeStandingPrompt(" \t ", "Driver instructions"); err == nil {
		t.Fatal("ComposeStandingPrompt() accepted an empty Agent identity")
	}
}
