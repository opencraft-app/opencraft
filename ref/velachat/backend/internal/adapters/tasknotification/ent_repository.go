// Package tasknotification implements durable Task assignment delivery with Ent.
package tasknotification

import (
	"context"
	"errors"
	"strings"
	"time"

	"chatserver/internal/database"
	"chatserver/internal/ent"
	"chatserver/internal/ent/agent"
	"chatserver/internal/ent/predicate"
	"chatserver/internal/ent/task"
	"chatserver/internal/ent/tencentoperation"
	tasknotificationport "chatserver/internal/ports/tasknotification"
)

const taskAssignmentOperationKind = "im.agent.task.assigned"

type EntRepository struct{ handle *database.Handle }

func NewEntRepository(handle *database.Handle) (*EntRepository, error) {
	if handle == nil || handle.Client() == nil {
		return nil, errors.New("Task notification Repository 缺少数据库 Handle")
	}
	return &EntRepository{handle: handle}, nil
}

func (repository *EntRepository) Claim(
	ctx context.Context,
	claim tasknotificationport.Claim,
) (work tasknotificationport.Work, found bool, returnErr error) {
	if strings.TrimSpace(claim.LeaseOwner) == "" || claim.Now.IsZero() ||
		!claim.LeaseExpiresAt.After(claim.Now) {
		return work, false, errors.New("Task notification claim 无效")
	}
	now := claim.Now.UTC()
	returnErr = repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		due := taskNotificationDue(now)
		operation, err := tx.TencentOperation.Query().Where(
			tencentoperation.ServiceEQ("im"),
			tencentoperation.KindEQ(taskAssignmentOperationKind),
			tencentoperation.ResourceTypeEQ("task"),
			due,
		).Order(
			ent.Asc(tencentoperation.FieldCreatedAt),
			ent.Asc(tencentoperation.FieldID),
		).First(ctx)
		if ent.IsNotFound(err) {
			return nil
		}
		if err != nil {
			return err
		}
		updated, err := tx.TencentOperation.Update().Where(
			tencentoperation.IDEQ(operation.ID),
			tencentoperation.ServiceEQ("im"),
			tencentoperation.KindEQ(taskAssignmentOperationKind),
			due,
		).SetState("running").
			AddAttempts(1).
			ClearNextAttemptAt().
			SetLeaseOwner(claim.LeaseOwner).
			SetLeaseExpiresAt(claim.LeaseExpiresAt.UTC()).
			ClearLastErrorCode().
			SetUpdatedAt(now).
			Save(ctx)
		if err != nil {
			return err
		}
		if updated != 1 {
			return nil
		}
		work = tasknotificationport.Work{
			OperationID: operation.ID,
			LeaseOwner:  claim.LeaseOwner,
			ServerID:    operation.PartitionKey,
			TaskID:      operation.ResourceID,
			Attempts:    operation.Attempts + 1,
		}
		if operation.DesiredRevision != nil {
			work.AssignmentRevision = *operation.DesiredRevision
		}
		currentTask, err := tx.Task.Query().Where(
			task.IDEQ(operation.ResourceID),
			task.ServerIDEQ(operation.PartitionKey),
		).Only(ctx)
		if ent.IsNotFound(err) {
			found = true
			return nil
		}
		if err != nil {
			return err
		}
		if operation.DesiredRevision == nil ||
			currentTask.AssignmentRevision != *operation.DesiredRevision ||
			currentTask.OwnerMemberID == nil ||
			currentTask.Status == "done" || currentTask.Status == "closed" {
			found = true
			return nil
		}
		recipient, err := tx.Agent.Query().Where(
			agent.IDEQ(*currentTask.OwnerMemberID),
			agent.ServerIDEQ(currentTask.ServerID),
			agent.DeletedAtIsNil(),
		).Only(ctx)
		if ent.IsNotFound(err) {
			found = true
			return nil
		}
		if err != nil {
			return err
		}
		work.Current = true
		work.AgentID = recipient.ID
		if recipient.ImState == "ready" {
			work.RecipientUserID = recipient.ImUserID
		}
		found = true
		return nil
	})
	return work, found, returnErr
}

func (repository *EntRepository) Complete(
	ctx context.Context,
	completion tasknotificationport.Completion,
) error {
	if strings.TrimSpace(completion.OperationID) == "" ||
		strings.TrimSpace(completion.LeaseOwner) == "" ||
		completion.CompletedAt.IsZero() {
		return errors.New("Task notification completion 无效")
	}
	update := repository.handle.Client().TencentOperation.Update().Where(
		tencentoperation.IDEQ(completion.OperationID),
		tencentoperation.ServiceEQ("im"),
		tencentoperation.KindEQ(taskAssignmentOperationKind),
		tencentoperation.ResourceTypeEQ("task"),
		tencentoperation.StateEQ("running"),
		tencentoperation.LeaseOwnerEQ(completion.LeaseOwner),
		tencentoperation.LeaseExpiresAtNotNil(),
		tencentoperation.LeaseExpiresAtGT(completion.CompletedAt.UTC()),
	).SetState(string(completion.Status)).
		SetUpdatedAt(completion.CompletedAt.UTC()).
		ClearLeaseOwner().
		ClearLeaseExpiresAt()
	switch completion.Status {
	case tasknotificationport.CompletionSucceeded,
		tasknotificationport.CompletionSuperseded:
		update.ClearLastErrorCode().
			ClearNextAttemptAt().
			SetCompletedAt(completion.CompletedAt.UTC())
	case tasknotificationport.CompletionFailed:
		if strings.TrimSpace(completion.ErrorCode) == "" {
			return errors.New("Task notification 终态失败缺少错误码")
		}
		update.SetLastErrorCode(completion.ErrorCode).
			ClearNextAttemptAt().
			SetCompletedAt(completion.CompletedAt.UTC())
	case tasknotificationport.CompletionRetry:
		if strings.TrimSpace(completion.ErrorCode) == "" ||
			!completion.NextAttemptAt.After(completion.CompletedAt) {
			return errors.New("Task notification 重试结果无效")
		}
		update.SetLastErrorCode(completion.ErrorCode).
			SetNextAttemptAt(completion.NextAttemptAt.UTC()).
			ClearCompletedAt()
	default:
		return errors.New("Task notification completion 状态无效")
	}
	affected, err := update.Save(ctx)
	if err != nil {
		return err
	}
	if affected != 1 {
		return tasknotificationport.ErrLeaseLost
	}
	return nil
}

func (repository *EntRepository) Current(
	ctx context.Context,
	work tasknotificationport.Work,
	now time.Time,
) (bool, error) {
	if now.IsZero() {
		return false, errors.New("Task notification current check 无效")
	}
	operationCurrent, err := repository.handle.Client().TencentOperation.Query().Where(
		tencentoperation.IDEQ(work.OperationID),
		tencentoperation.PartitionKeyEQ(work.ServerID),
		tencentoperation.ResourceIDEQ(work.TaskID),
		tencentoperation.StateEQ("running"),
		tencentoperation.LeaseOwnerEQ(work.LeaseOwner),
		tencentoperation.LeaseExpiresAtNotNil(),
		tencentoperation.LeaseExpiresAtGT(now.UTC()),
		tencentoperation.DesiredRevisionEQ(work.AssignmentRevision),
	).Exist(ctx)
	if err != nil || !operationCurrent {
		return false, err
	}
	taskCurrent, err := repository.handle.Client().Task.Query().Where(
		task.IDEQ(work.TaskID),
		task.ServerIDEQ(work.ServerID),
		task.OwnerMemberIDEQ(work.AgentID),
		task.AssignmentRevisionEQ(work.AssignmentRevision),
		task.StatusNotIn("done", "closed"),
	).Exist(ctx)
	if err != nil || !taskCurrent {
		return false, err
	}
	return repository.handle.Client().Agent.Query().Where(
		agent.IDEQ(work.AgentID),
		agent.ServerIDEQ(work.ServerID),
		agent.DeletedAtIsNil(),
		agent.ImStateEQ("ready"),
		agent.ImUserIDEQ(work.RecipientUserID),
	).Exist(ctx)
}

func taskNotificationDue(now time.Time) predicate.TencentOperation {
	return tencentoperation.Or(
		tencentoperation.StateEQ("pending"),
		tencentoperation.And(
			tencentoperation.StateEQ("retry_wait"),
			tencentoperation.NextAttemptAtNotNil(),
			tencentoperation.NextAttemptAtLTE(now),
		),
		tencentoperation.And(
			tencentoperation.StateEQ("running"),
			tencentoperation.LeaseExpiresAtNotNil(),
			tencentoperation.LeaseExpiresAtLTE(now),
		),
	)
}
