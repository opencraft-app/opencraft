package rescue

import (
	"errors"
	"testing"

	"github.com/stretchr/testify/mock"
	"go.temporal.io/sdk/testsuite"
)

func TestExportWorkflowCancelAfterEnterStillExitsRescue(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	env.RegisterWorkflow(ExportWorkflow)
	acts := Activities{}
	env.RegisterActivityWithOptions(acts.LocateInstance, ActivityOptions("LocateInstance"))
	env.RegisterActivityWithOptions(acts.EnsureBackup, ActivityOptions("EnsureBackup"))
	env.RegisterActivityWithOptions(acts.EnterRescueMode, ActivityOptions("EnterRescueMode"))
	env.RegisterActivityWithOptions(acts.ExitRescueMode, ActivityOptions("ExitRescueMode"))
	env.RegisterActivityWithOptions(acts.WaitInstanceRunning, ActivityOptions("WaitInstanceRunning"))
	env.RegisterActivityWithOptions(acts.SendFailureNotification, ActivityOptions("SendFailureNotification"))

	req := ExportRequest{
		InstanceID:             "ins-test",
		Execute:                true,
		SkipBackup:             true,
		CommandTransport:       "tat",
		WaitTimeoutSeconds:     30,
		CommandTimeoutSeconds:  30,
		TATWaitTimeoutSeconds:  30,
		COSUploadBucket:        "https://bucket-123.cos.ap-beijing.myqcloud.com",
		COSUploadURLTTLSeconds: 28800,
	}
	cfg := TencentConfig{}
	instance := InstanceInfo{InstanceID: req.InstanceID, Region: "ap-beijing", State: "RUNNING"}

	env.OnActivity("LocateInstance", mock.Anything, req, cfg).Return(instance, nil).Once()
	env.OnActivity("EnsureBackup", mock.Anything, req, cfg, instance.Region).Return(BackupInfo{Mode: "skipped"}, nil).Once()
	env.OnActivity("EnterRescueMode", mock.Anything, req, cfg, instance.Region).Run(func(mock.Arguments) {
		env.CancelWorkflow()
	}).Return(nil).Once()
	env.OnActivity("ExitRescueMode", mock.Anything, req, cfg, instance.Region).Return(true, nil).Once()
	env.OnActivity("WaitInstanceRunning", mock.Anything, req, cfg, instance.Region).Return("RUNNING", nil).Once()

	env.ExecuteWorkflow(ExportWorkflow, req, cfg)

	if !env.IsWorkflowCompleted() {
		t.Fatal("workflow did not complete")
	}
	if env.GetWorkflowError() == nil {
		t.Fatal("workflow should report cancellation after cleanup")
	}
	env.AssertExpectations(t)
}

func TestExportWorkflowFailureSendsNotification(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	env.RegisterWorkflow(ExportWorkflow)
	acts := Activities{}
	env.RegisterActivityWithOptions(acts.LocateInstance, ActivityOptions("LocateInstance"))
	env.RegisterActivityWithOptions(acts.SendFailureNotification, ActivityOptions("SendFailureNotification"))

	req := ExportRequest{
		InstanceID:        "ins-test",
		Region:            "ap-beijing",
		Execute:           true,
		NotificationEmail: "user@example.com",
	}
	cfg := TencentConfig{}
	locateErr := errors.New("locate failed")

	env.OnActivity("LocateInstance", mock.Anything, req, cfg).Return(InstanceInfo{}, locateErr).Once()
	env.OnActivity("SendFailureNotification", mock.Anything, mock.MatchedBy(func(notification FailureNotification) bool {
		return notification.Request.InstanceID == req.InstanceID &&
			notification.Request.NotificationEmail == req.NotificationEmail &&
			notification.Error != ""
	}), cfg).Return(FailureNotificationResult{Sent: true, Recipients: []string{req.NotificationEmail}}, nil).Once()

	env.ExecuteWorkflow(ExportWorkflow, req, cfg)

	if !env.IsWorkflowCompleted() {
		t.Fatal("workflow did not complete")
	}
	if env.GetWorkflowError() == nil {
		t.Fatal("workflow should fail")
	}
	env.AssertExpectations(t)
}

func TestExportWorkflowSchedulesCOSAutoDeleteChild(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	env.RegisterWorkflow(ExportWorkflow)
	env.RegisterWorkflow(DeleteCOSObjectWorkflow)
	acts := Activities{}
	env.RegisterActivityWithOptions(acts.LocateInstance, ActivityOptions("LocateInstance"))
	env.RegisterActivityWithOptions(acts.EnsureBackup, ActivityOptions("EnsureBackup"))
	env.RegisterActivityWithOptions(acts.EnterRescueMode, ActivityOptions("EnterRescueMode"))
	env.RegisterActivityWithOptions(acts.WaitRescueRunning, ActivityOptions("WaitRescueRunning"))
	env.RegisterActivityWithOptions(acts.WaitRescueTAT, ActivityOptions("WaitRescueTAT"))
	env.RegisterActivityWithOptions(acts.PrepareArchiveTATCommand, ActivityOptions("PrepareArchiveTATCommand"))
	env.RegisterActivityWithOptions(acts.StartTATCommand, ActivityOptions("StartTATCommand"))
	env.RegisterActivityWithOptions(acts.WaitTATCommand, ActivityOptions("WaitTATCommand"))
	env.RegisterActivityWithOptions(acts.FinalizeArchiveOverTAT, ActivityOptions("FinalizeArchiveOverTAT"))
	env.RegisterActivityWithOptions(acts.SCPArchive, ActivityOptions("SCPArchive"))
	env.RegisterActivityWithOptions(acts.SendExportNotificationEmail, ActivityOptions("SendExportNotificationEmail"))
	env.RegisterActivityWithOptions(acts.ConfirmExportNotificationDelivered, ActivityOptions("ConfirmExportNotificationDelivered"))
	env.RegisterActivityWithOptions(acts.ExitRescueMode, ActivityOptions("ExitRescueMode"))
	env.RegisterActivityWithOptions(acts.WaitInstanceRunning, ActivityOptions("WaitInstanceRunning"))

	req := ExportRequest{
		InstanceID:             "ins-test",
		Execute:                true,
		NotificationEmail:      "owner@example.com",
		SkipBackup:             true,
		CommandTransport:       "tat",
		WaitTimeoutSeconds:     30,
		CommandTimeoutSeconds:  30,
		TATWaitTimeoutSeconds:  30,
		COSUploadBucket:        "https://bucket-123.cos.ap-beijing.myqcloud.com",
		COSUploadRegion:        "ap-beijing",
		COSUploadURLTTLSeconds: 123,
	}
	cfg := TencentConfig{}
	instance := InstanceInfo{InstanceID: req.InstanceID, Region: "ap-beijing", State: "RUNNING"}
	prepared := PreparedTATArchive{
		InstanceID:  req.InstanceID,
		Region:      instance.Region,
		Mode:        "stream-upload",
		ObjectURL:   req.COSUploadBucket + "/rescue/a.tar.gz",
		DownloadURL: req.COSUploadBucket + "/rescue/a.tar.gz?q-signature=abc",
		ObjectKey:   "rescue/a.tar.gz",
		Bucket:      req.COSUploadBucket,
		Command:     TATCommandRequest{CommandName: "rescue-export-stream-upload", Script: "true", TimeoutSeconds: 30},
	}
	submitted := TATCommandResult{CommandID: "cmd-test", InvocationID: "inv-test", TaskStatus: "SUCCESS"}
	archive := PreparedArchive{
		InstanceID:  req.InstanceID,
		Region:      instance.Region,
		ObjectURL:   prepared.ObjectURL,
		DownloadURL: prepared.DownloadURL,
		ObjectKey:   prepared.ObjectKey,
		Bucket:      prepared.Bucket,
	}
	scp := SCPResult{LocalPath: archive.ObjectURL, OutputURL: archive.DownloadURL}
	emailSent := EmailNotificationResult{MessageID: "20260612-test-message-id", ToEmail: req.NotificationEmail}
	emailDelivered := EmailNotificationResult{
		MessageID:      emailSent.MessageID,
		ToEmail:        req.NotificationEmail,
		DeliverStatus:  sesDeliverStatusSuccess,
		EmailDelivered: true,
	}

	env.OnActivity("LocateInstance", mock.Anything, req, cfg).Return(instance, nil).Once()
	env.OnActivity("EnsureBackup", mock.Anything, req, cfg, instance.Region).Return(BackupInfo{Mode: "skipped"}, nil).Once()
	env.OnActivity("EnterRescueMode", mock.Anything, req, cfg, instance.Region).Return(nil).Once()
	env.OnActivity("WaitRescueRunning", mock.Anything, req, cfg, instance.Region).Return("RESCUE_MODE", nil).Once()
	env.OnActivity("WaitRescueTAT", mock.Anything, req, cfg, instance.Region).Return(nil).Once()
	env.OnActivity("PrepareArchiveTATCommand", mock.Anything, req, cfg, instance.Region).Return(prepared, nil).Once()
	env.OnActivity("StartTATCommand", mock.Anything, req, cfg, instance.Region, prepared.Command).Return(submitted, nil).Once()
	env.OnActivity("WaitTATCommand", mock.Anything, req, cfg, instance.Region, submitted).Return(submitted, nil).Once()
	env.OnActivity("FinalizeArchiveOverTAT", mock.Anything, req, prepared, submitted).Return(archive, nil).Once()
	env.OnActivity("SCPArchive", mock.Anything, req, cfg, instance, archive).Return(scp, nil).Once()
	env.OnWorkflow(DeleteCOSObjectWorkflow, mock.Anything, mock.MatchedBy(func(deleteReq COSDeleteRequest) bool {
		return deleteReq.ObjectKey == archive.ObjectKey &&
			deleteReq.BucketURL == archive.Bucket &&
			deleteReq.DelaySeconds == req.COSUploadURLTTLSeconds &&
			deleteReq.WorkflowID == "default-test-workflow-id-cos-delete"
	}), cfg).Return(COSDeleteResult{ObjectKey: archive.ObjectKey, ObjectURL: archive.ObjectURL, Deleted: true}, nil).Once()
	env.OnActivity("SendExportNotificationEmail", mock.Anything, req, archive.DownloadURL, req.COSUploadURLTTLSeconds).Return(emailSent, nil).Once()
	env.OnActivity("ConfirmExportNotificationDelivered", mock.Anything, req, emailSent).Return(emailDelivered, nil).Once()
	env.OnActivity("ExitRescueMode", mock.Anything, req, cfg, instance.Region).Return(true, nil).Once()
	env.OnActivity("WaitInstanceRunning", mock.Anything, req, cfg, instance.Region).Return("RUNNING", nil).Once()

	env.ExecuteWorkflow(ExportWorkflow, req, cfg)

	if !env.IsWorkflowCompleted() {
		t.Fatal("workflow did not complete")
	}
	if err := env.GetWorkflowError(); err != nil {
		t.Fatal(err)
	}
	var result ExportResult
	if err := env.GetWorkflowResult(&result); err != nil {
		t.Fatal(err)
	}
	if result.COSDeleteWorkflowID != "default-test-workflow-id-cos-delete" {
		t.Fatalf("unexpected delete workflow id: %s", result.COSDeleteWorkflowID)
	}
	if result.COSDeleteAfterSeconds != req.COSUploadURLTTLSeconds {
		t.Fatalf("unexpected delete delay: %d", result.COSDeleteAfterSeconds)
	}
	if result.NotificationEmail != req.NotificationEmail || result.EmailMessageID != emailSent.MessageID || !result.EmailDelivered {
		t.Fatalf("unexpected email result: %+v", result)
	}
	encodedStatus, err := env.QueryWorkflow(ExportStatusQuery)
	if err != nil {
		t.Fatal(err)
	}
	var status ExportStatus
	if err := encodedStatus.Get(&status); err != nil {
		t.Fatal(err)
	}
	if status.Phase != PhaseCompleted {
		t.Fatalf("unexpected status phase: %s", status.Phase)
	}
	if status.COSDeleteWorkflowID != result.COSDeleteWorkflowID {
		t.Fatalf("unexpected status delete workflow id: %s", status.COSDeleteWorkflowID)
	}
	if status.COSDeleteAfterSeconds != result.COSDeleteAfterSeconds {
		t.Fatalf("unexpected status delete delay: %d", status.COSDeleteAfterSeconds)
	}
	if status.TATCommand.InvocationID != submitted.InvocationID {
		t.Fatalf("unexpected status TAT invocation id: %s", status.TATCommand.InvocationID)
	}
	if status.NotificationEmail != req.NotificationEmail || status.EmailMessageID != emailSent.MessageID || !status.EmailDelivered {
		t.Fatalf("unexpected status email fields: %+v", status)
	}
	env.AssertExpectations(t)
}
