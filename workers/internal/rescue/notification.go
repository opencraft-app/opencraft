package rescue

import (
	"context"
	"encoding/base64"
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
	Operation  string
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
	errText := strings.TrimSpace(notification.Error)
	if errText == "" {
		errText = strings.TrimSpace(status.Error)
	}
	operation := strings.TrimSpace(notification.Operation)
	if operation == "" {
		operation = "export"
	}
	reason := productFailureReasonForOperation(errText, operation)
	agentLabel := exportAgentLabel(req)
	if operation == "import" {
		data := importFailureEmailTemplateData{
			AgentLabel: agentLabel,
			Reason:     reason,
		}
		return renderRescueTextTemplate("import_failure.subject", data),
			renderRescueHTMLTemplate("import_failure.html", data),
			renderRescueTextTemplate("import_failure.txt", data)
	}
	remotePaths := strings.Join(req.RemotePaths, ", ")
	if strings.TrimSpace(remotePaths) == "" {
		remotePaths = "/home/agentuser/.hermes"
	}
	data := exportFailureEmailTemplateData{
		AgentLabel:  agentLabel,
		RemotePaths: remotePaths,
		Reason:      reason,
	}
	return renderRescueTextTemplate("export_failure.subject", data),
		renderRescueHTMLTemplate("export_failure.html", data),
		renderRescueTextTemplate("export_failure.txt", data)
}

func productFailureReason(errText string) string {
	return productFailureReasonForOperation(errText, "export")
}

func productFailureReasonForOperation(errText string, operation string) string {
	cleaned := strings.TrimSpace(errText)
	actionText := "导出"
	serviceText := "导出服务"
	if operation == "import" {
		actionText = "导入"
		serviceText = "恢复服务"
	}
	if cleaned == "" {
		return actionText + "过程中遇到异常，请稍后重试。"
	}
	switch {
	case strings.Contains(cleaned, "ResourceUnavailable.SnapshotCreating"):
		return "云盘快照正在处理中，当前无法完成导出准备。请等待快照任务完成后再重试。"
	case strings.Contains(cleaned, "Request unauthorized"), strings.Contains(cleaned, "PermissionDenied"):
		return serviceText + "鉴权未通过，请稍后重试；如果仍然失败，请联系支持处理。"
	case strings.Contains(cleaned, "AuthFailure"), strings.Contains(cleaned, "UnauthorizedOperation"):
		return "云账号权限暂时不可用，请联系支持确认云资源授权。"
	case strings.Contains(cleaned, "ResourceNotFound"):
		return "未找到需要处理的运行环境，请确认 Agent 状态后重试。"
	case strings.Contains(cleaned, "hermes command is not available"), strings.Contains(cleaned, "command not found"):
		return "目标 Agent 的 Hermes 运行环境不可用，请稍后重试；如果仍然失败，请联系支持处理。"
	case strings.Contains(cleaned, "uploaded archive is empty"), strings.Contains(cleaned, "bad zip member"), strings.Contains(cleaned, "Not a valid zip"):
		return "导入包无法识别或已损坏，请重新选择 Hermes 导出的 zip 文件后再试。"
	case strings.Contains(cleaned, "Aborted."):
		return "目标工作区已有数据，导入未能继续。请重新发起导入任务。"
	}
	cleaned = stripBeforeLastMarker(cleaned, "): ")
	cleaned = stripBeforeLastMarker(cleaned, "] ")
	for _, marker := range []string{" (type:", ", retryable:", " scheduledEventID:", " startedEventID:", " identity:"} {
		if index := strings.Index(cleaned, marker); index >= 0 {
			cleaned = strings.TrimSpace(cleaned[:index])
		}
	}
	cleaned = strings.ReplaceAll(cleaned, "cvm.tencentcloudapi.com", "云服务")
	cleaned = strings.TrimSpace(cleaned)
	if cleaned == "" {
		return actionText + "过程中遇到异常，请稍后重试。"
	}
	if len([]rune(cleaned)) > 140 {
		runes := []rune(cleaned)
		cleaned = string(runes[:140]) + "..."
	}
	return cleaned
}

func stripBeforeLastMarker(value string, marker string) string {
	if index := strings.LastIndex(value, marker); index >= 0 {
		return strings.TrimSpace(value[index+len(marker):])
	}
	return value
}
