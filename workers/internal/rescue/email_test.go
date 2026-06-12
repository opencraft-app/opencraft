package rescue

import (
	"strings"
	"testing"
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
