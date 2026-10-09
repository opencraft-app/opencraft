// Package imcommunity 提供 Community Worker 的 Ent/SQLite Repository。
package imcommunity

import (
	"context"
	"errors"
	"strings"
	"time"

	"chatserver/internal/database"
	"chatserver/internal/ent"
	"chatserver/internal/ent/account"
	"chatserver/internal/ent/accountservermembership"
	"chatserver/internal/ent/channel"
	"chatserver/internal/ent/member"
	"chatserver/internal/ent/outboxevent"
	"chatserver/internal/ent/predicate"
	"chatserver/internal/ent/server"
	"chatserver/internal/ent/tencentoperation"
	"chatserver/internal/persistedjson"
	imcommunityport "chatserver/internal/ports/imcommunity"
)

// EntRepository 使用 SQLite 单写者事务实现短租约和 fencing。
type EntRepository struct {
	handle *database.Handle
}

// NewEntRepository 创建 Community Worker Repository。
func NewEntRepository(handle *database.Handle) (*EntRepository, error) {
	if handle == nil || handle.Client() == nil {
		return nil, errors.New("IM Community Repository 缺少数据库 Handle")
	}
	return &EntRepository{handle: handle}, nil
}

// Claim 原子领取一个到期的 im.community.ensure 并回读完整工作事实。
func (repository *EntRepository) Claim(
	ctx context.Context,
	claim imcommunityport.Claim,
) (work imcommunityport.Work, found bool, returnErr error) {
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
					tencentoperation.KindEQ("im.community.ensure"),
					tencentoperation.ResourceTypeEQ("server"),
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
			work, err = loadWork(ctx, tx, operation, claim.LeaseOwner)
			if err != nil {
				return err
			}
			found = true
			return nil
		},
	)
	return work, found, returnErr
}

// Complete 仅允许当前未过期 leaseOwner 原子收敛聚合与操作状态。
func (repository *EntRepository) Complete(
	ctx context.Context,
	completion imcommunityport.Completion,
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
					tencentoperation.KindEQ("im.community.ensure"),
					tencentoperation.StateEQ("running"),
					tencentoperation.LeaseOwnerEQ(completion.LeaseOwner),
					tencentoperation.LeaseExpiresAtNotNil(),
					tencentoperation.LeaseExpiresAtGT(
						completion.CompletedAt.UTC(),
					),
				).
				Only(ctx)
			if ent.IsNotFound(err) {
				return imcommunityport.ErrLeaseLost
			}
			if err != nil {
				return err
			}

			status := completion.Status
			switch status {
			case imcommunityport.CompletionSucceeded:
				status, err = completeAggregate(
					ctx,
					tx,
					operation,
					"ready",
					completion.CompletedAt.UTC(),
				)
			case imcommunityport.CompletionFailed:
				status, err = completeAggregate(
					ctx,
					tx,
					operation,
					"error",
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
			if status != imcommunityport.CompletionRetry {
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

func loadWork(
	ctx context.Context,
	tx *ent.Tx,
	operation *ent.TencentOperation,
	leaseOwner string,
) (imcommunityport.Work, error) {
	serverEntity, err := tx.Server.Query().
		Where(server.IDEQ(operation.ResourceID)).
		Only(ctx)
	if err != nil {
		return imcommunityport.Work{}, err
	}
	if serverEntity.OwnerMemberID == nil {
		return imcommunityport.Work{}, errors.New("Server 缺少 Owner Member")
	}
	owner, err := tx.Member.Query().
		Where(
			member.IDEQ(*serverEntity.OwnerMemberID),
			member.ServerIDEQ(serverEntity.ID),
			member.StatusEQ("active"),
		).
		Only(ctx)
	if err != nil {
		return imcommunityport.Work{}, err
	}
	if owner.AccountID == nil {
		return imcommunityport.Work{}, errors.New("Server Owner 缺少账号")
	}
	ownerAccount, err := tx.Account.Query().
		Where(
			account.IDEQ(*owner.AccountID),
			account.ImStateEQ("ready"),
		).
		Only(ctx)
	if err != nil {
		return imcommunityport.Work{}, err
	}
	rootChannel, err := tx.Channel.Query().
		Where(
			channel.ServerIDEQ(serverEntity.ID),
			channel.SystemKeyEQ("all"),
		).
		Only(ctx)
	if err != nil {
		return imcommunityport.Work{}, err
	}

	description := ""
	if serverEntity.Description != nil {
		description = *serverEntity.Description
	}
	desiredRevision := int64(-1)
	if operation.DesiredRevision != nil {
		desiredRevision = *operation.DesiredRevision
	}
	return imcommunityport.Work{
		OperationID:     operation.ID,
		LeaseOwner:      leaseOwner,
		ServerID:        serverEntity.ID,
		ServerName:      serverEntity.Name,
		Description:     description,
		GroupID:         serverEntity.ImGroupID,
		OwnerMemberID:   owner.ID,
		OwnerIMUserID:   ownerAccount.ImUserID,
		RootChannelID:   rootChannel.ID,
		IMState:         serverEntity.ImState,
		ServerRevision:  serverEntity.Revision,
		DesiredRevision: desiredRevision,
		Attempts:        operation.Attempts + 1,
	}, nil
}

func completeAggregate(
	ctx context.Context,
	tx *ent.Tx,
	operation *ent.TencentOperation,
	imState string,
	at time.Time,
) (imcommunityport.CompletionStatus, error) {
	serverEntity, err := tx.Server.Query().
		Where(server.IDEQ(operation.ResourceID)).
		Only(ctx)
	if err != nil {
		return "", err
	}
	if imState == "ready" && serverEntity.ImState == "ready" {
		return imcommunityport.CompletionSucceeded, nil
	}
	if operation.DesiredRevision == nil ||
		serverEntity.Revision != *operation.DesiredRevision ||
		serverEntity.ImState == "ready" {
		return imcommunityport.CompletionSuperseded, nil
	}
	if serverEntity.OwnerMemberID == nil {
		return "", errors.New("Server 缺少 Owner Member")
	}
	rootChannel, err := tx.Channel.Query().
		Where(
			channel.ServerIDEQ(serverEntity.ID),
			channel.SystemKeyEQ("all"),
		).
		Only(ctx)
	if err != nil {
		return "", err
	}

	serverUpdated, err := tx.Server.Update().
		Where(
			server.IDEQ(serverEntity.ID),
			server.RevisionEQ(serverEntity.Revision),
		).
		SetImState(imState).
		AddRevision(1).
		SetUpdatedAt(at).
		Save(ctx)
	if err != nil {
		return "", err
	}
	if serverUpdated != 1 {
		return imcommunityport.CompletionSuperseded, nil
	}
	if _, err := tx.Member.Update().
		Where(
			member.IDEQ(*serverEntity.OwnerMemberID),
			member.ServerIDEQ(serverEntity.ID),
		).
		SetImState(imState).
		AddRevision(1).
		SetUpdatedAt(at).
		Save(ctx); err != nil {
		return "", err
	}
	if imState == "ready" {
		if err := enqueueRootTopic(ctx, tx, operation, rootChannel, at); err != nil {
			return "", err
		}
	} else {
		if _, err := tx.Channel.Update().
			Where(
				channel.IDEQ(rootChannel.ID),
				channel.ServerIDEQ(serverEntity.ID),
			).
			SetImState(imState).
			AddRevision(1).
			SetUpdatedAt(at).
			Save(ctx); err != nil {
			return "", err
		}
	}
	if _, err := tx.AccountServerMembership.Update().
		Where(
			accountservermembership.ServerIDEQ(serverEntity.ID),
			accountservermembership.StatusEQ("active"),
		).
		SetServerRevision(serverEntity.Revision + 1).
		SetProjectedAt(at).
		SetUpdatedAt(at).
		Save(ctx); err != nil {
		return "", err
	}
	if imState == "ready" {
		return imcommunityport.CompletionSucceeded, nil
	}
	return imcommunityport.CompletionFailed, nil
}

func enqueueRootTopic(
	ctx context.Context,
	tx *ent.Tx,
	communityOperation *ent.TencentOperation,
	rootChannel *ent.Channel,
	at time.Time,
) error {
	if rootChannel.ImTopicID == nil || strings.TrimSpace(*rootChannel.ImTopicID) == "" {
		return errors.New("系统 #全员 缺少 TopicId")
	}
	exists, err := tx.TencentOperation.Query().
		Where(
			tencentoperation.KindEQ("im.topic.ensure"),
			tencentoperation.ResourceTypeEQ("channel"),
			tencentoperation.ResourceIDEQ(rootChannel.ID),
		).
		Exist(ctx)
	if err != nil || exists {
		return err
	}
	if communityOperation.RequestSnapshotJSON == nil {
		return errors.New("Community 操作缺少根 Topic 快照")
	}
	var snapshot struct {
		RootTopicOperationID string `json:"rootTopicOperationId"`
	}
	if _, err := persistedjson.DecodeSnapshot(
		*communityOperation.RequestSnapshotJSON,
		"im",
		"im.community.ensure",
		&snapshot,
	); err != nil {
		return err
	}
	if strings.TrimSpace(snapshot.RootTopicOperationID) == "" {
		return errors.New("Community 操作缺少根 Topic operationId")
	}
	exists, err = tx.TencentOperation.Query().
		Where(tencentoperation.IDEQ(snapshot.RootTopicOperationID)).
		Exist(ctx)
	if err != nil || exists {
		return err
	}
	operation, err := tx.TencentOperation.Create().
		SetID(snapshot.RootTopicOperationID).
		SetPartitionKey(rootChannel.ServerID).
		SetServerID(rootChannel.ServerID).
		SetService("im").
		SetKind("im.topic.ensure").
		SetResourceType("channel").
		SetResourceID(rootChannel.ID).
		SetIdempotencyKey("im.topic.ensure:v1:" + rootChannel.ID + ":1").
		SetDesiredRevision(rootChannel.Revision).
		SetState("pending").
		SetAttempts(0).
		SetCreatedAt(at).
		SetUpdatedAt(at).
		Save(ctx)
	if err != nil {
		return err
	}
	_, err = tx.OutboxEvent.Create().
		SetPartitionKey(rootChannel.ServerID).
		SetServerID(rootChannel.ServerID).
		SetEventType("tencent.operation.ready").
		SetAggregateType("tencent_operation").
		SetAggregateID(operation.ID).
		SetState("pending").
		SetAttempts(0).
		SetAvailableAt(at).
		SetCreatedAt(at).
		Save(ctx)
	return err
}

func updateOperation(
	ctx context.Context,
	tx *ent.Tx,
	operationID string,
	completion imcommunityport.Completion,
	status imcommunityport.CompletionStatus,
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
	case imcommunityport.CompletionRetry:
		update.
			SetNextAttemptAt(completion.NextAttemptAt.UTC()).
			SetLastErrorCode(completion.ErrorCode).
			ClearCompletedAt()
	case imcommunityport.CompletionFailed:
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
		return imcommunityport.ErrLeaseLost
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

func validateClaim(claim imcommunityport.Claim) error {
	if strings.TrimSpace(claim.LeaseOwner) == "" ||
		claim.Now.IsZero() ||
		!claim.LeaseExpiresAt.After(claim.Now) {
		return errors.New("Community 领取参数无效")
	}
	return nil
}

func validateCompletion(completion imcommunityport.Completion) error {
	if strings.TrimSpace(completion.OperationID) == "" ||
		strings.TrimSpace(completion.LeaseOwner) == "" ||
		completion.CompletedAt.IsZero() {
		return errors.New("Community 完成参数无效")
	}
	switch completion.Status {
	case imcommunityport.CompletionSucceeded,
		imcommunityport.CompletionSuperseded:
	case imcommunityport.CompletionRetry:
		if strings.TrimSpace(completion.ErrorCode) == "" ||
			!completion.NextAttemptAt.After(completion.CompletedAt) {
			return errors.New("Community 重试结果无效")
		}
	case imcommunityport.CompletionFailed:
		if strings.TrimSpace(completion.ErrorCode) == "" {
			return errors.New("Community 失败结果无效")
		}
	default:
		return errors.New("Community 完成状态无效")
	}
	return nil
}

var _ imcommunityport.Repository = (*EntRepository)(nil)
