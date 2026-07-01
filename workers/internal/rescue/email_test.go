package rescue

import (
	"strings"
	"testing"
	"time"
)

func TestFormatDownloadTTLLabel(t *testing.T) {
	if got := formatDownloadTTLLabel(28800); got != "8 小时" {
		t.Fatalf("unexpected ttl label: %q", got)
	}
	if got := formatDownloadTTLLabel(3600); got != "1 小时" {
		t.Fatalf("unexpected ttl label: %q", got)
	}
}

func TestSESRequestDateFromMessageID(t *testing.T) {
	got := sesRequestDateFromMessageID("qcloudses-30-1388575217-date-20260608225131-FAKZ1acbygYF1")
	if got != "2026-06-08" {
		t.Fatalf("unexpected request date: %q", got)
	}
}

func TestSESDeliveryTimeoutDefaultsToTwentyMinutes(t *testing.T) {
	t.Setenv("RESCUE_EXPORT_SES_DELIVERY_TIMEOUT_SECONDS", "")
	if got := sesDeliveryTimeout(); got != 20*time.Minute {
		t.Fatalf("unexpected default delivery timeout: %s", got)
	}

	t.Setenv("RESCUE_EXPORT_SES_DELIVERY_TIMEOUT_SECONDS", "bad")
	if got := sesDeliveryTimeout(); got != 20*time.Minute {
		t.Fatalf("unexpected invalid-env delivery timeout: %s", got)
	}
}

func TestSESDeliveryTimeoutResultPreservesWorkflowSuccessFields(t *testing.T) {
	t.Setenv("RESCUE_EXPORT_SES_DELIVERY_TIMEOUT_SECONDS", "1200")
	sent := EmailNotificationResult{MessageID: "qcloudses-test", ToEmail: "user@example.com"}
	result := sesDeliveryTimeoutResult(sent, EmailNotificationResult{DeliverStatus: -1})

	if result.MessageID != sent.MessageID || result.ToEmail != sent.ToEmail {
		t.Fatalf("timeout result lost sent fields: %+v", result)
	}
	if result.EmailDelivered {
		t.Fatalf("timeout result must not mark email delivered: %+v", result)
	}
	if result.DeliverStatus != -1 || !strings.Contains(result.DeliverMessage, "timed out waiting for SES delivery") {
		t.Fatalf("unexpected timeout delivery result: %+v", result)
	}
}

func TestBuildExportNotificationContentIncludesDownloadLink(t *testing.T) {
	req := ExportRequest{BotID: "bot-test", BotName: "我的 Agent", InstanceID: "ins-test", Region: "ap-beijing"}
	subject, html, text := buildExportNotificationContent(req, "https://example.com/download", 28800)
	if subject == "" {
		t.Fatal("expected subject")
	}
	for _, body := range []string{html, text} {
		if !strings.Contains(body, "我的 Agent") || !strings.Contains(body, "https://example.com/download") || !strings.Contains(body, "8 小时") {
			t.Fatalf("unexpected body: %s", body)
		}
		for _, hidden := range []string{"ins-test", "ap-beijing", "CVM", "COS"} {
			if strings.Contains(body, hidden) {
				t.Fatalf("body leaks infrastructure detail %q: %s", hidden, body)
			}
		}
	}
	for _, hidden := range []string{"ins-test", "ap-beijing", "CVM"} {
		if strings.Contains(subject, hidden) {
			t.Fatalf("subject leaks infrastructure detail %q: %s", hidden, subject)
		}
	}
}

func TestNotificationEmailPrefersCanonicalField(t *testing.T) {
	req := ExportRequest{NotifyEmail: "notify@example.com", NotificationEmail: "canonical@example.com"}
	if got := notificationEmail(req); got != "canonical@example.com" {
		t.Fatalf("unexpected email: %q", got)
	}
}
