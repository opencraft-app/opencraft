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
	return finish(cleanupErr)
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
