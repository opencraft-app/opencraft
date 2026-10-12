// Package botim 提供 Bot IM 身份、IM 路由与平台群的 Ent 持久化实现。
package botim

import (
	"context"
	"errors"
	"time"

	"git.woa.com/wisp/mono2/collaboration/internal/database"
	"git.woa.com/wisp/mono2/collaboration/internal/ent"
	"git.woa.com/wisp/mono2/collaboration/internal/ent/account"
	"git.woa.com/wisp/mono2/collaboration/internal/ent/botagent"
	"git.woa.com/wisp/mono2/collaboration/internal/ent/imgroup"
	"git.woa.com/wisp/mono2/collaboration/internal/ent/imgroupmember"
	"git.woa.com/wisp/mono2/collaboration/internal/ent/imidentityroute"
	botimport "git.woa.com/wisp/mono2/collaboration/internal/ports/botim"
	idport "git.woa.com/wisp/mono2/collaboration/internal/ports/id"
)

// EntRepository 每次查询都显式携带分片键：bot_agents 按 account_id，
// im_identity_routes 按 im_user_id，im_groups 按 id，im_group_members 按 group_id。
type EntRepository struct {
	handle *database.Handle
	ids    idport.Generator
}

func NewEntRepository(handle *database.Handle, ids idport.Generator) (*EntRepository, error) {
	if handle == nil || handle.Client() == nil || ids == nil {
		return nil, errors.New("Bot IM Repository 缺少数据库 Handle")
	}
	return &EntRepository{handle: handle, ids: ids}, nil
}

func (r *EntRepository) FindAccount(ctx context.Context, accountID string) (botimport.Account, error) {
	entity, err := r.handle.Client().Account.Query().Where(account.IDEQ(accountID)).Only(ctx)
	if ent.IsNotFound(err) {
		return botimport.Account{}, botimport.ErrNotFound
	}
	if err != nil {
		return botimport.Account{}, err
	}
	return botimport.Account{ID: entity.ID, IMUserID: entity.ImUserID, IMState: entity.ImState}, nil
}

func (r *EntRepository) FindBotByRef(
	ctx context.Context,
	accountID, instanceID, botID string,
) (botimport.BotAgent, error) {
	entity, err := r.handle.Client().BotAgent.Query().Where(
		botagent.AccountIDEQ(accountID),
		botagent.InstanceIDEQ(instanceID),
		botagent.BotIDEQ(botID),
	).Only(ctx)
	return botFromEntity(entity, err)
}

func (r *EntRepository) FindBot(ctx context.Context, accountID, botAgentID string) (botimport.BotAgent, error) {
	entity, err := r.handle.Client().BotAgent.Query().Where(
		botagent.AccountIDEQ(accountID),
		botagent.IDEQ(botAgentID),
	).Only(ctx)
	return botFromEntity(entity, err)
}

func (r *EntRepository) ListBots(ctx context.Context, accountID string, limit int) ([]botimport.BotAgent, error) {
	entities, err := r.handle.Client().BotAgent.Query().
		Where(botagent.AccountIDEQ(accountID)).
		Order(ent.Asc(botagent.FieldCreatedAt), ent.Asc(botagent.FieldID)).
		Limit(limit).
		All(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]botimport.BotAgent, 0, len(entities))
	for _, entity := range entities {
		bot, _ := botFromEntity(entity, nil)
		result = append(result, bot)
	}
	return result, nil
}

func (r *EntRepository) InsertBot(ctx context.Context, bot botimport.BotAgent) (botimport.BotAgent, error) {
	create := r.handle.Client().BotAgent.Create().
		SetID(bot.ID).
		SetAccountID(bot.AccountID).
		SetInstanceID(bot.InstanceID).
		SetBotID(bot.BotID).
		SetDisplayName(bot.DisplayName).
		SetImUserID(bot.IMUserID).
		SetState(bot.State).
		SetCommandPolicy(bot.CommandPolicy).
		SetCredentialVersion(bot.CredentialVersion).
		SetRevision(bot.Revision).
		SetCreatedAt(bot.CreatedAt).
		SetUpdatedAt(bot.UpdatedAt)
	if bot.LastErrorCode != "" {
		create.SetLastErrorCode(bot.LastErrorCode)
	}
	if len(bot.CredentialDigest) > 0 {
		create.SetCredentialDigest(bot.CredentialDigest)
	}
	entity, err := create.Save(ctx)
	if ent.IsConstraintError(err) {
		return botimport.BotAgent{}, botimport.ErrConflict
	}
	return botFromEntity(entity, err)
}

func (r *EntRepository) SaveBot(
	ctx context.Context,
	bot botimport.BotAgent,
	expectedRevision int64,
) (botimport.BotAgent, error) {
	update := r.handle.Client().BotAgent.Update().
		Where(
			botagent.AccountIDEQ(bot.AccountID),
			botagent.IDEQ(bot.ID),
			botagent.RevisionEQ(expectedRevision),
		).
		SetDisplayName(bot.DisplayName).
		SetState(bot.State).
		SetCommandPolicy(bot.CommandPolicy).
		SetCredentialVersion(bot.CredentialVersion).
		SetRevision(expectedRevision + 1).
		SetUpdatedAt(bot.UpdatedAt)
	if bot.LastErrorCode != "" {
		update.SetLastErrorCode(bot.LastErrorCode)
	} else {
		update.ClearLastErrorCode()
	}
	if len(bot.CredentialDigest) > 0 {
		update.SetCredentialDigest(bot.CredentialDigest)
	} else {
		update.ClearCredentialDigest()
	}
	affected, err := update.Save(ctx)
	if err != nil {
		return botimport.BotAgent{}, err
	}
	if affected != 1 {
		return botimport.BotAgent{}, botimport.ErrConflict
	}
	return r.FindBot(ctx, bot.AccountID, bot.ID)
}

func (r *EntRepository) FindRoute(ctx context.Context, imUserID string) (botimport.Route, error) {
	entity, err := r.handle.Client().IMIdentityRoute.Query().
		Where(imidentityroute.ImUserIDEQ(imUserID)).
		Only(ctx)
	if ent.IsNotFound(err) {
		return botimport.Route{}, botimport.ErrNotFound
	}
	if err != nil {
		return botimport.Route{}, err
	}
	return routeFromEntity(entity), nil
}

func (r *EntRepository) EnsureRoute(ctx context.Context, route botimport.Route) (botimport.Route, error) {
	existing, err := r.FindRoute(ctx, route.IMUserID)
	if err == nil {
		if existing.Kind != route.Kind || existing.AccountID != route.AccountID ||
			existing.BotAgentID != route.BotAgentID {
			return botimport.Route{}, botimport.ErrConflict
		}
		return existing, nil
	}
	if !errors.Is(err, botimport.ErrNotFound) {
		return botimport.Route{}, err
	}
	id, err := r.ids.New()
	if err != nil {
		return botimport.Route{}, err
	}
	now := time.Now().UTC()
	create := r.handle.Client().IMIdentityRoute.Create().
		SetID(id).
		SetImUserID(route.IMUserID).
		SetKind(route.Kind).
		SetAccountID(route.AccountID).
		SetCreatedAt(now).
		SetUpdatedAt(now)
	if route.BotAgentID != "" {
		create.SetBotAgentID(route.BotAgentID)
	}
	if _, err := create.Save(ctx); err != nil {
		if ent.IsConstraintError(err) {
			return r.EnsureRoute(ctx, route)
		}
		return botimport.Route{}, err
	}
	return r.FindRoute(ctx, route.IMUserID)
}

func (r *EntRepository) SetRouteRestricted(
	ctx context.Context,
	imUserID string,
	restrictedAt *time.Time,
) (botimport.Route, error) {
	update := r.handle.Client().IMIdentityRoute.Update().
		Where(imidentityroute.ImUserIDEQ(imUserID)).
		SetUpdatedAt(time.Now().UTC())
	if restrictedAt != nil {
		update.SetRestrictedAt(restrictedAt.UTC())
	} else {
		update.ClearRestrictedAt()
	}
	affected, err := update.Save(ctx)
	if err != nil {
		return botimport.Route{}, err
	}
	if affected != 1 {
		return botimport.Route{}, botimport.ErrNotFound
	}
	return r.FindRoute(ctx, imUserID)
}

func (r *EntRepository) FindGroup(
	ctx context.Context,
	groupID string,
) (botimport.Group, []botimport.GroupMember, error) {
	entity, err := r.handle.Client().IMGroup.Query().Where(imgroup.IDEQ(groupID)).Only(ctx)
	if ent.IsNotFound(err) {
		return botimport.Group{}, nil, botimport.ErrNotFound
	}
	if err != nil {
		return botimport.Group{}, nil, err
	}
	members, err := r.handle.Client().IMGroupMember.Query().
		Where(imgroupmember.GroupIDEQ(groupID)).
		Order(ent.Asc(imgroupmember.FieldCreatedAt), ent.Asc(imgroupmember.FieldID)).
		Limit(500).
		All(ctx)
	if err != nil {
		return botimport.Group{}, nil, err
	}
	result := make([]botimport.GroupMember, 0, len(members))
	for _, member := range members {
		result = append(result, memberFromEntity(member))
	}
	return groupFromEntity(entity), result, nil
}

func (r *EntRepository) InsertGroup(
	ctx context.Context,
	group botimport.Group,
	members []botimport.GroupMember,
) error {
	return r.handle.WithTx(ctx, func(txContext context.Context, tx *ent.Tx) error {
		if _, err := tx.IMGroup.Create().
			SetID(group.ID).
			SetTencentGroupID(group.TencentGroupID).
			SetOwnerAccountID(group.OwnerAccountID).
			SetCreatedByImUserID(group.CreatedByIMUserID).
			SetName(group.Name).
			SetReplyMode(group.ReplyMode).
			SetState(group.State).
			SetRevision(group.Revision).
			SetCreatedAt(group.CreatedAt).
			SetUpdatedAt(group.UpdatedAt).
			Save(txContext); err != nil {
			if ent.IsConstraintError(err) {
				return botimport.ErrConflict
			}
			return err
		}
		for _, member := range members {
			id, err := r.ids.New()
			if err != nil {
				return err
			}
			if _, err := tx.IMGroupMember.Create().
				SetID(id).
				SetGroupID(group.ID).
				SetImUserID(member.IMUserID).
				SetKind(member.Kind).
				SetRole(member.Role).
				SetState(member.State).
				SetAddedByImUserID(member.AddedByIMUserID).
				SetCreatedAt(group.CreatedAt).
				SetUpdatedAt(group.UpdatedAt).
				Save(txContext); err != nil {
				return err
			}
		}
		return nil
	})
}

func (r *EntRepository) SaveGroup(
	ctx context.Context,
	group botimport.Group,
	expectedRevision int64,
) (botimport.Group, error) {
	affected, err := r.handle.Client().IMGroup.Update().
		Where(imgroup.IDEQ(group.ID), imgroup.RevisionEQ(expectedRevision)).
		SetName(group.Name).
		SetReplyMode(group.ReplyMode).
		SetState(group.State).
		SetRevision(expectedRevision + 1).
		SetUpdatedAt(group.UpdatedAt).
		Save(ctx)
	if err != nil {
		return botimport.Group{}, err
	}
	if affected != 1 {
		return botimport.Group{}, botimport.ErrConflict
	}
	saved, _, err := r.FindGroup(ctx, group.ID)
	return saved, err
}

func (r *EntRepository) UpsertMember(ctx context.Context, member botimport.GroupMember) error {
	now := time.Now().UTC()
	return r.handle.WithTx(ctx, func(txContext context.Context, tx *ent.Tx) error {
		affected, err := tx.IMGroupMember.Update().
			Where(
				imgroupmember.GroupIDEQ(member.GroupID),
				imgroupmember.ImUserIDEQ(member.IMUserID),
			).
			SetKind(member.Kind).
			SetRole(member.Role).
			SetState(member.State).
			SetAddedByImUserID(member.AddedByIMUserID).
			SetUpdatedAt(now).
			Save(txContext)
		if err != nil {
			return err
		}
		if affected == 0 {
			id, err := r.ids.New()
			if err != nil {
				return err
			}
			if _, err := tx.IMGroupMember.Create().
				SetID(id).
				SetGroupID(member.GroupID).
				SetImUserID(member.IMUserID).
				SetKind(member.Kind).
				SetRole(member.Role).
				SetState(member.State).
				SetAddedByImUserID(member.AddedByIMUserID).
				SetCreatedAt(now).
				SetUpdatedAt(now).
				Save(txContext); err != nil {
				return err
			}
		}
		return bumpGroupRevision(txContext, tx, member.GroupID, now)
	})
}

func (r *EntRepository) MarkMemberRemoved(ctx context.Context, groupID, imUserID string) error {
	now := time.Now().UTC()
	return r.handle.WithTx(ctx, func(txContext context.Context, tx *ent.Tx) error {
		affected, err := tx.IMGroupMember.Update().
			Where(
				imgroupmember.GroupIDEQ(groupID),
				imgroupmember.ImUserIDEQ(imUserID),
				imgroupmember.StateEQ(botimport.MemberStateActive),
			).
			SetState(botimport.MemberStateRemoved).
			SetUpdatedAt(now).
			Save(txContext)
		if err != nil || affected == 0 {
			return err
		}
		return bumpGroupRevision(txContext, tx, groupID, now)
	})
}

func bumpGroupRevision(ctx context.Context, tx *ent.Tx, groupID string, now time.Time) error {
	return tx.IMGroup.Update().
		Where(imgroup.IDEQ(groupID)).
		AddRevision(1).
		SetUpdatedAt(now).
		Exec(ctx)
}

func botFromEntity(entity *ent.BotAgent, err error) (botimport.BotAgent, error) {
	if ent.IsNotFound(err) {
		return botimport.BotAgent{}, botimport.ErrNotFound
	}
	if err != nil {
		return botimport.BotAgent{}, err
	}
	bot := botimport.BotAgent{
		ID:                entity.ID,
		AccountID:         entity.AccountID,
		InstanceID:        entity.InstanceID,
		BotID:             entity.BotID,
		DisplayName:       entity.DisplayName,
		IMUserID:          entity.ImUserID,
		State:             entity.State,
		CommandPolicy:     entity.CommandPolicy,
		CredentialVersion: entity.CredentialVersion,
		Revision:          entity.Revision,
		CreatedAt:         entity.CreatedAt,
		UpdatedAt:         entity.UpdatedAt,
	}
	if entity.LastErrorCode != nil {
		bot.LastErrorCode = *entity.LastErrorCode
	}
	if entity.CredentialDigest != nil {
		bot.CredentialDigest = append([]byte(nil), (*entity.CredentialDigest)...)
	}
	return bot, nil
}

func routeFromEntity(entity *ent.IMIdentityRoute) botimport.Route {
	route := botimport.Route{
		IMUserID:  entity.ImUserID,
		Kind:      entity.Kind,
		AccountID: entity.AccountID,
	}
	if entity.BotAgentID != nil {
		route.BotAgentID = *entity.BotAgentID
	}
	if entity.RestrictedAt != nil {
		restrictedAt := entity.RestrictedAt.UTC()
		route.RestrictedAt = &restrictedAt
	}
	return route
}

func groupFromEntity(entity *ent.IMGroup) botimport.Group {
	return botimport.Group{
		ID:                entity.ID,
		TencentGroupID:    entity.TencentGroupID,
		OwnerAccountID:    entity.OwnerAccountID,
		CreatedByIMUserID: entity.CreatedByImUserID,
		Name:              entity.Name,
		ReplyMode:         entity.ReplyMode,
		State:             entity.State,
		Revision:          entity.Revision,
		CreatedAt:         entity.CreatedAt,
		UpdatedAt:         entity.UpdatedAt,
	}
}

func memberFromEntity(entity *ent.IMGroupMember) botimport.GroupMember {
	return botimport.GroupMember{
		GroupID:         entity.GroupID,
		IMUserID:        entity.ImUserID,
		Kind:            entity.Kind,
		Role:            entity.Role,
		State:           entity.State,
		AddedByIMUserID: entity.AddedByImUserID,
	}
}

var _ botimport.Repository = (*EntRepository)(nil)
