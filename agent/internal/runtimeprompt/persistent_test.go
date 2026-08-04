package runtimeprompt

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/runtimeapi"
)

func TestPersistentPlannerPreservesExplicitOpaqueReplyTarget(t *testing.T) {
	t.Parallel()

	const target = "c2c:dV9odW1hbl8x"
	plan, err := NewPersistentPlanner("codex").PlanLaunch(
		runtimeapi.LaunchInput{
			AgentID: "agent_1",
			Runtime: "codex",
			WakeMessage: json.RawMessage(`{
				"message_id":"message_1",
				"channel_type":"dm",
				"channel_name":"` + target + `",
				"target":"` + target + `",
				"sender_name":"human_1"
			}`),
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(
		plan.Prompt,
		`read: `+"`"+`raft message read --target "`+target+
			`" --around "message_1"`+"`",
	) {
		t.Fatalf("Prompt does not preserve explicit target:\n%s", plan.Prompt)
	}
	if strings.Contains(plan.Prompt, "dm:@"+target) {
		t.Fatalf("Prompt rewrote opaque target:\n%s", plan.Prompt)
	}
}

func TestTransientWakePromptPreservesPlatformTaskPayload(t *testing.T) {
	t.Parallel()

	raw := json.RawMessage(`{
		"message_id":"task-1:3",
		"channel_type":"task",
		"sender_name":"platform",
		"source":"task",
		"target":"server:server-1",
		"text":"Claim Task #7 with raft task claim."
	}`)
	prompt := transientWakePrompt(raw)
	for _, fragment := range []string{
		"[target=server:server-1 msg=task-1:3 time=- type=task]",
		"@platform: Claim Task #7 with raft task claim.",
	} {
		if !strings.Contains(prompt, fragment) {
			t.Fatalf("task wake prompt = %q, missing %q", prompt, fragment)
		}
	}
}

func TestTransientWakePromptPreservesPlatformReminderPayload(t *testing.T) {
	t.Parallel()

	raw := json.RawMessage(`{
		"message_id":"occurrence-1",
		"channel_type":"reminder",
		"sender_name":"platform",
		"source":"reminder",
		"target":"reminder:occurrence-1",
		"text":"Run the scheduled check now."
	}`)
	prompt := transientWakePrompt(raw)
	for _, fragment := range []string{
		"[target=reminder:occurrence-1 msg=occurrence-1 time=- type=reminder]",
		"@platform: Run the scheduled check now.",
	} {
		if !strings.Contains(prompt, fragment) {
			t.Fatalf("reminder wake prompt = %q, missing %q", prompt, fragment)
		}
	}
}
