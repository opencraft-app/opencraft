package rescue

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	sesEndpoint = "ses.tencentcloudapi.com"
	sesVersion  = "2020-10-02"
)

type SESConfig struct {
	Region           string
	FromEmailAddress string
}

const (
	sesDeliverStatusSuccess  = 1
	sesDeliverStatusDropped  = 2
	sesDeliverStatusRejected = 3
)

type EmailNotificationResult struct {
	MessageID      string
	ToEmail        string
	DryRun         bool
	DeliverStatus  int
	DeliverMessage string
	DeliverTime    int64
	EmailDelivered bool
}

func sesDeliveryTimeout() time.Duration {
	raw := strings.TrimSpace(os.Getenv("RESCUE_EXPORT_SES_DELIVERY_TIMEOUT_SECONDS"))
	if raw == "" {
		return 10 * time.Minute
	}
	seconds, err := strconv.Atoi(raw)
	if err != nil || seconds <= 0 {
		return 10 * time.Minute
	}
	return time.Duration(seconds) * time.Second
}

func sesDeliveryPollInterval() time.Duration {
	raw := strings.TrimSpace(os.Getenv("RESCUE_EXPORT_SES_DELIVERY_POLL_SECONDS"))
	if raw == "" {
		return 15 * time.Second
	}
	seconds, err := strconv.Atoi(raw)
	if err != nil || seconds <= 0 {
		return 15 * time.Second
	}
	return time.Duration(seconds) * time.Second
}

func LoadSESConfig() SESConfig {
	from := strings.TrimSpace(os.Getenv("RESCUE_EXPORT_SES_FROM"))
	if from == "" {
		from = "LightVela <noreply@service.lightvela.com>"
	}
	region := strings.TrimSpace(os.Getenv("RESCUE_EXPORT_SES_REGION"))
	if region == "" {
		region = "ap-guangzhou"
	}
	return SESConfig{Region: region, FromEmailAddress: from}
}

func notificationEmail(req ExportRequest) string {
	if email := strings.TrimSpace(req.NotificationEmail); email != "" {
		return email
	}
	return strings.TrimSpace(req.NotifyEmail)
}

func buildExportNotificationContent(req ExportRequest, downloadURL string, ttlSeconds int) (subject, html, text string) {
	data := exportSuccessEmailTemplateData{
		AgentLabel:  exportAgentLabel(req),
		DownloadURL: downloadURL,
		TTLLabel:    formatDownloadTTLLabel(ttlSeconds),
	}
	return renderRescueTextTemplate("export_success.subject", data),
		renderRescueHTMLTemplate("export_success.html", data),
		renderRescueTextTemplate("export_success.txt", data)
}

func formatDownloadTTLLabel(seconds int) string {
	if seconds <= 0 {
		seconds = 28800
	}
	hours := seconds / 3600
	if hours*3600 == seconds {
		if hours == 1 {
			return "1 小时"
		}
		return fmt.Sprintf("%d 小时", hours)
	}
	return fmt.Sprintf("%d 秒", seconds)
}

func exportAgentLabel(req ExportRequest) string {
	if value := strings.TrimSpace(req.BotName); value != "" {
		return value
	}
	if value := strings.TrimSpace(req.BotID); value != "" {
		return value
	}
	return "当前 Agent"
}

func deliverExportNotificationEmail(ctx context.Context, cfg TencentConfig, sesCfg SESConfig, toEmail, subject, htmlBody, textBody string, dryRun bool) (EmailNotificationResult, error) {
	toEmail = strings.TrimSpace(toEmail)
	if toEmail == "" {
		return EmailNotificationResult{}, temporalActivityError(fmt.Errorf("notification email address is empty"))
	}
	result := EmailNotificationResult{ToEmail: toEmail, DryRun: dryRun}
	if dryRun {
		fmt.Printf("[dry-run] would send export notification email to=%s subject=%q\n", toEmail, subject)
		result.MessageID = "dry-run-message-id"
		return result, nil
	}
	secretID, secretKey, err := resolveTencentCredentials(cfg)
	if err != nil {
		return EmailNotificationResult{}, temporalActivityError(err)
	}
	client := TencentClient{SecretID: secretID, SecretKey: secretKey, Region: sesCfg.Region}
	resp, err := client.SES(ctx, "SendEmail", map[string]any{
		"FromEmailAddress": sesCfg.FromEmailAddress,
		"Subject":          subject,
		"Destination":      []string{toEmail},
		"Simple": map[string]any{
			"Html": base64.StdEncoding.EncodeToString([]byte(htmlBody)),
			"Text": base64.StdEncoding.EncodeToString([]byte(textBody)),
		},
	}, false)
	if err != nil {
		return EmailNotificationResult{}, temporalActivityError(err)
	}
	result.MessageID = stringValue(resp["MessageId"])
	if result.MessageID == "" {
		return EmailNotificationResult{}, temporalActivityError(fmt.Errorf("SendEmail returned empty MessageId"))
	}
	fmt.Printf("[rescue] export notification email sent to=%s message_id=%s\n", toEmail, result.MessageID)
	return result, nil
}

func confirmExportNotificationDelivered(ctx context.Context, cfg TencentConfig, sesCfg SESConfig, sent EmailNotificationResult, dryRun bool) (EmailNotificationResult, error) {
	result := sent
	if dryRun {
		result.DeliverStatus = sesDeliverStatusSuccess
		result.EmailDelivered = true
		fmt.Printf("[dry-run] would confirm export notification delivery message_id=%s to=%s\n", sent.MessageID, sent.ToEmail)
		return result, nil
	}
	if strings.TrimSpace(sent.MessageID) == "" {
		return EmailNotificationResult{}, temporalActivityError(fmt.Errorf("cannot confirm delivery without MessageId"))
	}
	secretID, secretKey, err := resolveTencentCredentials(cfg)
	if err != nil {
		return EmailNotificationResult{}, temporalActivityError(err)
	}
	client := TencentClient{SecretID: secretID, SecretKey: secretKey, Region: sesCfg.Region}
	requestDate := sesRequestDateFromMessageID(sent.MessageID)
	deadline := time.Now().Add(sesDeliveryTimeout())
	poll := sesDeliveryPollInterval()
	var last EmailNotificationResult
	for time.Now().Before(deadline) {
		if err := ctx.Err(); err != nil {
			return last, err
		}
		status, err := querySESDeliveryStatus(ctx, client, requestDate, sent.MessageID, sent.ToEmail)
		if err != nil {
			return last, temporalActivityError(err)
		}
		last = status
		recordHeartbeat(ctx, map[string]string{
			"kind":           "ses-delivery",
			"message_id":     sent.MessageID,
			"to":             sent.ToEmail,
			"deliver_status": strconv.Itoa(status.DeliverStatus),
		})
		fmt.Printf("[rescue] ses delivery status message_id=%s to=%s deliver_status=%d message=%q\n",
			sent.MessageID, sent.ToEmail, status.DeliverStatus, status.DeliverMessage)
		switch status.DeliverStatus {
		case sesDeliverStatusSuccess:
			status.EmailDelivered = true
			fmt.Printf("[rescue] export notification delivered message_id=%s to=%s deliver_time=%d\n",
				sent.MessageID, sent.ToEmail, status.DeliverTime)
			return status, nil
		case sesDeliverStatusDropped, sesDeliverStatusRejected:
			return status, temporalActivityError(fmt.Errorf("email delivery failed deliver_status=%d message=%s",
				status.DeliverStatus, status.DeliverMessage))
		}
		if err := sleepContext(ctx, poll); err != nil {
			return last, err
		}
	}
	return last, temporalActivityError(fmt.Errorf("timed out waiting for SES delivery message_id=%s to=%s last_deliver_status=%d message=%s",
		sent.MessageID, sent.ToEmail, last.DeliverStatus, last.DeliverMessage))
}

func querySESDeliveryStatus(ctx context.Context, client TencentClient, requestDate, messageID, toEmail string) (EmailNotificationResult, error) {
	payload := map[string]any{
		"RequestDate": requestDate,
		"Offset":      0,
		"Limit":       10,
		"MessageId":   messageID,
	}
	if strings.TrimSpace(toEmail) != "" {
		payload["ToEmailAddress"] = strings.TrimSpace(toEmail)
	}
	resp, err := client.SES(ctx, "GetSendEmailStatus", payload, false)
	if err != nil {
		return EmailNotificationResult{}, err
	}
	list, _ := resp["EmailStatusList"].([]any)
	for _, item := range list {
		raw, _ := item.(map[string]any)
		if raw == nil {
			continue
		}
		if id := stringValue(raw["MessageId"]); id != "" && id != messageID {
			continue
		}
		return EmailNotificationResult{
			MessageID:      stringValue(raw["MessageId"]),
			ToEmail:        stringValue(raw["ToEmailAddress"]),
			DeliverStatus:  int(numberValue(raw["DeliverStatus"])),
			DeliverMessage: stringValue(raw["DeliverMessage"]),
			DeliverTime:    int64(numberValue(raw["DeliverTime"])),
		}, nil
	}
	return EmailNotificationResult{MessageID: messageID, ToEmail: toEmail, DeliverStatus: -1}, nil
}

func sesRequestDateFromMessageID(messageID string) string {
	const marker = "-date-"
	idx := strings.Index(messageID, marker)
	if idx < 0 {
		return time.Now().Format("2006-01-02")
	}
	rest := messageID[idx+len(marker):]
	if len(rest) < 8 {
		return time.Now().Format("2006-01-02")
	}
	ts := rest[:8]
	if t, err := time.Parse("20060102", ts); err == nil {
		return t.Format("2006-01-02")
	}
	return time.Now().Format("2006-01-02")
}

func numberValue(raw any) float64 {
	switch v := raw.(type) {
	case float64:
		return v
	case int:
		return float64(v)
	case int64:
		return float64(v)
	default:
		return 0
	}
}

func (c TencentClient) SES(ctx context.Context, action string, payload map[string]any, dryRun bool) (map[string]any, error) {
	return c.Call(ctx, sesEndpoint, sesVersion, action, payload, dryRun)
}
