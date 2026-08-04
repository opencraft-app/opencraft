// Package imtopic 提供 Topic Worker 的 Ent/SQLite Repository。
package imtopic

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	"chatserver/internal/database"
	"chatserver/internal/ent"
	"chatserver/internal/ent/account"
	"chatserver/internal/ent/channel"
	"chatserver/internal/ent/member"
	"chatserver/internal/ent/outboxevent"
	"chatserver/internal/ent/predicate"
	"chatserver/internal/ent/server"
	"chatserver/internal/ent/tencentoperation"
	idport "chatserver/internal/ports/id"
	imtopicport "chatserver/internal/ports/imtopic"
)

type EntRepository struct{ handle *database.Handle }

type topicDeriver interface {
	Topic(string, string, string) (string, string, error)
}

func NewEntRepository(handle *database.Handle) (*EntRepository, error) {
	if handle == nil || handle.Client() == nil {
		return nil, errors.New("IM Topic Repository 缺少数据库 Handle")
	}
	return &EntRepository{handle: handle}, nil
}

// RepairLegacySystemTopics 把旧版本错误映射到 Community 根消息的 #全员
// 原子转换为公开系统 Topic。条件更新让多个服务副本可安全并发启动。
func (repository *EntRepository) RepairLegacySystemTopics(
	ctx context.Context,
	resources topicDeriver,
	ids idport.Generator,
	at time.Time,
) (int, error) {
	if resources == nil || ids == nil || at.IsZero() {
		return 0, errors.New("系统 Topic 修复配置无效")
	}
	repaired := 0
	for {
		candidate, err := repository.handle.Client().Channel.Query().
			Where(
				channel.SystemKeyEQ("all"),
				channel.ImTopicIDIsNil(),
			).
			Order(ent.Asc(channel.FieldID)).
			First(ctx)
		if ent.IsNotFound(err) {
			return repaired, nil
		}
		if err != nil {
			return repaired, err
		}
		serverEntity, err := repository.handle.Client().Server.Query().
			Where(server.IDEQ(candidate.ServerID)).
			Only(ctx)
		if err != nil {
			return repaired, err
		}
		topicID, _, err := resources.Topic(
			candidate.ServerID,
			candidate.ID,
			serverEntity.ImGroupID,
		)
		if err != nil {
			return repaired, err
		}
		operationID, err := ids.New()
		if err != nil {
			return repaired, err
		}
		scheduled := false
		err = repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
			updated, err := tx.Channel.Update().
				Where(
					channel.IDEQ(candidate.ID),
					channel.ServerIDEQ(candidate.ServerID),
					channel.SystemKeyEQ("all"),
					channel.ImTopicIDIsNil(),
					channel.RevisionEQ(candidate.Revision),
				).
				SetImTopicID(topicID).
				SetImState("provisioning").
				AddRevision(1).
				SetUpdatedAt(at.UTC()).
				Save(ctx)
			if err != nil || updated == 0 {
				return err
			}
			operation, err := tx.TencentOperation.Create().
				SetID(operationID).
				SetPartitionKey(candidate.ServerID).
				SetServerID(candidate.ServerID).
				SetService("im").
				SetKind("im.topic.ensure").
				SetResourceType("channel").
				SetResourceID(candidate.ID).
				SetIdempotencyKey(
					"im.topic.ensure:v1:" + candidate.ID + ":" +
						strconv.FormatInt(candidate.Revision+1, 10),
				).
				SetDesiredRevision(candidate.Revision + 1).
				SetState("pending").
				SetAttempts(0).
				SetCreatedAt(at.UTC()).
				SetUpdatedAt(at.UTC()).
				Save(ctx)
			if err != nil {
				return err
			}
			if _, err := tx.OutboxEvent.Create().
				SetPartitionKey(candidate.ServerID).
				SetServerID(candidate.ServerID).
				SetEventType("tencent.operation.ready").
				SetAggregateType("tencent_operation").
				SetAggregateID(operation.ID).
				SetState("pending").
				SetAttempts(0).
				SetAvailableAt(at.UTC()).
				SetCreatedAt(at.UTC()).
				Save(ctx); err != nil {
				return err
			}
			scheduled = true
			return nil
		})
		if err != nil {
			return repaired, err
		}
		if scheduled {
			repaired++
		}
	}
}

func (repository *EntRepository) Claim(
	ctx context.Context,
	claim imtopicport.Claim,
) (work imtopicport.Work, found bool, returnErr error) {
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
					tencentoperation.KindEQ("im.topic.ensure"),
					tencentoperation.ResourceTypeEQ("channel"),
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

func (repository *EntRepository) Complete(
	ctx context.Context,
	completion imtopicport.Completion,
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
					tencentoperation.KindEQ("im.topic.ensure"),
					tencentoperation.StateEQ("running"),
					tencentoperation.LeaseOwnerEQ(completion.LeaseOwner),
					tencentoperation.LeaseExpiresAtNotNil(),
					tencentoperation.LeaseExpiresAtGT(
						completion.CompletedAt.UTC(),
					),
				).
				Only(ctx)
			if ent.IsNotFound(err) {
				return imtopicport.ErrLeaseLost
			}
			if err != nil {
				return err
			}
			status := completion.Status
			switch status {
			case imtopicport.CompletionSucceeded:
				status, err = completeChannel(
					ctx,
					tx,
					operation,
					"ready",
					completion.CompletedAt.UTC(),
				)
			case imtopicport.CompletionFailed:
				status, err = completeChannel(
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
			if status != imtopicport.CompletionRetry {
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
) (imtopicport.Work, error) {
	channelEntity, err := tx.Channel.Query().
		Where(channel.IDEQ(operation.ResourceID)).
		Only(ctx)
	if err != nil {
		return imtopicport.Work{}, err
	}
	if channelEntity.ImTopicID == nil {
		return imtopicport.Work{}, errors.New("普通 Channel 缺少 TopicId")
	}
	serverEntity, err := tx.Server.Query().
		Where(server.IDEQ(channelEntity.ServerID)).
		Only(ctx)
	if err != nil {
		return imtopicport.Work{}, err
	}
	if serverEntity.OwnerMemberID == nil {
		return imtopicport.Work{}, errors.New("Server 缺少 Owner Member")
	}
	owner, err := tx.Member.Query().
		Where(member.IDEQ(*serverEntity.OwnerMemberID)).
		Only(ctx)
	if err != nil {
		return imtopicport.Work{}, err
	}
	if owner.AccountID == nil {
		return imtopicport.Work{}, errors.New("Server Owner 缺少账号")
	}
	ownerAccount, err := tx.Account.Query().
		Where(
			account.IDEQ(*owner.AccountID),
			account.ImStateEQ("ready"),
		).
		Only(ctx)
	if err != nil {
		return imtopicport.Work{}, err
	}
	topicName, err := topicName(*channelEntity.ImTopicID)
	if err != nil {
		return imtopicport.Work{}, err
	}
	description := ""
	if channelEntity.Description != nil {
		description = *channelEntity.Description
	}
	desiredRevision := int64(-1)
	if operation.DesiredRevision != nil {
		desiredRevision = *operation.DesiredRevision
	}
	return imtopicport.Work{
		OperationID:     operation.ID,
		LeaseOwner:      leaseOwner,
		ServerID:        channelEntity.ServerID,
		ChannelID:       channelEntity.ID,
		GroupID:         channelEntity.ImGroupID,
		TopicID:         *channelEntity.ImTopicID,
		TopicName:       topicName,
		OwnerIMUserID:   ownerAccount.ImUserID,
		Description:     description,
		Private:         channelEntity.SystemKey == nil,
		IMState:         channelEntity.ImState,
		ChannelRevision: channelEntity.Revision,
		DesiredRevision: desiredRevision,
		Attempts:        operation.Attempts + 1,
	}, nil
}

func completeChannel(
	ctx context.Context,
	tx *ent.Tx,
	operation *ent.TencentOperation,
	imState string,
	at time.Time,
) (imtopicport.CompletionStatus, error) {
	entity, err := tx.Channel.Query().
		Where(channel.IDEQ(operation.ResourceID)).
		Only(ctx)
	if err != nil {
		return "", err
	}
	if operation.DesiredRevision == nil ||
		entity.Revision != *operation.DesiredRevision {
		return imtopicport.CompletionSuperseded, nil
	}
	updated, err := tx.Channel.Update().
		Where(
			channel.IDEQ(entity.ID),
			channel.RevisionEQ(entity.Revision),
		).
		SetImState(imState).
		AddRevision(1).
		SetUpdatedAt(at).
		Save(ctx)
	if err != nil {
		return "", err
	}
	if updated != 1 {
		return imtopicport.CompletionSuperseded, nil
	}
	if imState == "ready" {
		return imtopicport.CompletionSucceeded, nil
	}
	return imtopicport.CompletionFailed, nil
}

func updateOperation(
	ctx context.Context,
	tx *ent.Tx,
	operationID string,
	completion imtopicport.Completion,
	status imtopicport.CompletionStatus,
) error {
	update := tx.TencentOperation.Update().
		Where(
			tencentoperation.IDEQ(operationID),
			tencentoperation.StateEQ("running"),
			tencentoperation.LeaseOwnerEQ(completion.LeaseOwner),
			tencentoperation.LeaseExpiresAtNotNil(),
			tencentoperation.LeaseExpiresAtGT(completion.CompletedAt.UTC()),
		).
		SetState(string(status)).
		ClearLeaseOwner().
		ClearLeaseExpiresAt().
		SetUpdatedAt(completion.CompletedAt.UTC())
	switch status {
	case imtopicport.CompletionRetry:
		update.
			SetNextAttemptAt(completion.NextAttemptAt.UTC()).
			SetLastErrorCode(completion.ErrorCode).
			ClearCompletedAt()
	case imtopicport.CompletionFailed:
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
		return imtopicport.ErrLeaseLost
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

func topicName(topicID string) (string, error) {
	const marker = "@TOPIC#_T_"
	index := strings.LastIndex(topicID, marker)
	if index < 0 {
		return "", errors.New("TopicId 格式无效")
	}
	suffix := topicID[index+len(marker):]
	if len(suffix) != 26 {
		return "", errors.New("TopicId 摘要长度无效")
	}
	return "C-" + suffix[:20], nil
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

func validateClaim(claim imtopicport.Claim) error {
	if strings.TrimSpace(claim.LeaseOwner) == "" ||
		claim.Now.IsZero() ||
		!claim.LeaseExpiresAt.After(claim.Now) {
		return errors.New("Topic 领取参数无效")
	}
	return nil
}

func validateCompletion(completion imtopicport.Completion) error {
	if strings.TrimSpace(completion.OperationID) == "" ||
		strings.TrimSpace(completion.LeaseOwner) == "" ||
		completion.CompletedAt.IsZero() {
		return errors.New("Topic 完成参数无效")
	}
	switch completion.Status {
	case imtopicport.CompletionSucceeded,
		imtopicport.CompletionSuperseded:
	case imtopicport.CompletionRetry:
		if strings.TrimSpace(completion.ErrorCode) == "" ||
			!completion.NextAttemptAt.After(completion.CompletedAt) {
			return errors.New("Topic 重试结果无效")
		}
	case imtopicport.CompletionFailed:
		if strings.TrimSpace(completion.ErrorCode) == "" {
			return errors.New("Topic 失败结果无效")
		}
	default:
		return errors.New("Topic 完成状态无效")
	}
	return nil
}

var _ imtopicport.Repository = (*EntRepository)(nil)
