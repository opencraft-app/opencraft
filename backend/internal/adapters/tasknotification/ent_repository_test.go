package tasknotification

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"chatserver/internal/config"
	"chatserver/internal/database"
	"chatserver/internal/database/migration"
	"chatserver/internal/ent/tencentoperation"
	tasknotificationport "chatserver/internal/ports/tasknotification"
)

const (
	taskNotificationServerID    = "0198f4c2-7a31-7c91-a6d2-7d76f9188c38"
	taskNotificationMemberID    = "0198f4c2-7a32-7d02-b8c1-3f6e15aa91b4"
	taskNotificationAgentID     = "0198f4c2-7a33-7e45-913c-6baf30401a82"
	taskNotificationTaskID      = "0198f4c2-7a34-7e45-913c-6baf30401a83"
	taskNotificationOperationID = "0198f4c2-7a3b-7e45-913c-6baf30401a8a"
)

var taskNotificationNow = time.Date(2026, 8, 1, 14, 0, 0, 0, time.UTC)

func TestEntRepositoryClaimsCurrentAgentAssignmentAndCompletesIt(t *testing.T) {
	repository, handle := openTaskNotificationRepository(t)
	seedTaskNotification(t, handle, 2, 2, "pending", nil)

	work, found, err := repository.Claim(context.Background(), tasknotificationport.Claim{
		LeaseOwner: "task-worker-1", Now: taskNotificationNow,
		LeaseExpiresAt: taskNotificationNow.Add(30 * time.Second),
	})
	if err != nil || !found {
		t.Fatalf("Claim() = (%#v, %v, %v)", work, found, err)
	}
	if !work.Current || work.AgentID != taskNotificationAgentID ||
		work.RecipientUserID != "a_task_notification_agent" ||
		work.AssignmentRevision != 2 || work.Attempts != 1 {
		t.Fatalf("work = %#v", work)
	}
	if err := repository.Complete(context.Background(), tasknotificationport.Completion{
		OperationID: taskNotificationOperationID, LeaseOwner: "task-worker-1",
		Status:      tasknotificationport.CompletionSucceeded,
		CompletedAt: taskNotificationNow.Add(time.Second),
	}); err != nil {
		t.Fatal(err)
	}
	operation, err := handle.Client().TencentOperation.Query().Where(
		tencentoperation.IDEQ(taskNotificationOperationID),
	).Only(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if operation.State != "succeeded" || operation.CompletedAt == nil ||
		operation.LeaseOwner != nil || operation.LeaseExpiresAt != nil {
		t.Fatalf("operation = %#v", operation)
	}
}

func TestEntRepositoryMarksOlderAssignmentAsNotCurrent(t *testing.T) {
	repository, handle := openTaskNotificationRepository(t)
	seedTaskNotification(t, handle, 3, 2, "pending", nil)

	work, found, err := repository.Claim(context.Background(), tasknotificationport.Claim{
		LeaseOwner: "task-worker-1", Now: taskNotificationNow,
		LeaseExpiresAt: taskNotificationNow.Add(30 * time.Second),
	})
	if err != nil || !found || work.Current || work.RecipientUserID != "" {
		t.Fatalf("Claim() = (%#v, %v, %v)", work, found, err)
	}
	if err := repository.Complete(context.Background(), tasknotificationport.Completion{
		OperationID: taskNotificationOperationID, LeaseOwner: "task-worker-1",
		Status:      tasknotificationport.CompletionSuperseded,
		CompletedAt: taskNotificationNow.Add(time.Second),
	}); err != nil {
		t.Fatal(err)
	}
	state, err := handle.Client().TencentOperation.Query().Where(
		tencentoperation.IDEQ(taskNotificationOperationID),
	).Select(tencentoperation.FieldState).String(context.Background())
	if err != nil || state != "superseded" {
		t.Fatalf("state = (%q, %v)", state, err)
	}
}

func TestEntRepositoryRetriesAtDueTimeAndFencesExpiredLease(t *testing.T) {
	repository, handle := openTaskNotificationRepository(t)
	seedTaskNotification(t, handle, 2, 2, "pending", nil)
	claim := tasknotificationport.Claim{
		LeaseOwner: "task-worker-1", Now: taskNotificationNow,
		LeaseExpiresAt: taskNotificationNow.Add(30 * time.Second),
	}
	work, found, err := repository.Claim(context.Background(), claim)
	if err != nil || !found {
		t.Fatalf("Claim() = (%#v, %v, %v)", work, found, err)
	}
	next := taskNotificationNow.Add(time.Minute)
	if err := repository.Complete(context.Background(), tasknotificationport.Completion{
		OperationID: work.OperationID, LeaseOwner: claim.LeaseOwner,
		Status: tasknotificationport.CompletionRetry, ErrorCode: "im_timeout",
		NextAttemptAt: next, CompletedAt: taskNotificationNow.Add(time.Second),
	}); err != nil {
		t.Fatal(err)
	}
	if _, found, err := repository.Claim(context.Background(), tasknotificationport.Claim{
		LeaseOwner: "task-worker-2", Now: next.Add(-time.Nanosecond),
		LeaseExpiresAt: next.Add(time.Second),
	}); err != nil || found {
		t.Fatalf("early Claim() = (%v, %v)", found, err)
	}
	retry, found, err := repository.Claim(context.Background(), tasknotificationport.Claim{
		LeaseOwner: "task-worker-2", Now: next,
		LeaseExpiresAt: next.Add(30 * time.Second),
	})
	if err != nil || !found || retry.Attempts != 2 {
		t.Fatalf("retry Claim() = (%#v, %v, %v)", retry, found, err)
	}
	if err := repository.Complete(context.Background(), tasknotificationport.Completion{
		OperationID: retry.OperationID, LeaseOwner: "task-worker-2",
		Status:      tasknotificationport.CompletionSucceeded,
		CompletedAt: next.Add(31 * time.Second),
	}); !errors.Is(err, tasknotificationport.ErrLeaseLost) {
		t.Fatalf("expired Complete() error = %v", err)
	}
}

func openTaskNotificationRepository(t *testing.T) (*EntRepository, *database.Handle) {
	t.Helper()
	cfg, err := config.NewDatabase(filepath.Join(t.TempDir(), "data", "chatserver.db"))
	if err != nil {
		t.Fatal(err)
	}
	handle, err := database.OpenWriter(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = handle.Close() })
	if err := migration.Apply(context.Background(), handle.SQLDB()); err != nil {
		t.Fatal(err)
	}
	repository, err := NewEntRepository(handle)
	if err != nil {
		t.Fatal(err)
	}
	return repository, handle
}

func seedTaskNotification(
	t *testing.T,
	handle *database.Handle,
	taskRevision, desiredRevision int64,
	state string,
	nextAttemptAt *time.Time,
) {
	t.Helper()
	ctx := context.Background()
	if _, err := handle.Client().Agent.Create().
		SetID(taskNotificationAgentID).
		SetServerID(taskNotificationServerID).
		SetImUserID("a_task_notification_agent").
		SetRuntimeKind("codex").
		SetReplyPolicy("mentions").
		SetDesiredState("running").
		SetObservedState("running").
		SetCredentialVersion(1).
		SetImState("ready").
		SetCreatedByMemberID(taskNotificationMemberID).
		SetRevision(1).
		SetCreatedAt(taskNotificationNow).
		SetUpdatedAt(taskNotificationNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Task.Create().
		SetID(taskNotificationTaskID).
		SetServerID(taskNotificationServerID).
		SetNumber(1).
		SetTitle("修复生产故障").
		SetStatus("todo").
		SetOwnerMemberID(taskNotificationAgentID).
		SetAssignmentRevision(taskRevision).
		SetCreatedByMemberID(taskNotificationMemberID).
		SetUpdatedByMemberID(taskNotificationMemberID).
		SetRevision(1).
		SetCreatedAt(taskNotificationNow).
		SetUpdatedAt(taskNotificationNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().TencentOperation.Create().
		SetID(taskNotificationOperationID).
		SetPartitionKey(taskNotificationServerID).
		SetServerID(taskNotificationServerID).
		SetService("im").
		SetKind("im.agent.task.assigned").
		SetResourceType("task").
		SetResourceID(taskNotificationTaskID).
		SetIdempotencyKey("task.assigned:v1:task:2").
		SetDesiredRevision(desiredRevision).
		SetState(state).
		SetAttempts(0).
		SetNillableNextAttemptAt(nextAttemptAt).
		SetCreatedAt(taskNotificationNow).
		SetUpdatedAt(taskNotificationNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
}
