package agentcli

import (
	"testing"
)

func TestFormatReminderCommandResultPreservesTypeWarningAndFiredFallback(
	t *testing.T,
) {
	t.Parallel()

	scheduled, err := formatReminderCommandResult(
		"reminder schedule",
		map[string]any{
			"reminder": map[string]any{
				"reminderId": "abcd1234-0000-4000-8000-000000000000",
				"title":      "Review deploy",
				"fireAt":     "2026-07-26T09:00:00Z",
				"status":     "scheduled",
				"recurrence": map[string]any{
					"kind":        "interval",
					"description": "every 1 day",
				},
			},
			"warning": "The next occurrence is close.",
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	const scheduledWant = "Reminder scheduled: #abcd1234 " +
		"(recurring · every 1 day) \"Review deploy\"\n" +
		"Next: 2026-07-26T09:00:00Z\n" +
		"(to modify: snooze/update/cancel; vela reminder --help)\n" +
		"Warning: The next occurrence is close."
	if scheduled != scheduledWant {
		t.Fatalf("scheduled:\n%s\nwant:\n%s", scheduled, scheduledWant)
	}

	list, err := formatReminderCommandResult(
		"reminder list",
		map[string]any{
			"reminders": []any{map[string]any{
				"reminderId": "beef5678-0000-4000-8000-000000000000",
				"title":      "Check report",
				"fireAt":     "2026-07-24T09:00:00Z",
				"firedAt":    nil,
				"status":     "fired",
				"msgRef":     "#general:message1",
				"recurrence": nil,
			}},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	const listWant = "#beef5678 [fired] (one-time) " +
		"fired_at=2026-07-24T09:00:00Z \"Check report\" " +
		"ref=#general:message1"
	if list != listWant {
		t.Fatalf("list = %q, want %q", list, listWant)
	}
}

func TestFormatReminderCommandResultHandlesEmptyCollections(t *testing.T) {
	t.Parallel()

	list, err := formatReminderCommandResult(
		"reminder list",
		map[string]any{"reminders": []any{}},
	)
	if err != nil {
		t.Fatal(err)
	}
	if list != "No reminders." {
		t.Fatalf("list = %q", list)
	}
	log, err := formatReminderCommandResult(
		"reminder log",
		map[string]any{"events": []any{}},
	)
	if err != nil {
		t.Fatal(err)
	}
	if log != "No reminder events." {
		t.Fatalf("log = %q", log)
	}
}

func TestFormatReminderCommandResultShowsMessageAndThreadAnchors(t *testing.T) {
	t.Parallel()

	got, err := formatReminderCommandResult(
		"reminder list",
		map[string]any{"reminders": []any{
			map[string]any{
				"reminderId": "aaaa1111-0000-4000-8000-000000000000",
				"title":      "Message follow-up", "fireAt": "2026-08-02T09:00:00Z",
				"status": "scheduled", "msgRef": "#general:message-1",
				"anchorKind": "message", "threadId": nil, "recurrence": nil,
			},
			map[string]any{
				"reminderId": "bbbb2222-0000-4000-8000-000000000000",
				"title":      "Thread follow-up", "fireAt": "2026-08-02T10:00:00Z",
				"status": "scheduled", "msgRef": "#general:root-message",
				"anchorKind": "thread",
				"threadId":   "019fc0c8-48fc-78e4-b9bb-00510f33a0f5",
				"recurrence": nil,
			},
		}},
	)
	if err != nil {
		t.Fatal(err)
	}
	want := "#aaaa1111 [scheduled] (one-time) next=2026-08-02T09:00:00Z " +
		"\"Message follow-up\" anchor=message ref=#general:message-1\n" +
		"#bbbb2222 [scheduled] (one-time) next=2026-08-02T10:00:00Z " +
		"\"Thread follow-up\" anchor=thread thread=#019fc0c8 ref=#general:root-message"
	if got != want {
		t.Fatalf("anchors:\n%s\nwant:\n%s", got, want)
	}

	scheduled, err := formatReminderCommandResult(
		"reminder schedule",
		map[string]any{"reminder": map[string]any{
			"reminderId": "bbbb2222-0000-4000-8000-000000000000",
			"title":      "Thread follow-up", "fireAt": "2026-08-02T10:00:00Z",
			"status": "scheduled", "msgRef": "#general:root-message",
			"anchorKind": "thread",
			"threadId":   "019fc0c8-48fc-78e4-b9bb-00510f33a0f5",
			"recurrence": nil,
		}},
	)
	if err != nil {
		t.Fatal(err)
	}
	scheduledWant := "Reminder scheduled: #bbbb2222 (one-time) \"Thread follow-up\"\n" +
		"Next: 2026-08-02T10:00:00Z\n" +
		"Anchor: thread #019fc0c8 ref=#general:root-message\n" + reminderModifyHint
	if scheduled != scheduledWant {
		t.Fatalf("scheduled anchor:\n%s\nwant:\n%s", scheduled, scheduledWant)
	}
}

func TestFormatReminderLogPreservesActorAndNextFireSemantics(t *testing.T) {
	t.Parallel()

	got, err := formatReminderCommandResult(
		"reminder log",
		map[string]any{
			"events": []any{
				map[string]any{
					"eventType":  "scheduled",
					"actorType":  "agent",
					"actorId":    "agent-fixture",
					"occurredAt": "2026-07-25T08:00:00Z",
					"nextFireAt": "2026-07-26T09:00:00Z",
				},
				map[string]any{
					"eventType":  "updated",
					"actorType":  "system",
					"actorId":    nil,
					"occurredAt": "2026-07-25T08:05:00Z",
					"nextFireAt": nil,
				},
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	const want = "2026-07-25T08:00:00Z SCHEDULED by " +
		"agent:agent-fixture next=2026-07-26T09:00:00Z\n" +
		"2026-07-25T08:05:00Z UPDATED by system next=none"
	if got != want {
		t.Fatalf("log:\n%s\nwant:\n%s", got, want)
	}
}
