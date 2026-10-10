package runtimeprompt

import (
	"encoding/json"
	"strings"
	"testing"

	"velachat/agent/internal/runtimeapi"
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
		`read: `+"`"+`vela message read --target "`+target+
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
		"text":"Claim Task #7 with vela task claim."
	}`)
	prompt := transientWakePrompt(raw)
	for _, fragment := range []string{
		"[target=server:server-1 msg=task-1:3 time=- type=task]",
		"@platform: Claim Task #7 with vela task claim.",
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

func TestPersistentPlannerRendersAttachmentWakeMessage(t *testing.T) {
	t.Parallel()

	plan, err := NewPersistentPlanner("codex").PlanLaunch(runtimeapi.LaunchInput{
		AgentID: "agent_1",
		Runtime: "codex",
		WakeMessage: json.RawMessage(`{
			"message_id":"image-1",
			"channel_type":"channel",
			"channel_name":"#general",
			"target":"#general",
			"sender_name":"human_1",
			"text":"[Image attachment: screenshot.png, id=attc_11111111111111111111111111111111]",
			"attachments":[{
				"id":"attc_11111111111111111111111111111111",
				"filename":"screenshot.png",
				"mimeType":"image/png",
				"sizeBytes":136000
			}]
		}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, fragment := range []string{
		"attachment screenshot.png",
		"id=attc_11111111111111111111111111111111",
		"vela attachment view --id attc_11111111111111111111111111111111",
	} {
		if !strings.Contains(plan.Prompt, fragment) {
			t.Fatalf("attachment wake prompt = %q, missing %q", plan.Prompt, fragment)
		}
	}
	if plan.RebindDelivery == nil || len(plan.RebindDelivery.Attachments) != 1 ||
		plan.RebindDelivery.Attachments[0].ID != "attc_11111111111111111111111111111111" {
		t.Fatalf("attachment rebind delivery = %#v", plan.RebindDelivery)
	}
}
