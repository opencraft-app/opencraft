// Package imidentity 提供 Human IM 身份 Worker 的 Ent Repository。
package imidentity

import (
	"context"
	"errors"
	"strings"
	"time"

	"chatserver/internal/database"
	"chatserver/internal/ent"
	"chatserver/internal/ent/account"
	"chatserver/internal/ent/outboxevent"
	"chatserver/internal/ent/predicate"
	"chatserver/internal/ent/tencentoperation"
	imidentityport "chatserver/internal/ports/imidentity"
)

// EntRepository 使用 SQLite 单写者事务实现短租约和 fencing。
type EntRepository struct {
	handle *database.Handle
}

// NewEntRepository 创建 IM 身份 Worker Repository。
func NewEntRepository(handle *database.Handle) (*EntRepository, error) {
	if handle == nil || handle.Client() == nil {
		return nil, errors.New("IM 身份 Repository 缺少数据库 Handle")
	}
	return &EntRepository{handle: handle}, nil
}

// Claim 原子领取一个已到期的 im.identity.ensure 并回读 Account。
func (repository *EntRepository) Claim(
	ctx context.Context,
	claim imidentityport.Claim,
) (work imidentityport.Work, found bool, returnErr error) {
	if err := validateClaim(claim); err != nil {
		return work, false, err
	}
	returnErr = repository.handle.WithTx(
		ctx,
		func(ctx context.Context, tx *ent.Tx) error {
			due := dueOperationPredicate(claim.Now.UTC())
			operation, err := tx.TencentOperation.Query().
				Where(
					tencentoperation.ServiceEQ("im"),
					tencentoperation.KindEQ("im.identity.ensure"),
					tencentoperation.ResourceTypeEQ("account"),
					due,
				).
				Order(
					ent.Asc(tencentoperation.FieldCreatedAt),
					ent.Asc(tencentoperation.FieldID),
				).
				First(ctx)
			if ent.IsNotFound(err) {
				return nil
			}
			if err != nil {
				return err
			}
			updated, err := tx.TencentOperation.Update().
				Where(tencentoperation.IDEQ(operation.ID), due).
				SetState("running").
				AddAttempts(1).
				ClearNextAttemptAt().
				SetLeaseOwner(claim.LeaseOwner).
				SetLeaseExpiresAt(claim.LeaseExpiresAt.UTC()).
				ClearLastErrorCode().
				SetUpdatedAt(claim.Now.UTC()).
				Save(ctx)
			if err != nil {
				return err
			}
			if updated != 1 {
				return nil
			}
			entity, err := tx.Account.Query().
				Where(account.IDEQ(operation.ResourceID)).
				Only(ctx)
			if err != nil {
				return err
			}
			desiredRevision := int64(-1)
			if operation.DesiredRevision != nil {
				desiredRevision = *operation.DesiredRevision
			}
			work = imidentityport.Work{
				OperationID:     operation.ID,
				LeaseOwner:      claim.LeaseOwner,
				AccountID:       entity.ID,
				DisplayName:     entity.DisplayName,
				IMUserID:        entity.ImUserID,
				IMState:         entity.ImState,
				AccountRevision: entity.Revision,
				DesiredRevision: desiredRevision,
				Attempts:        operation.Attempts + 1,
			}
			found = true
			return nil
		},
	)
	return work, found, returnErr
}

// Complete 仅允许当前 leaseOwner 写回一次归一化结论。
func (repository *EntRepository) Complete(
	ctx context.Context,
	completion imidentityport.Completion,
) error {
	if err := validateCompletion(completion); err != nil {
		return err
	}
	return repository.handle.WithTx(
		ctx,
		func(ctx context.Context, tx *ent.Tx) error {
			operation, err := tx.TencentOperation.Query().
				Where(
					tencentoperation.IDEQ(completion.OperationID),
					tencentoperation.StateEQ("running"),
					tencentoperation.LeaseOwnerEQ(completion.LeaseOwner),
					tencentoperation.LeaseExpiresAtNotNil(),
					tencentoperation.LeaseExpiresAtGT(
						completion.CompletedAt.UTC(),
					),
				).
				Only(ctx)
			if ent.IsNotFound(err) {
				return imidentityport.ErrLeaseLost
			}
			if err != nil {
				return err
			}

			status := completion.Status
			switch status {
			case imidentityport.CompletionSucceeded:
				status, err = completeAccountSuccess(
					ctx,
					tx,
					operation,
					completion.IMUserID,
					completion.CompletedAt.UTC(),
				)
			case imidentityport.CompletionFailed:
				status, err = completeAccountFailure(
					ctx,
					tx,
					operation,
					completion.CompletedAt.UTC(),
				)
			}
			if err != nil {
				return err
			}
			if err := updateOperation(
				ctx,
				tx,
				operation.ID,
				completion,
				status,
			); err != nil {
				return err
			}
			if status != imidentityport.CompletionRetry {
				if err := processOutbox(
					ctx,
					tx,
					operation.ID,
					completion.CompletedAt.UTC(),
				); err != nil {
					return err
				}
			}
			return nil
		},
	)
}

func dueOperationPredicate(now time.Time) predicate.TencentOperation {
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

func completeAccountSuccess(
	ctx context.Context,
	tx *ent.Tx,
	operation *ent.TencentOperation,
	imUserID string,
	at time.Time,
) (imidentityport.CompletionStatus, error) {
	entity, err := tx.Account.Query().
		Where(account.IDEQ(operation.ResourceID)).
		Only(ctx)
	if err != nil {
		return "", err
	}
	if entity.ImState == "ready" && entity.ImUserID == imUserID {
		return imidentityport.CompletionSucceeded, nil
	}
	if operation.DesiredRevision == nil ||
		entity.Revision != *operation.DesiredRevision {
		return imidentityport.CompletionSuperseded, nil
	}
	if entity.ImUserID != "" && entity.ImUserID != imUserID {
		return "", errors.New("账号已有不同的 IM UserID")
	}
	updated, err := tx.Account.Update().
		Where(
			account.IDEQ(entity.ID),
			account.RevisionEQ(entity.Revision),
			account.ImStateIn("provisioning", "error"),
		).
		SetImUserID(imUserID).
		SetImState("ready").
		AddRevision(1).
		SetUpdatedAt(at).
		Save(ctx)
	if err != nil {
		return "", err
	}
	if updated != 1 {
		return imidentityport.CompletionSuperseded, nil
	}
	return imidentityport.CompletionSucceeded, nil
}

func completeAccountFailure(
	ctx context.Context,
	tx *ent.Tx,
	operation *ent.TencentOperation,
	at time.Time,
) (imidentityport.CompletionStatus, error) {
	entity, err := tx.Account.Query().
		Where(account.IDEQ(operation.ResourceID)).
		Only(ctx)
	if err != nil {
		return "", err
	}
	if operation.DesiredRevision == nil ||
		entity.Revision != *operation.DesiredRevision ||
		entity.ImState == "ready" {
		return imidentityport.CompletionSuperseded, nil
	}
	updated, err := tx.Account.Update().
		Where(
			account.IDEQ(entity.ID),
			account.RevisionEQ(entity.Revision),
		).
		SetImState("error").
		AddRevision(1).
		SetUpdatedAt(at).
		Save(ctx)
	if err != nil {
		return "", err
	}
	if updated != 1 {
		return imidentityport.CompletionSuperseded, nil
	}
	return imidentityport.CompletionFailed, nil
}

func updateOperation(
	ctx context.Context,
	tx *ent.Tx,
	operationID string,
	completion imidentityport.Completion,
	status imidentityport.CompletionStatus,
) error {
	update := tx.TencentOperation.Update().
		Where(
			tencentoperation.IDEQ(operationID),
			tencentoperation.StateEQ("running"),
			tencentoperation.LeaseOwnerEQ(completion.LeaseOwner),
			tencentoperation.LeaseExpiresAtNotNil(),
			tencentoperation.LeaseExpiresAtGT(
				completion.CompletedAt.UTC(),
			),
		).
		SetState(string(status)).
		ClearLeaseOwner().
		ClearLeaseExpiresAt().
		SetUpdatedAt(completion.CompletedAt.UTC())
	switch status {
	case imidentityport.CompletionRetry:
		update.
			SetNextAttemptAt(completion.NextAttemptAt.UTC()).
			SetLastErrorCode(completion.ErrorCode).
			ClearCompletedAt()
	case imidentityport.CompletionFailed:
		update.
			ClearNextAttemptAt().
			SetLastErrorCode(completion.ErrorCode).
			SetCompletedAt(completion.CompletedAt.UTC())
	default:
		update.
			ClearNextAttemptAt().
			ClearLastErrorCode().
			SetCompletedAt(completion.CompletedAt.UTC())
	}
	updated, err := update.Save(ctx)
	if err != nil {
		return err
	}
	if updated != 1 {
		return imidentityport.ErrLeaseLost
	}
	return nil
}

func processOutbox(
	ctx context.Context,
	tx *ent.Tx,
	operationID string,
	at time.Time,
) error {
	_, err := tx.OutboxEvent.Update().
		Where(
			outboxevent.AggregateTypeEQ("tencent_operation"),
			outboxevent.AggregateIDEQ(operationID),
			outboxevent.StateIn("pending", "processing"),
		).
		SetState("processed").
		ClearLeaseOwner().
		ClearLeaseExpiresAt().
		ClearLastErrorCode().
		SetProcessedAt(at).
		Save(ctx)
	return err
}

func validateClaim(claim imidentityport.Claim) error {
	if strings.TrimSpace(claim.LeaseOwner) == "" ||
		claim.Now.IsZero() ||
		!claim.LeaseExpiresAt.After(claim.Now) {
		return errors.New("IM 身份领取参数无效")
	}
	return nil
}

func validateCompletion(completion imidentityport.Completion) error {
	if strings.TrimSpace(completion.OperationID) == "" ||
		strings.TrimSpace(completion.LeaseOwner) == "" ||
		completion.CompletedAt.IsZero() {
		return errors.New("IM 身份完成参数无效")
	}
	switch completion.Status {
	case imidentityport.CompletionSucceeded:
		if strings.TrimSpace(completion.IMUserID) == "" ||
			len(completion.IMUserID) > 32 {
			return errors.New("IM 身份成功结果无效")
		}
	case imidentityport.CompletionRetry:
		if strings.TrimSpace(completion.ErrorCode) == "" ||
			!completion.NextAttemptAt.After(completion.CompletedAt) {
			return errors.New("IM 身份重试结果无效")
		}
	case imidentityport.CompletionFailed:
		if strings.TrimSpace(completion.ErrorCode) == "" {
			return errors.New("IM 身份失败结果无效")
		}
	case imidentityport.CompletionSuperseded:
	default:
		return errors.New("IM 身份完成状态无效")
	}
	return nil
}

var _ imidentityport.Repository = (*EntRepository)(nil)
