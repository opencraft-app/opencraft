// Package imdirectconversation 提供 Server 内私信腾讯群 Worker 的 Ent Repository。
package imdirectconversation

import (
	"context"
	"errors"
	"strings"
	"time"

	"chatserver/internal/database"
	"chatserver/internal/ent"
	"chatserver/internal/ent/account"
	"chatserver/internal/ent/agent"
	directentity "chatserver/internal/ent/directconversation"
	"chatserver/internal/ent/member"
	"chatserver/internal/ent/outboxevent"
	"chatserver/internal/ent/predicate"
	"chatserver/internal/ent/tencentoperation"
	workport "chatserver/internal/ports/imdirectconversation"
)

type EntRepository struct{ handle *database.Handle }

func NewEntRepository(handle *database.Handle) (*EntRepository, error) {
	if handle == nil || handle.Client() == nil {
		return nil, errors.New("Server 内私信 IM Repository 缺少数据库 Handle")
	}
	return &EntRepository{handle: handle}, nil
}

func (repository *EntRepository) Claim(
	ctx context.Context,
	claim workport.Claim,
) (work workport.Work, found bool, returnErr error) {
	if err := validateClaim(claim); err != nil {
		return work, false, err
	}
	returnErr = repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		due := dueOperationPredicate(claim.Now.UTC())
		operation, err := tx.TencentOperation.Query().Where(
			tencentoperation.ServiceEQ("im"),
			tencentoperation.KindEQ("im.direct.ensure"),
			tencentoperation.ResourceTypeEQ("direct_conversation"),
			due,
		).Order(ent.Asc(tencentoperation.FieldCreatedAt), ent.Asc(tencentoperation.FieldID)).First(ctx)
		if ent.IsNotFound(err) {
			return nil
		}
		if err != nil {
			return err
		}
		updated, err := tx.TencentOperation.Update().Where(tencentoperation.IDEQ(operation.ID), due).
			SetState("running").AddAttempts(1).ClearNextAttemptAt().SetLeaseOwner(claim.LeaseOwner).
			SetLeaseExpiresAt(claim.LeaseExpiresAt.UTC()).ClearLastErrorCode().SetUpdatedAt(claim.Now.UTC()).Save(ctx)
		if err != nil {
			return err
		}
		if updated != 1 {
			return nil
		}
		work, err = loadWork(ctx, tx, operation, claim.LeaseOwner)
		if err != nil {
			return err
		}
		found = true
		return nil
	})
	return work, found, returnErr
}

func (repository *EntRepository) Complete(ctx context.Context, completion workport.Completion) error {
	if err := validateCompletion(completion); err != nil {
		return err
	}
	return repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		operation, err := tx.TencentOperation.Query().Where(
			tencentoperation.IDEQ(completion.OperationID),
			tencentoperation.KindEQ("im.direct.ensure"),
			tencentoperation.StateEQ("running"),
			tencentoperation.LeaseOwnerEQ(completion.LeaseOwner),
			tencentoperation.LeaseExpiresAtNotNil(),
			tencentoperation.LeaseExpiresAtGT(completion.CompletedAt.UTC()),
		).Only(ctx)
		if ent.IsNotFound(err) {
			return workport.ErrLeaseLost
		}
		if err != nil {
			return err
		}
		status := completion.Status
		switch status {
		case workport.CompletionSucceeded:
			status, err = completeConversation(ctx, tx, operation, "ready", completion.CompletedAt.UTC())
		case workport.CompletionFailed:
			status, err = completeConversation(ctx, tx, operation, "error", completion.CompletedAt.UTC())
		}
		if err != nil {
			return err
		}
		if err := updateOperation(ctx, tx, operation.ID, completion, status); err != nil {
			return err
		}
		if status != workport.CompletionRetry {
			return processOutbox(ctx, tx, operation.ID, completion.CompletedAt.UTC())
		}
		return nil
	})
}

func loadWork(ctx context.Context, tx *ent.Tx, operation *ent.TencentOperation, leaseOwner string) (workport.Work, error) {
	conversation, err := tx.DirectConversation.Query().Where(directentity.IDEQ(operation.ResourceID)).Only(ctx)
	if err != nil {
		return workport.Work{}, err
	}
	memberAUserID, err := memberIMUserID(ctx, tx, conversation.ServerID, conversation.MemberAID)
	if err != nil {
		return workport.Work{}, err
	}
	memberBUserID, err := memberIMUserID(ctx, tx, conversation.ServerID, conversation.MemberBID)
	if err != nil {
		return workport.Work{}, err
	}
	desiredRevision := int64(-1)
	if operation.DesiredRevision != nil {
		desiredRevision = *operation.DesiredRevision
	}
	return workport.Work{
		OperationID: operation.ID, LeaseOwner: leaseOwner, ServerID: conversation.ServerID,
		DirectConversationID: conversation.ID, GroupID: conversation.ImGroupID, GroupName: "Server 内私信",
		MemberAIMUserID: memberAUserID, MemberBIMUserID: memberBUserID, IMState: conversation.ImState,
		ConversationRevision: conversation.Revision, DesiredRevision: desiredRevision, Attempts: operation.Attempts + 1,
	}, nil
}

func memberIMUserID(ctx context.Context, tx *ent.Tx, serverID, memberID string) (string, error) {
	value, err := tx.Member.Query().Where(member.IDEQ(memberID), member.ServerIDEQ(serverID), member.StatusEQ("active")).Only(ctx)
	if err != nil {
		return "", err
	}
	switch value.Kind {
	case "human":
		if value.AccountID == nil {
			return "", errors.New("Human Member 缺少账号")
		}
		identity, err := tx.Account.Query().Where(account.IDEQ(*value.AccountID), account.ImStateEQ("ready")).Only(ctx)
		if err != nil {
			return "", err
		}
		if strings.TrimSpace(identity.ImUserID) == "" {
			return "", errors.New("Human Member IM 身份未就绪")
		}
		return identity.ImUserID, nil
	case "agent":
		identity, err := tx.Agent.Query().Where(
			agent.IDEQ(value.ID), agent.ServerIDEQ(serverID), agent.ImStateEQ("ready"), agent.DeletedAtIsNil(),
		).Only(ctx)
		if err != nil {
			return "", err
		}
		if strings.TrimSpace(identity.ImUserID) == "" {
			return "", errors.New("Agent Member IM 身份未就绪")
		}
		return identity.ImUserID, nil
	default:
		return "", errors.New("Member 类型不支持 Server 内私信")
	}
}

func completeConversation(
	ctx context.Context,
	tx *ent.Tx,
	operation *ent.TencentOperation,
	imState string,
	at time.Time,
) (workport.CompletionStatus, error) {
	conversation, err := tx.DirectConversation.Query().Where(directentity.IDEQ(operation.ResourceID)).Only(ctx)
	if err != nil {
		return "", err
	}
	if operation.DesiredRevision == nil || conversation.Revision != *operation.DesiredRevision {
		return workport.CompletionSuperseded, nil
	}
	updated, err := tx.DirectConversation.Update().Where(
		directentity.IDEQ(conversation.ID), directentity.RevisionEQ(conversation.Revision),
	).SetImState(imState).AddRevision(1).SetUpdatedAt(at).Save(ctx)
	if err != nil {
		return "", err
	}
	if updated != 1 {
		return workport.CompletionSuperseded, nil
	}
	if imState == "ready" {
		return workport.CompletionSucceeded, nil
	}
	return workport.CompletionFailed, nil
}

func updateOperation(
	ctx context.Context,
	tx *ent.Tx,
	operationID string,
	completion workport.Completion,
	status workport.CompletionStatus,
) error {
	update := tx.TencentOperation.Update().Where(
		tencentoperation.IDEQ(operationID), tencentoperation.StateEQ("running"),
		tencentoperation.LeaseOwnerEQ(completion.LeaseOwner), tencentoperation.LeaseExpiresAtNotNil(),
		tencentoperation.LeaseExpiresAtGT(completion.CompletedAt.UTC()),
	).SetState(string(status)).ClearLeaseOwner().ClearLeaseExpiresAt().SetUpdatedAt(completion.CompletedAt.UTC())
	switch status {
	case workport.CompletionRetry:
		update.SetNextAttemptAt(completion.NextAttemptAt.UTC()).SetLastErrorCode(completion.ErrorCode).ClearCompletedAt()
	case workport.CompletionFailed:
		update.ClearNextAttemptAt().SetLastErrorCode(completion.ErrorCode).SetCompletedAt(completion.CompletedAt.UTC())
	default:
		update.ClearNextAttemptAt().ClearLastErrorCode().SetCompletedAt(completion.CompletedAt.UTC())
	}
	updated, err := update.Save(ctx)
	if err != nil {
		return err
	}
	if updated != 1 {
		return workport.ErrLeaseLost
	}
	return nil
}

func processOutbox(ctx context.Context, tx *ent.Tx, operationID string, at time.Time) error {
	_, err := tx.OutboxEvent.Update().Where(
		outboxevent.AggregateTypeEQ("tencent_operation"), outboxevent.AggregateIDEQ(operationID),
		outboxevent.StateIn("pending", "processing"),
	).SetState("processed").ClearLeaseOwner().ClearLeaseExpiresAt().ClearLastErrorCode().SetProcessedAt(at).Save(ctx)
	return err
}

func dueOperationPredicate(now time.Time) predicate.TencentOperation {
	return tencentoperation.Or(
		tencentoperation.StateEQ("pending"),
		tencentoperation.And(tencentoperation.StateEQ("retry_wait"), tencentoperation.NextAttemptAtNotNil(), tencentoperation.NextAttemptAtLTE(now)),
		tencentoperation.And(tencentoperation.StateEQ("running"), tencentoperation.LeaseExpiresAtNotNil(), tencentoperation.LeaseExpiresAtLTE(now)),
	)
}

func validateClaim(claim workport.Claim) error {
	if strings.TrimSpace(claim.LeaseOwner) == "" || claim.Now.IsZero() || !claim.LeaseExpiresAt.After(claim.Now) {
		return errors.New("Server 内私信领取参数无效")
	}
	return nil
}

func validateCompletion(completion workport.Completion) error {
	if strings.TrimSpace(completion.OperationID) == "" || strings.TrimSpace(completion.LeaseOwner) == "" || completion.CompletedAt.IsZero() {
		return errors.New("Server 内私信完成参数无效")
	}
	switch completion.Status {
	case workport.CompletionSucceeded, workport.CompletionSuperseded:
	case workport.CompletionRetry:
		if strings.TrimSpace(completion.ErrorCode) == "" || !completion.NextAttemptAt.After(completion.CompletedAt) {
			return errors.New("Server 内私信重试结果无效")
		}
	case workport.CompletionFailed:
		if strings.TrimSpace(completion.ErrorCode) == "" {
			return errors.New("Server 内私信失败结果无效")
		}
	default:
		return errors.New("Server 内私信完成状态无效")
	}
	return nil
}

var _ workport.Repository = (*EntRepository)(nil)
