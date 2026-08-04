// Package agent 使用 Ent/SQLite 保存 Agent、Member 和可靠腾讯云操作。
package agent

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"chatserver/internal/database"
	"chatserver/internal/ent"
	"chatserver/internal/ent/accountservermembership"
	agententity "chatserver/internal/ent/agent"
	"chatserver/internal/ent/agentruntimecredential"
	"chatserver/internal/ent/channelmember"
	"chatserver/internal/ent/computer"
	"chatserver/internal/ent/idempotencyrecord"
	"chatserver/internal/ent/member"
	"chatserver/internal/ent/reminder"
	"chatserver/internal/ent/reminderoccurrence"
	"chatserver/internal/ent/server"
	"chatserver/internal/ent/task"
	"chatserver/internal/ent/tencentoperation"
	"chatserver/internal/persistedjson"
	agentport "chatserver/internal/ports/agent"
)

type EntRepository struct{ handle *database.Handle }

func NewEntRepository(handle *database.Handle) (*EntRepository, error) {
	if handle == nil || handle.Client() == nil {
		return nil, errors.New("Agent Repository 缺少数据库 Handle")
	}
	return &EntRepository{handle: handle}, nil
}

func (repository *EntRepository) GetServerContext(
	ctx context.Context,
	accountID string,
	serverID string,
) (agentport.ServerContext, error) {
	membership, err := repository.activeMembership(ctx, accountID, serverID)
	if err != nil {
		return agentport.ServerContext{}, err
	}
	entity, err := repository.handle.Client().Server.Query().
		Where(server.IDEQ(serverID)).
		Only(ctx)
	if ent.IsNotFound(err) {
		return agentport.ServerContext{}, agentport.ErrServerNotFound
	}
	if err != nil {
		return agentport.ServerContext{}, err
	}
	return agentport.ServerContext{
		Role:            membership.Role,
		IMState:         entity.ImState,
		CreatorMemberID: membership.MemberID,
	}, nil
}

func (repository *EntRepository) Create(
	ctx context.Context,
	command agentport.CreateCommand,
) (result agentport.CreateResult, returnErr error) {
	returnErr = repository.handle.WithTx(
		ctx,
		func(ctx context.Context, tx *ent.Tx) error {
			membership, err := requireMembership(
				ctx, tx, command.AccountID, command.ServerID,
			)
			if err != nil {
				return err
			}
			if !canManage(membership.Role) {
				return agentport.ErrPermissionDenied
			}
			stored, err := findIdempotency(
				ctx,
				tx,
				command.ServerID,
				"agent.create",
				command.ServerID,
				command.IdempotencyKey,
			)
			if err == nil {
				if !sameHash(stored.RequestHash, command.RequestHash) {
					return agentport.ErrIdempotencyConflict
				}
				agentID, operationID, err := decodeLocator(
					stored.ResponseBodyJSON,
					"agent.create",
				)
				if err != nil {
					return err
				}
				return loadCreateResult(
					ctx,
					tx,
					command.ServerID,
					agentID,
					operationID,
					&result,
				)
			}
			if !ent.IsNotFound(err) {
				return err
			}
			serverEntity, err := tx.Server.Query().
				Where(server.IDEQ(command.ServerID)).
				Only(ctx)
			if ent.IsNotFound(err) {
				return agentport.ErrServerNotFound
			}
			if err != nil {
				return err
			}
			if serverEntity.ImState != "ready" {
				return agentport.ErrServerNotFound
			}
			if command.Agent.CreatorMemberID != membership.MemberID {
				return agentport.ErrPermissionDenied
			}
			if err := requireAssignableComputer(
				ctx,
				tx,
				command.ServerID,
				command.Agent.ComputerID,
			); err != nil {
				return err
			}
			conflict, err := tx.Member.Query().
				Where(
					member.ServerIDEQ(command.ServerID),
					member.ActiveHandleKeyEQ(command.Agent.Handle),
				).
				Exist(ctx)
			if err != nil {
				return err
			}
			if conflict {
				return agentport.ErrHandleConflict
			}
			now := command.CreatedAt.UTC()
			if _, err := tx.Member.Create().
				SetID(command.Agent.ID).
				SetServerID(command.ServerID).
				SetKind("agent").
				SetRole("member").
				SetDisplayName(command.Agent.DisplayName).
				SetHandle(command.Agent.Handle).
				SetActiveHandleKey(command.Agent.Handle).
				SetStatus("active").
				SetImState("provisioning").
				SetRevision(1).
				SetCreatedAt(now).
				SetUpdatedAt(now).
				Save(ctx); err != nil {
				if ent.IsConstraintError(err) {
					return agentport.ErrHandleConflict
				}
				return err
			}
			entity, err := tx.Agent.Create().
				SetID(command.Agent.ID).
				SetServerID(command.ServerID).
				SetImUserID(command.Agent.IMUserID).
				SetNillableComputerID(command.Agent.ComputerID).
				SetNillableDescription(command.Agent.Description).
				SetRuntimeKind(command.Agent.Runtime.Kind).
				SetNillableRuntimeModel(command.Agent.Runtime.Model).
				SetReplyPolicy(command.Agent.ReplyPolicy).
				SetDesiredState("stopped").
				SetObservedState("unknown").
				SetCredentialVersion(0).
				SetImState("provisioning").
				SetImPresence("unknown").
				SetCreatedByMemberID(command.Agent.CreatorMemberID).
				SetRevision(1).
				SetCreatedAt(now).
				SetUpdatedAt(now).
				Save(ctx)
			if err != nil {
				return err
			}
			if err := bumpComputerAssignments(
				ctx,
				tx,
				command.ServerID,
				[]*string{command.Agent.ComputerID},
				now,
			); err != nil {
				return err
			}
			if _, err := tx.AgentIMRoute.Create().
				SetID(entity.ID).
				SetImUserID(entity.ImUserID).
				SetServerID(entity.ServerID).
				SetAgentID(entity.ID).
				SetState("active").
				SetCreatedAt(now).
				SetUpdatedAt(now).
				Save(ctx); err != nil {
				return err
			}
			operation, err := createOperation(
				ctx,
				tx,
				command.OperationID,
				command.ServerID,
				"im",
				"im.identity.ensure",
				entity.ID,
				1,
				"im.identity.ensure:v1:"+entity.ID+":1",
				nil,
				nil,
				now,
			)
			if err != nil {
				return err
			}
			if err := createOutbox(ctx, tx, command.ServerID, operation.ID, now); err != nil {
				return err
			}
			if err := saveIdempotency(
				ctx,
				tx,
				command.ServerID,
				"agent.create",
				command.ServerID,
				command.IdempotencyKey,
				command.RequestHash,
				entity.ID,
				operation.ID,
				now,
			); err != nil {
				return err
			}
			result = agentport.CreateResult{
				Agent:     mapAgent(entity, command.Agent.DisplayName, command.Agent.Handle),
				Operation: mapOperation(operation),
			}
			return nil
		},
	)
	return result, returnErr
}

func (repository *EntRepository) List(
	ctx context.Context,
	accountID string,
	serverID string,
) ([]agentport.Agent, error) {
	if _, err := repository.activeMembership(ctx, accountID, serverID); err != nil {
		return nil, err
	}
	entities, err := repository.handle.Client().Agent.Query().
		Where(
			agententity.ServerIDEQ(serverID),
			agententity.DeletedAtIsNil(),
		).
		Order(ent.Asc(agententity.FieldID)).
		All(ctx)
	if err != nil {
		return nil, err
	}
	values := make([]agentport.Agent, 0, len(entities))
	for _, entity := range entities {
		memberEntity, err := repository.handle.Client().Member.Query().
			Where(
				member.IDEQ(entity.ID),
				member.ServerIDEQ(serverID),
				member.KindEQ("agent"),
				member.StatusEQ("active"),
			).
			Only(ctx)
		if ent.IsNotFound(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		values = append(
			values,
			mapAgent(entity, memberEntity.DisplayName, memberEntity.Handle),
		)
	}
	return values, nil
}

func (repository *EntRepository) Get(
	ctx context.Context,
	accountID string,
	serverID string,
	agentID string,
) (agentport.Agent, error) {
	if _, err := repository.activeMembership(ctx, accountID, serverID); err != nil {
		return agentport.Agent{}, err
	}
	entity, memberEntity, err := repository.loadAgent(
		ctx,
		serverID,
		agentID,
	)
	if err != nil {
		return agentport.Agent{}, err
	}
	return mapAgent(entity, memberEntity.DisplayName, memberEntity.Handle), nil
}

func (repository *EntRepository) Update(
	ctx context.Context,
	command agentport.UpdateCommand,
) (result agentport.Agent, returnErr error) {
	returnErr = repository.handle.WithTx(
		ctx,
		func(ctx context.Context, tx *ent.Tx) error {
			membership, err := requireMembership(
				ctx, tx, command.AccountID, command.ServerID,
			)
			if err != nil {
				return err
			}
			if !canManage(membership.Role) {
				return agentport.ErrPermissionDenied
			}
			const scope = "agent.update"
			stored, err := findIdempotency(
				ctx,
				tx,
				command.ServerID,
				scope,
				command.AgentID,
				command.IdempotencyKey,
			)
			if err == nil {
				if !sameHash(stored.RequestHash, command.RequestHash) {
					return agentport.ErrIdempotencyConflict
				}
				_, err = persistedjson.DecodeScoped(
					stored.ResponseBodyJSON, scope, &result,
				)
				return err
			}
			if !ent.IsNotFound(err) {
				return err
			}
			entity, memberEntity, err := loadAgentInTx(
				ctx, tx, command.ServerID, command.AgentID,
			)
			if err != nil {
				return err
			}
			if entity.Revision != command.Revision {
				return agentport.ErrRevisionConflict
			}
			if command.Patch.Runtime != nil ||
				command.Patch.ComputerIDSet {
				if entity.DesiredState != "stopped" ||
					(entity.ObservedState != "unknown" &&
						entity.ObservedState != "stopped" &&
						entity.ObservedState != "error") {
					return agentport.ErrAgentMustBeStopped
				}
			}
			if command.Patch.ComputerIDSet {
				if err := requireAssignableComputer(
					ctx,
					tx,
					command.ServerID,
					command.Patch.ComputerID,
				); err != nil {
					return err
				}
			}
			now := command.UpdatedAt.UTC()
			if command.Patch.DisplayName != nil {
				updated, err := tx.Member.Update().
					Where(
						member.IDEQ(memberEntity.ID),
						member.ServerIDEQ(command.ServerID),
						member.KindEQ("agent"),
						member.StatusEQ("active"),
					).
					SetDisplayName(*command.Patch.DisplayName).
					AddRevision(1).
					SetUpdatedAt(now).
					Save(ctx)
				if err != nil {
					return err
				}
				if updated != 1 {
					return agentport.ErrRevisionConflict
				}
				memberEntity.DisplayName = *command.Patch.DisplayName
			}
			update := tx.Agent.Update().
				Where(
					agententity.IDEQ(entity.ID),
					agententity.ServerIDEQ(command.ServerID),
					agententity.RevisionEQ(command.Revision),
				).
				SetRevision(command.Revision + 1).
				SetUpdatedAt(now)
			if command.Patch.DescriptionSet {
				if command.Patch.Description == nil {
					update.ClearDescription()
				} else {
					update.SetDescription(*command.Patch.Description)
				}
			}
			if command.Patch.ComputerIDSet {
				update.SetComputerID(*command.Patch.ComputerID)
			}
			if command.Patch.Runtime != nil {
				update.SetRuntimeKind(command.Patch.Runtime.Kind)
				if command.Patch.Runtime.Model == nil {
					update.ClearRuntimeModel()
				} else {
					update.SetRuntimeModel(*command.Patch.Runtime.Model)
				}
			}
			if command.Patch.ReplyPolicy != nil {
				update.SetReplyPolicy(*command.Patch.ReplyPolicy)
			}
			updated, err := update.Save(ctx)
			if err != nil {
				return err
			}
			if updated != 1 {
				return agentport.ErrRevisionConflict
			}
			if command.Patch.Runtime != nil || command.Patch.ReplyPolicy != nil ||
				command.Patch.ComputerIDSet {
				nextComputerID := entity.ComputerID
				if command.Patch.ComputerIDSet {
					nextComputerID = command.Patch.ComputerID
				}
				if err := bumpComputerAssignments(
					ctx,
					tx,
					command.ServerID,
					[]*string{entity.ComputerID, nextComputerID},
					now,
				); err != nil {
					return err
				}
			}
			entity, err = tx.Agent.Query().
				Where(
					agententity.IDEQ(command.AgentID),
					agententity.ServerIDEQ(command.ServerID),
				).
				Only(ctx)
			if err != nil {
				return err
			}
			result = mapAgent(
				entity,
				memberEntity.DisplayName,
				memberEntity.Handle,
			)
			return saveAgentUpdateIdempotency(
				ctx,
				tx,
				command,
				result,
				now,
			)
		},
	)
	return result, returnErr
}

// Delete 在业务事实层墓碑 Agent，并提交可靠的腾讯 IM account_delete 操作。
// Computer/TAT 不属于 Agent 生命周期；Computer 只通过 Assignment revision 收敛。
func (repository *EntRepository) Delete(
	ctx context.Context,
	command agentport.DeleteCommand,
) (result agentport.Operation, returnErr error) {
	returnErr = repository.handle.WithTx(
		ctx,
		func(ctx context.Context, tx *ent.Tx) error {
			membership, err := requireMembership(
				ctx, tx, command.AccountID, command.ServerID,
			)
			if err != nil {
				return err
			}
			if !canManage(membership.Role) {
				return agentport.ErrPermissionDenied
			}
			const scope = "agent.delete"
			stored, err := findIdempotency(
				ctx,
				tx,
				command.ServerID,
				scope,
				command.AgentID,
				command.IdempotencyKey,
			)
			if err == nil {
				if !sameHash(stored.RequestHash, command.RequestHash) {
					return agentport.ErrIdempotencyConflict
				}
				_, operationID, err := decodeLocator(
					stored.ResponseBodyJSON, scope,
				)
				if err != nil {
					return err
				}
				operation, err := tx.TencentOperation.Query().
					Where(tencentoperation.IDEQ(operationID)).
					Only(ctx)
				if err != nil {
					return err
				}
				result = mapOperation(operation)
				return nil
			}
			if !ent.IsNotFound(err) {
				return err
			}
			tombstone, err := tx.Agent.Query().
				Where(
					agententity.IDEQ(command.AgentID),
					agententity.ServerIDEQ(command.ServerID),
					agententity.DeletedAtNotNil(),
				).
				Only(ctx)
			if err == nil {
				operation, err := tx.TencentOperation.Query().
					Where(
						tencentoperation.PartitionKeyEQ(command.ServerID),
						tencentoperation.ServiceEQ("im"),
						tencentoperation.KindEQ("im.identity.delete"),
						tencentoperation.ResourceTypeEQ("agent"),
						tencentoperation.ResourceIDEQ(tombstone.ID),
					).
					Order(ent.Asc(tencentoperation.FieldCreatedAt)).
					First(ctx)
				if err != nil {
					return err
				}
				if err := saveIdempotency(
					ctx,
					tx,
					command.ServerID,
					scope,
					command.AgentID,
					command.IdempotencyKey,
					command.RequestHash,
					command.AgentID,
					operation.ID,
					command.DeletedAt.UTC(),
				); err != nil {
					return err
				}
				result = mapOperation(operation)
				return nil
			}
			if err != nil && !ent.IsNotFound(err) {
				return err
			}

			entity, memberEntity, err := loadAgentInTx(
				ctx, tx, command.ServerID, command.AgentID,
			)
			if err != nil {
				return err
			}
			now := command.DeletedAt.UTC()
			nextRevision := entity.Revision + 1
			updated, err := tx.Agent.Update().
				Where(
					agententity.IDEQ(entity.ID),
					agententity.ServerIDEQ(command.ServerID),
					agententity.RevisionEQ(entity.Revision),
					agententity.DeletedAtIsNil(),
				).
				SetDesiredState("stopped").
				SetObservedState("stopping").
				SetImState("deleting").
				SetDeletedAt(now).
				ClearCurrentLaunchID().
				ClearCurrentLaunchAssignmentEpoch().
				SetCurrentLaunchGeneration(0).
				SetCurrentLaunchCredentialVersion(0).
				SetCurrentLaunchAttempt(0).
				ClearCurrentLaunchUpdatedAt().
				SetRevision(nextRevision).
				SetUpdatedAt(now).
				Save(ctx)
			if err != nil {
				return err
			}
			if updated != 1 {
				return agentport.ErrRevisionConflict
			}
			updated, err = tx.Member.Update().
				Where(
					member.IDEQ(memberEntity.ID),
					member.ServerIDEQ(command.ServerID),
					member.KindEQ("agent"),
					member.StatusEQ("active"),
				).
				SetStatus("removed").
				ClearActiveHandleKey().
				SetImState("deleting").
				AddRevision(1).
				SetUpdatedAt(now).
				Save(ctx)
			if err != nil {
				return err
			}
			if updated != 1 {
				return agentport.ErrRevisionConflict
			}
			if _, err := tx.AgentRuntimeCredential.Update().
				Where(
					agentruntimecredential.ServerIDEQ(command.ServerID),
					agentruntimecredential.AgentIDEQ(command.AgentID),
					agentruntimecredential.StateEQ("active"),
					agentruntimecredential.RevokedAtIsNil(),
				).
				SetState("revoked").
				SetRevokedAt(now).
				Save(ctx); err != nil {
				return err
			}
			if _, err := tx.ChannelMember.Update().
				Where(
					channelmember.ServerIDEQ(command.ServerID),
					channelmember.MemberIDEQ(command.AgentID),
					channelmember.StateEQ("active"),
				).
				SetState("removed").
				SetImState("removing").
				AddMembershipVersion(1).
				SetUpdatedAt(now).
				Save(ctx); err != nil {
				return err
			}
			if _, err := tx.Task.Update().
				Where(
					task.ServerIDEQ(command.ServerID),
					task.OwnerMemberIDEQ(command.AgentID),
					task.StatusIn("todo", "in_progress", "in_review"),
				).
				ClearOwnerMemberID().
				AddAssignmentRevision(1).
				SetUpdatedByMemberID(membership.MemberID).
				AddRevision(1).
				SetUpdatedAt(now).
				Save(ctx); err != nil {
				return err
			}
			if _, err := tx.Reminder.Update().
				Where(
					reminder.ServerIDEQ(command.ServerID),
					reminder.AgentIDEQ(command.AgentID),
					reminder.StatusIn("active", "paused"),
				).
				SetStatus("canceled").
				ClearNextFireAt().
				AddRevision(1).
				SetUpdatedAt(now).
				Save(ctx); err != nil {
				return err
			}
			if _, err := tx.ReminderOccurrence.Update().
				Where(
					reminderoccurrence.ServerIDEQ(command.ServerID),
					reminderoccurrence.AgentIDEQ(command.AgentID),
					reminderoccurrence.StateEQ("due"),
				).
				SetState("canceled").
				SetResultCode("agent_deleted").
				SetUpdatedAt(now).
				Save(ctx); err != nil {
				return err
			}
			if err := bumpComputerAssignments(
				ctx,
				tx,
				command.ServerID,
				[]*string{entity.ComputerID},
				now,
			); err != nil {
				return err
			}
			operation, err := createOperation(
				ctx,
				tx,
				command.OperationID,
				command.ServerID,
				"im",
				"im.identity.delete",
				entity.ID,
				nextRevision,
				"im.identity.delete:v1:"+entity.ID+":"+
					strconv.FormatInt(nextRevision, 10),
				nil,
				nil,
				now,
			)
			if err != nil {
				return err
			}
			if err := createOutbox(
				ctx, tx, command.ServerID, operation.ID, now,
			); err != nil {
				return err
			}
			if err := saveIdempotency(
				ctx,
				tx,
				command.ServerID,
				scope,
				command.AgentID,
				command.IdempotencyKey,
				command.RequestHash,
				command.AgentID,
				operation.ID,
				now,
			); err != nil {
				return err
			}
			result = mapOperation(operation)
			return nil
		},
	)
	return result, returnErr
}

func (repository *EntRepository) ApplyLifecycle(
	ctx context.Context,
	command agentport.LifecycleCommand,
) (result agentport.Operation, returnErr error) {
	returnErr = repository.handle.WithTx(
		ctx,
		func(ctx context.Context, tx *ent.Tx) error {
			membership, err := requireMembership(
				ctx, tx, command.AccountID, command.ServerID,
			)
			if err != nil {
				return err
			}
			if !canManage(membership.Role) {
				return agentport.ErrPermissionDenied
			}
			scope := command.Kind
			stored, err := findIdempotency(
				ctx,
				tx,
				command.ServerID,
				scope,
				command.AgentID,
				command.IdempotencyKey,
			)
			if err == nil {
				if !sameHash(stored.RequestHash, command.RequestHash) {
					return agentport.ErrIdempotencyConflict
				}
				_, operationID, err := decodeLocator(stored.ResponseBodyJSON, scope)
				if err != nil {
					return err
				}
				operation, err := tx.TencentOperation.Query().
					Where(tencentoperation.IDEQ(operationID)).
					Only(ctx)
				if err != nil {
					return err
				}
				result = mapOperation(operation)
				return nil
			}
			if !ent.IsNotFound(err) {
				return err
			}
			entity, err := requireAgent(ctx, tx, command.ServerID, command.AgentID)
			if err != nil {
				return err
			}
			if entity.ImState != "ready" {
				return agentport.ErrAgentNotReady
			}
			if err := requireComputer(
				ctx,
				tx,
				command.ServerID,
				entity.ComputerID,
			); err != nil {
				return err
			}
			if command.Kind == "agent.start" ||
				command.Kind == "agent.restart" {
				if entity.CredentialVersion <= 0 {
					return agentport.ErrCredentialMissing
				}
				active, err := tx.AgentRuntimeCredential.Query().
					Where(
						agentruntimecredential.ServerIDEQ(
							command.ServerID,
						),
						agentruntimecredential.AgentIDEQ(
							command.AgentID,
						),
						agentruntimecredential.VersionEQ(
							entity.CredentialVersion,
						),
						agentruntimecredential.StateEQ("active"),
						agentruntimecredential.RevokedAtIsNil(),
					).
					Exist(ctx)
				if err != nil {
					return err
				}
				if !active {
					return agentport.ErrCredentialMissing
				}
			}
			desired, observed, ok := lifecycleStates(command.Kind)
			if !ok {
				return errors.New("Agent 生命周期类型无效")
			}
			nextRevision := entity.Revision + 1
			updated, err := tx.Agent.Update().
				Where(
					agententity.IDEQ(entity.ID),
					agententity.ServerIDEQ(command.ServerID),
					agententity.RevisionEQ(entity.Revision),
				).
				SetDesiredState(desired).
				SetObservedState(observed).
				ClearLastErrorCode().
				SetRevision(nextRevision).
				SetUpdatedAt(command.CreatedAt.UTC()).
				Save(ctx)
			if err != nil {
				return err
			}
			if updated != 1 {
				return agentport.ErrIdempotencyConflict
			}
			if err := bumpComputerAssignments(
				ctx,
				tx,
				command.ServerID,
				[]*string{entity.ComputerID},
				command.CreatedAt.UTC(),
			); err != nil {
				return err
			}
			operation, err := createCompletedPlatformOperation(
				ctx,
				tx,
				command.OperationID,
				command.ServerID,
				command.Kind,
				entity.ID,
				nextRevision,
				command.CreatedAt.UTC(),
			)
			if err != nil {
				return err
			}
			if err := saveIdempotency(
				ctx,
				tx,
				command.ServerID,
				scope,
				command.AgentID,
				command.IdempotencyKey,
				command.RequestHash,
				command.AgentID,
				operation.ID,
				command.CreatedAt.UTC(),
			); err != nil {
				return err
			}
			result = mapOperation(operation)
			return nil
		},
	)
	return result, returnErr
}

func bumpComputerAssignments(
	ctx context.Context,
	tx *ent.Tx,
	serverID string,
	computerIDs []*string,
	at time.Time,
) error {
	seen := make(map[string]struct{}, len(computerIDs))
	for _, pointer := range computerIDs {
		if pointer == nil || strings.TrimSpace(*pointer) == "" {
			continue
		}
		computerID := strings.TrimSpace(*pointer)
		if _, exists := seen[computerID]; exists {
			continue
		}
		seen[computerID] = struct{}{}
		updated, err := tx.Computer.Update().
			Where(
				computer.IDEQ(computerID),
				computer.ServerIDEQ(serverID),
				computer.LifecycleStateEQ("active"),
			).
			AddAssignmentRevision(1).
			SetUpdatedAt(at.UTC()).
			Save(ctx)
		if err != nil {
			return err
		}
		if updated != 1 {
			return agentport.ErrComputerNotReady
		}
	}
	return nil
}

func (repository *EntRepository) RotateCredential(
	ctx context.Context,
	command agentport.CredentialCommand,
) (result agentport.CredentialResult, returnErr error) {
	returnErr = repository.handle.WithTx(
		ctx,
		func(ctx context.Context, tx *ent.Tx) error {
			membership, err := requireMembership(
				ctx, tx, command.AccountID, command.ServerID,
			)
			if err != nil {
				return err
			}
			if !canManage(membership.Role) {
				return agentport.ErrPermissionDenied
			}
			const scope = "agent.credential.rotate"
			stored, err := findIdempotency(
				ctx,
				tx,
				command.ServerID,
				scope,
				command.AgentID,
				command.IdempotencyKey,
			)
			if err == nil {
				if !sameHash(stored.RequestHash, command.RequestHash) {
					return agentport.ErrIdempotencyConflict
				}
				_, operationID, err := decodeLocator(stored.ResponseBodyJSON, scope)
				if err != nil {
					return err
				}
				operation, err := tx.TencentOperation.Query().
					Where(tencentoperation.IDEQ(operationID)).
					Only(ctx)
				if err != nil {
					return err
				}
				result = agentport.CredentialResult{
					Operation: mapOperation(operation),
					Created:   false,
				}
				return nil
			}
			if !ent.IsNotFound(err) {
				return err
			}
			entity, err := requireAgent(ctx, tx, command.ServerID, command.AgentID)
			if err != nil {
				return err
			}
			if entity.ImState != "ready" {
				return agentport.ErrAgentNotReady
			}
			if err := requireComputer(
				ctx,
				tx,
				command.ServerID,
				entity.ComputerID,
			); err != nil {
				return err
			}
			if command.Version != entity.CredentialVersion+1 {
				return agentport.ErrIdempotencyConflict
			}
			now := command.CreatedAt.UTC()
			if _, err := tx.AgentRuntimeCredential.Update().
				Where(
					agentruntimecredential.ServerIDEQ(command.ServerID),
					agentruntimecredential.AgentIDEQ(command.AgentID),
					agentruntimecredential.StateEQ("active"),
					agentruntimecredential.RevokedAtIsNil(),
				).
				SetState("revoked").
				SetRevokedAt(now).
				Save(ctx); err != nil {
				return err
			}
			if _, err := tx.AgentRuntimeCredential.Delete().
				Where(
					agentruntimecredential.ServerIDEQ(command.ServerID),
					agentruntimecredential.AgentIDEQ(command.AgentID),
					agentruntimecredential.VersionEQ(command.Version),
					agentruntimecredential.StateEQ("revoked"),
					agentruntimecredential.RevokedAtNotNil(),
				).
				Exec(ctx); err != nil {
				return err
			}
			if _, err := tx.AgentRuntimeCredential.Create().
				SetID(command.CredentialID).
				SetServerID(command.ServerID).
				SetAgentID(command.AgentID).
				SetVersion(command.Version).
				SetSecretHash(command.SecretHash[:]).
				SetState("active").
				SetCreatedAt(now).
				Save(ctx); err != nil {
				if ent.IsConstraintError(err) {
					return agentport.ErrCredentialPending
				}
				return err
			}
			nextRevision := entity.Revision + 1
			updated, err := tx.Agent.Update().
				Where(
					agententity.IDEQ(entity.ID),
					agententity.ServerIDEQ(command.ServerID),
					agententity.RevisionEQ(entity.Revision),
				).
				SetCredentialVersion(command.Version).
				SetRevision(nextRevision).
				SetUpdatedAt(now).
				Save(ctx)
			if err != nil {
				return err
			}
			if updated != 1 {
				return agentport.ErrIdempotencyConflict
			}
			if err := bumpComputerAssignments(
				ctx,
				tx,
				command.ServerID,
				[]*string{entity.ComputerID},
				now,
			); err != nil {
				return err
			}
			operation, err := createCompletedPlatformOperation(
				ctx,
				tx,
				command.OperationID,
				command.ServerID,
				"agent.credential.rotate",
				entity.ID,
				nextRevision,
				now,
			)
			if err != nil {
				return err
			}
			if err := saveIdempotency(
				ctx,
				tx,
				command.ServerID,
				scope,
				command.AgentID,
				command.IdempotencyKey,
				command.RequestHash,
				command.AgentID,
				operation.ID,
				now,
			); err != nil {
				return err
			}
			result = agentport.CredentialResult{
				Operation: mapOperation(operation),
				Created:   true,
			}
			return nil
		},
	)
	return result, returnErr
}

func (repository *EntRepository) activeMembership(
	ctx context.Context,
	accountID string,
	serverID string,
) (*ent.AccountServerMembership, error) {
	entity, err := repository.handle.Client().
		AccountServerMembership.Query().
		Where(
			accountservermembership.AccountIDEQ(accountID),
			accountservermembership.ServerIDEQ(serverID),
			accountservermembership.StatusEQ("active"),
		).
		Only(ctx)
	if ent.IsNotFound(err) {
		return nil, agentport.ErrServerNotFound
	}
	return entity, err
}

func requireMembership(
	ctx context.Context,
	tx *ent.Tx,
	accountID string,
	serverID string,
) (*ent.AccountServerMembership, error) {
	entity, err := tx.AccountServerMembership.Query().
		Where(
			accountservermembership.AccountIDEQ(accountID),
			accountservermembership.ServerIDEQ(serverID),
			accountservermembership.StatusEQ("active"),
		).
		Only(ctx)
	if ent.IsNotFound(err) {
		return nil, agentport.ErrServerNotFound
	}
	return entity, err
}

func requireAgent(
	ctx context.Context,
	tx *ent.Tx,
	serverID string,
	agentID string,
) (*ent.Agent, error) {
	memberExists, err := tx.Member.Query().
		Where(
			member.IDEQ(agentID),
			member.ServerIDEQ(serverID),
			member.KindEQ("agent"),
			member.StatusEQ("active"),
		).
		Exist(ctx)
	if err != nil {
		return nil, err
	}
	if !memberExists {
		return nil, agentport.ErrAgentNotFound
	}
	entity, err := tx.Agent.Query().
		Where(
			agententity.IDEQ(agentID),
			agententity.ServerIDEQ(serverID),
			agententity.DeletedAtIsNil(),
		).
		Only(ctx)
	if ent.IsNotFound(err) {
		return nil, agentport.ErrAgentNotFound
	}
	return entity, err
}

func loadAgentInTx(
	ctx context.Context,
	tx *ent.Tx,
	serverID string,
	agentID string,
) (*ent.Agent, *ent.Member, error) {
	entity, err := requireAgent(ctx, tx, serverID, agentID)
	if err != nil {
		return nil, nil, err
	}
	memberEntity, err := tx.Member.Query().
		Where(
			member.IDEQ(agentID),
			member.ServerIDEQ(serverID),
			member.KindEQ("agent"),
			member.StatusEQ("active"),
		).
		Only(ctx)
	if ent.IsNotFound(err) {
		return nil, nil, agentport.ErrAgentNotFound
	}
	if err != nil {
		return nil, nil, err
	}
	return entity, memberEntity, nil
}

func requireComputer(
	ctx context.Context,
	tx *ent.Tx,
	serverID string,
	computerID *string,
) error {
	if computerID == nil || strings.TrimSpace(*computerID) == "" {
		return agentport.ErrComputerNotReady
	}
	entity, err := tx.Computer.Query().
		Where(
			computer.IDEQ(*computerID),
			computer.ServerIDEQ(serverID),
		).
		Only(ctx)
	if ent.IsNotFound(err) {
		return agentport.ErrComputerNotReady
	}
	if err != nil {
		return err
	}
	if entity.LifecycleState != "active" ||
		entity.TatAgentState != "online" ||
		entity.TatInstanceID == nil {
		return agentport.ErrComputerNotReady
	}
	return nil
}

func requireAssignableComputer(
	ctx context.Context,
	tx *ent.Tx,
	serverID string,
	computerID *string,
) error {
	if computerID == nil || strings.TrimSpace(*computerID) == "" {
		return agentport.ErrComputerNotReady
	}
	entity, err := tx.Computer.Query().
		Where(
			computer.IDEQ(*computerID),
			computer.ServerIDEQ(serverID),
		).
		Only(ctx)
	if ent.IsNotFound(err) {
		return agentport.ErrComputerNotReady
	}
	if err != nil {
		return err
	}
	if entity.LifecycleState != "active" || entity.TatInstanceID == nil {
		return agentport.ErrComputerNotReady
	}
	return nil
}

func (repository *EntRepository) loadAgent(
	ctx context.Context,
	serverID string,
	agentID string,
) (*ent.Agent, *ent.Member, error) {
	entity, err := repository.handle.Client().Agent.Query().
		Where(
			agententity.IDEQ(agentID),
			agententity.ServerIDEQ(serverID),
			agententity.DeletedAtIsNil(),
		).
		Only(ctx)
	if ent.IsNotFound(err) {
		return nil, nil, agentport.ErrAgentNotFound
	}
	if err != nil {
		return nil, nil, err
	}
	memberEntity, err := repository.handle.Client().Member.Query().
		Where(
			member.IDEQ(agentID),
			member.ServerIDEQ(serverID),
			member.KindEQ("agent"),
			member.StatusEQ("active"),
		).
		Only(ctx)
	if ent.IsNotFound(err) {
		return nil, nil, agentport.ErrAgentNotFound
	}
	return entity, memberEntity, err
}

func loadCreateResult(
	ctx context.Context,
	tx *ent.Tx,
	serverID string,
	agentID string,
	operationID string,
	result *agentport.CreateResult,
) error {
	entity, err := tx.Agent.Query().
		Where(
			agententity.IDEQ(agentID),
			agententity.ServerIDEQ(serverID),
		).
		Only(ctx)
	if err != nil {
		return err
	}
	memberEntity, err := tx.Member.Query().
		Where(member.IDEQ(agentID), member.ServerIDEQ(serverID)).
		Only(ctx)
	if err != nil {
		return err
	}
	operation, err := tx.TencentOperation.Query().
		Where(tencentoperation.IDEQ(operationID)).
		Only(ctx)
	if err != nil {
		return err
	}
	*result = agentport.CreateResult{
		Agent:     mapAgent(entity, memberEntity.DisplayName, memberEntity.Handle),
		Operation: mapOperation(operation),
	}
	return nil
}

func createOperation(
	ctx context.Context,
	tx *ent.Tx,
	operationID string,
	serverID string,
	service string,
	kind string,
	resourceID string,
	desiredRevision int64,
	idempotencyKey string,
	requestSnapshot []byte,
	deadline *time.Time,
	now time.Time,
) (*ent.TencentOperation, error) {
	builder := tx.TencentOperation.Create().
		SetID(operationID).
		SetPartitionKey(serverID).
		SetServerID(serverID).
		SetService(service).
		SetKind(kind).
		SetResourceType("agent").
		SetResourceID(resourceID).
		SetIdempotencyKey(idempotencyKey).
		SetDesiredRevision(desiredRevision).
		SetState("pending").
		SetAttempts(0).
		SetCreatedAt(now).
		SetUpdatedAt(now)
	if len(requestSnapshot) > 0 {
		encoded, err := persistedjson.EncodeSnapshot(
			service, kind, json.RawMessage(requestSnapshot),
		)
		if err != nil {
			return nil, err
		}
		builder.SetRequestSnapshotJSON(encoded)
	}
	if deadline != nil {
		builder.SetDeadlineAt(deadline.UTC())
	}
	return builder.Save(ctx)
}

func createCompletedPlatformOperation(
	ctx context.Context,
	tx *ent.Tx,
	operationID string,
	serverID string,
	kind string,
	resourceID string,
	desiredRevision int64,
	now time.Time,
) (*ent.TencentOperation, error) {
	now = now.UTC()
	return tx.TencentOperation.Create().
		SetID(operationID).
		SetPartitionKey(serverID).
		SetServerID(serverID).
		SetService("platform").
		SetKind(kind).
		SetResourceType("agent").
		SetResourceID(resourceID).
		SetIdempotencyKey(
			kind + ":v1:" + resourceID + ":" +
				strconv.FormatInt(desiredRevision, 10),
		).
		SetDesiredRevision(desiredRevision).
		SetState("succeeded").
		SetAttempts(0).
		SetCreatedAt(now).
		SetUpdatedAt(now).
		SetCompletedAt(now).
		Save(ctx)
}

func createOutbox(
	ctx context.Context,
	tx *ent.Tx,
	serverID string,
	operationID string,
	now time.Time,
) error {
	_, err := tx.OutboxEvent.Create().
		SetPartitionKey(serverID).
		SetServerID(serverID).
		SetEventType("tencent.operation.ready").
		SetAggregateType("tencent_operation").
		SetAggregateID(operationID).
		SetState("pending").
		SetAttempts(0).
		SetAvailableAt(now).
		SetCreatedAt(now).
		Save(ctx)
	return err
}

func findIdempotency(
	ctx context.Context,
	tx *ent.Tx,
	partitionKey string,
	scope string,
	scopeID string,
	key string,
) (*ent.IdempotencyRecord, error) {
	return tx.IdempotencyRecord.Query().
		Where(
			idempotencyrecord.PartitionKeyEQ(partitionKey),
			idempotencyrecord.ScopeTypeEQ(scope),
			idempotencyrecord.ScopeIDEQ(scopeID),
			idempotencyrecord.IdempotencyKeyEQ(key),
		).
		Only(ctx)
}

func saveIdempotency(
	ctx context.Context,
	tx *ent.Tx,
	partitionKey string,
	scope string,
	scopeID string,
	key string,
	requestHash [32]byte,
	resourceID string,
	operationID string,
	now time.Time,
) error {
	response, err := persistedjson.EncodeScoped(scope, struct {
		ResourceID  string `json:"resourceId"`
		OperationID string `json:"operationId"`
	}{
		ResourceID: resourceID, OperationID: operationID,
	})
	if err != nil {
		return err
	}
	_, err = tx.IdempotencyRecord.Create().
		SetPartitionKey(partitionKey).
		SetScopeType(scope).
		SetScopeID(scopeID).
		SetIdempotencyKey(key).
		SetRequestHash(requestHash[:]).
		SetResponseStatus(202).
		SetResponseBodyJSON(response).
		SetExpiresAt(now.Add(24 * time.Hour)).
		SetCreatedAt(now).
		Save(ctx)
	return err
}

func saveAgentUpdateIdempotency(
	ctx context.Context,
	tx *ent.Tx,
	command agentport.UpdateCommand,
	result agentport.Agent,
	now time.Time,
) error {
	response, err := persistedjson.EncodeScoped("agent.update", result)
	if err != nil {
		return err
	}
	_, err = tx.IdempotencyRecord.Create().
		SetPartitionKey(command.ServerID).
		SetScopeType("agent.update").
		SetScopeID(command.AgentID).
		SetIdempotencyKey(command.IdempotencyKey).
		SetRequestHash(command.RequestHash[:]).
		SetResponseStatus(200).
		SetResponseBodyJSON(response).
		SetExpiresAt(now.Add(24 * time.Hour)).
		SetCreatedAt(now).
		Save(ctx)
	return err
}

func decodeLocator(value string, scope string) (string, string, error) {
	var locator struct {
		ResourceID  string `json:"resourceId"`
		OperationID string `json:"operationId"`
	}
	if _, err := persistedjson.DecodeScoped(value, scope, &locator); err != nil {
		return "", "", err
	}
	if locator.ResourceID == "" || locator.OperationID == "" {
		return "", "", errors.New("Agent 幂等记录无效")
	}
	return locator.ResourceID, locator.OperationID, nil
}

func sameHash(stored []byte, expected [32]byte) bool {
	return subtle.ConstantTimeCompare(stored, expected[:]) == 1
}

func mapAgent(
	entity *ent.Agent,
	displayName string,
	handle string,
) agentport.Agent {
	return agentport.Agent{
		ID: entity.ID, ServerID: entity.ServerID,
		DisplayName: displayName, Handle: handle,
		Description: entity.Description, IMUserID: entity.ImUserID,
		IMState: entity.ImState, ComputerID: entity.ComputerID,
		Runtime: agentport.Runtime{
			Kind: entity.RuntimeKind, Model: entity.RuntimeModel,
		},
		ReplyPolicy:                    entity.ReplyPolicy,
		DesiredState:                   entity.DesiredState,
		ObservedState:                  entity.ObservedState,
		IMPresence:                     entity.ImPresence,
		IMPresenceUpdatedAt:            entity.ImPresenceUpdatedAt,
		IMTransportState:               entity.ImTransportState,
		IMTransportUpdatedAt:           entity.ImTransportUpdatedAt,
		HostLastSeenAt:                 entity.HostLastSeenAt,
		CredentialVersion:              entity.CredentialVersion,
		LastObservedAt:                 entity.LastObservedAt,
		LastErrorCode:                  stringValue(entity.LastErrorCode),
		ObservedAssignmentEpoch:        entity.ObservedAssignmentEpoch,
		ObservedGeneration:             entity.ObservedGeneration,
		ObservedAttempt:                entity.ObservedAttempt,
		ObservedLaunchID:               entity.ObservedLaunchID,
		CurrentLaunchID:                entity.CurrentLaunchID,
		CurrentLaunchAssignmentEpoch:   entity.CurrentLaunchAssignmentEpoch,
		CurrentLaunchGeneration:        entity.CurrentLaunchGeneration,
		CurrentLaunchCredentialVersion: entity.CurrentLaunchCredentialVersion,
		CurrentLaunchAttempt:           entity.CurrentLaunchAttempt,
		Revision:                       entity.Revision,
	}
}

func mapOperation(entity *ent.TencentOperation) agentport.Operation {
	return agentport.Operation{
		ID: entity.ID, ServerID: stringValue(entity.ServerID),
		Service: entity.Service, Kind: entity.Kind, State: entity.State,
		CreatedAt: entity.CreatedAt, CompletedAt: entity.CompletedAt,
		LastErrorCode: stringValue(entity.LastErrorCode),
	}
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func canManage(role string) bool {
	return role == "owner" || role == "admin"
}

func lifecycleStates(kind string) (string, string, bool) {
	switch kind {
	case "agent.deploy":
		return "stopped", "stopped", true
	case "agent.start":
		return "running", "starting", true
	case "agent.stop":
		return "stopped", "stopping", true
	case "agent.restart":
		return "running", "starting", true
	default:
		return "", "", false
	}
}

var _ agentport.Repository = (*EntRepository)(nil)
