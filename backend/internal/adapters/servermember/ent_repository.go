// Package servermember 提供 Server 与 Member 的 Ent/SQLite Repository。
package servermember

import (
	"context"
	"crypto/subtle"
	"errors"
	"time"

	"chatserver/internal/database"
	"chatserver/internal/ent"
	"chatserver/internal/ent/account"
	"chatserver/internal/ent/accountservermembership"
	agententity "chatserver/internal/ent/agent"
	"chatserver/internal/ent/channelmember"
	"chatserver/internal/ent/idempotencyrecord"
	"chatserver/internal/ent/member"
	"chatserver/internal/ent/server"
	"chatserver/internal/persistedjson"
	servermemberport "chatserver/internal/ports/servermember"
)

// EntRepository 使用一个 SQLite 事务保存完整 Server aggregate。
type EntRepository struct {
	handle *database.Handle
}

// NewEntRepository 创建 Server/Member Repository。
func NewEntRepository(handle *database.Handle) (*EntRepository, error) {
	if handle == nil || handle.Client() == nil {
		return nil, errors.New("Server Repository 缺少数据库 Handle")
	}
	return &EntRepository{handle: handle}, nil
}

// Create 原子创建 Server、Owner、根 Channel 及可靠副作用记录。
func (repository *EntRepository) Create(
	ctx context.Context,
	command servermemberport.CreateCommand,
) (result servermemberport.CreateResult, returnErr error) {
	returnErr = repository.handle.WithTx(
		ctx,
		func(ctx context.Context, tx *ent.Tx) error {
			if command.RootChannelTopicID == "" || command.RootTopicOperationID == "" {
				return errors.New("Server 根 Topic 路由无效")
			}
			stored, err := tx.IdempotencyRecord.Query().
				Where(
					idempotencyrecord.PartitionKeyEQ(command.AccountID),
					idempotencyrecord.ScopeTypeEQ("server.create"),
					idempotencyrecord.ScopeIDEQ(command.AccountID),
					idempotencyrecord.IdempotencyKeyEQ(command.IdempotencyKey),
				).
				Only(ctx)
			if err == nil {
				if subtle.ConstantTimeCompare(
					stored.RequestHash,
					command.RequestHash[:],
				) != 1 {
					return servermemberport.ErrIdempotencyConflict
				}
				locator, err := decodeAcceptedLocator(
					stored.ResponseBodyJSON,
				)
				if err != nil {
					return err
				}
				result = servermemberport.CreateResult{
					ServerID:    locator.ServerID,
					OperationID: locator.OperationID,
				}
				return nil
			}
			if !ent.IsNotFound(err) {
				return err
			}
			accountEntity, err := tx.Account.Query().
				Where(account.IDEQ(command.AccountID)).
				Only(ctx)
			if ent.IsNotFound(err) {
				return servermemberport.ErrAccountNotFound
			}
			if err != nil {
				return err
			}
			if accountEntity.ImState != "ready" || accountEntity.ImUserID == "" {
				return servermemberport.ErrAccountIMNotReady
			}
			now := command.CreatedAt.UTC()
			if _, err := tx.ServerSlugRegistry.Create().
				SetSlug(command.Server.Slug).
				SetServerID(command.Server.ID).
				SetState("active").
				SetCreatedAt(now).
				SetUpdatedAt(now).
				Save(ctx); err != nil {
				if ent.IsConstraintError(err) {
					return servermemberport.ErrServerSlugConflict
				}
				return err
			}
			if _, err := tx.Server.Create().
				SetID(command.Server.ID).
				SetSlug(command.Server.Slug).
				SetName(command.Server.Name).
				SetNillableDescription(command.Server.Description).
				SetOwnerMemberID(command.Server.OwnerMemberID).
				SetImGroupID(command.Server.IMGroupID).
				SetImState("provisioning").
				SetNextTaskNumber(1).
				SetRevision(1).
				SetCreatedAt(now).
				SetUpdatedAt(now).
				Save(ctx); err != nil {
				return err
			}
			if _, err := tx.Member.Create().
				SetID(command.Owner.ID).
				SetServerID(command.Server.ID).
				SetAccountID(command.AccountID).
				SetKind("human").
				SetRole("owner").
				SetDisplayName(accountEntity.DisplayName).
				SetHandle(command.Owner.Handle).
				SetActiveHandleKey(command.Owner.Handle).
				SetStatus("active").
				SetImState("provisioning").
				SetRevision(1).
				SetCreatedAt(now).
				SetUpdatedAt(now).
				Save(ctx); err != nil {
				return err
			}
			if _, err := tx.Channel.Create().
				SetID(command.RootChannelID).
				SetServerID(command.Server.ID).
				SetName("全员").
				SetVisibility("public").
				SetSystemKey("all").
				SetImGroupID(command.Server.IMGroupID).
				SetImTopicID(command.RootChannelTopicID).
				SetImState("provisioning").
				SetRevision(1).
				SetCreatedAt(now).
				SetUpdatedAt(now).
				Save(ctx); err != nil {
				return err
			}
			if _, err := tx.AccountServerMembership.Create().
				SetAccountID(command.AccountID).
				SetServerID(command.Server.ID).
				SetMemberID(command.Owner.ID).
				SetRole("owner").
				SetStatus("active").
				SetServerNameSnapshot(command.Server.Name).
				SetServerSlugSnapshot(command.Server.Slug).
				SetServerRevision(1).
				SetProjectedAt(now).
				SetUpdatedAt(now).
				Save(ctx); err != nil {
				return err
			}
			snapshot, err := persistedjson.EncodeSnapshot(
				"im",
				"im.community.ensure",
				struct {
					RootTopicOperationID string `json:"rootTopicOperationId"`
				}{RootTopicOperationID: command.RootTopicOperationID},
			)
			if err != nil {
				return err
			}
			operation, err := tx.TencentOperation.Create().
				SetID(command.OperationID).
				SetPartitionKey(command.Server.ID).
				SetServerID(command.Server.ID).
				SetService("im").
				SetKind("im.community.ensure").
				SetResourceType("server").
				SetResourceID(command.Server.ID).
				SetIdempotencyKey(
					"im.community.ensure:v1:" + command.Server.ID + ":1",
				).
				SetDesiredRevision(1).
				SetRequestSnapshotJSON(snapshot).
				SetState("pending").
				SetAttempts(0).
				SetCreatedAt(now).
				SetUpdatedAt(now).
				Save(ctx)
			if err != nil {
				return err
			}
			if _, err := tx.OutboxEvent.Create().
				SetPartitionKey(command.Server.ID).
				SetServerID(command.Server.ID).
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
			response, err := acceptedResponseJSON(
				command.Server.ID,
				operation.ID,
				now,
			)
			if err != nil {
				return err
			}
			if _, err := tx.IdempotencyRecord.Create().
				SetPartitionKey(command.AccountID).
				SetScopeType("server.create").
				SetScopeID(command.AccountID).
				SetIdempotencyKey(command.IdempotencyKey).
				SetRequestHash(command.RequestHash[:]).
				SetResponseStatus(202).
				SetResponseBodyJSON(response).
				SetExpiresAt(now.Add(24 * time.Hour)).
				SetCreatedAt(now).
				Save(ctx); err != nil {
				return err
			}
			result = servermemberport.CreateResult{
				Created:     true,
				ServerID:    command.Server.ID,
				OperationID: operation.ID,
			}
			return nil
		},
	)
	return result, returnErr
}

func acceptedResponseJSON(
	serverID string,
	operationID string,
	createdAt time.Time,
) (string, error) {
	type operation struct {
		ID        string `json:"id"`
		Service   string `json:"service"`
		Kind      string `json:"kind"`
		State     string `json:"state"`
		CreatedAt string `json:"createdAt"`
	}
	body := struct {
		ResourceID string      `json:"resourceId"`
		Operations []operation `json:"operations"`
	}{
		ResourceID: serverID,
		Operations: []operation{{
			ID:        operationID,
			Service:   "im",
			Kind:      "im.community.ensure",
			State:     "pending",
			CreatedAt: createdAt.UTC().Format(time.RFC3339Nano),
		}},
	}
	return persistedjson.EncodeScoped("server.create", body)
}

type acceptedLocator struct {
	ServerID    string
	OperationID string
}

func decodeAcceptedLocator(value string) (acceptedLocator, error) {
	var body struct {
		ResourceID string `json:"resourceId"`
		Operations []struct {
			ID        string `json:"id"`
			Service   string `json:"service"`
			Kind      string `json:"kind"`
			State     string `json:"state"`
			CreatedAt string `json:"createdAt"`
		} `json:"operations"`
	}
	if _, err := persistedjson.DecodeScoped(value, "server.create", &body); err != nil {
		return acceptedLocator{}, err
	}
	if body.ResourceID == "" || len(body.Operations) != 1 ||
		body.Operations[0].ID == "" {
		return acceptedLocator{}, errors.New("Server 幂等记录无效")
	}
	return acceptedLocator{
		ServerID:    body.ResourceID,
		OperationID: body.Operations[0].ID,
	}, nil
}

// Update 在 Server 分区内授权、幂等检查并以 revision CAS 修改展示元数据。
func (repository *EntRepository) Update(
	ctx context.Context,
	command servermemberport.UpdateCommand,
) (result servermemberport.Server, returnErr error) {
	returnErr = repository.handle.WithTx(
		ctx,
		func(ctx context.Context, tx *ent.Tx) error {
			actor, err := tx.Member.Query().
				Where(
					member.ServerIDEQ(command.ServerID),
					member.AccountIDEQ(command.AccountID),
					member.KindEQ("human"),
					member.StatusEQ("active"),
				).
				Only(ctx)
			if ent.IsNotFound(err) {
				return servermemberport.ErrServerNotFound
			}
			if err != nil {
				return err
			}
			if actor.Role != "owner" && actor.Role != "admin" {
				return servermemberport.ErrPermissionDenied
			}
			stored, err := tx.IdempotencyRecord.Query().
				Where(
					idempotencyrecord.PartitionKeyEQ(command.ServerID),
					idempotencyrecord.ScopeTypeEQ("server.update"),
					idempotencyrecord.ScopeIDEQ(command.ServerID),
					idempotencyrecord.IdempotencyKeyEQ(command.IdempotencyKey),
				).
				Only(ctx)
			if err == nil {
				return decodeServerUpdate(stored, command.RequestHash, &result)
			}
			if !ent.IsNotFound(err) {
				return err
			}
			update := tx.Server.Update().
				Where(
					server.IDEQ(command.ServerID),
					server.RevisionEQ(command.Revision),
				).
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
			affected, err := update.Save(ctx)
			if err != nil {
				return err
			}
			if affected != 1 {
				return servermemberport.ErrRevisionConflict
			}
			updated, err := tx.Server.Query().
				Where(server.IDEQ(command.ServerID)).
				Only(ctx)
			if err != nil {
				return err
			}
			result = mapServer(updated)
			response, err := persistedjson.EncodeScoped("server.update", result)
			if err != nil {
				return err
			}
			if _, err := tx.IdempotencyRecord.Create().
				SetPartitionKey(command.ServerID).
				SetScopeType("server.update").
				SetScopeID(command.ServerID).
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
	if !errors.Is(returnErr, servermemberport.ErrRevisionConflict) {
		return result, returnErr
	}
	// 同一幂等请求可能与另一个事务同时通过首次查询。CAS 失败后只从已提交
	// 数据重新判定；命中同一请求应返回稳定结果，而不是误报 revision 冲突。
	stored, err := repository.handle.Client().IdempotencyRecord.Query().
		Where(
			idempotencyrecord.PartitionKeyEQ(command.ServerID),
			idempotencyrecord.ScopeTypeEQ("server.update"),
			idempotencyrecord.ScopeIDEQ(command.ServerID),
			idempotencyrecord.IdempotencyKeyEQ(command.IdempotencyKey),
		).
		Only(ctx)
	if ent.IsNotFound(err) {
		return servermemberport.Server{}, returnErr
	}
	if err != nil {
		return servermemberport.Server{}, err
	}
	if err := decodeServerUpdate(stored, command.RequestHash, &result); err != nil {
		return servermemberport.Server{}, err
	}
	return result, nil
}

func decodeServerUpdate(
	stored *ent.IdempotencyRecord,
	requestHash [32]byte,
	result *servermemberport.Server,
) error {
	if subtle.ConstantTimeCompare(stored.RequestHash, requestHash[:]) != 1 {
		return servermemberport.ErrIdempotencyConflict
	}
	_, err := persistedjson.DecodeScoped(
		stored.ResponseBodyJSON,
		"server.update",
		result,
	)
	return err
}

// ListServers 列出当前账号 active projection 指向的 Server。
func (repository *EntRepository) ListServers(
	ctx context.Context,
	accountID string,
	options servermemberport.ListOptions,
) (servermemberport.ServerPage, error) {
	limit := normalizedLimit(options.Limit)
	query := repository.handle.Client().AccountServerMembership.Query().
		Where(
			accountservermembership.AccountIDEQ(accountID),
			accountservermembership.StatusEQ("active"),
		)
	if options.AfterID != "" {
		query = query.Where(
			accountservermembership.ServerIDGT(options.AfterID),
		)
	}
	projections, err := query.
		Order(ent.Asc(accountservermembership.FieldServerID)).
		Limit(limit + 1).
		All(ctx)
	if err != nil {
		return servermemberport.ServerPage{}, err
	}
	page := servermemberport.ServerPage{
		Items: make([]servermemberport.Server, 0, min(limit, len(projections))),
	}
	if len(projections) > limit {
		page.NextCursor = projections[limit-1].ServerID
		projections = projections[:limit]
	}
	for _, projection := range projections {
		entity, err := repository.handle.Client().Server.Query().
			Where(server.IDEQ(projection.ServerID)).
			Only(ctx)
		if err != nil {
			return servermemberport.ServerPage{}, err
		}
		page.Items = append(page.Items, mapServer(entity))
	}
	return page, nil
}

// GetServer 在 active Human membership 授权后返回 Server。
func (repository *EntRepository) GetServer(
	ctx context.Context,
	accountID string,
	serverID string,
) (servermemberport.Server, error) {
	if err := repository.requireActiveMembership(
		ctx,
		accountID,
		serverID,
	); err != nil {
		return servermemberport.Server{}, err
	}
	entity, err := repository.handle.Client().Server.Query().
		Where(server.IDEQ(serverID)).
		Only(ctx)
	if ent.IsNotFound(err) {
		return servermemberport.Server{}, servermemberport.ErrServerNotFound
	}
	if err != nil {
		return servermemberport.Server{}, err
	}
	return mapServer(entity), nil
}

// ListMembers 列出目标 Server 的 active Member。
func (repository *EntRepository) ListMembers(
	ctx context.Context,
	accountID string,
	serverID string,
	options servermemberport.ListOptions,
) (servermemberport.MemberPage, error) {
	if err := repository.requireActiveMembership(
		ctx,
		accountID,
		serverID,
	); err != nil {
		return servermemberport.MemberPage{}, err
	}
	query := repository.handle.Client().Member.Query().
		Where(
			member.ServerIDEQ(serverID),
			member.StatusEQ("active"),
		)
	if options.AfterCreatedAt != nil && options.AfterID != "" {
		query = query.Where(member.Or(
			member.CreatedAtGT(*options.AfterCreatedAt),
			member.And(member.CreatedAtEQ(*options.AfterCreatedAt), member.IDGT(options.AfterID)),
		))
	}
	limit := normalizedLimit(options.Limit)
	entities, err := query.
		Order(ent.Asc(member.FieldCreatedAt), ent.Asc(member.FieldID)).
		Limit(limit + 1).
		All(ctx)
	if err != nil {
		return servermemberport.MemberPage{}, err
	}
	page := servermemberport.MemberPage{Items: make([]servermemberport.Member, 0, min(limit, len(entities)))}
	if len(entities) > limit {
		last := entities[limit-1]
		createdAt := last.CreatedAt.UTC()
		page.NextCreatedAt = &createdAt
		page.NextID = last.ID
		entities = entities[:limit]
	}
	for _, entity := range entities {
		value, err := repository.mapMember(ctx, entity)
		if err != nil {
			return servermemberport.MemberPage{}, err
		}
		page.Items = append(page.Items, value)
	}
	return page, nil
}

// ListChannelMembers 列出普通 Channel 的显式 active Member。
func (repository *EntRepository) ListChannelMembers(
	ctx context.Context,
	accountID string,
	serverID string,
	channelID string,
	options servermemberport.ListOptions,
) ([]servermemberport.Member, error) {
	actor, err := repository.handle.Client().AccountServerMembership.Query().
		Where(
			accountservermembership.AccountIDEQ(accountID),
			accountservermembership.ServerIDEQ(serverID),
			accountservermembership.StatusEQ("active"),
		).
		Only(ctx)
	if ent.IsNotFound(err) {
		return nil, servermemberport.ErrServerNotFound
	}
	if err != nil {
		return nil, err
	}
	if actor.Role != "owner" && actor.Role != "admin" {
		allowed, err := repository.handle.Client().ChannelMember.Query().
			Where(
				channelmember.ServerIDEQ(serverID),
				channelmember.ChannelIDEQ(channelID),
				channelmember.MemberIDEQ(actor.MemberID),
				channelmember.StateEQ("active"),
			).
			Exist(ctx)
		if err != nil {
			return nil, err
		}
		if !allowed {
			return nil, servermemberport.ErrPermissionDenied
		}
	}
	membershipQuery := repository.handle.Client().ChannelMember.Query().
		Where(
			channelmember.ServerIDEQ(serverID),
			channelmember.ChannelIDEQ(channelID),
			channelmember.StateEQ("active"),
		)
	if options.Cursor != "" {
		membershipQuery = membershipQuery.Where(
			channelmember.MemberIDGT(options.Cursor),
		)
	}
	memberships, err := membershipQuery.
		Order(ent.Asc(channelmember.FieldMemberID)).
		Limit(normalizedLimit(options.Limit)).
		All(ctx)
	if err != nil {
		return nil, err
	}
	memberIDs := make([]string, 0, len(memberships))
	for _, membership := range memberships {
		memberIDs = append(memberIDs, membership.MemberID)
	}
	if len(memberIDs) == 0 {
		return []servermemberport.Member{}, nil
	}
	entities, err := repository.handle.Client().Member.Query().
		Where(
			member.ServerIDEQ(serverID),
			member.StatusEQ("active"),
			member.IDIn(memberIDs...),
		).
		Order(ent.Asc(member.FieldID)).
		All(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]servermemberport.Member, 0, len(entities))
	for _, entity := range entities {
		value, err := repository.mapMember(ctx, entity)
		if err != nil {
			return nil, err
		}
		result = append(result, value)
	}
	return result, nil
}

// GetMember 返回目标 Server 内的单个 Member。
func (repository *EntRepository) GetMember(
	ctx context.Context,
	accountID string,
	serverID string,
	memberID string,
) (servermemberport.Member, error) {
	if err := repository.requireActiveMembership(
		ctx,
		accountID,
		serverID,
	); err != nil {
		return servermemberport.Member{}, err
	}
	entity, err := repository.handle.Client().Member.Query().
		Where(
			member.IDEQ(memberID),
			member.ServerIDEQ(serverID),
		).
		Only(ctx)
	if ent.IsNotFound(err) {
		return servermemberport.Member{}, servermemberport.ErrMemberNotFound
	}
	if err != nil {
		return servermemberport.Member{}, err
	}
	return repository.mapMember(ctx, entity)
}

func (repository *EntRepository) requireActiveMembership(
	ctx context.Context,
	accountID string,
	serverID string,
) error {
	exists, err := repository.handle.Client().AccountServerMembership.Query().
		Where(
			accountservermembership.AccountIDEQ(accountID),
			accountservermembership.ServerIDEQ(serverID),
			accountservermembership.StatusEQ("active"),
		).
		Exist(ctx)
	if err != nil {
		return err
	}
	if !exists {
		return servermemberport.ErrServerNotFound
	}
	return nil
}

func (repository *EntRepository) mapMember(
	ctx context.Context,
	entity *ent.Member,
) (servermemberport.Member, error) {
	value := servermemberport.Member{
		ID:          entity.ID,
		ServerID:    entity.ServerID,
		AccountID:   entity.AccountID,
		Kind:        entity.Kind,
		Role:        entity.Role,
		DisplayName: entity.DisplayName,
		Handle:      entity.Handle,
		Status:      entity.Status,
		IMState:     entity.ImState,
		Revision:    nonNegativeRevision(entity.Revision),
		CreatedAt:   entity.CreatedAt,
	}
	if entity.AccountID != nil {
		accountEntity, err := repository.handle.Client().Account.Query().
			Where(account.IDEQ(*entity.AccountID)).
			Only(ctx)
		if err != nil {
			return servermemberport.Member{}, err
		}
		value.IMUserID = accountEntity.ImUserID
	} else if entity.Kind == "agent" {
		agentEntity, err := repository.handle.Client().Agent.Query().
			Where(
				agententity.IDEQ(entity.ID),
				agententity.ServerIDEQ(entity.ServerID),
			).
			Only(ctx)
		if err != nil {
			return servermemberport.Member{}, err
		}
		value.IMUserID = agentEntity.ImUserID
	}
	return value, nil
}

func mapServer(entity *ent.Server) servermemberport.Server {
	ownerMemberID := ""
	if entity.OwnerMemberID != nil {
		ownerMemberID = *entity.OwnerMemberID
	}
	return servermemberport.Server{
		ID:            entity.ID,
		Slug:          entity.Slug,
		Name:          entity.Name,
		Description:   entity.Description,
		OwnerMemberID: ownerMemberID,
		IMState:       entity.ImState,
		Revision:      nonNegativeRevision(entity.Revision),
	}
}

func normalizedLimit(value int) int {
	if value <= 0 {
		return 20
	}
	if value > 100 {
		return 100
	}
	return value
}

func nonNegativeRevision(value int64) uint64 {
	if value < 0 {
		return 0
	}
	return uint64(value)
}

var _ servermemberport.Repository = (*EntRepository)(nil)
