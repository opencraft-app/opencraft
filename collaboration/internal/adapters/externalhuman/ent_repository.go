// Package externalhuman persists the LightVela subject to collaboration actor mapping.
package externalhuman

import (
	"context"
	"errors"
	"strings"

	"git.woa.com/wisp/mono2/collaboration/internal/app/externalhuman"
	"git.woa.com/wisp/mono2/collaboration/internal/database"
	"git.woa.com/wisp/mono2/collaboration/internal/ent"
	"git.woa.com/wisp/mono2/collaboration/internal/ent/account"
	"git.woa.com/wisp/mono2/collaboration/internal/ent/accountloginidentity"
)

type EntRepository struct {
	handle *database.Handle
}

func NewEntRepository(handle *database.Handle) (*EntRepository, error) {
	if handle == nil || handle.Client() == nil {
		return nil, errors.New("LightVela Human Repository 缺少数据库 Handle")
	}
	return &EntRepository{handle: handle}, nil
}

func (repository *EntRepository) ResolveOrCreate(
	ctx context.Context,
	input externalhuman.EnsureInput,
) (string, error) {
	if strings.TrimSpace(input.Kind) != externalhuman.LightVelaIdentityKind ||
		strings.TrimSpace(input.Subject) == "" || len(input.SubjectHash) != 64 ||
		strings.TrimSpace(input.ProposedAccountID) == "" || input.OccurredAt.IsZero() {
		return "", errors.New("LightVela Human 映射参数无效")
	}
	if accountID, found, err := repository.find(ctx, input); err != nil || found {
		return accountID, err
	}

	err := repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		_, err := tx.AccountLoginIdentity.Create().
			SetLoginHash(input.SubjectHash).
			SetKind(input.Kind).
			SetNormalizedLogin(input.Subject).
			SetAccountID(input.ProposedAccountID).
			SetState("active").
			SetCreatedAt(input.OccurredAt.UTC()).
			Save(ctx)
		if err != nil {
			return err
		}
		_, err = tx.Account.Create().
			SetID(input.ProposedAccountID).
			SetEmail("").
			SetEmailNormalized("").
			SetDisplayName("LightVela user").
			SetPasswordHash("").
			SetTokenVersion(0).
			SetImUserID("").
			SetImState("provisioning").
			SetRevision(1).
			SetCreatedAt(input.OccurredAt.UTC()).
			SetUpdatedAt(input.OccurredAt.UTC()).
			Save(ctx)
		if err != nil {
			return err
		}
		operation, err := tx.TencentOperation.Create().
			SetPartitionKey(input.ProposedAccountID).
			SetService("im").
			SetKind("im.identity.ensure").
			SetResourceType("account").
			SetResourceID(input.ProposedAccountID).
			SetIdempotencyKey("account:" + input.ProposedAccountID + ":im.identity.ensure:v1").
			SetDesiredRevision(1).
			SetState("pending").
			SetAttempts(0).
			SetCreatedAt(input.OccurredAt.UTC()).
			SetUpdatedAt(input.OccurredAt.UTC()).
			Save(ctx)
		if err != nil {
			return err
		}
		_, err = tx.OutboxEvent.Create().
			SetPartitionKey(input.ProposedAccountID).
			SetEventType("tencent.operation.ready").
			SetAggregateType("tencent_operation").
			SetAggregateID(operation.ID).
			SetState("pending").
			SetAttempts(0).
			SetAvailableAt(input.OccurredAt.UTC()).
			SetCreatedAt(input.OccurredAt.UTC()).
			Save(ctx)
		return err
	})
	if err == nil {
		return input.ProposedAccountID, nil
	}
	if ent.IsConstraintError(err) {
		if accountID, found, findErr := repository.find(ctx, input); findErr != nil {
			return "", findErr
		} else if found {
			return accountID, nil
		}
	}
	return "", err
}

func (repository *EntRepository) find(
	ctx context.Context,
	input externalhuman.EnsureInput,
) (string, bool, error) {
	identity, err := repository.handle.Client().AccountLoginIdentity.Query().Where(
		accountloginidentity.LoginHashEQ(input.SubjectHash),
		accountloginidentity.KindEQ(input.Kind),
		accountloginidentity.StateEQ("active"),
	).Only(ctx)
	if ent.IsNotFound(err) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if identity.NormalizedLogin != input.Subject {
		return "", false, errors.New("LightVela subject hash 冲突")
	}
	exists, err := repository.handle.Client().Account.Query().Where(
		account.IDEQ(identity.AccountID),
	).Exist(ctx)
	if err != nil {
		return "", false, err
	}
	if !exists {
		return "", false, errors.New("LightVela Human 映射缺少本地 actor")
	}
	return identity.AccountID, true, nil
}
