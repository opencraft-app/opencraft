package codex

import (
	"encoding/json"
	"strings"
	"testing"

	"velachat/agent/internal/runtimeapi"
)

func TestLaunchPlannerPreservesCodexStartAndResumePrompts(t *testing.T) {
	t.Parallel()

	planner := NewLaunchPlanner()
	testCases := []struct {
		name  string
		input runtimeapi.LaunchInput
		want  string
	}{
		{
			name: "cold start",
			input: runtimeapi.LaunchInput{
				AgentID: "agent-1",
				Runtime: "codex",
			},
			want: "Start.",
		},
		{
			name: "explicit session resume",
			input: runtimeapi.LaunchInput{
				AgentID:      "agent-1",
				Runtime:      "codex",
				SessionID:    "thread-1",
				ResumePrompt: "Continue queued work.",
			},
			want: "Continue queued work." + codexBusyDeliveryNote,
		},
		{
			name: "no work resume",
			input: runtimeapi.LaunchInput{
				AgentID:   "agent-1",
				Runtime:   "codex",
				SessionID: "thread-1",
			},
			want: "No new messages while you were away. Nothing to do — just stop. " +
				codexMessageDeliveryText + codexBusyDeliveryNote,
		},
	}
	for _, testCase := range testCases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			plan, err := planner.PlanLaunch(testCase.input)
			if err != nil {
				t.Fatal(err)
			}
			if plan.Prompt != testCase.want {
				t.Fatalf("Prompt = %q, want %q", plan.Prompt, testCase.want)
			}
			if !strings.Contains(plan.StandingPrompt, testCase.input.AgentID) {
				t.Fatalf("StandingPrompt = %q", plan.StandingPrompt)
			}
		})
	}
}

func TestLaunchPlannerCombinesDurableWakeAndBufferedPrefix(t *testing.T) {
	t.Parallel()

	planner := NewLaunchPlanner()
	wake := json.RawMessage(`{
		"message_id":"message-0001",
		"seq":1,
		"channel_type":"channel",
		"channel_name":"general",
		"sender_name":"alice"
	}`)
	buffered := json.RawMessage(`{
		"message_id":"message-0002",
		"seq":2,
		"channel_type":"channel",
		"channel_name":"general",
		"sender_name":"bob"
	}`)
	plan, err := planner.PlanLaunch(runtimeapi.LaunchInput{
		AgentID:     "agent-1",
		Runtime:     "codex",
		WakeMessage: wake,
		BufferedMessages: []runtimeapi.BufferedLaunchMessage{
			{Raw: buffered, Transient: false},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := "[Vela inbox notice:\n" +
		"Inbox update: 2 unread messages total; 1 changed target\n" +
		"#general  pending: 2 messages · first msg=message-0001 · latest sender @bob · latest msg=message-0002\n" +
		"read: `vela message read --target \"#general\" --around \"message-0002\"`\n" +
		"]"
	if plan.Prompt != want {
		t.Fatalf("Prompt = %q, want %q", plan.Prompt, want)
	}
	if plan.RebindDelivery == nil ||
		plan.RebindDelivery.Text != want ||
		plan.RebindDelivery.Transient {
		t.Fatalf("RebindDelivery = %#v", plan.RebindDelivery)
	}
	if plan.PostStartDelivery == nil ||
		plan.PostStartDelivery.Text != want ||
		plan.PostStartDelivery.Mode != "idle" ||
		plan.PostStartDelivery.Transient {
		t.Fatalf("PostStartDelivery = %#v", plan.PostStartDelivery)
	}
	if plan.ConsumedBufferedMessages != 1 {
		t.Fatalf(
			"ConsumedBufferedMessages = %d, want 1",
			plan.ConsumedBufferedMessages,
		)
	}
}

func TestLaunchPlannerKeepsTransientWakeSeparateFromBufferedPrefix(t *testing.T) {
	t.Parallel()

	planner := NewLaunchPlanner()
	wake := json.RawMessage(`{
		"message_id":"wake-1",
		"channel_type":"channel",
		"channel_name":"general",
		"sender_name":"alice",
		"sender_type":"user",
		"content":"Check the queued work."
	}`)
	buffered := json.RawMessage(`{
		"message_id":"message-0002",
		"seq":2,
		"channel_type":"channel",
		"channel_name":"general",
		"sender_name":"bob"
	}`)
	plan, err := planner.PlanLaunch(runtimeapi.LaunchInput{
		AgentID:              "agent-1",
		Runtime:              "codex",
		WakeMessage:          wake,
		WakeMessageTransient: true,
		BufferedMessages: []runtimeapi.BufferedLaunchMessage{
			{Raw: buffered, Transient: true},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	wantPrompt := "System notice received:\n\n" +
		"[target=#general msg=wake-1 time=- type=user] @alice: Check the queued work." +
		"\n\nRespond as appropriate. Complete all your work before stopping.\n" +
		responseTargetHint
	if plan.Prompt != wantPrompt ||
		plan.RebindDelivery == nil ||
		!plan.RebindDelivery.Transient ||
		plan.RebindDelivery.Text != wantPrompt {
		t.Fatalf("transient launch plan = %#v", plan)
	}
	if plan.PostStartDelivery == nil ||
		!plan.PostStartDelivery.Transient ||
		plan.PostStartDelivery.Mode != "idle" ||
		!strings.Contains(plan.PostStartDelivery.Text, "1 unread message total") {
		t.Fatalf("buffered PostStartDelivery = %#v", plan.PostStartDelivery)
	}
	if plan.ConsumedBufferedMessages != 1 {
		t.Fatalf(
			"ConsumedBufferedMessages = %d, want 1",
			plan.ConsumedBufferedMessages,
		)
	}
}

func TestLaunchPlannerUsesBufferedPrefixForImplicitSessionResumeOnly(t *testing.T) {
	t.Parallel()

	planner := NewLaunchPlanner()
	buffered := runtimeapi.BufferedLaunchMessage{
		Raw: json.RawMessage(`{
			"message_id":"message-resume-1",
			"channel_type":"channel",
			"channel_name":"general",
			"sender_name":"alice",
			"sender_type":"user",
			"content":"Continue the queued review."
		}`),
	}
	implicit, err := planner.PlanLaunch(runtimeapi.LaunchInput{
		AgentID:          "agent-1",
		Runtime:          "codex",
		SessionID:        "thread-1",
		BufferedMessages: []runtimeapi.BufferedLaunchMessage{buffered},
	})
	if err != nil {
		t.Fatal(err)
	}
	if implicit.ConsumedBufferedMessages != 1 ||
		!strings.HasPrefix(implicit.Prompt, "New message received:") {
		t.Fatalf("implicit resume plan = %#v", implicit)
	}

	explicit, err := planner.PlanLaunch(runtimeapi.LaunchInput{
		AgentID:          "agent-1",
		Runtime:          "codex",
		SessionID:        "thread-1",
		ResumePrompt:     "Explicit work.",
		BufferedMessages: []runtimeapi.BufferedLaunchMessage{buffered},
	})
	if err != nil {
		t.Fatal(err)
	}
	if explicit.ConsumedBufferedMessages != 0 ||
		explicit.PostStartDelivery != nil ||
		explicit.Prompt != "Explicit work."+codexBusyDeliveryNote {
		t.Fatalf("explicit resume plan = %#v", explicit)
	}
}

func TestLaunchPlannerRejectsWrongRuntimeWithoutConsumingBuffer(t *testing.T) {
	t.Parallel()

	plan, err := NewLaunchPlanner().PlanLaunch(runtimeapi.LaunchInput{
		AgentID:   "agent-1",
		Runtime:   "claude",
		SessionID: "session-1",
		BufferedMessages: []runtimeapi.BufferedLaunchMessage{
			{Raw: json.RawMessage(`{"text":"fixture"}`)},
		},
	})
	if err == nil {
		t.Fatal("PlanLaunch() error = nil")
	}
	if plan.ConsumedBufferedMessages != 0 {
		t.Fatalf("failed plan consumed %d messages", plan.ConsumedBufferedMessages)
	}
}
