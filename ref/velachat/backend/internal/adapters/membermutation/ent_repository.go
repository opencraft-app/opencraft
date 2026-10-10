// Package membermutation 提供 Server Member 变更的 Ent Repository。
package membermutation

import (
	"context"
	"crypto/subtle"
	"errors"
	"strconv"
	"time"

	"chatserver/internal/database"
	"chatserver/internal/ent"
	"chatserver/internal/ent/accountservermembership"
	"chatserver/internal/ent/idempotencyrecord"
	"chatserver/internal/ent/member"
	"chatserver/internal/persistedjson"
	membermutationport "chatserver/internal/ports/membermutation"
)

type EntRepository struct{ handle *database.Handle }

func NewEntRepository(handle *database.Handle) (*EntRepository, error) {
	if handle == nil || handle.Client() == nil {
		return nil, errors.New("Member Mutation Repository 缺少数据库 Handle")
	}
	return &EntRepository{handle: handle}, nil
}

func (repository *EntRepository) Update(
	ctx context.Context,
	command membermutationport.UpdateCommand,
) (result membermutationport.UpdateResult, returnErr error) {
	returnErr = repository.handle.WithTx(
		ctx,
		func(ctx context.Context, tx *ent.Tx) error {
			actor, err := activeProjection(
				ctx,
				tx,
				command.AccountID,
				command.ServerID,
			)
			if err != nil {
				return err
			}
			stored, err := findIdempotency(
				ctx,
				tx,
				command.ServerID,
				"member.update",
				command.MemberID,
				command.IdempotencyKey,
			)
			if err == nil {
				if subtle.ConstantTimeCompare(
					stored.RequestHash,
					command.RequestHash[:],
				) != 1 {
					return membermutationport.ErrIdempotencyConflict
				}
				_, err = persistedjson.DecodeScoped(
					stored.ResponseBodyJSON, "member.update", &result,
				)
				return err
			}
			if !ent.IsNotFound(err) {
				return err
			}
			target, err := tx.Member.Query().
				Where(
					member.IDEQ(command.MemberID),
					member.ServerIDEQ(command.ServerID),
					member.StatusEQ("active"),
				).
				Only(ctx)
			if ent.IsNotFound(err) {
				return membermutationport.ErrMemberNotFound
			}
			if err != nil {
				return err
			}
			if target.Revision != command.ExpectedRevision {
				return membermutationport.ErrRevisionConflict
			}
			if target.Role == "owner" && command.Role != nil {
				return membermutationport.ErrOwnerImmutable
			}
			isSelf := target.AccountID != nil &&
				*target.AccountID == command.AccountID
			isManager := actor.Role == "owner" || actor.Role == "admin"
			if command.Role != nil && actor.Role != "owner" {
				return membermutationport.ErrPermissionDenied
			}
			if command.DisplayName != nil && !isSelf && !isManager {
				return membermutationport.ErrPermissionDenied
			}
			update := tx.Member.Update().
				Where(
					member.IDEQ(target.ID),
					member.RevisionEQ(command.ExpectedRevision),
				).
				AddRevision(1).
				SetUpdatedAt(command.UpdatedAt.UTC())
			if command.DisplayName != nil {
				update.SetDisplayName(*command.DisplayName)
			}
			if command.Role != nil {
				update.SetRole(*command.Role)
			}
			updated, err := update.Save(ctx)
			if err != nil {
				return err
			}
			if updated != 1 {
				return membermutationport.ErrRevisionConflict
			}
			if command.Role != nil && target.AccountID != nil {
				if _, err := tx.AccountServerMembership.Update().
					Where(
						accountservermembership.AccountIDEQ(
							*target.AccountID,
						),
						accountservermembership.ServerIDEQ(command.ServerID),
					).
					SetRole(*command.Role).
					SetUpdatedAt(command.UpdatedAt.UTC()).
					Save(ctx); err != nil {
					return err
				}
			}
			result = membermutationport.UpdateResult{MemberID: target.ID}
			return saveIdempotency(
				ctx,
				tx,
				command.ServerID,
				"member.update",
				target.ID,
				command.IdempotencyKey,
				command.RequestHash,
				200,
				result,
				command.UpdatedAt.UTC(),
			)
		},
	)
	return result, returnErr
}

func (repository *EntRepository) Remove(
	ctx context.Context,
	command membermutationport.RemoveCommand,
) (result membermutationport.RemoveResult, returnErr error) {
	returnErr = repository.handle.WithTx(
		ctx,
		func(ctx context.Context, tx *ent.Tx) error {
			actor, err := activeProjection(
				ctx,
				tx,
				command.AccountID,
				command.ServerID,
			)
			if err != nil {
				return err
			}
			stored, err := findIdempotency(
				ctx,
				tx,
				command.ServerID,
				"member.remove",
				command.MemberID,
				command.IdempotencyKey,
			)
			if err == nil {
				if subtle.ConstantTimeCompare(
					stored.RequestHash,
					command.RequestHash[:],
				) != 1 {
					return membermutationport.ErrIdempotencyConflict
				}
				_, err = persistedjson.DecodeScoped(
					stored.ResponseBodyJSON, "member.remove", &result,
				)
				return err
			}
			if !ent.IsNotFound(err) {
				return err
			}
			target, err := tx.Member.Query().
				Where(
					member.IDEQ(command.MemberID),
					member.ServerIDEQ(command.ServerID),
					member.StatusEQ("active"),
				).
				Only(ctx)
			if ent.IsNotFound(err) {
				return membermutationport.ErrMemberNotFound
			}
			if err != nil {
				return err
			}
			if target.Role == "owner" {
				return membermutationport.ErrOwnerImmutable
			}
			isSelf := actor.MemberID == target.ID
			isManager := actor.Role == "owner" || actor.Role == "admin"
			if !isSelf && !isManager {
				return membermutationport.ErrPermissionDenied
			}
			if target.AccountID == nil {
				return membermutationport.ErrPermissionDenied
			}
			nextRevision := target.Revision + 1
			updated, err := tx.Member.Update().
				Where(
					member.IDEQ(target.ID),
					member.RevisionEQ(target.Revision),
				).
				SetStatus("removed").
				ClearActiveHandleKey().
				SetImState("provisioning").
				SetRevision(nextRevision).
				SetUpdatedAt(command.RemovedAt.UTC()).
				Save(ctx)
			if err != nil {
				return err
			}
			if updated != 1 {
				return membermutationport.ErrRevisionConflict
			}
			if _, err := tx.AccountServerMembership.Update().
				Where(
					accountservermembership.AccountIDEQ(*target.AccountID),
					accountservermembership.ServerIDEQ(command.ServerID),
				).
				SetStatus("removed").
				SetRole(target.Role).
				SetUpdatedAt(command.RemovedAt.UTC()).
				Save(ctx); err != nil {
				return err
			}
			operation, err := tx.TencentOperation.Create().
				SetID(command.OperationID).
				SetPartitionKey(command.ServerID).
				SetServerID(command.ServerID).
				SetService("im").
				SetKind("im.membership.remove").
				SetResourceType("member").
				SetResourceID(target.ID).
				SetIdempotencyKey(
					"im.membership.remove:v1:" + target.ID + ":" +
						strconv.FormatInt(nextRevision, 10),
				).
				SetDesiredRevision(nextRevision).
				SetState("pending").
				SetAttempts(0).
				SetCreatedAt(command.RemovedAt.UTC()).
				SetUpdatedAt(command.RemovedAt.UTC()).
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
				SetAvailableAt(command.RemovedAt.UTC()).
				SetCreatedAt(command.RemovedAt.UTC()).
				Save(ctx); err != nil {
				return err
			}
			result = membermutationport.RemoveResult{
				MemberID: target.ID, OperationID: operation.ID,
				CreatedAt: command.RemovedAt.UTC(),
			}
			return saveIdempotency(
				ctx,
				tx,
				command.ServerID,
				"member.remove",
				target.ID,
				command.IdempotencyKey,
				command.RequestHash,
				202,
				result,
				command.RemovedAt.UTC(),
			)
		},
	)
	return result, returnErr
}

func activeProjection(
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
		return nil, membermutationport.ErrPermissionDenied
	}
	return entity, err
}

func findIdempotency(
	ctx context.Context,
	tx *ent.Tx,
	partitionKey, scopeType, scopeID, key string,
) (*ent.IdempotencyRecord, error) {
	return tx.IdempotencyRecord.Query().
		Where(
			idempotencyrecord.PartitionKeyEQ(partitionKey),
			idempotencyrecord.ScopeTypeEQ(scopeType),
			idempotencyrecord.ScopeIDEQ(scopeID),
			idempotencyrecord.IdempotencyKeyEQ(key),
		).
		Only(ctx)
}

func saveIdempotency(
	ctx context.Context,
	tx *ent.Tx,
	partitionKey, scopeType, scopeID, key string,
	requestHash [32]byte,
	status int,
	result any,
	at time.Time,
) error {
	response, err := persistedjson.EncodeScoped(scopeType, result)
	if err != nil {
		return err
	}
	_, err = tx.IdempotencyRecord.Create().
		SetPartitionKey(partitionKey).
		SetScopeType(scopeType).
		SetScopeID(scopeID).
		SetIdempotencyKey(key).
		SetRequestHash(requestHash[:]).
		SetResponseStatus(status).
		SetResponseBodyJSON(response).
		SetExpiresAt(at.Add(24 * time.Hour)).
		SetCreatedAt(at).
		Save(ctx)
	return err
}

var _ membermutationport.Repository = (*EntRepository)(nil)
