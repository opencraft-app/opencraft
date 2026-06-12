package rescue

import (
	"context"
	"encoding/base64"
	"fmt"
	"html"
	"net/mail"
	"os"
	"strings"
)

const (
	defaultSESEndpoint = "ses.tencentcloudapi.com"
	defaultSESVersion  = "2020-10-02"
	defaultSESRegion   = "ap-guangzhou"
	defaultSESFrom     = "LightVela <noreply@service.lightvela.com>"
)

type FailureNotification struct {
	WorkflowID string
	RunID      string
	Request    ExportRequest
	Status     ExportStatus
	Error      string
}

type FailureNotificationResult struct {
	Sent       bool
	Recipients []string
	MessageIDs []string
	RequestIDs []string
	Skipped    string
}

func (Activities) SendFailureNotification(ctx context.Context, notification FailureNotification, cfg TencentConfig) (FailureNotificationResult, error) {
	recipients := failureNotificationRecipients(notification.Request)
	if len(recipients) == 0 {
		return FailureNotificationResult{Skipped: "no recipients configured"}, nil
	}
	from := strings.TrimSpace(os.Getenv("RESCUE_EXPORT_SES_FROM"))
	if from == "" {
		from = defaultSESFrom
	}
	region := strings.TrimSpace(os.Getenv("RESCUE_EXPORT_SES_REGION"))
	if region == "" {
		region = defaultSESRegion
	}
	secretID, secretKey, err := resolveTencentCredentials(cfg)
	if err != nil {
		return FailureNotificationResult{}, err
	}
	client := TencentClient{SecretID: secretID, SecretKey: secretKey, Region: region}
	subject, htmlBody, textBody := buildFailureNotificationContent(notification)
	result := FailureNotificationResult{Recipients: recipients}
	for _, recipient := range recipients {
		resp, err := client.Call(ctx, defaultSESEndpoint, defaultSESVersion, "SendEmail", map[string]any{
			"FromEmailAddress": from,
			"Subject":          subject,
			"Destination":      []string{recipient},
			"Simple": map[string]string{
				"Html": base64.StdEncoding.EncodeToString([]byte(htmlBody)),
				"Text": base64.StdEncoding.EncodeToString([]byte(textBody)),
			},
		}, false)
		if err != nil {
			return result, err
		}
		result.Sent = true
		result.MessageIDs = append(result.MessageIDs, stringValue(resp["MessageId"]))
		result.RequestIDs = append(result.RequestIDs, stringValue(resp["RequestId"]))
	}
	return result, nil
}

func failureNotificationRecipients(req ExportRequest) []string {
	values := append([]string{}, req.NotificationEmails...)
	values = append(values, req.NotificationEmail, req.NotifyEmail)
	values = append(values, os.Getenv("RESCUE_EXPORT_FAILURE_EMAIL_TO"), os.Getenv("RESCUE_EXPORT_NOTIFY_EMAILS"))
	seen := map[string]bool{}
	recipients := []string{}
	for _, value := range values {
		for _, item := range strings.Split(value, ",") {
			item = strings.TrimSpace(item)
			if item == "" || seen[strings.ToLower(item)] {
				continue
			}
			if _, err := mail.ParseAddress(item); err != nil {
				continue
			}
			seen[strings.ToLower(item)] = true
			recipients = append(recipients, item)
		}
	}
	return recipients
}

func buildFailureNotificationContent(notification FailureNotification) (subject string, htmlBody string, textBody string) {
	req := notification.Request
	status := notification.Status
	phase := status.Phase
	if phase == "" {
		phase = PhaseFailed
	}
	errText := strings.TrimSpace(notification.Error)
	if errText == "" {
		errText = strings.TrimSpace(status.Error)
	}
	subject = fmt.Sprintf("[LightVela] Rescue export failed: %s", req.InstanceID)
	lines := []string{
		"Rescue export failed.",
		"",
		"Instance: " + req.InstanceID,
		"Region: " + firstNonEmpty(status.Instance.Region, req.Region),
		"Phase: " + phase,
		"Workflow ID: " + notification.WorkflowID,
		"Run ID: " + notification.RunID,
		"Remote paths: " + strings.Join(req.RemotePaths, ", "),
		"Error: " + errText,
	}
	textBody = strings.Join(lines, "\n")
	htmlBody = fmt.Sprintf(`<html><body style="font-family:sans-serif;line-height:1.6;color:#333">
<p>Rescue export failed.</p>
<table cellpadding="6" cellspacing="0" style="border-collapse:collapse">
<tr><td><b>Instance</b></td><td>%s</td></tr>
<tr><td><b>Region</b></td><td>%s</td></tr>
<tr><td><b>Phase</b></td><td>%s</td></tr>
<tr><td><b>Workflow ID</b></td><td>%s</td></tr>
<tr><td><b>Run ID</b></td><td>%s</td></tr>
<tr><td><b>Remote paths</b></td><td>%s</td></tr>
</table>
<p><b>Error</b></p>
<pre style="white-space:pre-wrap;background:#f6f7f8;padding:12px;border-radius:6px">%s</pre>
</body></html>`,
		html.EscapeString(req.InstanceID),
		html.EscapeString(firstNonEmpty(status.Instance.Region, req.Region)),
		html.EscapeString(phase),
		html.EscapeString(notification.WorkflowID),
		html.EscapeString(notification.RunID),
		html.EscapeString(strings.Join(req.RemotePaths, ", ")),
		html.EscapeString(errText),
	)
	return subject, htmlBody, textBody
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
