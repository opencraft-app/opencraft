package rescue

import (
	"strings"
	"time"

	"go.temporal.io/sdk/workflow"
)

const ExportStatusQuery = "status"

const (
	PhaseLocating             = "locating"
	PhaseEnterRescue          = "enter_rescue"
	PhaseWaitRescue           = "wait_rescue"
	PhaseWaitRemoteAccess     = "wait_remote_access"
	PhasePrepareArchive       = "prepare_archive"
	PhaseStartTAT             = "start_tat"
	PhaseWaitTAT              = "wait_tat"
	PhaseFinalizeArchive      = "finalize_archive"
	PhaseCopyArchive          = "copy_archive"
	PhaseScheduleDelete       = "schedule_delete"
	PhaseNotifyEmail          = "notify_email"
	PhaseConfirmEmailDelivery = "confirm_email_delivery"
	PhaseCleanupRemote        = "cleanup_remote"
	PhaseExitRescue           = "exit_rescue"
	PhaseWaitRunning          = "wait_running"
	PhaseCompleted            = "completed"
	PhaseFailed               = "failed"
)

const (
	SearchAttrInstanceID       = "RescueInstanceId"
	SearchAttrRegion           = "RescueRegion"
	SearchAttrPhase            = "RescuePhase"
	SearchAttrObjectKey        = "RescueObjectKey"
	SearchAttrDeleteWorkflowID = "RescueDeleteWorkflowId"
	SearchAttrExitedRescue     = "RescueExitedRescue"
	SearchAttrExpiresAt        = "RescueExpiresAt"
)

const maxExportStatusLogs = 80

func RescueSearchAttributeNames() []string {
	return []string{
		SearchAttrInstanceID,
		SearchAttrRegion,
		SearchAttrPhase,
		SearchAttrObjectKey,
		SearchAttrDeleteWorkflowID,
		SearchAttrExitedRescue,
		SearchAttrExpiresAt,
	}
}

func InitExportStatus(ctx workflow.Context, req ExportRequest) (*ExportStatus, error) {
	info := workflow.GetInfo(ctx)
	status := &ExportStatus{
		WorkflowID: info.WorkflowExecution.ID,
		RunID:      info.WorkflowExecution.RunID,
		Phase:      PhaseLocating,
		DryRun:     !req.Execute,
	}
	if err := workflow.SetQueryHandler(ctx, ExportStatusQuery, func() (ExportStatus, error) {
		return *status, nil
	}); err != nil {
		return status, err
	}
	updateWorkflowPhase(ctx, req, status, PhaseLocating)
	return status, nil
}

func updateWorkflowPhase(ctx workflow.Context, req ExportRequest, status *ExportStatus, phase string) {
	status.Phase = phase
	appendExportStatusLog(ctx, status, phase, phaseStatusMessage(phase, status.DryRun), "info")
	workflow.GetLogger(ctx).Info("rescue workflow phase", "phase", phase, "instance_id", req.InstanceID, "region", status.Instance.Region)
	upsertRescueSearchAttributes(ctx, req, map[string]interface{}{
		SearchAttrInstanceID: req.InstanceID,
		SearchAttrRegion:     status.Instance.Region,
		SearchAttrPhase:      phase,
	})
}

func completeWorkflowStatus(ctx workflow.Context, req ExportRequest, status *ExportStatus, result ExportResult, err error) {
	status.Instance = result.Instance
	status.Archive = result.Archive
	status.SCP = result.SCP
	status.ExitedRescue = result.ExitedRescue
	status.COSDeleteWorkflowID = result.COSDeleteWorkflowID
	status.COSDeleteAfterSeconds = result.COSDeleteAfterSeconds
	status.NotificationEmail = result.NotificationEmail
	status.EmailMessageID = result.EmailMessageID
	status.EmailDelivered = result.EmailDelivered
	status.EmailDeliverStatus = result.EmailDeliverStatus
	status.EmailDeliverMessage = result.EmailDeliverMessage
	status.DryRun = result.DryRun
	if err != nil {
		status.Phase = PhaseFailed
		status.Error = productFailureReason(err.Error())
		appendExportStatusLog(ctx, status, PhaseFailed, status.Error, "error")
	} else {
		status.Phase = PhaseCompleted
		appendExportStatusLog(ctx, status, PhaseCompleted, phaseStatusMessage(PhaseCompleted, status.DryRun), "success")
	}
	upsertRescueSearchAttributes(ctx, req, map[string]interface{}{
		SearchAttrInstanceID:       req.InstanceID,
		SearchAttrRegion:           result.Instance.Region,
		SearchAttrPhase:            status.Phase,
		SearchAttrObjectKey:        result.Archive.ObjectKey,
		SearchAttrDeleteWorkflowID: result.COSDeleteWorkflowID,
		SearchAttrExitedRescue:     result.ExitedRescue,
	})
}

func updateArchiveVisibility(ctx workflow.Context, req ExportRequest, status *ExportStatus, archive PreparedArchive) {
	status.Archive = archive
	if strings.TrimSpace(archive.ObjectURL) != "" {
		appendExportStatusLog(ctx, status, PhaseCopyArchive, "导出包已上传，下载链接将通过邮件发送。", "success")
	} else if strings.TrimSpace(archive.ObjectKey) != "" {
		appendExportStatusLog(ctx, status, PhaseCopyArchive, "导出包已写入对象存储，正在准备通知。", "info")
	}
	attrs := map[string]interface{}{
		SearchAttrObjectKey: archive.ObjectKey,
	}
	if archive.ObjectKey != "" {
		attrs[SearchAttrExpiresAt] = workflow.Now(ctx).Add(time.Duration(cosURLTTLSeconds(req)) * time.Second)
	}
	upsertRescueSearchAttributes(ctx, req, attrs)
}

func updateDeleteVisibility(ctx workflow.Context, req ExportRequest, status *ExportStatus, workflowID string, delaySeconds int) {
	status.COSDeleteWorkflowID = workflowID
	status.COSDeleteAfterSeconds = delaySeconds
	appendExportStatusLog(ctx, status, PhaseScheduleDelete, "已安排临时导出包自动清理。", "info")
	upsertRescueSearchAttributes(ctx, req, map[string]interface{}{
		SearchAttrDeleteWorkflowID: workflowID,
	})
}

func appendExportStatusLog(ctx workflow.Context, status *ExportStatus, phase string, message string, level string) {
	message = strings.TrimSpace(message)
	if message == "" {
		return
	}
	status.Logs = append(status.Logs, ExportStatusLog{
		Time:    workflow.Now(ctx).Format(time.RFC3339),
		Phase:   phase,
		Message: message,
		Level:   level,
	})
	if len(status.Logs) > maxExportStatusLogs {
		status.Logs = status.Logs[len(status.Logs)-maxExportStatusLogs:]
	}
}

func phaseStatusMessage(phase string, dryRun bool) string {
	if dryRun {
		switch phase {
		case PhaseLocating:
			return "正在检查 Agent 导出配置。"
		case PhaseCompleted:
			return "检查完成，当前配置可以发起导出。"
		}
	}
	switch phase {
	case PhaseLocating:
		return "正在定位 Agent 运行环境。"
	case PhaseEnterRescue:
		return "正在准备导出环境。"
	case PhaseWaitRescue:
		return "正在等待导出环境就绪。"
	case PhaseWaitRemoteAccess:
		return "正在等待远程命令通道可用。"
	case PhasePrepareArchive:
		return "正在准备工作区导出包。"
	case PhaseStartTAT:
		return "正在下发导出命令。"
	case PhaseWaitTAT:
		return "导出命令执行中。"
	case PhaseFinalizeArchive:
		return "正在完成导出包打包。"
	case PhaseCopyArchive:
		return "正在上传导出包。"
	case PhaseScheduleDelete:
		return "正在安排临时文件自动清理。"
	case PhaseNotifyEmail:
		return "正在发送导出结果邮件。"
	case PhaseConfirmEmailDelivery:
		return "正在确认邮件投递状态。"
	case PhaseCleanupRemote:
		return "正在清理远端临时文件。"
	case PhaseExitRescue:
		return "正在退出导出环境。"
	case PhaseWaitRunning:
		return "正在等待 Agent 恢复运行。"
	case PhaseCompleted:
		return "导出完成，结果已发送到绑定邮箱。"
	case PhaseFailed:
		return "导出未完成。"
	default:
		return "导出任务处理中。"
	}
}

func upsertRescueSearchAttributes(ctx workflow.Context, req ExportRequest, attrs map[string]interface{}) {
	filtered := map[string]interface{}{}
	for key, value := range attrs {
		if value == nil || value == "" {
			continue
		}
		if searchAttributeEnabled(req, key) {
			filtered[key] = value
		}
	}
	if len(filtered) == 0 {
		return
	}
	if err := workflow.UpsertSearchAttributes(ctx, filtered); err != nil {
		workflow.GetLogger(ctx).Warn("failed to upsert search attributes", "error", err, "keys", searchAttributeKeys(filtered))
	}
}

func searchAttributeEnabled(req ExportRequest, key string) bool {
	for _, enabled := range req.SearchAttributes {
		if enabled == key {
			return true
		}
	}
	return false
}

func searchAttributeKeys(attrs map[string]interface{}) []string {
	keys := make([]string, 0, len(attrs))
	for key := range attrs {
		keys = append(keys, key)
	}
	return keys
}
