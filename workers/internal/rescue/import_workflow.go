package rescue

import (
	"strings"
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

func ImportWorkflow(ctx workflow.Context, req ImportRequest, cfg TencentConfig) (ImportResult, error) {
	req = NormalizeImportRequest(req)
	result := ImportResult{DryRun: !req.Execute}
	status, err := InitImportStatus(ctx, req)
	if err != nil {
		return result, err
	}
	finish := func(err error) (ImportResult, error) {
		completeImportWorkflowStatus(ctx, req, status, result, err)
		if err != nil {
			notifyImportFailure(ctx, req, cfg, status, err)
		}
		return result, err
	}

	short := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 5 * time.Minute,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 3},
	})
	exportReq := req.exportRequest()
	var instance InstanceInfo
	if err := workflow.ExecuteActivity(short, "LocateInstance", exportReq, cfg).Get(short, &instance); err != nil {
		return finish(err)
	}
	result.Instance = instance
	status.Instance = instance

	updateImportWorkflowPhase(ctx, req, status, PhaseWaitRemoteAccess)
	waitRemoteCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: time.Duration(req.WaitTimeoutSeconds+60) * time.Second,
		HeartbeatTimeout:    30 * time.Second,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 1},
	})
	if err := workflow.ExecuteActivity(waitRemoteCtx, "WaitRescueTAT", exportReq, cfg, instance.Region).Get(waitRemoteCtx, nil); err != nil {
		return finish(err)
	}

	updateImportWorkflowPhase(ctx, req, status, PhasePrepareImport)
	prepareCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 5 * time.Minute,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 1},
	})
	var prepared PreparedImport
	if err := workflow.ExecuteActivity(prepareCtx, "PrepareImportTATCommand", req, cfg, instance.Region).Get(prepareCtx, &prepared); err != nil {
		return finish(err)
	}
	updateImportObjectVisibility(ctx, req, status, prepared)
	result.Import = prepared

	updateImportWorkflowPhase(ctx, req, status, PhaseStartTAT)
	startCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 5 * time.Minute,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 1},
	})
	var submitted TATCommandResult
	if err := workflow.ExecuteActivity(startCtx, "StartTATCommand", exportReq, cfg, instance.Region, prepared.Command).Get(startCtx, &submitted); err != nil {
		cleanupImportObject(ctx, req, cfg, status, &result)
		return finish(err)
	}
	result.TATCommand = submitted
	status.TATCommand = submitted

	updateImportWorkflowPhase(ctx, req, status, PhaseWaitTAT)
	waitTATCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: time.Duration(req.CommandTimeoutSeconds+300) * time.Second,
		HeartbeatTimeout:    30 * time.Second,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 1},
	})
	var workflowErr error
	workflowErr = workflow.ExecuteActivity(waitTATCtx, "WaitTATCommand", exportReq, cfg, instance.Region, submitted).Get(waitTATCtx, &submitted)
	result.TATCommand = submitted
	status.TATCommand = submitted
	if workflowErr == nil {
		updateImportWorkflowPhase(ctx, req, status, PhaseFinalizeImport)
		finalizeCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
			StartToCloseTimeout: 2 * time.Minute,
			RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 1},
		})
		workflowErr = workflow.ExecuteActivity(finalizeCtx, "FinalizeImportOverTAT", req, prepared, submitted).Get(finalizeCtx, &result.Import)
	}
	cleanupErr := cleanupImportObject(ctx, req, cfg, status, &result)
	if workflowErr != nil {
		return finish(workflowErr)
	}
	if cleanupErr != nil {
		return finish(cleanupErr)
	}
	if emailResult, err := maybeSendImportNotification(ctx, req, status, &result); err != nil {
		return finish(err)
	} else if emailResult.MessageID != "" {
		result.NotificationEmail = emailResult.ToEmail
		result.EmailMessageID = emailResult.MessageID
		result.EmailDelivered = emailResult.EmailDelivered
		result.EmailDeliverStatus = emailResult.DeliverStatus
		result.EmailDeliverMessage = emailResult.DeliverMessage
		status.NotificationEmail = emailResult.ToEmail
		status.EmailMessageID = emailResult.MessageID
		status.EmailDelivered = emailResult.EmailDelivered
		status.EmailDeliverStatus = emailResult.DeliverStatus
		status.EmailDeliverMessage = emailResult.DeliverMessage
	}
	return finish(nil)
}

func maybeSendImportNotification(ctx workflow.Context, req ImportRequest, status *ImportStatus, result *ImportResult) (EmailNotificationResult, error) {
	empty := EmailNotificationResult{}
	toEmail := notificationEmail(req.exportRequest())
	if toEmail == "" {
		return empty, nil
	}
	updateImportWorkflowPhase(ctx, req, status, PhaseNotifyEmail)
	notifyCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 2 * time.Minute,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 3},
	})
	var emailResult EmailNotificationResult
	if err := workflow.ExecuteActivity(notifyCtx, "SendImportNotificationEmail", req).Get(notifyCtx, &emailResult); err != nil {
		return empty, err
	}
	if strings.TrimSpace(emailResult.MessageID) == "" {
		return emailResult, nil
	}
	updateImportWorkflowPhase(ctx, req, status, PhaseConfirmEmailDelivery)
	confirmCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 12 * time.Minute,
		HeartbeatTimeout:    30 * time.Second,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 1},
	})
	var delivered EmailNotificationResult
	if err := workflow.ExecuteActivity(confirmCtx, "ConfirmExportNotificationDelivered", req.exportRequest(), emailResult).Get(confirmCtx, &delivered); err != nil {
		return empty, err
	}
	delivered.ToEmail = emailResult.ToEmail
	if delivered.MessageID == "" {
		delivered.MessageID = emailResult.MessageID
	}
	result.NotificationEmail = delivered.ToEmail
	result.EmailMessageID = delivered.MessageID
	result.EmailDelivered = delivered.EmailDelivered
	result.EmailDeliverStatus = delivered.DeliverStatus
	result.EmailDeliverMessage = delivered.DeliverMessage
	return delivered, nil
}

func notifyImportFailure(ctx workflow.Context, req ImportRequest, cfg TencentConfig, status *ImportStatus, workflowErr error) {
	notifyCtx := cleanupActivityContext(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Second,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 1},
	})
	exportReq := req.exportRequest()
	notification := FailureNotification{
		WorkflowID: workflow.GetInfo(ctx).WorkflowExecution.ID,
		RunID:      workflow.GetInfo(ctx).WorkflowExecution.RunID,
		Operation:  "import",
		Request:    exportReq,
		Status: ExportStatus{
			WorkflowID: status.WorkflowID,
			RunID:      status.RunID,
			Phase:      status.Phase,
			Instance:   status.Instance,
			Error:      status.Error,
			DryRun:     status.DryRun,
			Logs:       status.Logs,
		},
		Error: workflowErr.Error(),
	}
	var sent FailureNotificationResult
	if err := workflow.ExecuteActivity(notifyCtx, "SendFailureNotification", notification, cfg).Get(notifyCtx, &sent); err != nil {
		workflow.GetLogger(ctx).Warn("failed to send Hermes import failure notification", "error", err, "instance_id", req.InstanceID)
		return
	}
	if sent.Sent {
		workflow.GetLogger(ctx).Info("Hermes import failure notification sent", "instance_id", req.InstanceID, "recipients", sent.Recipients)
	}
}

func cleanupImportObject(ctx workflow.Context, req ImportRequest, cfg TencentConfig, status *ImportStatus, result *ImportResult) error {
	if strings.TrimSpace(req.ImportObjectKey) == "" || strings.TrimSpace(req.COSUploadBucket) == "" {
		return nil
	}
	updateImportWorkflowPhase(ctx, req, status, PhaseCleanupImportObject)
	cleanupCtx := cleanupActivityContext(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 5 * time.Minute,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 3},
	})
	deleteReq := COSDeleteRequest{
		InstanceID:   req.InstanceID,
		BucketURL:    req.COSUploadBucket,
		BucketRegion: req.COSUploadRegion,
		ObjectKey:    req.ImportObjectKey,
		ObjectURL:    req.ImportObjectURL,
		DelaySeconds: 0,
		WorkflowID:   workflow.GetInfo(ctx).WorkflowExecution.ID,
	}
	var deleteResult COSDeleteResult
	err := workflow.ExecuteActivity(cleanupCtx, "DeleteCOSObject", deleteReq, cfg).Get(cleanupCtx, &deleteResult)
	result.COSDeleted = deleteResult.Deleted
	updateImportCleanupVisibility(ctx, req, status, deleteResult.Deleted)
	return err
}
