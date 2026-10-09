// Package agent 使用 Ent/SQLite 保存 Agent、Member 和可靠腾讯云操作。
package agent

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
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

type profileCapabilityRefreshSnapshot struct {
	SchemaVersion         int       `json:"schemaVersion"`
	ServerID              string    `json:"serverId"`
	AgentID               string    `json:"agentId"`
	ComputerID            string    `json:"computerId"`
	RuntimeKind           string    `json:"runtimeKind"`
	ContextGeneration     int64     `json:"contextGeneration"`
	AuthorityContextKey   string    `json:"authorityContextKey"`
	InvalidationWatermark int64     `json:"invalidationWatermark"`
	ForceReload           bool      `json:"forceReload"`
	Trigger               string    `json:"trigger"`
	RequestedAt           time.Time `json:"requestedAt"`
}

type profileCapabilityResultSnapshot struct {
	SchemaVersion          int    `json:"schemaVersion"`
	Status                 string `json:"status"`
	ResultDigest           string `json:"resultDigest"`
	ErrorCode              string `json:"errorCode,omitempty"`
	SatisfiedByOperationID string `json:"satisfiedByOperationId,omitempty"`
}

func (repository *EntRepository) SupportsProfileCapabilities(
	ctx context.Context,
	serverID string,
	computerID string,
) (bool, error) {
	entity, err := repository.handle.Client().Computer.Query().
		Where(
			computer.IDEQ(computerID),
			computer.ServerIDEQ(serverID),
			computer.LifecycleStateEQ("active"),
		).
		Only(ctx)
	if ent.IsNotFound(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return entity.AssignmentProtocolVersion >= 2 &&
		entity.ProfileCapabilityVersion != nil &&
		*entity.ProfileCapabilityVersion == 1, nil
}

func (repository *EntRepository) SupportsAssignmentVersion(
	ctx context.Context,
	serverID string,
	computerID string,
	version int,
) (bool, error) {
	if version < 1 {
		return false, nil
	}
	exists, err := repository.handle.Client().Computer.Query().
		Where(
			computer.IDEQ(computerID),
			computer.ServerIDEQ(serverID),
			computer.LifecycleStateEQ("active"),
			computer.AssignmentProtocolVersionGTE(version),
		).
		Exist(ctx)
	return exists, err
}

func (repository *EntRepository) GetProfileCapabilities(
	ctx context.Context,
	accountID string,
	serverID string,
	agentID string,
) (agentport.ProfileCapabilities, error) {
	membership, err := repository.activeMembership(ctx, accountID, serverID)
	if err != nil {
		return agentport.ProfileCapabilities{}, err
	}
	if !canManage(membership.Role) {
		return agentport.ProfileCapabilities{}, agentport.ErrPermissionDenied
	}
	entity, err := repository.handle.Client().Agent.Query().
		Where(
			agententity.IDEQ(agentID),
			agententity.ServerIDEQ(serverID),
			agententity.DeletedAtIsNil(),
		).
		Only(ctx)
	if ent.IsNotFound(err) {
		return agentport.ProfileCapabilities{}, agentport.ErrAgentNotFound
	}
	if err != nil {
		return agentport.ProfileCapabilities{}, err
	}
	result := agentport.ProfileCapabilities{
		AgentID: entity.ID, ComputerID: entity.ComputerID,
		ContextGeneration: entity.Revision,
		Runtime: agentport.Runtime{
			Kind: entity.RuntimeKind, Model: entity.RuntimeModel,
		},
		SnapshotJSON: entity.ProfileCapabilitiesJSON,
	}
	if entity.ProfileCapabilityRefreshID != nil {
		operation, err := repository.handle.Client().TencentOperation.Query().
			Where(
				tencentoperation.IDEQ(*entity.ProfileCapabilityRefreshID),
				tencentoperation.PartitionKeyEQ(serverID),
			).
			Only(ctx)
		if err != nil {
			return agentport.ProfileCapabilities{}, err
		}
		mapped := mapOperation(operation)
		result.RefreshOperation = &mapped
	}
	return result, nil
}

func (repository *EntRepository) BeginProfileCapabilityRefresh(
	ctx context.Context,
	command agentport.ProfileCapabilityRefreshCommand,
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
			const scope = "agent.profile-capabilities.refresh"
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
					Where(
						tencentoperation.IDEQ(operationID),
						tencentoperation.PartitionKeyEQ(command.ServerID),
					).
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
			entity, err := tx.Agent.Query().
				Where(
					agententity.IDEQ(command.AgentID),
					agententity.ServerIDEQ(command.ServerID),
					agententity.DeletedAtIsNil(),
				).
				Only(ctx)
			if ent.IsNotFound(err) {
				return agentport.ErrAgentNotFound
			}
			if err != nil {
				return err
			}
			if entity.ComputerID == nil || *entity.ComputerID != command.ComputerID ||
				entity.RuntimeKind != command.RuntimeKind ||
				entity.Revision != command.ContextGeneration {
				return agentport.ErrRevisionConflict
			}
			if entity.ProfileCapabilityRefreshID != nil &&
				*entity.ProfileCapabilityRefreshID != command.OperationID {
				previousID := *entity.ProfileCapabilityRefreshID
				digest := sha256.Sum256([]byte(
					"agent-profile-capability-superseded/v1\x00" +
						previousID + "\x00" + command.OperationID,
				))
				previousResult, err := persistedjson.EncodeResultSnapshot(
					"platform",
					"agent.profile.capabilities.refresh",
					profileCapabilityResultSnapshot{
						SchemaVersion: 1, Status: "superseded",
						ResultDigest:           base64.RawURLEncoding.EncodeToString(digest[:]),
						ErrorCode:              "superseded",
						SatisfiedByOperationID: command.OperationID,
					},
				)
				if err != nil {
					return err
				}
				if _, err := tx.TencentOperation.Update().
					Where(
						tencentoperation.IDEQ(previousID),
						tencentoperation.PartitionKeyEQ(command.ServerID),
						tencentoperation.StateIn(
							"pending", "running", "retry_wait", "uncertain",
						),
					).
					SetState("superseded").
					SetResultJSON(previousResult).
					SetLastErrorCode("superseded").
					SetCompletedAt(command.CreatedAt.UTC()).
					SetUpdatedAt(command.CreatedAt.UTC()).
					ClearNextAttemptAt().ClearLeaseOwner().ClearLeaseExpiresAt().
					Save(ctx); err != nil {
					return err
				}
			}
			snapshot, err := json.Marshal(profileCapabilityRefreshSnapshot{
				SchemaVersion:         1,
				ServerID:              command.ServerID,
				AgentID:               command.AgentID,
				ComputerID:            command.ComputerID,
				RuntimeKind:           command.RuntimeKind,
				ContextGeneration:     command.ContextGeneration,
				AuthorityContextKey:   command.AuthorityContextKey,
				InvalidationWatermark: command.InvalidationWatermark,
				ForceReload:           command.ForceReload,
				Trigger:               command.Trigger,
				RequestedAt:           command.CreatedAt.UTC(),
			})
			if err != nil {
				return err
			}
			deadline := command.DeadlineAt.UTC()
			operation, err := createOperation(
				ctx,
				tx,
				command.OperationID,
				command.ServerID,
				"platform",
				"agent.profile.capabilities.refresh",
				command.AgentID,
				command.ContextGeneration,
				command.IdempotencyKey,
				snapshot,
				&deadline,
				command.CreatedAt.UTC(),
			)
			if err != nil {
				return err
			}
			updated, err := tx.Agent.Update().
				Where(
					agententity.IDEQ(command.AgentID),
					agententity.ServerIDEQ(command.ServerID),
					agententity.RevisionEQ(command.ContextGeneration),
					agententity.ComputerIDEQ(command.ComputerID),
					agententity.RuntimeKindEQ(command.RuntimeKind),
				).
				SetProfileCapabilityRefreshID(operation.ID).
				SetUpdatedAt(command.CreatedAt.UTC()).
				Save(ctx)
			if err != nil {
				return err
			}
			if updated != 1 {
				return agentport.ErrRevisionConflict
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

func (repository *EntRepository) EnsureSystemProfileCapabilityRefresh(
	ctx context.Context,
	command agentport.SystemProfileCapabilityEnsureCommand,
) (result agentport.Operation, returnErr error) {
	returnErr = repository.handle.WithTx(
		ctx,
		func(ctx context.Context, tx *ent.Tx) error {
			const scope = "agent.profile-capabilities.refresh"
			idempotencyKey := "system:agent-profile-capabilities:" +
				command.AgentID + ":" + strconv.FormatInt(command.ContextGeneration, 10)
			requestHash := sha256.Sum256([]byte(
				"agent.profile-capabilities.system-ensure/v1\x00" +
					command.ServerID + "\x00" + command.AgentID + "\x00" +
					strconv.FormatInt(command.ContextGeneration, 10),
			))
			stored, err := findIdempotency(
				ctx, tx, command.ServerID, scope, command.AgentID, idempotencyKey,
			)
			if err == nil {
				if !sameHash(stored.RequestHash, requestHash) {
					return agentport.ErrIdempotencyConflict
				}
				_, operationID, err := decodeLocator(stored.ResponseBodyJSON, scope)
				if err != nil {
					return err
				}
				operation, err := tx.TencentOperation.Query().
					Where(
						tencentoperation.IDEQ(operationID),
						tencentoperation.PartitionKeyEQ(command.ServerID),
					).
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
			entity, err := tx.Agent.Query().
				Where(
					agententity.IDEQ(command.AgentID),
					agententity.ServerIDEQ(command.ServerID),
					agententity.ComputerIDEQ(command.ComputerID),
					agententity.RevisionEQ(command.ContextGeneration),
					agententity.DeletedAtIsNil(),
				).
				Only(ctx)
			if ent.IsNotFound(err) {
				return agentport.ErrRevisionConflict
			}
			if err != nil {
				return err
			}
			if entity.RuntimeKind != "codex" && entity.RuntimeKind != "hermes-acp" &&
				entity.RuntimeKind != "hermes-gateway" {
				return agentport.ErrProfileCapabilitiesUnsupported
			}
			machine, err := tx.Computer.Query().
				Where(
					computer.IDEQ(command.ComputerID),
					computer.ServerIDEQ(command.ServerID),
					computer.LifecycleStateEQ("active"),
				).
				Only(ctx)
			if err != nil {
				return err
			}
			if machine.AssignmentProtocolVersion < 2 ||
				machine.ProfileCapabilityVersion == nil ||
				*machine.ProfileCapabilityVersion != 1 {
				return agentport.ErrProfileCapabilitiesUnsupported
			}
			invalidationWatermark := int64(0)
			if entity.ProfileCapabilitiesJSON != nil {
				var payload persistedjson.ProfileCapabilitiesPayload
				if _, err := persistedjson.DecodeProfileCapabilities(
					*entity.ProfileCapabilitiesJSON, &payload,
				); err != nil {
					return err
				}
				invalidationWatermark = payload.InvalidationGeneration
			}
			authorityKey := agentport.ProfileCapabilityAuthorityContextKey(
				command.ServerID, command.AgentID, command.ComputerID,
				entity.RuntimeKind, command.ContextGeneration,
			)
			requestSnapshot, err := json.Marshal(profileCapabilityRefreshSnapshot{
				SchemaVersion: 1, ServerID: command.ServerID, AgentID: command.AgentID,
				ComputerID: command.ComputerID, RuntimeKind: entity.RuntimeKind,
				ContextGeneration:     command.ContextGeneration,
				AuthorityContextKey:   authorityKey,
				InvalidationWatermark: invalidationWatermark,
				ForceReload:           false, Trigger: "system", RequestedAt: command.CreatedAt.UTC(),
			})
			if err != nil {
				return err
			}
			deadline := command.DeadlineAt.UTC()
			operation, err := createOperation(
				ctx, tx, command.OperationID, command.ServerID, "platform",
				"agent.profile.capabilities.refresh", command.AgentID,
				command.ContextGeneration, idempotencyKey, requestSnapshot,
				&deadline, command.CreatedAt.UTC(),
			)
			if err != nil {
				return err
			}
			if entity.ProfileCapabilityRefreshID != nil {
				digest := sha256.Sum256([]byte(
					"agent-profile-capability-system-satisfied/v1\x00" +
						*entity.ProfileCapabilityRefreshID,
				))
				terminal, err := persistedjson.EncodeResultSnapshot(
					"platform", "agent.profile.capabilities.refresh",
					profileCapabilityResultSnapshot{
						SchemaVersion: 1, Status: "superseded",
						ResultDigest:           base64.RawURLEncoding.EncodeToString(digest[:]),
						ErrorCode:              "satisfied_by_outstanding_refresh",
						SatisfiedByOperationID: *entity.ProfileCapabilityRefreshID,
					},
				)
				if err != nil {
					return err
				}
				if _, err := tx.TencentOperation.UpdateOneID(operation.ID).
					SetState("superseded").SetResultJSON(terminal).
					SetLastErrorCode("satisfied_by_outstanding_refresh").
					SetCompletedAt(command.CreatedAt.UTC()).
					SetUpdatedAt(command.CreatedAt.UTC()).Save(ctx); err != nil {
					return err
				}
				operation, err = tx.TencentOperation.Get(ctx, operation.ID)
				if err != nil {
					return err
				}
			} else {
				updated, err := tx.Agent.Update().
					Where(
						agententity.IDEQ(command.AgentID),
						agententity.ServerIDEQ(command.ServerID),
						agententity.ComputerIDEQ(command.ComputerID),
						agententity.RevisionEQ(command.ContextGeneration),
						agententity.ProfileCapabilityRefreshIDIsNil(),
					).
					SetProfileCapabilityRefreshID(operation.ID).
					SetUpdatedAt(command.CreatedAt.UTC()).Save(ctx)
				if err != nil {
					return err
				}
				if updated != 1 {
					return agentport.ErrRevisionConflict
				}
				if err := bumpComputerAssignments(
					ctx, tx, command.ServerID, []*string{entity.ComputerID},
					command.CreatedAt.UTC(),
				); err != nil {
					return err
				}
			}
			if err := saveIdempotency(
				ctx, tx, command.ServerID, scope, command.AgentID,
				idempotencyKey, requestHash, command.AgentID, operation.ID,
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

func (repository *EntRepository) CompleteProfileCapabilityRefresh(
	ctx context.Context,
	command agentport.ProfileCapabilityResultCommand,
) (result agentport.ProfileCapabilitySubmissionResult, returnErr error) {
	returnErr = repository.handle.WithTx(
		ctx,
		func(ctx context.Context, tx *ent.Tx) error {
			operation, err := tx.TencentOperation.Query().
				Where(
					tencentoperation.IDEQ(command.OperationID),
					tencentoperation.PartitionKeyEQ(command.ServerID),
					tencentoperation.ServerIDEQ(command.ServerID),
					tencentoperation.ServiceEQ("platform"),
					tencentoperation.KindEQ("agent.profile.capabilities.refresh"),
					tencentoperation.ResourceTypeEQ("agent"),
					tencentoperation.ResourceIDEQ(command.AgentID),
				).
				Only(ctx)
			if err != nil {
				return err
			}
			if operation.RequestSnapshotJSON == nil {
				return errors.New("Profile capability Operation 缺少 request snapshot")
			}
			var request profileCapabilityRefreshSnapshot
			if _, err := persistedjson.DecodeSnapshot(
				*operation.RequestSnapshotJSON,
				"platform",
				"agent.profile.capabilities.refresh",
				&request,
			); err != nil {
				return err
			}
			if request.ComputerID != command.ComputerID ||
				request.ContextGeneration != command.ContextGeneration ||
				request.AuthorityContextKey != command.AuthorityContextKey {
				result = agentport.ProfileCapabilitySubmissionResult{
					Accepted: false, Reason: "superseded",
				}
				return nil
			}
			if operation.State == "succeeded" || operation.State == "failed" {
				if operation.ResultJSON == nil {
					return errors.New("Profile capability Operation 缺少 result snapshot")
				}
				var completed profileCapabilityResultSnapshot
				if _, err := persistedjson.DecodeResultSnapshot(
					*operation.ResultJSON,
					"platform",
					"agent.profile.capabilities.refresh",
					&completed,
				); err != nil {
					return err
				}
				status := "failed"
				if command.Succeeded {
					status = "succeeded"
				}
				digest := base64.RawURLEncoding.EncodeToString(command.ResultHash[:])
				if completed.Status == status && completed.ResultDigest == digest &&
					completed.ErrorCode == command.ErrorCode {
					result = agentport.ProfileCapabilitySubmissionResult{
						Accepted: false, Reason: "duplicate",
					}
				} else {
					result = agentport.ProfileCapabilitySubmissionResult{
						Accepted: false, Reason: "superseded",
					}
				}
				return nil
			}
			entity, err := tx.Agent.Query().
				Where(
					agententity.IDEQ(command.AgentID),
					agententity.ServerIDEQ(command.ServerID),
					agententity.DeletedAtIsNil(),
				).
				Only(ctx)
			if err != nil {
				return err
			}
			if entity.ProfileCapabilityRefreshID == nil ||
				*entity.ProfileCapabilityRefreshID != command.OperationID ||
				entity.ComputerID == nil || *entity.ComputerID != command.ComputerID ||
				entity.Revision != command.ContextGeneration ||
				request.ContextGeneration != command.ContextGeneration ||
				request.AuthorityContextKey != command.AuthorityContextKey {
				result = agentport.ProfileCapabilitySubmissionResult{
					Accepted: false, Reason: "superseded",
				}
				return nil
			}
			status := "failed"
			if command.Succeeded {
				status = "succeeded"
			}
			resultSnapshot, err := persistedjson.EncodeResultSnapshot(
				"platform",
				"agent.profile.capabilities.refresh",
				profileCapabilityResultSnapshot{
					SchemaVersion: 1,
					Status:        status,
					ResultDigest: base64.RawURLEncoding.EncodeToString(
						command.ResultHash[:],
					),
					ErrorCode: command.ErrorCode,
				},
			)
			if err != nil {
				return err
			}
			agentUpdate := tx.Agent.Update().
				Where(
					agententity.IDEQ(command.AgentID),
					agententity.ServerIDEQ(command.ServerID),
					agententity.ProfileCapabilityRefreshIDEQ(command.OperationID),
					agententity.RevisionEQ(command.ContextGeneration),
				).
				ClearProfileCapabilityRefreshID().
				SetUpdatedAt(command.CompletedAt.UTC())
			if command.Succeeded {
				payload := persistedjson.ProfileCapabilitiesPayload{
					SchemaVersion: 1,
					Snapshot:      append(json.RawMessage(nil), command.ResultJSON...),
					Invalidations: []persistedjson.ProfileCapabilityInvalidation{},
				}
				if entity.ProfileCapabilitiesJSON != nil {
					var previous persistedjson.ProfileCapabilitiesPayload
					if _, err := persistedjson.DecodeProfileCapabilities(
						*entity.ProfileCapabilitiesJSON, &previous,
					); err == nil && previous.SchemaVersion == 1 {
						payload.InvalidationGeneration = previous.InvalidationGeneration
						var cursor struct {
							RuntimeContextGeneration int64 `json:"runtimeContextGeneration"`
							ObservedThroughSequence  int64 `json:"observedThroughSequence"`
						}
						if json.Unmarshal(command.ResultJSON, &cursor) == nil {
							for _, invalidation := range previous.Invalidations {
								covered := invalidation.Generation <= request.InvalidationWatermark &&
									(invalidation.RuntimeContextGeneration < cursor.RuntimeContextGeneration ||
										invalidation.RuntimeContextGeneration == cursor.RuntimeContextGeneration &&
											invalidation.EventSequence <= cursor.ObservedThroughSequence)
								if !covered {
									payload.Invalidations = append(payload.Invalidations, invalidation)
								}
							}
						}
					}
				}
				encoded, err := persistedjson.EncodeProfileCapabilities(
					payload,
				)
				if err != nil {
					return err
				}
				agentUpdate.SetProfileCapabilitiesJSON(encoded)
			}
			updated, err := agentUpdate.Save(ctx)
			if err != nil {
				return err
			}
			if updated != 1 {
				return agentport.ErrRevisionConflict
			}
			operationUpdate := tx.TencentOperation.Update().
				Where(
					tencentoperation.IDEQ(command.OperationID),
					tencentoperation.PartitionKeyEQ(command.ServerID),
					tencentoperation.StateIn("pending", "running", "retry_wait", "uncertain"),
				).
				SetState(status).
				SetResultJSON(resultSnapshot).
				SetCompletedAt(command.CompletedAt.UTC()).
				SetUpdatedAt(command.CompletedAt.UTC()).
				ClearNextAttemptAt().
				ClearLeaseOwner().
				ClearLeaseExpiresAt()
			if command.ErrorCode == "" {
				operationUpdate.ClearLastErrorCode()
			} else {
				operationUpdate.SetLastErrorCode(command.ErrorCode)
			}
			operationUpdated, err := operationUpdate.Save(ctx)
			if err != nil {
				return err
			}
			if operationUpdated != 1 {
				return agentport.ErrRevisionConflict
			}
			if err := bumpComputerAssignments(
				ctx,
				tx,
				command.ServerID,
				[]*string{entity.ComputerID},
				command.CompletedAt.UTC(),
			); err != nil {
				return err
			}
			result = agentport.ProfileCapabilitySubmissionResult{
				Accepted: true, Reason: "accepted",
			}
			return nil
		},
	)
	return result, returnErr
}

func (repository *EntRepository) PutProfileCapabilityInvalidation(
	ctx context.Context,
	command agentport.ProfileCapabilityInvalidationCommand,
) (result agentport.ProfileCapabilitySubmissionResult, returnErr error) {
	returnErr = repository.handle.WithTx(
		ctx,
		func(ctx context.Context, tx *ent.Tx) error {
			entity, err := tx.Agent.Query().
				Where(
					agententity.IDEQ(command.AgentID),
					agententity.ServerIDEQ(command.ServerID),
					agententity.DeletedAtIsNil(),
				).
				Only(ctx)
			if err != nil {
				return err
			}
			expectedKey := ""
			if entity.ComputerID != nil {
				expectedKey = agentport.ProfileCapabilityAuthorityContextKey(
					command.ServerID, command.AgentID, *entity.ComputerID,
					entity.RuntimeKind, entity.Revision,
				)
			}
			if entity.ComputerID == nil || *entity.ComputerID != command.ComputerID ||
				entity.Revision != command.ContextGeneration ||
				expectedKey != command.AuthorityContextKey {
				result = agentport.ProfileCapabilitySubmissionResult{
					Accepted: false, Reason: "superseded",
				}
				return nil
			}
			payload := persistedjson.ProfileCapabilitiesPayload{
				SchemaVersion: 1,
				Invalidations: []persistedjson.ProfileCapabilityInvalidation{},
			}
			if entity.ProfileCapabilitiesJSON != nil {
				if _, err := persistedjson.DecodeProfileCapabilities(
					*entity.ProfileCapabilitiesJSON, &payload,
				); err != nil {
					return err
				}
			}
			for _, invalidation := range payload.Invalidations {
				if invalidation.EventID == command.EventID ||
					invalidation.RuntimeContextGeneration > command.RuntimeContextGeneration ||
					invalidation.RuntimeContextGeneration == command.RuntimeContextGeneration &&
						invalidation.EventSequence >= command.EventSequence {
					result = agentport.ProfileCapabilitySubmissionResult{
						Accepted: false, Reason: "duplicate",
					}
					return nil
				}
			}
			payload.InvalidationGeneration++
			payload.Invalidations = append(
				payload.Invalidations,
				persistedjson.ProfileCapabilityInvalidation{
					EventID:                  command.EventID,
					Generation:               payload.InvalidationGeneration,
					RuntimeContextGeneration: command.RuntimeContextGeneration,
					EventSequence:            command.EventSequence,
					Reason:                   command.Reason,
					ObservedAt:               command.ObservedAt.UTC(),
				},
			)
			encoded, err := persistedjson.EncodeProfileCapabilities(payload)
			if err != nil {
				return err
			}
			updated, err := tx.Agent.Update().
				Where(
					agententity.IDEQ(command.AgentID),
					agententity.ServerIDEQ(command.ServerID),
					agententity.RevisionEQ(command.ContextGeneration),
					agententity.ComputerIDEQ(command.ComputerID),
				).
				SetProfileCapabilitiesJSON(encoded).
				SetUpdatedAt(command.ObservedAt.UTC()).
				Save(ctx)
			if err != nil {
				return err
			}
			if updated != 1 {
				return agentport.ErrRevisionConflict
			}
			result = agentport.ProfileCapabilitySubmissionResult{
				Accepted: true, Reason: "accepted",
			}
			return nil
		},
	)
	return result, returnErr
}

func (repository *EntRepository) ExpireProfileCapabilityRefresh(
	ctx context.Context,
	now time.Time,
) (expired bool, returnErr error) {
	returnErr = repository.handle.WithTx(
		ctx,
		func(ctx context.Context, tx *ent.Tx) error {
			operation, err := tx.TencentOperation.Query().
				Where(
					tencentoperation.ServiceEQ("platform"),
					tencentoperation.KindEQ("agent.profile.capabilities.refresh"),
					tencentoperation.StateIn("pending", "running", "retry_wait", "uncertain"),
					tencentoperation.DeadlineAtNotNil(),
					tencentoperation.DeadlineAtLTE(now.UTC()),
				).
				Order(ent.Asc(tencentoperation.FieldDeadlineAt), ent.Asc(tencentoperation.FieldID)).
				First(ctx)
			if ent.IsNotFound(err) {
				return nil
			}
			if err != nil {
				return err
			}
			digest := sha256.Sum256([]byte(
				"agent-profile-capability-deadline/v1\x00" + operation.ID,
			))
			resultSnapshot, err := persistedjson.EncodeResultSnapshot(
				"platform", "agent.profile.capabilities.refresh",
				profileCapabilityResultSnapshot{
					SchemaVersion: 1, Status: "failed",
					ResultDigest: base64.RawURLEncoding.EncodeToString(digest[:]),
					ErrorCode:    "profile_capability_deadline_exceeded",
				},
			)
			if err != nil {
				return err
			}
			updated, err := tx.TencentOperation.Update().
				Where(
					tencentoperation.IDEQ(operation.ID),
					tencentoperation.PartitionKeyEQ(operation.PartitionKey),
					tencentoperation.StateIn("pending", "running", "retry_wait", "uncertain"),
					tencentoperation.DeadlineAtNotNil(),
					tencentoperation.DeadlineAtLTE(now.UTC()),
				).
				SetState("failed").SetResultJSON(resultSnapshot).
				SetLastErrorCode("profile_capability_deadline_exceeded").
				SetCompletedAt(now.UTC()).SetUpdatedAt(now.UTC()).
				ClearNextAttemptAt().ClearLeaseOwner().ClearLeaseExpiresAt().
				Save(ctx)
			if err != nil {
				return err
			}
			if updated != 1 {
				return nil
			}
			entity, err := tx.Agent.Query().
				Where(
					agententity.IDEQ(operation.ResourceID),
					agententity.ServerIDEQ(operation.PartitionKey),
					agententity.ProfileCapabilityRefreshIDEQ(operation.ID),
				).
				Only(ctx)
			if err == nil {
				if _, err := tx.Agent.UpdateOne(entity).
					ClearProfileCapabilityRefreshID().SetUpdatedAt(now.UTC()).Save(ctx); err != nil {
					return err
				}
				if err := bumpComputerAssignments(
					ctx, tx, operation.PartitionKey, []*string{entity.ComputerID}, now.UTC(),
				); err != nil {
					return err
				}
			} else if !ent.IsNotFound(err) {
				return err
			}
			expired = true
			return nil
		},
	)
	return expired, returnErr
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
			if agentport.RequiresActiveCredential(command.Kind) {
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
