// Package agentidentity 提供 Agent IM 身份 Worker 的 Ent Repository。
package agentidentity

import (
	"context"
	"errors"
	"strconv"
	"time"

	"chatserver/internal/database"
	"chatserver/internal/ent"
	"chatserver/internal/ent/agent"
	"chatserver/internal/ent/agentimroute"
	"chatserver/internal/ent/channelmember"
	"chatserver/internal/ent/member"
	"chatserver/internal/ent/outboxevent"
	"chatserver/internal/ent/predicate"
	"chatserver/internal/ent/tencentoperation"
	agentidentityport "chatserver/internal/ports/agentidentity"

	"github.com/google/uuid"
)

type EntRepository struct{ handle *database.Handle }

const (
	legacyRepairPartitionID = "0198f4c2-7a30-7a11-8c55-24db9f090001"
	legacyRepairKind        = "maintenance.agent_membership_backfill.v1"
)

func NewEntRepository(handle *database.Handle) (*EntRepository, error) {
	if handle == nil || handle.Client() == nil {
		return nil, errors.New("Agent IM 身份 Repository 缺少数据库 Handle")
	}
	return &EntRepository{handle: handle}, nil
}

// LegacyMembershipRepairCompleted 用固定 synthetic partition O(1) 判断一次性修复状态。
func (repository *EntRepository) LegacyMembershipRepairCompleted(
	ctx context.Context,
) (bool, error) {
	return repository.handle.Client().TencentOperation.Query().
		Where(
			tencentoperation.PartitionKeyEQ(legacyRepairPartitionID),
			tencentoperation.ServiceEQ("maintenance"),
			tencentoperation.KindEQ(legacyRepairKind),
			tencentoperation.ResourceTypeEQ("maintenance"),
			tencentoperation.ResourceIDEQ(legacyRepairPartitionID),
			tencentoperation.IdempotencyKeyEQ(legacyRepairKind),
			tencentoperation.StateEQ("succeeded"),
		).
		Exist(ctx)
}

// CompleteLegacyMembershipRepair 写入不被任何副作用 Worker 消费的终态 marker。
func (repository *EntRepository) CompleteLegacyMembershipRepair(
	ctx context.Context,
	operationID string,
	completedAt time.Time,
) error {
	if !validUUIDv7(operationID) || completedAt.IsZero() {
		return errors.New("旧 Agent membership 修复 marker 参数无效")
	}
	completed, err := repository.LegacyMembershipRepairCompleted(ctx)
	if err != nil || completed {
		return err
	}
	err = repository.handle.WithTx(
		ctx,
		func(ctx context.Context, tx *ent.Tx) error {
			exists, err := tx.TencentOperation.Query().
				Where(
					tencentoperation.PartitionKeyEQ(
						legacyRepairPartitionID,
					),
					tencentoperation.ServiceEQ("maintenance"),
					tencentoperation.IdempotencyKeyEQ(
						legacyRepairKind,
					),
				).
				Exist(ctx)
			if err != nil || exists {
				return err
			}
			_, err = tx.TencentOperation.Create().
				SetID(operationID).
				SetPartitionKey(legacyRepairPartitionID).
				SetService("maintenance").
				SetKind(legacyRepairKind).
				SetResourceType("maintenance").
				SetResourceID(legacyRepairPartitionID).
				SetIdempotencyKey(legacyRepairKind).
				SetState("succeeded").
				SetAttempts(1).
				SetCreatedAt(completedAt.UTC()).
				SetUpdatedAt(completedAt.UTC()).
				SetCompletedAt(completedAt.UTC()).
				Save(ctx)
			return err
		},
	)
	if !ent.IsConstraintError(err) {
		return err
	}
	completed, verifyErr := repository.LegacyMembershipRepairCompleted(ctx)
	if verifyErr != nil {
		return verifyErr
	}
	if completed {
		return nil
	}
	return err
}

// FindLegacyMembership 返回一个旧 Agent 入群候选，不修改任何状态。
func (repository *EntRepository) FindLegacyMembership(
	ctx context.Context,
) (agentidentityport.LegacyMembership, bool, error) {
	const pageSize = 100
	afterID := ""
	for {
		query := repository.handle.Client().Member.Query().
			Where(
				member.KindEQ("agent"),
				member.StatusEQ("active"),
				member.ImStateEQ("ready"),
			)
		if afterID != "" {
			query = query.Where(member.IDGT(afterID))
		}
		members, err := query.
			Order(ent.Asc(member.FieldID)).
			Limit(pageSize).
			All(ctx)
		if err != nil {
			return agentidentityport.LegacyMembership{}, false, err
		}
		if len(members) == 0 {
			return agentidentityport.LegacyMembership{}, false, nil
		}
		for _, memberEntity := range members {
			agentReady, err := repository.handle.Client().Agent.Query().
				Where(
					agent.IDEQ(memberEntity.ID),
					agent.ServerIDEQ(memberEntity.ServerID),
					agent.DeletedAtIsNil(),
					agent.ImStateEQ("ready"),
				).
				Exist(ctx)
			if err != nil {
				return agentidentityport.LegacyMembership{}, false, err
			}
			if !agentReady {
				continue
			}
			operationExists, err := repository.handle.Client().
				TencentOperation.Query().
				Where(
					tencentoperation.PartitionKeyEQ(
						memberEntity.ServerID,
					),
					tencentoperation.ServiceEQ("im"),
					tencentoperation.KindEQ(
						"im.membership.ensure",
					),
					tencentoperation.ResourceTypeEQ("member"),
					tencentoperation.ResourceIDEQ(memberEntity.ID),
				).
				Exist(ctx)
			if err != nil {
				return agentidentityport.LegacyMembership{}, false, err
			}
			if operationExists {
				continue
			}
			return agentidentityport.LegacyMembership{
				ServerID: memberEntity.ServerID,
				MemberID: memberEntity.ID,
				Revision: memberEntity.Revision,
			}, true, nil
		}
		afterID = members[len(members)-1].ID
	}
}

// ScheduleLegacyMembership 原子地把一个旧 Agent Member 重新交给 membership Worker。
func (repository *EntRepository) ScheduleLegacyMembership(
	ctx context.Context,
	command agentidentityport.LegacyMembershipSchedule,
) (scheduled bool, returnErr error) {
	if !validUUIDv7(command.ServerID) ||
		!validUUIDv7(command.MemberID) ||
		!validUUIDv7(command.OperationID) ||
		command.Revision <= 0 ||
		command.ScheduledAt.IsZero() {
		return false, errors.New("旧 Agent membership 修复参数无效")
	}
	returnErr = repository.handle.WithTx(
		ctx,
		func(ctx context.Context, tx *ent.Tx) error {
			memberEntity, err := tx.Member.Query().
				Where(
					member.IDEQ(command.MemberID),
					member.ServerIDEQ(command.ServerID),
					member.KindEQ("agent"),
					member.StatusEQ("active"),
					member.ImStateEQ("ready"),
					member.RevisionEQ(command.Revision),
				).
				Only(ctx)
			if ent.IsNotFound(err) {
				return nil
			}
			if err != nil {
				return err
			}
			agentReady, err := tx.Agent.Query().
				Where(
					agent.IDEQ(memberEntity.ID),
					agent.ServerIDEQ(memberEntity.ServerID),
					agent.DeletedAtIsNil(),
					agent.ImStateEQ("ready"),
				).
				Exist(ctx)
			if err != nil || !agentReady {
				return err
			}
			operationExists, err := tx.TencentOperation.Query().
				Where(
					tencentoperation.PartitionKeyEQ(
						memberEntity.ServerID,
					),
					tencentoperation.ServiceEQ("im"),
					tencentoperation.KindEQ(
						"im.membership.ensure",
					),
					tencentoperation.ResourceTypeEQ("member"),
					tencentoperation.ResourceIDEQ(memberEntity.ID),
				).
				Exist(ctx)
			if err != nil || operationExists {
				return err
			}
			nextRevision := memberEntity.Revision + 1
			updated, err := tx.Member.Update().
				Where(
					member.IDEQ(memberEntity.ID),
					member.ServerIDEQ(memberEntity.ServerID),
					member.ImStateEQ("ready"),
					member.RevisionEQ(memberEntity.Revision),
				).
				SetImState("provisioning").
				SetRevision(nextRevision).
				SetUpdatedAt(command.ScheduledAt.UTC()).
				Save(ctx)
			if err != nil {
				return err
			}
			if updated != 1 {
				return nil
			}
			operation, err := tx.TencentOperation.Create().
				SetID(command.OperationID).
				SetPartitionKey(memberEntity.ServerID).
				SetServerID(memberEntity.ServerID).
				SetService("im").
				SetKind("im.membership.ensure").
				SetResourceType("member").
				SetResourceID(memberEntity.ID).
				SetIdempotencyKey(
					"im.membership.ensure:v1:" + memberEntity.ID + ":" +
						strconv.FormatInt(nextRevision, 10),
				).
				SetDesiredRevision(nextRevision).
				SetState("pending").
				SetAttempts(0).
				SetCreatedAt(command.ScheduledAt.UTC()).
				SetUpdatedAt(command.ScheduledAt.UTC()).
				Save(ctx)
			if err != nil {
				return err
			}
			if _, err := tx.OutboxEvent.Create().
				SetPartitionKey(memberEntity.ServerID).
				SetServerID(memberEntity.ServerID).
				SetEventType("tencent.operation.ready").
				SetAggregateType("tencent_operation").
				SetAggregateID(operation.ID).
				SetState("pending").
				SetAttempts(0).
				SetAvailableAt(command.ScheduledAt.UTC()).
				SetCreatedAt(command.ScheduledAt.UTC()).
				Save(ctx); err != nil {
				return err
			}
			scheduled = true
			return nil
		},
	)
	return scheduled, returnErr
}

func (repository *EntRepository) Claim(
	ctx context.Context,
	claim agentidentityport.Claim,
) (work agentidentityport.Work, found bool, returnErr error) {
	if claim.LeaseOwner == "" || claim.Now.IsZero() ||
		!claim.LeaseExpiresAt.After(claim.Now) {
		return work, false, errors.New("Agent IM 身份领取参数无效")
	}
	returnErr = repository.handle.WithTx(
		ctx,
		func(ctx context.Context, tx *ent.Tx) error {
			due := dueOperationPredicate(claim.Now.UTC())
			operation, err := tx.TencentOperation.Query().
				Where(
					tencentoperation.ServiceEQ("im"),
					tencentoperation.KindIn(
						"im.identity.ensure",
						"im.identity.delete",
					),
					tencentoperation.ResourceTypeEQ("agent"),
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
			agentEntity, err := tx.Agent.Query().
				Where(agent.IDEQ(operation.ResourceID)).
				Only(ctx)
			if err != nil {
				return err
			}
			memberStatus := "active"
			if operation.Kind == "im.identity.delete" {
				memberStatus = "removed"
			}
			memberEntity, err := tx.Member.Query().
				Where(
					member.IDEQ(agentEntity.ID),
					member.ServerIDEQ(agentEntity.ServerID),
					member.KindEQ("agent"),
					member.StatusEQ(memberStatus),
				).
				Only(ctx)
			if err != nil {
				return err
			}
			desiredRevision := int64(-1)
			if operation.DesiredRevision != nil {
				desiredRevision = *operation.DesiredRevision
			}
			work = agentidentityport.Work{
				Kind:        operation.Kind,
				OperationID: operation.ID, LeaseOwner: claim.LeaseOwner,
				AgentID:         agentEntity.ID,
				DisplayName:     memberEntity.DisplayName,
				IMUserID:        agentEntity.ImUserID,
				IMState:         agentEntity.ImState,
				AgentRevision:   agentEntity.Revision,
				DesiredRevision: desiredRevision,
				Attempts:        operation.Attempts + 1,
				Deleted:         agentEntity.DeletedAt != nil,
			}
			found = true
			return nil
		},
	)
	return work, found, returnErr
}

// RevokeRoute 在 `im_user_id` 路由分片上幂等撤销 Agent 的全局回调入口。
func (repository *EntRepository) RevokeRoute(
	ctx context.Context,
	command agentidentityport.RouteRevocation,
) error {
	if !validUUIDv7(command.OperationID) ||
		!validUUIDv7(command.AgentID) ||
		command.LeaseOwner == "" || command.IMUserID == "" ||
		command.RevokedAt.IsZero() {
		return errors.New("Agent IM 路由撤销参数无效")
	}
	current, err := repository.handle.Client().TencentOperation.Query().
		Where(
			tencentoperation.IDEQ(command.OperationID),
			tencentoperation.ServiceEQ("im"),
			tencentoperation.KindEQ("im.identity.delete"),
			tencentoperation.ResourceTypeEQ("agent"),
			tencentoperation.ResourceIDEQ(command.AgentID),
			tencentoperation.StateEQ("running"),
			tencentoperation.LeaseOwnerEQ(command.LeaseOwner),
			tencentoperation.LeaseExpiresAtNotNil(),
			tencentoperation.LeaseExpiresAtGT(command.RevokedAt.UTC()),
		).
		Exist(ctx)
	if err != nil {
		return err
	}
	if !current {
		return agentidentityport.ErrLeaseLost
	}
	updated, err := repository.handle.Client().AgentIMRoute.Update().
		Where(
			agentimroute.ImUserIDEQ(command.IMUserID),
			agentimroute.AgentIDEQ(command.AgentID),
			agentimroute.StateEQ("active"),
		).
		SetState("revoked").
		SetUpdatedAt(command.RevokedAt.UTC()).
		Save(ctx)
	if err != nil || updated != 0 {
		return err
	}
	route, err := repository.handle.Client().AgentIMRoute.Query().
		Where(agentimroute.ImUserIDEQ(command.IMUserID)).
		Only(ctx)
	if ent.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if route.AgentID != command.AgentID || route.State != "revoked" {
		return errors.New("Agent IM 路由与删除目标不一致")
	}
	return nil
}

func (repository *EntRepository) Complete(
	ctx context.Context,
	completion agentidentityport.Completion,
) error {
	if completion.OperationID == "" || completion.LeaseOwner == "" ||
		completion.CompletedAt.IsZero() {
		return errors.New("Agent IM 身份完成参数无效")
	}
	return repository.handle.WithTx(
		ctx,
		func(ctx context.Context, tx *ent.Tx) error {
			operation, err := tx.TencentOperation.Query().
				Where(
					tencentoperation.IDEQ(completion.OperationID),
					tencentoperation.ServiceEQ("im"),
					tencentoperation.KindIn(
						"im.identity.ensure",
						"im.identity.delete",
					),
					tencentoperation.ResourceTypeEQ("agent"),
					tencentoperation.StateEQ("running"),
					tencentoperation.LeaseOwnerEQ(completion.LeaseOwner),
					tencentoperation.LeaseExpiresAtNotNil(),
					tencentoperation.LeaseExpiresAtGT(
						completion.CompletedAt.UTC(),
					),
				).
				Only(ctx)
			if ent.IsNotFound(err) {
				return agentidentityport.ErrLeaseLost
			}
			if err != nil {
				return err
			}
			status := completion.Status
			if operation.Kind == "im.identity.delete" {
				switch status {
				case agentidentityport.CompletionSucceeded:
					status, err = completeDeletion(
						ctx, tx, operation, "deleted",
						completion.CompletedAt.UTC(),
					)
				case agentidentityport.CompletionFailed:
					status, err = completeDeletion(
						ctx, tx, operation, "error",
						completion.CompletedAt.UTC(),
					)
				}
			} else {
				if status == agentidentityport.CompletionSucceeded &&
					!validUUIDv7(completion.MembershipOperationID) {
					return errors.New("Agent Community membership 操作 ID 无效")
				}
				switch status {
				case agentidentityport.CompletionSucceeded:
					status, err = completeIdentity(
						ctx, tx, operation, "ready",
						completion.MembershipOperationID,
						completion.CompletedAt.UTC(),
					)
				case agentidentityport.CompletionFailed:
					status, err = completeIdentity(
						ctx, tx, operation, "error", "",
						completion.CompletedAt.UTC(),
					)
				}
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
			if status != agentidentityport.CompletionRetry {
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

func completeIdentity(
	ctx context.Context,
	tx *ent.Tx,
	operation *ent.TencentOperation,
	imState string,
	membershipOperationID string,
	at time.Time,
) (agentidentityport.CompletionStatus, error) {
	agentEntity, err := tx.Agent.Query().
		Where(
			agent.IDEQ(operation.ResourceID),
			agent.DeletedAtIsNil(),
		).
		Only(ctx)
	if err != nil {
		return "", err
	}
	if operation.DesiredRevision == nil ||
		agentEntity.Revision != *operation.DesiredRevision {
		return agentidentityport.CompletionSuperseded, nil
	}
	memberEntity, err := tx.Member.Query().
		Where(
			member.IDEQ(agentEntity.ID),
			member.ServerIDEQ(agentEntity.ServerID),
			member.KindEQ("agent"),
			member.StatusEQ("active"),
		).
		Only(ctx)
	if err != nil {
		return "", err
	}
	updated, err := tx.Agent.Update().
		Where(
			agent.IDEQ(agentEntity.ID),
			agent.RevisionEQ(agentEntity.Revision),
		).
		SetImState(imState).
		AddRevision(1).
		SetUpdatedAt(at).
		Save(ctx)
	if err != nil {
		return "", err
	}
	if updated != 1 {
		return agentidentityport.CompletionSuperseded, nil
	}
	if imState == "ready" {
		membershipOperation, err := tx.TencentOperation.Create().
			SetID(membershipOperationID).
			SetPartitionKey(memberEntity.ServerID).
			SetServerID(memberEntity.ServerID).
			SetService("im").
			SetKind("im.membership.ensure").
			SetResourceType("member").
			SetResourceID(memberEntity.ID).
			SetIdempotencyKey(
				"im.membership.ensure:v1:" + memberEntity.ID + ":" +
					strconv.FormatInt(memberEntity.Revision, 10),
			).
			SetDesiredRevision(memberEntity.Revision).
			SetState("pending").
			SetAttempts(0).
			SetCreatedAt(at).
			SetUpdatedAt(at).
			Save(ctx)
		if err != nil {
			return "", err
		}
		if _, err := tx.OutboxEvent.Create().
			SetPartitionKey(memberEntity.ServerID).
			SetServerID(memberEntity.ServerID).
			SetEventType("tencent.operation.ready").
			SetAggregateType("tencent_operation").
			SetAggregateID(membershipOperation.ID).
			SetState("pending").
			SetAttempts(0).
			SetAvailableAt(at).
			SetCreatedAt(at).
			Save(ctx); err != nil {
			return "", err
		}
		return agentidentityport.CompletionSucceeded, nil
	}
	updated, err = tx.Member.Update().
		Where(
			member.IDEQ(memberEntity.ID),
			member.RevisionEQ(memberEntity.Revision),
		).
		SetImState(imState).
		AddRevision(1).
		SetUpdatedAt(at).
		Save(ctx)
	if err != nil {
		return "", err
	}
	if updated != 1 {
		return "", errors.New("Agent Member IM 状态发生并发冲突")
	}
	return agentidentityport.CompletionFailed, nil
}

func completeDeletion(
	ctx context.Context,
	tx *ent.Tx,
	operation *ent.TencentOperation,
	imState string,
	at time.Time,
) (agentidentityport.CompletionStatus, error) {
	agentEntity, err := tx.Agent.Query().
		Where(
			agent.IDEQ(operation.ResourceID),
			agent.DeletedAtNotNil(),
		).
		Only(ctx)
	if ent.IsNotFound(err) {
		return agentidentityport.CompletionSuperseded, nil
	}
	if err != nil {
		return "", err
	}
	if operation.DesiredRevision == nil ||
		agentEntity.Revision != *operation.DesiredRevision {
		return agentidentityport.CompletionSuperseded, nil
	}
	memberEntity, err := tx.Member.Query().
		Where(
			member.IDEQ(agentEntity.ID),
			member.ServerIDEQ(agentEntity.ServerID),
			member.KindEQ("agent"),
			member.StatusEQ("removed"),
		).
		Only(ctx)
	if err != nil {
		return "", err
	}
	updated, err := tx.Agent.Update().
		Where(
			agent.IDEQ(agentEntity.ID),
			agent.DeletedAtNotNil(),
			agent.RevisionEQ(agentEntity.Revision),
		).
		SetImState(imState).
		AddRevision(1).
		SetUpdatedAt(at).
		Save(ctx)
	if err != nil {
		return "", err
	}
	if updated != 1 {
		return agentidentityport.CompletionSuperseded, nil
	}
	updated, err = tx.Member.Update().
		Where(
			member.IDEQ(memberEntity.ID),
			member.StatusEQ("removed"),
			member.RevisionEQ(memberEntity.Revision),
		).
		SetImState(imState).
		AddRevision(1).
		SetUpdatedAt(at).
		Save(ctx)
	if err != nil {
		return "", err
	}
	if updated != 1 {
		return "", errors.New("已删除 Agent Member IM 状态发生并发冲突")
	}
	projectionState := "removed"
	if imState == "error" {
		projectionState = "error"
	}
	if _, err := tx.ChannelMember.Update().
		Where(
			channelmember.ServerIDEQ(agentEntity.ServerID),
			channelmember.MemberIDEQ(agentEntity.ID),
			channelmember.StateEQ("removed"),
			channelmember.ImStateEQ("removing"),
		).
		SetImState(projectionState).
		SetUpdatedAt(at).
		Save(ctx); err != nil {
		return "", err
	}
	if imState == "deleted" {
		return agentidentityport.CompletionSucceeded, nil
	}
	return agentidentityport.CompletionFailed, nil
}

func validUUIDv7(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed != uuid.Nil && parsed.Version() == 7
}

func updateOperation(
	ctx context.Context,
	tx *ent.Tx,
	operationID string,
	completion agentidentityport.Completion,
	status agentidentityport.CompletionStatus,
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
	case agentidentityport.CompletionRetry:
		update.
			SetNextAttemptAt(completion.NextAttemptAt.UTC()).
			SetLastErrorCode(completion.ErrorCode).
			ClearCompletedAt()
	case agentidentityport.CompletionFailed:
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
		return agentidentityport.ErrLeaseLost
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

var _ agentidentityport.Repository = (*EntRepository)(nil)
