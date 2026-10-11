// Package serverinvite 提供 Server 邀请的 Ent/SQLite Repository。
package serverinvite

import (
	"context"
	"crypto/subtle"
	"errors"
	"strconv"
	"time"

	"chatserver/internal/database"
	"chatserver/internal/ent"
	"chatserver/internal/ent/account"
	"chatserver/internal/ent/accountservermembership"
	channelentity "chatserver/internal/ent/channel"
	"chatserver/internal/ent/channelmember"
	"chatserver/internal/ent/idempotencyrecord"
	"chatserver/internal/ent/member"
	serverentity "chatserver/internal/ent/server"
	serverinviteentity "chatserver/internal/ent/serverinvite"
	"chatserver/internal/persistedjson"
	inviteport "chatserver/internal/ports/serverinvite"
)

type EntRepository struct{ handle *database.Handle }

func NewEntRepository(handle *database.Handle) (*EntRepository, error) {
	if handle == nil || handle.Client() == nil {
		return nil, errors.New("Server Invite Repository 缺少数据库 Handle")
	}
	return &EntRepository{handle: handle}, nil
}

func (repository *EntRepository) Create(
	ctx context.Context,
	command inviteport.CreateCommand,
) (result inviteport.Invite, returnErr error) {
	returnErr = repository.handle.WithTx(
		ctx,
		func(ctx context.Context, tx *ent.Tx) error {
			memberID, err := requireManager(
				ctx,
				tx,
				command.AccountID,
				command.ServerID,
			)
			if err != nil {
				return err
			}
			if command.LandingChannelID != nil {
				exists, err := tx.Channel.Query().
					Where(
						channelentity.IDEQ(*command.LandingChannelID),
						channelentity.ServerIDEQ(command.ServerID),
					).
					Exist(ctx)
				if err != nil {
					return err
				}
				if !exists {
					return inviteport.ErrLandingNotFound
				}
			}
			entity, err := tx.ServerInvite.Create().
				SetID(command.InviteID).
				SetServerID(command.ServerID).
				SetTokenHash(command.TokenHash[:]).
				SetRole(command.Role).
				SetMaxUses(command.MaxUses).
				SetUsedCount(0).
				SetNillableLandingChannelID(command.LandingChannelID).
				SetExpiresAt(command.ExpiresAt.UTC()).
				SetCreatedByMemberID(memberID).
				SetRevision(1).
				SetCreatedAt(command.CreatedAt.UTC()).
				SetUpdatedAt(command.CreatedAt.UTC()).
				Save(ctx)
			if err != nil {
				return err
			}
			result = mapInvite(entity)
			return nil
		},
	)
	return result, returnErr
}

func (repository *EntRepository) List(
	ctx context.Context,
	accountID string,
	serverID string,
) ([]inviteport.Invite, error) {
	if _, err := requireManagerClient(
		ctx,
		repository.handle.Client(),
		accountID,
		serverID,
	); err != nil {
		return nil, err
	}
	entities, err := repository.handle.Client().ServerInvite.Query().
		Where(
			serverinviteentity.ServerIDEQ(serverID),
			serverinviteentity.RevokedAtIsNil(),
		).
		Order(
			ent.Asc(serverinviteentity.FieldExpiresAt),
			ent.Asc(serverinviteentity.FieldID),
		).
		All(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]inviteport.Invite, 0, len(entities))
	for _, entity := range entities {
		result = append(result, mapInvite(entity))
	}
	return result, nil
}

func (repository *EntRepository) Revoke(
	ctx context.Context,
	command inviteport.RevokeCommand,
) error {
	return repository.handle.WithTx(
		ctx,
		func(ctx context.Context, tx *ent.Tx) error {
			if _, err := requireManager(
				ctx,
				tx,
				command.AccountID,
				command.ServerID,
			); err != nil {
				return err
			}
			entity, err := tx.ServerInvite.Query().
				Where(
					serverinviteentity.IDEQ(command.InviteID),
					serverinviteentity.ServerIDEQ(command.ServerID),
				).
				Only(ctx)
			if ent.IsNotFound(err) {
				return inviteport.ErrInviteNotFound
			}
			if err != nil {
				return err
			}
			if entity.RevokedAt != nil {
				return nil
			}
			updated, err := tx.ServerInvite.Update().
				Where(
					serverinviteentity.IDEQ(entity.ID),
					serverinviteentity.RevisionEQ(entity.Revision),
					serverinviteentity.RevokedAtIsNil(),
				).
				SetRevokedAt(command.RevokedAt.UTC()).
				AddRevision(1).
				SetUpdatedAt(command.RevokedAt.UTC()).
				Save(ctx)
			if err != nil {
				return err
			}
			if updated != 1 {
				return inviteport.ErrInviteNotFound
			}
			return nil
		},
	)
}

func (repository *EntRepository) Accept(
	ctx context.Context,
	command inviteport.AcceptCommand,
) (result inviteport.AcceptResult, returnErr error) {
	returnErr = repository.handle.WithTx(
		ctx,
		func(ctx context.Context, tx *ent.Tx) error {
			scope := acceptScope(command.AllowExistingMember)
			stored, err := tx.IdempotencyRecord.Query().
				Where(
					idempotencyrecord.PartitionKeyEQ(command.AccountID),
					idempotencyrecord.ScopeTypeEQ(scope),
					idempotencyrecord.ScopeIDEQ(command.AccountID),
					idempotencyrecord.IdempotencyKeyEQ(
						command.IdempotencyKey,
					),
				).
				Only(ctx)
			if err == nil {
				if subtle.ConstantTimeCompare(
					stored.RequestHash,
					command.RequestHash[:],
				) != 1 {
					return inviteport.ErrIdempotency
				}
				return decodeAcceptResult(stored.ResponseBodyJSON, scope, &result)
			}
			if !ent.IsNotFound(err) {
				return err
			}
			accountEntity, err := tx.Account.Query().
				Where(
					account.IDEQ(command.AccountID),
					account.ImStateEQ("ready"),
				).
				Only(ctx)
			if ent.IsNotFound(err) {
				return inviteport.ErrAccountNotReady
			}
			if err != nil {
				return err
			}
			serverEntity, err := tx.Server.Query().
				Where(serverentity.IDEQ(command.ServerID)).
				Only(ctx)
			if ent.IsNotFound(err) {
				return inviteport.ErrInviteInvalid
			}
			if err != nil {
				return err
			}
			invite, err := tx.ServerInvite.Query().
				Where(
					serverinviteentity.ServerIDEQ(command.ServerID),
					serverinviteentity.TokenHashEQ(command.TokenHash[:]),
					serverinviteentity.RevokedAtIsNil(),
					serverinviteentity.ExpiresAtGT(
						command.AcceptedAt.UTC(),
					),
				).
				Only(ctx)
			if ent.IsNotFound(err) {
				return inviteport.ErrInviteInvalid
			}
			if err != nil {
				return err
			}
			now := command.AcceptedAt.UTC()
			projection, err := tx.AccountServerMembership.Query().
				Where(
					accountservermembership.AccountIDEQ(command.AccountID),
					accountservermembership.ServerIDEQ(command.ServerID),
				).
				Only(ctx)
			if err != nil && !ent.IsNotFound(err) {
				return err
			}
			landingMemberID := command.MemberID
			if projection != nil {
				landingMemberID = projection.MemberID
			}
			landingChannelID, err := resolveLandingChannel(
				ctx,
				tx,
				command.ServerID,
				landingMemberID,
				invite.LandingChannelID,
			)
			if err != nil {
				return err
			}
			if projection != nil && projection.Status == "active" {
				if !command.AllowExistingMember {
					return inviteport.ErrAlreadyMember
				}
				result = inviteport.AcceptResult{
					MemberID:         projection.MemberID,
					ServerID:         command.ServerID,
					ServerSlug:       serverEntity.Slug,
					LandingChannelID: landingChannelID,
					CreatedAt:        now,
				}
				return persistAcceptResult(ctx, tx, command, scope, result, 200)
			}
			if invite.UsedCount >= invite.MaxUses {
				return inviteport.ErrInviteInvalid
			}
			memberID := command.MemberID
			memberRevision := int64(1)
			if projection == nil {
				if _, err := tx.Member.Create().
					SetID(memberID).
					SetServerID(command.ServerID).
					SetAccountID(command.AccountID).
					SetKind("human").
					SetRole(invite.Role).
					SetDisplayName(accountEntity.DisplayName).
					SetHandle(command.Handle).
					SetActiveHandleKey(command.Handle).
					SetStatus("active").
					SetImState("provisioning").
					SetRevision(memberRevision).
					SetCreatedAt(now).
					SetUpdatedAt(now).
					Save(ctx); err != nil {
					return err
				}
				if _, err := tx.AccountServerMembership.Create().
					SetAccountID(command.AccountID).
					SetServerID(command.ServerID).
					SetMemberID(memberID).
					SetRole(invite.Role).
					SetStatus("active").
					SetServerNameSnapshot(serverEntity.Name).
					SetServerSlugSnapshot(serverEntity.Slug).
					SetServerRevision(serverEntity.Revision).
					SetProjectedAt(now).
					SetUpdatedAt(now).
					Save(ctx); err != nil {
					return err
				}
			} else {
				memberID = projection.MemberID
				memberEntity, err := tx.Member.Query().
					Where(
						member.IDEQ(memberID),
						member.ServerIDEQ(command.ServerID),
						member.AccountIDEQ(command.AccountID),
					).
					Only(ctx)
				if err != nil {
					return err
				}
				memberRevision = memberEntity.Revision + 1
				if _, err := tx.Member.UpdateOneID(memberID).
					SetRole(invite.Role).
					SetDisplayName(accountEntity.DisplayName).
					SetActiveHandleKey(memberEntity.Handle).
					SetStatus("active").
					SetImState("provisioning").
					SetRevision(memberRevision).
					SetUpdatedAt(now).
					Save(ctx); err != nil {
					return err
				}
				if _, err := tx.AccountServerMembership.
					UpdateOneID(projection.ID).
					SetRole(invite.Role).
					SetStatus("active").
					SetServerNameSnapshot(serverEntity.Name).
					SetServerSlugSnapshot(serverEntity.Slug).
					SetServerRevision(serverEntity.Revision).
					SetProjectedAt(now).
					SetUpdatedAt(now).
					Save(ctx); err != nil {
					return err
				}
			}
			updated, err := tx.ServerInvite.Update().
				Where(
					serverinviteentity.IDEQ(invite.ID),
					serverinviteentity.RevisionEQ(invite.Revision),
					serverinviteentity.UsedCountLT(invite.MaxUses),
					serverinviteentity.RevokedAtIsNil(),
				).
				AddUsedCount(1).
				AddRevision(1).
				SetUpdatedAt(now).
				Save(ctx)
			if err != nil {
				return err
			}
			if updated != 1 {
				return inviteport.ErrInviteInvalid
			}
			operation, err := tx.TencentOperation.Create().
				SetID(command.OperationID).
				SetPartitionKey(command.ServerID).
				SetServerID(command.ServerID).
				SetService("im").
				SetKind("im.membership.ensure").
				SetResourceType("member").
				SetResourceID(memberID).
				SetIdempotencyKey(
					"im.membership.ensure:v1:" + memberID + ":" +
						int64String(memberRevision),
				).
				SetDesiredRevision(memberRevision).
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
			result = inviteport.AcceptResult{
				MemberID:         memberID,
				ServerID:         command.ServerID,
				ServerSlug:       serverEntity.Slug,
				LandingChannelID: landingChannelID,
				OperationID:      operation.ID,
				CreatedAt:        now,
			}
			return persistAcceptResult(ctx, tx, command, scope, result, 202)
		},
	)
	return result, returnErr
}

func int64String(value int64) string {
	return strconv.FormatInt(value, 10)
}

func decodeAcceptResult(
	value string,
	scope string,
	result *inviteport.AcceptResult,
) error {
	if _, err := persistedjson.DecodeScoped(value, scope, result); err != nil {
		return err
	}
	if result.MemberID == "" || result.ServerID == "" || result.CreatedAt.IsZero() ||
		(scope == "invite.accept" && result.OperationID == "") ||
		(scope == "join_link.accept" &&
			(result.ServerSlug == "" || result.LandingChannelID == "")) {
		return errors.New("邀请接受幂等记录无效")
	}
	return nil
}

func requireManager(
	ctx context.Context,
	tx *ent.Tx,
	accountID string,
	serverID string,
) (string, error) {
	entity, err := tx.AccountServerMembership.Query().
		Where(
			accountservermembership.AccountIDEQ(accountID),
			accountservermembership.ServerIDEQ(serverID),
			accountservermembership.StatusEQ("active"),
		).
		Only(ctx)
	if ent.IsNotFound(err) {
		return "", inviteport.ErrPermissionDenied
	}
	if err != nil {
		return "", err
	}
	if entity.Role != "owner" && entity.Role != "admin" {
		return "", inviteport.ErrPermissionDenied
	}
	return entity.MemberID, nil
}

func requireManagerClient(
	ctx context.Context,
	client *ent.Client,
	accountID string,
	serverID string,
) (string, error) {
	entity, err := client.AccountServerMembership.Query().
		Where(
			accountservermembership.AccountIDEQ(accountID),
			accountservermembership.ServerIDEQ(serverID),
			accountservermembership.StatusEQ("active"),
		).
		Only(ctx)
	if ent.IsNotFound(err) {
		return "", inviteport.ErrPermissionDenied
	}
	if err != nil {
		return "", err
	}
	if entity.Role != "owner" && entity.Role != "admin" {
		return "", inviteport.ErrPermissionDenied
	}
	return entity.MemberID, nil
}

func mapInvite(entity *ent.ServerInvite) inviteport.Invite {
	return inviteport.Invite{
		ID:               entity.ID,
		ServerID:         entity.ServerID,
		Role:             entity.Role,
		MaxUses:          entity.MaxUses,
		UsedCount:        entity.UsedCount,
		LandingChannelID: entity.LandingChannelID,
		ExpiresAt:        entity.ExpiresAt.UTC(),
		Revision:         uint64(entity.Revision),
	}
}

func acceptScope(allowExistingMember bool) string {
	if allowExistingMember {
		return "join_link.accept"
	}
	return "invite.accept"
}

func persistAcceptResult(
	ctx context.Context,
	tx *ent.Tx,
	command inviteport.AcceptCommand,
	scope string,
	result inviteport.AcceptResult,
	status int,
) error {
	response, err := persistedjson.EncodeScoped(scope, result)
	if err != nil {
		return err
	}
	_, err = tx.IdempotencyRecord.Create().
		SetPartitionKey(command.AccountID).
		SetScopeType(scope).
		SetScopeID(command.AccountID).
		SetIdempotencyKey(command.IdempotencyKey).
		SetRequestHash(command.RequestHash[:]).
		SetResponseStatus(status).
		SetResponseBodyJSON(response).
		SetExpiresAt(command.AcceptedAt.UTC().Add(24 * time.Hour)).
		SetCreatedAt(command.AcceptedAt.UTC()).
		Save(ctx)
	return err
}

func resolveLandingChannel(
	ctx context.Context,
	tx *ent.Tx,
	serverID string,
	memberID string,
	requested *string,
) (string, error) {
	root, err := tx.Channel.Query().
		Where(
			channelentity.ServerIDEQ(serverID),
			channelentity.SystemKeyEQ("all"),
		).
		Only(ctx)
	if err != nil {
		return "", err
	}
	if requested == nil || *requested == root.ID {
		return root.ID, nil
	}
	candidate, err := tx.Channel.Query().
		Where(
			channelentity.IDEQ(*requested),
			channelentity.ServerIDEQ(serverID),
		).
		Only(ctx)
	if ent.IsNotFound(err) {
		return root.ID, nil
	}
	if err != nil {
		return "", err
	}
	if candidate.Visibility == "public" {
		return candidate.ID, nil
	}
	allowed, err := tx.ChannelMember.Query().
		Where(
			channelmember.ServerIDEQ(serverID),
			channelmember.ChannelIDEQ(candidate.ID),
			channelmember.MemberIDEQ(memberID),
			channelmember.StateEQ("active"),
		).
		Exist(ctx)
	if err != nil {
		return "", err
	}
	if allowed {
		return candidate.ID, nil
	}
	return root.ID, nil
}

var _ inviteport.Repository = (*EntRepository)(nil)
