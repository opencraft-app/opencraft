package rescue

import (
	"strings"
	"time"

	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

func ExportWorkflow(ctx workflow.Context, req ExportRequest, cfg TencentConfig) (ExportResult, error) {
	retry := &temporal.RetryPolicy{MaximumAttempts: 3}
	result := ExportResult{DryRun: !req.Execute}
	status, err := InitExportStatus(ctx, req)
	if err != nil {
		return result, err
	}
	finish := func(err error) (ExportResult, error) {
		completeWorkflowStatus(ctx, req, status, result, err)
		return result, err
	}

	short := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 5 * time.Minute,
		RetryPolicy:         retry,
	})
	var instance InstanceInfo
	if err := workflow.ExecuteActivity(short, "LocateInstance", req, cfg).Get(short, &instance); err != nil {
		return finish(err)
	}
	result.Instance = instance
	status.Instance = instance
	updateWorkflowPhase(ctx, req, status, PhaseBackup)

	backupCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 50 * time.Minute,
		HeartbeatTimeout:    30 * time.Second,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 1},
	})
	if err := workflow.ExecuteActivity(backupCtx, "EnsureBackup", req, cfg, instance.Region).Get(backupCtx, &result.Backup); err != nil {
		return finish(err)
	}
	status.Backup = result.Backup

	if instance.State == "RESCUE_MODE" && req.ReenterRescue {
		updateWorkflowPhase(ctx, req, status, PhaseExitRescue)
		if err := workflow.ExecuteActivity(short, "ExitRescueMode", req, cfg, instance.Region).Get(short, nil); err != nil {
			return finish(err)
		}
		updateWorkflowPhase(ctx, req, status, PhaseWaitRunning)
		waitNormalCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
			StartToCloseTimeout: time.Duration(req.WaitTimeoutSeconds+60) * time.Second,
			HeartbeatTimeout:    30 * time.Second,
			RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 1},
		})
		var ignored string
		if err := workflow.ExecuteActivity(waitNormalCtx, "WaitInstanceRunning", req, cfg, instance.Region).Get(waitNormalCtx, &ignored); err != nil {
			return finish(err)
		}
	}

	rescueMayBeEntered := false
	var workflowErr error
	updateWorkflowPhase(ctx, req, status, PhaseEnterRescue)
	if workflowErr = workflow.ExecuteActivity(short, "EnterRescueMode", req, cfg, instance.Region).Get(short, nil); workflowErr == nil {
		rescueMayBeEntered = true
		updateWorkflowPhase(ctx, req, status, PhaseWaitRescue)
		waitCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
			StartToCloseTimeout: time.Duration(req.WaitTimeoutSeconds+60) * time.Second,
			HeartbeatTimeout:    30 * time.Second,
			RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 1},
		})
		var ignored string
		workflowErr = workflow.ExecuteActivity(waitCtx, "WaitRescueRunning", req, cfg, instance.Region).Get(waitCtx, &ignored)
	} else if ctx.Err() != nil || temporal.IsCanceledError(workflowErr) || temporal.IsTimeoutError(workflowErr) {
		rescueMayBeEntered = true
	}
	if workflowErr == nil {
		updateWorkflowPhase(ctx, req, status, PhaseWaitRemoteAccess)
		waitRemoteCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
			StartToCloseTimeout: time.Duration(req.WaitTimeoutSeconds+60) * time.Second,
			HeartbeatTimeout:    30 * time.Second,
			RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 1},
		})
		if req.CommandTransport == "tat" {
			workflowErr = workflow.ExecuteActivity(waitRemoteCtx, "WaitRescueTAT", req, cfg, instance.Region).Get(waitRemoteCtx, nil)
		} else {
			workflowErr = workflow.ExecuteActivity(waitRemoteCtx, "WaitRescueSSH", req, instance).Get(waitRemoteCtx, nil)
		}
	}
	if workflowErr == nil {
		updateWorkflowPhase(ctx, req, status, PhasePrepareArchive)
		archiveCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
			StartToCloseTimeout: 10 * time.Minute,
			RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 1},
		})
		if req.CommandTransport == "tat" {
			var prepared PreparedTATArchive
			workflowErr = workflow.ExecuteActivity(archiveCtx, "PrepareArchiveTATCommand", req, cfg, instance.Region).Get(archiveCtx, &prepared)
			if workflowErr == nil {
				updateWorkflowPhase(ctx, req, status, PhaseStartTAT)
				startCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
					StartToCloseTimeout: 5 * time.Minute,
					RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 1},
				})
				var submitted TATCommandResult
				workflowErr = workflow.ExecuteActivity(startCtx, "StartTATCommand", req, cfg, instance.Region, prepared.Command).Get(startCtx, &submitted)
				status.TATCommand = submitted
				if workflowErr == nil {
					updateWorkflowPhase(ctx, req, status, PhaseWaitTAT)
					waitTATCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
						StartToCloseTimeout: time.Duration(req.CommandTimeoutSeconds+300) * time.Second,
						HeartbeatTimeout:    30 * time.Second,
						RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 3},
					})
					workflowErr = workflow.ExecuteActivity(waitTATCtx, "WaitTATCommand", req, cfg, instance.Region, submitted).Get(waitTATCtx, &submitted)
					status.TATCommand = submitted
				}
				if workflowErr == nil {
					updateWorkflowPhase(ctx, req, status, PhaseFinalizeArchive)
					finalizeCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
						StartToCloseTimeout: 5 * time.Minute,
						RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 1},
					})
					workflowErr = workflow.ExecuteActivity(finalizeCtx, "FinalizeArchiveOverTAT", req, prepared, submitted).Get(finalizeCtx, &result.Archive)
				}
			}
		} else {
			workflowErr = workflow.ExecuteActivity(archiveCtx, "PrepareArchiveOverSSH", req, instance).Get(archiveCtx, &result.Archive)
		}
		if workflowErr == nil {
			updateArchiveVisibility(ctx, req, status, result.Archive)
		}
	}
	if workflowErr == nil {
		updateWorkflowPhase(ctx, req, status, PhaseCopyArchive)
		scpCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
			StartToCloseTimeout: time.Duration(req.CommandTimeoutSeconds+300) * time.Second,
			HeartbeatTimeout:    30 * time.Second,
			RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 1},
		})
		workflowErr = workflow.ExecuteActivity(scpCtx, "SCPArchive", req, cfg, instance, result.Archive).Get(scpCtx, &result.SCP)
		status.SCP = result.SCP
	}
	if workflowErr == nil {
		updateWorkflowPhase(ctx, req, status, PhaseScheduleDelete)
		workflowErr = scheduleCOSAutoDelete(ctx, req, cfg, result.Archive, &result)
		if workflowErr == nil {
			updateDeleteVisibility(ctx, req, status, result.COSDeleteWorkflowID, result.COSDeleteAfterSeconds)
		}
	}
	if workflowErr == nil {
		if emailResult, err := maybeSendExportNotification(ctx, req, cfg, status, &result); err != nil {
			workflowErr = err
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
	}
	if result.Archive.RemotePath != "" {
		updateWorkflowPhase(ctx, req, status, PhaseCleanupRemote)
		cleanupCtx := cleanupActivityContext(ctx, workflow.ActivityOptions{
			StartToCloseTimeout: 5 * time.Minute,
			HeartbeatTimeout:    30 * time.Second,
			RetryPolicy:         retry,
		})
		cleanupErr := workflow.ExecuteActivity(cleanupCtx, "CleanupRemoteArchive", req, cfg, instance, result.Archive).Get(cleanupCtx, nil)
		if workflowErr == nil {
			workflowErr = cleanupErr
		}
	}

	if rescueMayBeEntered {
		updateWorkflowPhase(ctx, req, status, PhaseExitRescue)
		exitCtx := cleanupActivityContext(ctx, workflow.ActivityOptions{
			StartToCloseTimeout: 5 * time.Minute,
			RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 5},
		})
		var exited bool
		exitErr := workflow.ExecuteActivity(exitCtx, "ExitRescueMode", req, cfg, instance.Region).Get(exitCtx, &exited)
		result.ExitedRescue = exited
		status.ExitedRescue = exited
		var waitExitErr error
		if exitErr == nil {
			updateWorkflowPhase(ctx, req, status, PhaseWaitRunning)
			waitExitCtx := cleanupActivityContext(ctx, workflow.ActivityOptions{
				StartToCloseTimeout: time.Duration(req.WaitTimeoutSeconds+60) * time.Second,
				HeartbeatTimeout:    30 * time.Second,
				RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 1},
			})
			var ignored string
			waitExitErr = workflow.ExecuteActivity(waitExitCtx, "WaitInstanceRunning", req, cfg, instance.Region).Get(waitExitCtx, &ignored)
			result.ExitedRescue = waitExitErr == nil
			status.ExitedRescue = result.ExitedRescue
		}
		if workflowErr != nil {
			return finish(workflowErr)
		}
		if exitErr != nil {
			return finish(exitErr)
		}
		if waitExitErr != nil {
			return finish(waitExitErr)
		}
	}
	return finish(workflowErr)
}

func maybeSendExportNotification(ctx workflow.Context, req ExportRequest, cfg TencentConfig, status *ExportStatus, result *ExportResult) (EmailNotificationResult, error) {
	empty := EmailNotificationResult{}
	toEmail := notificationEmail(req)
	if toEmail == "" {
		return empty, nil
	}
	downloadURL := strings.TrimSpace(result.Archive.DownloadURL)
	if downloadURL == "" {
		downloadURL = strings.TrimSpace(result.SCP.OutputURL)
	}
	if downloadURL == "" {
		workflow.GetLogger(ctx).Warn("notification email requested but no download URL is available", "instance_id", req.InstanceID, "to", toEmail)
		return empty, nil
	}
	updateWorkflowPhase(ctx, req, status, PhaseNotifyEmail)
	notifyCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 2 * time.Minute,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 3},
	})
	var emailResult EmailNotificationResult
	if err := workflow.ExecuteActivity(notifyCtx, "SendExportNotificationEmail", req, downloadURL, cosURLTTLSeconds(req)).Get(notifyCtx, &emailResult); err != nil {
		return empty, err
	}
	if strings.TrimSpace(emailResult.MessageID) == "" {
		return emailResult, nil
	}
	updateWorkflowPhase(ctx, req, status, PhaseConfirmEmailDelivery)
	confirmCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 12 * time.Minute,
		HeartbeatTimeout:    30 * time.Second,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 1},
	})
	var delivered EmailNotificationResult
	if err := workflow.ExecuteActivity(confirmCtx, "ConfirmExportNotificationDelivered", req, emailResult).Get(confirmCtx, &delivered); err != nil {
		return empty, err
	}
	delivered.ToEmail = emailResult.ToEmail
	if delivered.MessageID == "" {
		delivered.MessageID = emailResult.MessageID
	}
	return delivered, nil
}

func cleanupActivityContext(ctx workflow.Context, options workflow.ActivityOptions) workflow.Context {
	base := ctx
	if ctx.Err() != nil {
		disconnected, _ := workflow.NewDisconnectedContext(ctx)
		base = disconnected
	}
	return workflow.WithActivityOptions(base, options)
}

func DeleteCOSObjectWorkflow(ctx workflow.Context, req COSDeleteRequest, cfg TencentConfig) (COSDeleteResult, error) {
	if req.DelaySeconds > 0 {
		if err := workflow.NewTimer(ctx, time.Duration(req.DelaySeconds)*time.Second).Get(ctx, nil); err != nil {
			return COSDeleteResult{}, err
		}
	}
	activityCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout:    5 * time.Minute,
		ScheduleToCloseTimeout: 24 * time.Hour,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    time.Minute,
			BackoffCoefficient: 2,
			MaximumInterval:    time.Hour,
		},
	})
	var result COSDeleteResult
	err := workflow.ExecuteActivity(activityCtx, "DeleteCOSObject", req, cfg).Get(activityCtx, &result)
	return result, err
}

func scheduleCOSAutoDelete(ctx workflow.Context, req ExportRequest, cfg TencentConfig, archive PreparedArchive, result *ExportResult) error {
	if !req.Execute || req.DisableCOSAutoDelete || archive.ObjectKey == "" || archive.Bucket == "" {
		return nil
	}
	delay := cosURLTTLSeconds(req)
	childID := workflow.GetInfo(ctx).WorkflowExecution.ID + "-cos-delete"
	deleteReq := COSDeleteRequest{
		InstanceID:   req.InstanceID,
		BucketURL:    archive.Bucket,
		BucketRegion: req.COSUploadRegion,
		ObjectKey:    archive.ObjectKey,
		ObjectURL:    archive.ObjectURL,
		DelaySeconds: delay,
		WorkflowID:   childID,
	}
	childBase := ctx
	if ctx.Err() != nil {
		disconnected, _ := workflow.NewDisconnectedContext(ctx)
		childBase = disconnected
	}
	childCtx := workflow.WithChildOptions(childBase, workflow.ChildWorkflowOptions{
		WorkflowID:               childID,
		WorkflowExecutionTimeout: time.Duration(delay)*time.Second + 24*time.Hour,
		WorkflowTaskTimeout:      time.Minute,
		ParentClosePolicy:        enumspb.PARENT_CLOSE_POLICY_ABANDON,
	})
	child := workflow.ExecuteChildWorkflow(childCtx, DeleteCOSObjectWorkflow, deleteReq, cfg)
	if err := child.GetChildWorkflowExecution().Get(childCtx, nil); err != nil {
		return err
	}
	result.COSDeleteWorkflowID = childID
	result.COSDeleteAfterSeconds = delay
	return nil
}
