// Package channel 使用 Ent/SQLite 保存 Channel 与可靠 IM Topic 操作。
package channel

import (
	"context"
	"crypto/subtle"
	"errors"
	"strings"
	"time"

	"chatserver/internal/database"
	"chatserver/internal/ent"
	"chatserver/internal/ent/accountservermembership"
	channelentity "chatserver/internal/ent/channel"
	"chatserver/internal/ent/channelmember"
	"chatserver/internal/ent/idempotencyrecord"
	"chatserver/internal/ent/server"
	"chatserver/internal/ent/tencentoperation"
	"chatserver/internal/persistedjson"
	channelport "chatserver/internal/ports/channel"
)

// EntRepository 以 server_id 作为业务分区保存 Channel。
type EntRepository struct{ handle *database.Handle }

// NewEntRepository 创建 Channel Repository。
func NewEntRepository(handle *database.Handle) (*EntRepository, error) {
	if handle == nil || handle.Client() == nil {
		return nil, errors.New("Channel Repository 缺少数据库 Handle")
	}
	return &EntRepository{handle: handle}, nil
}

// GetServerContext 返回 active membership 对应的 Community 路由。
func (repository *EntRepository) GetServerContext(
	ctx context.Context,
	accountID string,
	serverID string,
) (channelport.ServerContext, error) {
	membership, err := repository.handle.Client().
		AccountServerMembership.Query().
		Where(
			accountservermembership.AccountIDEQ(accountID),
			accountservermembership.ServerIDEQ(serverID),
			accountservermembership.StatusEQ("active"),
		).
		Only(ctx)
	if ent.IsNotFound(err) {
		return channelport.ServerContext{}, channelport.ErrServerNotFound
	}
	if err != nil {
		return channelport.ServerContext{}, err
	}
	entity, err := repository.handle.Client().Server.Query().
		Where(server.IDEQ(serverID)).
		Only(ctx)
	if ent.IsNotFound(err) {
		return channelport.ServerContext{}, channelport.ErrServerNotFound
	}
	if err != nil {
		return channelport.ServerContext{}, err
	}
	return channelport.ServerContext{
		IMGroupID: entity.ImGroupID,
		IMState:   entity.ImState,
		Role:      membership.Role,
	}, nil
}

// Create 原子创建 Channel、Topic ensure operation、Outbox 与幂等记录。
func (repository *EntRepository) Create(
	ctx context.Context,
	command channelport.CreateCommand,
) (result channelport.CreateResult, returnErr error) {
	returnErr = repository.handle.WithTx(
		ctx,
		func(ctx context.Context, tx *ent.Tx) error {
			membership, err := requireMembership(
				ctx,
				tx,
				command.AccountID,
				command.ServerID,
			)
			if err != nil {
				return err
			}
			if membership.Role != "owner" && membership.Role != "admin" {
				return channelport.ErrPermissionDenied
			}
			stored, err := tx.IdempotencyRecord.Query().
				Where(
					idempotencyrecord.PartitionKeyEQ(command.ServerID),
					idempotencyrecord.ScopeTypeEQ("channel.create"),
					idempotencyrecord.ScopeIDEQ(command.ServerID),
					idempotencyrecord.IdempotencyKeyEQ(command.IdempotencyKey),
				).
				Only(ctx)
			if err == nil {
				if subtle.ConstantTimeCompare(
					stored.RequestHash,
					command.RequestHash[:],
				) != 1 {
					return channelport.ErrIdempotencyConflict
				}
				channelID, operationIDs, err := decodeLocator(
					stored.ResponseBodyJSON,
				)
				if err != nil {
					return err
				}
				return loadResult(
					ctx,
					tx,
					command.ServerID,
					channelID,
					operationIDs,
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
				return channelport.ErrServerNotFound
			}
			if err != nil {
				return err
			}
			if serverEntity.ImState != "ready" ||
				serverEntity.ImGroupID != command.Channel.IMGroupID {
				return channelport.ErrServerNotReady
			}
			if !validTopicRoute(command.Channel) {
				return errors.New("Channel Topic 路由无效")
			}
			conflict, err := tx.Channel.Query().
				Where(
					channelentity.ServerIDEQ(command.ServerID),
					channelentity.NameEQ(command.Channel.Name),
				).
				Exist(ctx)
			if err != nil {
				return err
			}
			if conflict {
				return channelport.ErrChannelNameConflict
			}
			now := command.CreatedAt.UTC()
			entity, err := tx.Channel.Create().
				SetID(command.Channel.ID).
				SetServerID(command.ServerID).
				SetName(command.Channel.Name).
				SetNillableDescription(command.Channel.Description).
				SetVisibility(command.Channel.Visibility).
				SetImGroupID(command.Channel.IMGroupID).
				SetImTopicID(command.Channel.IMTopicID).
				SetImState("provisioning").
				SetRevision(1).
				SetCreatedAt(now).
				SetUpdatedAt(now).
				Save(ctx)
			if err != nil {
				if ent.IsConstraintError(err) {
					return channelport.ErrChannelNameConflict
				}
				return err
			}
			operation, err := tx.TencentOperation.Create().
				SetID(command.OperationID).
				SetPartitionKey(command.ServerID).
				SetServerID(command.ServerID).
				SetService("im").
				SetKind("im.topic.ensure").
				SetResourceType("channel").
				SetResourceID(entity.ID).
				SetIdempotencyKey(
					"im.topic.ensure:v1:" + entity.ID + ":1",
				).
				SetDesiredRevision(1).
				SetState("pending").
				SetAttempts(0).
				SetCreatedAt(now).
				SetUpdatedAt(now).
				Save(ctx)
			if err != nil {
				return err
			}
			if _, err := tx.OutboxEvent.Create().
				SetPartitionKey(command.ServerID).
				SetServerID(command.ServerID).
				SetEventType("tencent.operation.ready").
				SetAggregateType("tencent_operation").
				SetAggregateID(operation.ID).
				SetState("pending").
				SetAttempts(0).
				SetAvailableAt(now).
				SetCreatedAt(now).
				Save(ctx); err != nil {
				return err
			}
			initialMembership, err := tx.ChannelMember.Create().
				SetID(command.InitialChannelMemberID).
				SetServerID(command.ServerID).
				SetChannelID(entity.ID).
				SetMemberID(membership.MemberID).
				SetState("active").
				SetImState("provisioning").
				SetMembershipVersion(1).
				SetCreatedAt(now).
				SetUpdatedAt(now).
				Save(ctx)
			if err != nil {
				return err
			}
			membershipOperation, err := tx.TencentOperation.Create().
				SetID(command.InitialMembershipOperationID).
				SetPartitionKey(command.ServerID).
				SetServerID(command.ServerID).
				SetService("im").
				SetKind("im.membership.ensure").
				SetResourceType("channel_member").
				SetResourceID(initialMembership.ID).
				SetIdempotencyKey(
					"im.membership.ensure:v1:" + initialMembership.ID + ":1",
				).
				SetDesiredRevision(1).
				SetState("pending").
				SetAttempts(0).
				SetCreatedAt(now).
				SetUpdatedAt(now).
				Save(ctx)
			if err != nil {
				return err
			}
			if _, err := tx.OutboxEvent.Create().
				SetPartitionKey(command.ServerID).
				SetServerID(command.ServerID).
				SetEventType("tencent.operation.ready").
				SetAggregateType("tencent_operation").
				SetAggregateID(membershipOperation.ID).
				SetState("pending").
				SetAttempts(0).
				SetAvailableAt(now).
				SetCreatedAt(now).
				Save(ctx); err != nil {
				return err
			}
			operationIDs := []string{operation.ID, membershipOperation.ID}
			response, err := encodeLocator(entity.ID, operationIDs)
			if err != nil {
				return err
			}
			if _, err := tx.IdempotencyRecord.Create().
				SetPartitionKey(command.ServerID).
				SetScopeType("channel.create").
				SetScopeID(command.ServerID).
				SetIdempotencyKey(command.IdempotencyKey).
				SetRequestHash(command.RequestHash[:]).
				SetResponseStatus(202).
				SetResponseBodyJSON(response).
				SetExpiresAt(now.Add(24 * time.Hour)).
				SetCreatedAt(now).
				Save(ctx); err != nil {
				return err
			}
			result = channelport.CreateResult{
				Channel: func() channelport.Channel {
					value := mapChannel(entity)
					value.Joined = false
					return value
				}(),
				Operations: []channelport.Operation{
					mapOperation(operation),
					mapOperation(membershipOperation),
				},
			}
			return nil
		},
	)
	return result, returnErr
}

// Update 原子修改 Channel 元数据并保存稳定幂等响应。
func (repository *EntRepository) Update(
	ctx context.Context,
	command channelport.UpdateCommand,
) (result channelport.Channel, returnErr error) {
	returnErr = repository.handle.WithTx(
		ctx,
		func(ctx context.Context, tx *ent.Tx) error {
			membership, err := requireMembership(
				ctx,
				tx,
				command.AccountID,
				command.ServerID,
			)
			if err != nil {
				return err
			}
			if membership.Role != "owner" && membership.Role != "admin" {
				return channelport.ErrPermissionDenied
			}
			stored, err := tx.IdempotencyRecord.Query().
				Where(
					idempotencyrecord.PartitionKeyEQ(command.ServerID),
					idempotencyrecord.ScopeTypeEQ("channel.update"),
					idempotencyrecord.ScopeIDEQ(command.ChannelID),
					idempotencyrecord.IdempotencyKeyEQ(command.IdempotencyKey),
				).
				Only(ctx)
			if err == nil {
				if subtle.ConstantTimeCompare(
					stored.RequestHash,
					command.RequestHash[:],
				) != 1 {
					return channelport.ErrIdempotencyConflict
				}
				_, err = persistedjson.DecodeScoped(
					stored.ResponseBodyJSON, "channel.update", &result,
				)
				return err
			}
			if !ent.IsNotFound(err) {
				return err
			}
			entity, err := tx.Channel.Query().
				Where(
					channelentity.IDEQ(command.ChannelID),
					channelentity.ServerIDEQ(command.ServerID),
				).
				Only(ctx)
			if ent.IsNotFound(err) {
				return channelport.ErrChannelNotFound
			}
			if err != nil {
				return err
			}
			if entity.Revision != command.Revision {
				return channelport.ErrRevisionConflict
			}
			if command.NameSet && command.Name != entity.Name {
				conflict, err := tx.Channel.Query().
					Where(
						channelentity.ServerIDEQ(command.ServerID),
						channelentity.NameEQ(command.Name),
						channelentity.IDNEQ(command.ChannelID),
					).
					Exist(ctx)
				if err != nil {
					return err
				}
				if conflict {
					return channelport.ErrChannelNameConflict
				}
			}
			update := tx.Channel.UpdateOne(entity).
				AddRevision(1).
				SetUpdatedAt(command.UpdatedAt.UTC())
			if command.NameSet {
				update.SetName(command.Name)
			}
			if command.DescriptionSet {
				if command.Description == nil {
					update.ClearDescription()
				} else {
					update.SetDescription(*command.Description)
				}
			}
			updated, err := update.Save(ctx)
			if err != nil {
				if ent.IsConstraintError(err) {
					return channelport.ErrChannelNameConflict
				}
				return err
			}
			result = mapChannel(updated)
			joined, err := tx.ChannelMember.Query().
				Where(
					channelmember.ServerIDEQ(command.ServerID),
					channelmember.ChannelIDEQ(command.ChannelID),
					channelmember.MemberIDEQ(membership.MemberID),
					channelmember.StateEQ("active"),
					channelmember.ImStateEQ("ready"),
				).
				Exist(ctx)
			if err != nil {
				return err
			}
			result.Joined = updated.SystemKey != nil &&
				*updated.SystemKey == "all" || joined
			response, err := persistedjson.EncodeScoped("channel.update", result)
			if err != nil {
				return err
			}
			if _, err := tx.IdempotencyRecord.Create().
				SetPartitionKey(command.ServerID).
				SetScopeType("channel.update").
				SetScopeID(command.ChannelID).
				SetIdempotencyKey(command.IdempotencyKey).
				SetRequestHash(command.RequestHash[:]).
				SetResponseStatus(200).
				SetResponseBodyJSON(response).
				SetExpiresAt(command.UpdatedAt.UTC().Add(24 * time.Hour)).
				SetCreatedAt(command.UpdatedAt.UTC()).
				Save(ctx); err != nil {
				return err
			}
			return nil
		},
	)
	return result, returnErr
}

// List 列出 active membership 可见的所有 Channel。
func (repository *EntRepository) List(
	ctx context.Context,
	accountID string,
	serverID string,
) ([]channelport.Channel, error) {
	actor, err := repository.activeMembership(
		ctx,
		accountID,
		serverID,
	)
	if err != nil {
		return nil, err
	}
	memberships, err := repository.handle.Client().ChannelMember.Query().
		Where(
			channelmember.ServerIDEQ(serverID),
			channelmember.MemberIDEQ(actor.MemberID),
			channelmember.StateEQ("active"),
			channelmember.ImStateEQ("ready"),
		).
		All(ctx)
	if err != nil {
		return nil, err
	}
	joined := make(map[string]struct{}, len(memberships))
	for _, membership := range memberships {
		joined[membership.ChannelID] = struct{}{}
	}
	entities, err := repository.handle.Client().Channel.Query().
		Where(channelentity.ServerIDEQ(serverID)).
		Order(ent.Asc(channelentity.FieldID)).
		All(ctx)
	if err != nil {
		return nil, err
	}
	values := make([]channelport.Channel, 0, len(entities))
	for _, entity := range entities {
		_, explicit := joined[entity.ID]
		root := entity.SystemKey != nil && *entity.SystemKey == "all"
		manager := actor.Role == "owner" || actor.Role == "admin"
		if !manager && !root && entity.Visibility != "public" && !explicit {
			continue
		}
		value := mapChannel(entity)
		value.Joined = root || explicit
		values = append(values, value)
	}
	return values, nil
}

// Get 返回 active membership 可见的单个 Channel。
func (repository *EntRepository) Get(
	ctx context.Context,
	accountID string,
	serverID string,
	channelID string,
) (channelport.Channel, error) {
	actor, err := repository.activeMembership(
		ctx,
		accountID,
		serverID,
	)
	if err != nil {
		return channelport.Channel{}, err
	}
	entity, err := repository.handle.Client().Channel.Query().
		Where(
			channelentity.IDEQ(channelID),
			channelentity.ServerIDEQ(serverID),
		).
		Only(ctx)
	if ent.IsNotFound(err) {
		return channelport.Channel{}, channelport.ErrChannelNotFound
	}
	if err != nil {
		return channelport.Channel{}, err
	}
	explicit, err := repository.handle.Client().ChannelMember.Query().
		Where(
			channelmember.ServerIDEQ(serverID),
			channelmember.ChannelIDEQ(channelID),
			channelmember.MemberIDEQ(actor.MemberID),
			channelmember.StateEQ("active"),
			channelmember.ImStateEQ("ready"),
		).
		Exist(ctx)
	if err != nil {
		return channelport.Channel{}, err
	}
	root := entity.SystemKey != nil && *entity.SystemKey == "all"
	manager := actor.Role == "owner" || actor.Role == "admin"
	if !manager && !root && entity.Visibility != "public" && !explicit {
		return channelport.Channel{}, channelport.ErrChannelNotFound
	}
	value := mapChannel(entity)
	value.Joined = root || explicit
	return value, nil
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
		return nil, channelport.ErrServerNotFound
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
		return nil, channelport.ErrServerNotFound
	}
	return entity, err
}

func validTopicRoute(draft channelport.Draft) bool {
	prefix := draft.IMGroupID + "@TOPIC#_T_"
	if !strings.HasPrefix(draft.IMTopicID, prefix) {
		return false
	}
	suffix := strings.TrimPrefix(draft.IMTopicID, prefix)
	return len(suffix) == 26 &&
		draft.IMTopicName == "C-"+suffix[:20]
}

func mapChannel(entity *ent.Channel) channelport.Channel {
	return channelport.Channel{
		ID:          entity.ID,
		ServerID:    entity.ServerID,
		Name:        entity.Name,
		Description: entity.Description,
		Visibility:  entity.Visibility,
		SystemKey:   entity.SystemKey,
		IMGroupID:   entity.ImGroupID,
		IMTopicID:   entity.ImTopicID,
		IMState:     entity.ImState,
		Revision:    entity.Revision,
	}
}

func mapOperation(entity *ent.TencentOperation) channelport.Operation {
	return channelport.Operation{
		ID:        entity.ID,
		ServerID:  stringValue(entity.ServerID),
		Service:   entity.Service,
		Kind:      entity.Kind,
		State:     entity.State,
		CreatedAt: entity.CreatedAt,
	}
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func loadResult(
	ctx context.Context,
	tx *ent.Tx,
	serverID string,
	channelID string,
	operationIDs []string,
	result *channelport.CreateResult,
) error {
	channelEntity, err := tx.Channel.Query().
		Where(
			channelentity.IDEQ(channelID),
			channelentity.ServerIDEQ(serverID),
		).
		Only(ctx)
	if err != nil {
		return err
	}
	operations := make([]channelport.Operation, 0, len(operationIDs))
	for _, operationID := range operationIDs {
		operationEntity, err := tx.TencentOperation.Query().
			Where(
				tencentoperation.IDEQ(operationID),
				tencentoperation.PartitionKeyEQ(serverID),
			).
			Only(ctx)
		if err != nil {
			return err
		}
		operations = append(operations, mapOperation(operationEntity))
	}
	*result = channelport.CreateResult{
		Channel: func() channelport.Channel {
			value := mapChannel(channelEntity)
			value.Joined = false
			return value
		}(),
		Operations: operations,
	}
	return nil
}

func encodeLocator(channelID string, operationIDs []string) (string, error) {
	encoded, err := persistedjson.EncodeScoped("channel.create", struct {
		ChannelID    string   `json:"channelId"`
		OperationIDs []string `json:"operationIds"`
	}{
		ChannelID:    channelID,
		OperationIDs: operationIDs,
	})
	return encoded, err
}

func decodeLocator(raw string) (string, []string, error) {
	var value struct {
		ChannelID    string   `json:"channelId"`
		OperationID  string   `json:"operationId,omitempty"`
		OperationIDs []string `json:"operationIds,omitempty"`
	}
	if _, err := persistedjson.DecodeScoped(raw, "channel.create", &value); err != nil {
		return "", nil, err
	}
	if len(value.OperationIDs) == 0 && value.OperationID != "" {
		value.OperationIDs = []string{value.OperationID}
	}
	if value.ChannelID == "" || len(value.OperationIDs) == 0 {
		return "", nil, errors.New("Channel 幂等记录无效")
	}
	for _, operationID := range value.OperationIDs {
		if strings.TrimSpace(operationID) == "" {
			return "", nil, errors.New("Channel 幂等记录无效")
		}
	}
	return value.ChannelID, value.OperationIDs, nil
}

var _ channelport.Repository = (*EntRepository)(nil)
