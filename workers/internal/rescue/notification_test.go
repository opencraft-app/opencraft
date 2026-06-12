package rescue

import (
	"strings"
	"testing"
)

func TestFailureNotificationRecipientsDedupeAndFallback(t *testing.T) {
	t.Setenv("RESCUE_EXPORT_FAILURE_EMAIL_TO", "ops@example.com, bad-address")
	t.Setenv("RESCUE_EXPORT_NOTIFY_EMAILS", "ops@example.com, fallback@example.com")

	got := failureNotificationRecipients(ExportRequest{
		NotificationEmail:  "user@example.com",
		NotifyEmail:        "user@example.com",
		NotificationEmails: []string{"team@example.com"},
	})

	want := []string{"team@example.com", "user@example.com", "ops@example.com", "fallback@example.com"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("recipients = %v, want %v", got, want)
	}
}

func TestBuildFailureNotificationContentIncludesError(t *testing.T) {
	notification := FailureNotification{
		WorkflowID: "wf-test",
		RunID:      "run-test",
		Request: ExportRequest{
			InstanceID:  "ins-test",
			RemotePaths: []string{"/home/agentuser/.openclaw/workspace"},
		},
		Status: ExportStatus{Phase: PhaseFailed},
		Error:  "DescribeInstances failed",
	}

	subject, htmlBody, textBody := buildFailureNotificationContent(notification)
	for _, value := range []string{subject, htmlBody, textBody} {
		if !strings.Contains(value, "ins-test") {
			t.Fatalf("content missing instance: %q", value)
		}
	}
	if !strings.Contains(textBody, "DescribeInstances failed") {
		t.Fatalf("text body missing error: %s", textBody)
	}
	if !strings.Contains(htmlBody, "DescribeInstances failed") {
		t.Fatalf("html body missing error: %s", htmlBody)
	}
}
