// Package channelmembership 提供普通 Channel 显式 membership 的 Ent Repository。
package channelmembership

import (
	"context"
	"crypto/subtle"
	"errors"
	"strconv"
	"time"

	"chatserver/internal/database"
	"chatserver/internal/ent"
	"chatserver/internal/ent/accountservermembership"
	"chatserver/internal/ent/channel"
	"chatserver/internal/ent/channelmember"
	"chatserver/internal/ent/idempotencyrecord"
	"chatserver/internal/ent/member"
	"chatserver/internal/persistedjson"
	channelmembershipport "chatserver/internal/ports/channelmembership"
)

type EntRepository struct{ handle *database.Handle }

func NewEntRepository(handle *database.Handle) (*EntRepository, error) {
	if handle == nil || handle.Client() == nil {
		return nil, errors.New("Channel Membership Repository 缺少数据库 Handle")
	}
	return &EntRepository{handle: handle}, nil
}

func (repository *EntRepository) Change(
	ctx context.Context,
	command channelmembershipport.Command,
) (result channelmembershipport.Result, returnErr error) {
	returnErr = repository.handle.WithTx(
		ctx,
		func(ctx context.Context, tx *ent.Tx) error {
			actor, err := tx.AccountServerMembership.Query().
				Where(
					accountservermembership.AccountIDEQ(command.AccountID),
					accountservermembership.ServerIDEQ(command.ServerID),
					accountservermembership.StatusEQ("active"),
				).
				Only(ctx)
			if ent.IsNotFound(err) {
				return channelmembershipport.ErrServerNotFound
			}
			if err != nil {
				return err
			}
			scopeType := "channel.member." + command.Action
			stored, err := tx.IdempotencyRecord.Query().
				Where(
					idempotencyrecord.PartitionKeyEQ(command.ServerID),
					idempotencyrecord.ScopeTypeEQ(scopeType),
					idempotencyrecord.ScopeIDEQ(command.ChannelID),
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
					return channelmembershipport.ErrIdempotencyConflict
				}
				_, err = persistedjson.DecodeScoped(
					stored.ResponseBodyJSON, scopeType, &result,
				)
				return err
			}
			if !ent.IsNotFound(err) {
				return err
			}
			channelEntity, err := tx.Channel.Query().
				Where(
					channel.IDEQ(command.ChannelID),
					channel.ServerIDEQ(command.ServerID),
				).
				Only(ctx)
			if ent.IsNotFound(err) {
				return channelmembershipport.ErrChannelNotFound
			}
			if err != nil {
				return err
			}
			if channelEntity.SystemKey != nil ||
				channelEntity.ImTopicID == nil {
				return channelmembershipport.ErrImplicitMembership
			}
			target, err := tx.Member.Query().
				Where(
					member.IDEQ(command.MemberID),
					member.ServerIDEQ(command.ServerID),
					member.StatusEQ("active"),
				).
				Only(ctx)
			if ent.IsNotFound(err) {
				return channelmembershipport.ErrMemberNotFound
			}
			if err != nil {
				return err
			}
			isManager := actor.Role == "owner" || actor.Role == "admin"
			isSelf := actor.MemberID == target.ID
			if command.Action == "ensure" && !isManager &&
				!(isSelf && channelEntity.Visibility == "public") {
				return channelmembershipport.ErrPermissionDenied
			}
			if command.Action == "remove" && !isManager && !isSelf {
				return channelmembershipport.ErrPermissionDenied
			}
			existing, err := tx.ChannelMember.Query().
				Where(
					channelmember.ServerIDEQ(command.ServerID),
					channelmember.ChannelIDEQ(command.ChannelID),
					channelmember.MemberIDEQ(command.MemberID),
				).
				Only(ctx)
			if err != nil && !ent.IsNotFound(err) {
				return err
			}
			now := command.ChangedAt.UTC()
			membershipID := command.ChannelMemberID
			version := int64(1)
			state := "active"
			if command.Action == "remove" {
				state = "removed"
				if ent.IsNotFound(err) {
					return channelmembershipport.ErrMembershipNotFound
				}
			}
			if existing == nil {
				if _, err := tx.ChannelMember.Create().
					SetID(membershipID).
					SetServerID(command.ServerID).
					SetChannelID(command.ChannelID).
					SetMemberID(command.MemberID).
					SetState(state).
					SetImState("provisioning").
					SetMembershipVersion(version).
					SetCreatedAt(now).
					SetUpdatedAt(now).
					Save(ctx); err != nil {
					return err
				}
			} else {
				membershipID = existing.ID
				version = existing.MembershipVersion + 1
				if _, err := tx.ChannelMember.UpdateOneID(existing.ID).
					SetState(state).
					SetImState("provisioning").
					SetMembershipVersion(version).
					SetUpdatedAt(now).
					Save(ctx); err != nil {
					return err
				}
			}
			kind := "im.membership." + command.Action
			operation, err := tx.TencentOperation.Create().
				SetID(command.OperationID).
				SetPartitionKey(command.ServerID).
				SetServerID(command.ServerID).
				SetService("im").
				SetKind(kind).
				SetResourceType("channel_member").
				SetResourceID(membershipID).
				SetIdempotencyKey(
					kind + ":v1:" + membershipID + ":" +
						strconv.FormatInt(version, 10),
				).
				SetDesiredRevision(version).
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
			result = channelmembershipport.Result{
				ChannelMemberID: membershipID,
				OperationID:     operation.ID,
				CreatedAt:       now,
			}
			response, err := persistedjson.EncodeScoped(scopeType, result)
			if err != nil {
				return err
			}
			if _, err := tx.IdempotencyRecord.Create().
				SetPartitionKey(command.ServerID).
				SetScopeType(scopeType).
				SetScopeID(command.ChannelID).
				SetIdempotencyKey(command.IdempotencyKey).
				SetRequestHash(command.RequestHash[:]).
				SetResponseStatus(202).
				SetResponseBodyJSON(response).
				SetExpiresAt(now.Add(24 * time.Hour)).
				SetCreatedAt(now).
				Save(ctx); err != nil {
				return err
			}
			return nil
		},
	)
	return result, returnErr
}

var _ channelmembershipport.Repository = (*EntRepository)(nil)
