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

func TestBuildFailureNotificationContentIsProductized(t *testing.T) {
	notification := FailureNotification{
		WorkflowID: "wf-test",
		RunID:      "run-test",
		Request: ExportRequest{
			BotID:       "bot-test",
			BotName:     "我的 Agent",
			InstanceID:  "ins-test",
			Region:      "ap-beijing",
			RemotePaths: []string{"/home/agentuser/.hermes"},
		},
		Status: ExportStatus{Phase: PhaseFailed},
		Error:  "activity error (type: EnsureBackup, scheduledEventID: 11, startedEventID: 12, identity: worker@): cvm.tencentcloudapi.com CreateImage failed: ResourceUnavailable.SnapshotCreating: Disk(disk-hqe03fm1) is creating snapshot, please retry it later (type: TencentAPIError, retryable: true)",
	}

	subject, htmlBody, textBody := buildFailureNotificationContent(notification)
	for _, value := range []string{subject, htmlBody, textBody} {
		if !strings.Contains(value, "我的 Agent") {
			t.Fatalf("content missing agent label: %q", value)
		}
	}
	if !strings.Contains(textBody, "磁盘快照正在创建") || !strings.Contains(htmlBody, "磁盘快照正在创建") {
		t.Fatalf("content missing productized reason: text=%s html=%s", textBody, htmlBody)
	}
	for _, body := range []string{subject, htmlBody, textBody} {
		for _, hidden := range []string{"ins-test", "ap-beijing", "wf-test", "run-test", "activity error", "scheduledEventID", "identity", "cvm.tencentcloudapi.com", "TencentAPIError", "retryable"} {
			if strings.Contains(body, hidden) {
				t.Fatalf("content leaks %q: %s", hidden, body)
			}
		}
	}
}
