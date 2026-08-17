// Package immembership 提供腾讯云 IM 成员同步的 Ent Repository。
package immembership

import (
	"context"
	"errors"
	"strings"
	"time"

	"chatserver/internal/database"
	"chatserver/internal/ent"
	"chatserver/internal/ent/account"
	"chatserver/internal/ent/agent"
	"chatserver/internal/ent/channel"
	"chatserver/internal/ent/channelmember"
	"chatserver/internal/ent/member"
	"chatserver/internal/ent/outboxevent"
	"chatserver/internal/ent/predicate"
	"chatserver/internal/ent/server"
	"chatserver/internal/ent/tencentoperation"
	immembershipport "chatserver/internal/ports/immembership"
)

type EntRepository struct{ handle *database.Handle }

func NewEntRepository(handle *database.Handle) (*EntRepository, error) {
	if handle == nil || handle.Client() == nil {
		return nil, errors.New("IM membership Repository 缺少数据库 Handle")
	}
	return &EntRepository{handle: handle}, nil
}

func (repository *EntRepository) Claim(
	ctx context.Context,
	claim immembershipport.Claim,
) (work immembershipport.Work, found bool, returnErr error) {
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
					tencentoperation.KindIn(
						"im.membership.ensure",
						"im.membership.remove",
					),
					tencentoperation.ResourceTypeIn(
						"member",
						"channel_member",
					),
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

func loadWork(
	ctx context.Context,
	tx *ent.Tx,
	operation *ent.TencentOperation,
	leaseOwner string,
) (immembershipport.Work, error) {
	if operation.ResourceType == "channel_member" {
		return loadChannelMemberWork(ctx, tx, operation, leaseOwner)
	}
	memberEntity, err := tx.Member.Query().
		Where(member.IDEQ(operation.ResourceID)).
		Only(ctx)
	if err != nil {
		return immembershipport.Work{}, err
	}
	serverEntity, err := tx.Server.Query().
		Where(server.IDEQ(memberEntity.ServerID)).
		Only(ctx)
	if err != nil {
		return immembershipport.Work{}, err
	}
	imUserID := ""
	if memberEntity.AccountID != nil {
		accountEntity, err := tx.Account.Query().
			Where(
				account.IDEQ(*memberEntity.AccountID),
				account.ImStateEQ("ready"),
			).
			Only(ctx)
		if err != nil {
			return immembershipport.Work{}, err
		}
		imUserID = accountEntity.ImUserID
	} else if memberEntity.Kind == "agent" {
		agentEntity, err := tx.Agent.Query().
			Where(
				agent.IDEQ(memberEntity.ID),
				agent.ServerIDEQ(memberEntity.ServerID),
			).
			Only(ctx)
		if err != nil {
			return immembershipport.Work{}, err
		}
		imUserID = agentEntity.ImUserID
	}
	if strings.TrimSpace(imUserID) == "" {
		return immembershipport.Work{}, errors.New("Member 缺少 IM UserID")
	}
	desiredRevision := int64(-1)
	if operation.DesiredRevision != nil {
		desiredRevision = *operation.DesiredRevision
	}
	return immembershipport.Work{
		OperationID: operation.ID, LeaseOwner: leaseOwner,
		Kind: operation.Kind, ResourceType: operation.ResourceType,
		ServerID: memberEntity.ServerID,
		MemberID: memberEntity.ID, GroupID: serverEntity.ImGroupID,
		IMUserID: imUserID, IMState: memberEntity.ImState,
		MemberRevision:  memberEntity.Revision,
		DesiredRevision: desiredRevision,
		Attempts:        operation.Attempts + 1,
	}, nil
}

func loadChannelMemberWork(
	ctx context.Context,
	tx *ent.Tx,
	operation *ent.TencentOperation,
	leaseOwner string,
) (immembershipport.Work, error) {
	membership, err := tx.ChannelMember.Query().
		Where(channelmember.IDEQ(operation.ResourceID)).
		Only(ctx)
	if err != nil {
		return immembershipport.Work{}, err
	}
	channelEntity, err := tx.Channel.Query().
		Where(
			channel.IDEQ(membership.ChannelID),
			channel.ServerIDEQ(membership.ServerID),
		).
		Only(ctx)
	if err != nil {
		return immembershipport.Work{}, err
	}
	if channelEntity.ImTopicID == nil {
		return immembershipport.Work{}, errors.New(
			"普通 Channel 缺少 TopicID",
		)
	}
	memberEntity, err := tx.Member.Query().
		Where(member.IDEQ(membership.MemberID)).
		Only(ctx)
	if err != nil {
		return immembershipport.Work{}, err
	}
	imUserID, err := memberIMUserID(ctx, tx, memberEntity)
	if err != nil {
		return immembershipport.Work{}, err
	}
	desiredRevision := int64(-1)
	if operation.DesiredRevision != nil {
		desiredRevision = *operation.DesiredRevision
	}
	return immembershipport.Work{
		OperationID: operation.ID, LeaseOwner: leaseOwner,
		Kind: operation.Kind, ResourceType: operation.ResourceType,
		ServerID: membership.ServerID,
		MemberID: membership.MemberID, GroupID: channelEntity.ImGroupID,
		TopicID:         strings.TrimSpace(*channelEntity.ImTopicID),
		IMUserID:        imUserID,
		IMState:         membership.ImState,
		MemberRevision:  membership.MembershipVersion,
		DesiredRevision: desiredRevision,
		Attempts:        operation.Attempts + 1,
	}, nil
}

func memberIMUserID(
	ctx context.Context,
	tx *ent.Tx,
	memberEntity *ent.Member,
) (string, error) {
	if memberEntity.AccountID != nil {
		accountEntity, err := tx.Account.Query().
			Where(
				account.IDEQ(*memberEntity.AccountID),
				account.ImStateEQ("ready"),
			).
			Only(ctx)
		if err != nil {
			return "", err
		}
		return accountEntity.ImUserID, nil
	}
	if memberEntity.Kind == "agent" {
		agentEntity, err := tx.Agent.Query().
			Where(
				agent.IDEQ(memberEntity.ID),
				agent.ServerIDEQ(memberEntity.ServerID),
			).
			Only(ctx)
		if err != nil {
			return "", err
		}
		return agentEntity.ImUserID, nil
	}
	return "", errors.New("Member 缺少 IM UserID")
}

func (repository *EntRepository) Complete(
	ctx context.Context,
	completion immembershipport.Completion,
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
					tencentoperation.KindIn(
						"im.membership.ensure",
						"im.membership.remove",
					),
					tencentoperation.StateEQ("running"),
					tencentoperation.LeaseOwnerEQ(completion.LeaseOwner),
					tencentoperation.LeaseExpiresAtNotNil(),
					tencentoperation.LeaseExpiresAtGT(
						completion.CompletedAt.UTC(),
					),
				).
				Only(ctx)
			if ent.IsNotFound(err) {
				return immembershipport.ErrLeaseLost
			}
			if err != nil {
				return err
			}
			status := completion.Status
			if status == immembershipport.CompletionSucceeded ||
				status == immembershipport.CompletionFailed {
				if operation.ResourceType == "channel_member" {
					status, err = completeChannelMember(
						ctx,
						tx,
						operation,
						status,
						completion.CompletedAt.UTC(),
					)
				} else {
					status, err = completeMember(
						ctx,
						tx,
						operation,
						status,
						completion.CompletedAt.UTC(),
					)
				}
				if err != nil {
					return err
				}
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
			if status != immembershipport.CompletionRetry {
				return processOutbox(
					ctx,
					tx,
					operation.ID,
					completion.CompletedAt.UTC(),
				)
			}
			return nil
		},
	)
}

func completeChannelMember(
	ctx context.Context,
	tx *ent.Tx,
	operation *ent.TencentOperation,
	status immembershipport.CompletionStatus,
	at time.Time,
) (immembershipport.CompletionStatus, error) {
	entity, err := tx.ChannelMember.Query().
		Where(channelmember.IDEQ(operation.ResourceID)).
		Only(ctx)
	if err != nil {
		return "", err
	}
	if operation.DesiredRevision == nil ||
		entity.MembershipVersion != *operation.DesiredRevision {
		return immembershipport.CompletionSuperseded, nil
	}
	imState := "error"
	if status == immembershipport.CompletionSucceeded {
		if operation.Kind == "im.membership.remove" {
			imState = "removed"
		} else {
			imState = "ready"
		}
	}
	updated, err := tx.ChannelMember.Update().
		Where(
			channelmember.IDEQ(entity.ID),
			channelmember.MembershipVersionEQ(entity.MembershipVersion),
		).
		SetImState(imState).
		AddMembershipVersion(1).
		SetUpdatedAt(at).
		Save(ctx)
	if err != nil {
		return "", err
	}
	if updated != 1 {
		return immembershipport.CompletionSuperseded, nil
	}
	return status, nil
}

func completeMember(
	ctx context.Context,
	tx *ent.Tx,
	operation *ent.TencentOperation,
	status immembershipport.CompletionStatus,
	at time.Time,
) (immembershipport.CompletionStatus, error) {
	entity, err := tx.Member.Query().
		Where(member.IDEQ(operation.ResourceID)).
		Only(ctx)
	if err != nil {
		return "", err
	}
	if operation.DesiredRevision == nil ||
		entity.Revision != *operation.DesiredRevision {
		return immembershipport.CompletionSuperseded, nil
	}
	imState := "error"
	if status == immembershipport.CompletionSucceeded {
		if operation.Kind == "im.membership.remove" {
			imState = "removed"
		} else {
			imState = "ready"
		}
	}
	updated, err := tx.Member.Update().
		Where(
			member.IDEQ(entity.ID),
			member.RevisionEQ(entity.Revision),
		).
		SetImState(imState).
		AddRevision(1).
		SetUpdatedAt(at).
		Save(ctx)
	if err != nil {
		return "", err
	}
	if updated != 1 {
		return immembershipport.CompletionSuperseded, nil
	}
	return status, nil
}

func updateOperation(
	ctx context.Context,
	tx *ent.Tx,
	operationID string,
	completion immembershipport.Completion,
	status immembershipport.CompletionStatus,
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
	case immembershipport.CompletionRetry:
		update.
			SetNextAttemptAt(completion.NextAttemptAt.UTC()).
			SetLastErrorCode(completion.ErrorCode).
			ClearCompletedAt()
	case immembershipport.CompletionFailed:
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
		return immembershipport.ErrLeaseLost
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

func validateClaim(claim immembershipport.Claim) error {
	if strings.TrimSpace(claim.LeaseOwner) == "" ||
		claim.Now.IsZero() || !claim.LeaseExpiresAt.After(claim.Now) {
		return errors.New("IM membership 领取参数无效")
	}
	return nil
}

func validateCompletion(completion immembershipport.Completion) error {
	if strings.TrimSpace(completion.OperationID) == "" ||
		strings.TrimSpace(completion.LeaseOwner) == "" ||
		completion.CompletedAt.IsZero() {
		return errors.New("IM membership 完成参数无效")
	}
	switch completion.Status {
	case immembershipport.CompletionSucceeded,
		immembershipport.CompletionSuperseded:
	case immembershipport.CompletionRetry:
		if strings.TrimSpace(completion.ErrorCode) == "" ||
			!completion.NextAttemptAt.After(completion.CompletedAt) {
			return errors.New("IM membership 重试结果无效")
		}
	case immembershipport.CompletionFailed:
		if strings.TrimSpace(completion.ErrorCode) == "" {
			return errors.New("IM membership 失败结果无效")
		}
	default:
		return errors.New("IM membership 完成状态无效")
	}
	return nil
}

var _ immembershipport.Repository = (*EntRepository)(nil)
