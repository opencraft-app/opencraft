package agentcli

import (
	"errors"
	"strings"

	"github.com/QuantumNous/new-api/common"
)

const reminderModifyHint = "(to modify: snooze/update/cancel; raft reminder --help)"

type reminderRecurrenceView struct {
	Kind        string `json:"kind"`
	Description string `json:"description"`
}

type reminderView struct {
	ReminderID string                  `json:"reminderId"`
	Title      string                  `json:"title"`
	FireAt     string                  `json:"fireAt"`
	FiredAt    *string                 `json:"firedAt"`
	Status     string                  `json:"status"`
	MsgRef     *string                 `json:"msgRef"`
	AnchorKind string                  `json:"anchorKind"`
	ThreadID   *string                 `json:"threadId"`
	Recurrence *reminderRecurrenceView `json:"recurrence"`
}

type reminderEventView struct {
	EventType  string  `json:"eventType"`
	ActorType  string  `json:"actorType"`
	ActorID    *string `json:"actorId"`
	OccurredAt string  `json:"occurredAt"`
	NextFireAt *string `json:"nextFireAt"`
}

type reminderMutationView struct {
	Reminder reminderView `json:"reminder"`
	Warning  *string      `json:"warning"`
}

type reminderListView struct {
	Reminders []reminderView `json:"reminders"`
}

type reminderLogView struct {
	Events []reminderEventView `json:"events"`
}

func formatReminderCommandResult(
	commandPath string,
	result map[string]any,
) (string, error) {
	switch commandPath {
	case "reminder list":
		var response reminderListView
		if err := decodeReminderResult(result, &response); err != nil {
			return "", err
		}
		if len(response.Reminders) == 0 {
			return "No reminders.", nil
		}
		lines := make([]string, 0, len(response.Reminders))
		for _, reminder := range response.Reminders {
			lines = append(lines, formatReminderRow(reminder))
		}
		return strings.Join(lines, "\n"), nil
	case "reminder log":
		var response reminderLogView
		if err := decodeReminderResult(result, &response); err != nil {
			return "", err
		}
		if len(response.Events) == 0 {
			return "No reminder events.", nil
		}
		lines := make([]string, 0, len(response.Events))
		for _, event := range response.Events {
			actor := event.ActorType
			if event.ActorID != nil && *event.ActorID != "" {
				actor += ":" + *event.ActorID
			}
			next := "none"
			if event.NextFireAt != nil && *event.NextFireAt != "" {
				next = *event.NextFireAt
			}
			lines = append(
				lines,
				event.OccurredAt+" "+strings.ToUpper(event.EventType)+
					" by "+actor+" next="+next,
			)
		}
		return strings.Join(lines, "\n"), nil
	case "reminder schedule",
		"reminder cancel",
		"reminder snooze",
		"reminder update":
		var response reminderMutationView
		if err := decodeReminderResult(result, &response); err != nil {
			return "", err
		}
		switch commandPath {
		case "reminder cancel":
			return "Reminder canceled: #" +
				shortReminderID(response.Reminder.ReminderID) +
				" [" + response.Reminder.Status + "] \"" +
				response.Reminder.Title + "\"", nil
		case "reminder schedule", "reminder snooze", "reminder update":
			action := map[string]string{
				"reminder schedule": "scheduled",
				"reminder snooze":   "snoozed",
				"reminder update":   "updated",
			}[commandPath]
			lines := []string{
				"Reminder " + action + ": #" +
					shortReminderID(response.Reminder.ReminderID) + " " +
					formatReminderType(response.Reminder) + " \"" +
					response.Reminder.Title + "\"",
				"Next: " + response.Reminder.FireAt,
			}
			if anchor := formatReminderAnchorSummary(response.Reminder); anchor != "" {
				lines = append(lines, "Anchor: "+anchor)
			}
			lines = append(lines, reminderModifyHint)
			if (commandPath == "reminder schedule" ||
				commandPath == "reminder update") &&
				response.Warning != nil &&
				*response.Warning != "" {
				lines = append(lines, "Warning: "+*response.Warning)
			}
			return strings.Join(lines, "\n"), nil
		}
	default:
		return "", errors.New("unsupported reminder formatter")
	}
	return "", errors.New("unsupported reminder formatter")
}

func formatReminderRow(reminder reminderView) string {
	timeField := "next=" + reminder.FireAt
	if reminder.Status == "fired" {
		firedAt := reminder.FireAt
		if reminder.FiredAt != nil {
			firedAt = *reminder.FiredAt
		}
		timeField = "fired_at=" + firedAt
	}
	reference := formatReminderAnchor(reminder)
	if reminder.MsgRef != nil && *reminder.MsgRef != "" {
		reference = " ref=" + *reminder.MsgRef
		if anchor := formatReminderAnchor(reminder); anchor != "" {
			reference = anchor + reference
		}
	}
	return "#" + shortReminderID(reminder.ReminderID) +
		" [" + reminder.Status + "] " +
		formatReminderType(reminder) + " " +
		timeField + " \"" + reminder.Title + "\"" + reference
}

func formatReminderAnchor(reminder reminderView) string {
	kind := strings.TrimSpace(reminder.AnchorKind)
	if kind != "message" && kind != "thread" {
		return ""
	}
	anchor := " anchor=" + kind
	if kind == "thread" && reminder.ThreadID != nil &&
		strings.TrimSpace(*reminder.ThreadID) != "" {
		anchor += " thread=#" + shortReminderID(strings.TrimSpace(*reminder.ThreadID))
	}
	return anchor
}

func formatReminderAnchorSummary(reminder reminderView) string {
	kind := strings.TrimSpace(reminder.AnchorKind)
	if kind != "message" && kind != "thread" {
		return ""
	}
	summary := kind
	if kind == "thread" && reminder.ThreadID != nil &&
		strings.TrimSpace(*reminder.ThreadID) != "" {
		summary += " #" + shortReminderID(strings.TrimSpace(*reminder.ThreadID))
	}
	if reminder.MsgRef != nil && strings.TrimSpace(*reminder.MsgRef) != "" {
		summary += " ref=" + strings.TrimSpace(*reminder.MsgRef)
	}
	return summary
}

func formatReminderType(reminder reminderView) string {
	if reminder.Recurrence == nil {
		return "(one-time)"
	}
	return "(recurring · " + reminder.Recurrence.Description + ")"
}

func shortReminderID(reminderID string) string {
	if len(reminderID) <= 8 {
		return reminderID
	}
	return reminderID[:8]
}

func decodeReminderResult(result map[string]any, destination any) error {
	data, err := common.Marshal(result)
	if err != nil {
		return err
	}
	return common.Unmarshal(data, destination)
}
