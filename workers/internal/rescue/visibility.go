package rescue

import (
	"time"

	"go.temporal.io/sdk/workflow"
)

const ExportStatusQuery = "status"

const (
	PhaseLocating         = "locating"
	PhaseBackup           = "backup"
	PhaseEnterRescue      = "enter_rescue"
	PhaseWaitRescue       = "wait_rescue"
	PhaseWaitRemoteAccess = "wait_remote_access"
	PhasePrepareArchive   = "prepare_archive"
	PhaseStartTAT         = "start_tat"
	PhaseWaitTAT          = "wait_tat"
	PhaseFinalizeArchive  = "finalize_archive"
	PhaseCopyArchive      = "copy_archive"
	PhaseScheduleDelete   = "schedule_delete"
	PhaseCleanupRemote    = "cleanup_remote"
	PhaseExitRescue       = "exit_rescue"
	PhaseWaitRunning      = "wait_running"
	PhaseCompleted        = "completed"
	PhaseFailed           = "failed"
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
	workflow.GetLogger(ctx).Info("rescue workflow phase", "phase", phase, "instance_id", req.InstanceID, "region", status.Instance.Region)
	upsertRescueSearchAttributes(ctx, req, map[string]interface{}{
		SearchAttrInstanceID: req.InstanceID,
		SearchAttrRegion:     status.Instance.Region,
		SearchAttrPhase:      phase,
	})
}

func completeWorkflowStatus(ctx workflow.Context, req ExportRequest, status *ExportStatus, result ExportResult, err error) {
	status.Instance = result.Instance
	status.Backup = result.Backup
	status.Archive = result.Archive
	status.SCP = result.SCP
	status.ExitedRescue = result.ExitedRescue
	status.COSDeleteWorkflowID = result.COSDeleteWorkflowID
	status.COSDeleteAfterSeconds = result.COSDeleteAfterSeconds
	status.DryRun = result.DryRun
	if err != nil {
		status.Phase = PhaseFailed
		status.Error = err.Error()
	} else {
		status.Phase = PhaseCompleted
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
	upsertRescueSearchAttributes(ctx, req, map[string]interface{}{
		SearchAttrDeleteWorkflowID: workflowID,
	})
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
