// Package externalhuman persists the LightVela subject to collaboration actor mapping.
package externalhuman

import (
	"context"
	"errors"
	"strings"
	"time"

	"git.woa.com/wisp/mono2/collaboration/internal/app/externalhuman"
	"git.woa.com/wisp/mono2/collaboration/internal/database"
	"git.woa.com/wisp/mono2/collaboration/internal/ent"
	"git.woa.com/wisp/mono2/collaboration/internal/ent/account"
	"git.woa.com/wisp/mono2/collaboration/internal/ent/accountloginidentity"
	"git.woa.com/wisp/mono2/collaboration/internal/ent/tencentoperation"
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
		strings.TrimSpace(input.ProposedAccountID) == "" ||
		!validProvisioningEpoch(input.ProvisioningEpoch) || input.OccurredAt.IsZero() {
		return "", errors.New("LightVela Human 映射参数无效")
	}
	if accountID, found, err := repository.find(ctx, input); err != nil || found {
		if err == nil && found {
			err = repository.ensureProvisioningEpoch(ctx, accountID, input)
		}
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
		return createProvisioningOperation(
			ctx,
			tx,
			input.ProposedAccountID,
			1,
			input.ProvisioningEpoch,
			input.OccurredAt.UTC(),
		)
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

func (repository *EntRepository) ensureProvisioningEpoch(
	ctx context.Context,
	accountID string,
	input externalhuman.EnsureInput,
) error {
	return repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		entity, err := tx.Account.Query().Where(account.IDEQ(accountID)).Only(ctx)
		if err != nil {
			return err
		}
		if entity.ImState != "error" {
			return nil
		}
		idempotencyKey := provisioningIdempotencyKey(accountID, input.ProvisioningEpoch)
		exists, err := tx.TencentOperation.Query().Where(
			tencentoperation.PartitionKeyEQ(accountID),
			tencentoperation.ServiceEQ("im"),
			tencentoperation.IdempotencyKeyEQ(idempotencyKey),
		).Exist(ctx)
		if err != nil || exists {
			return err
		}
		updated, err := tx.Account.Update().Where(
			account.IDEQ(accountID),
			account.RevisionEQ(entity.Revision),
			account.ImStateEQ("error"),
		).
			SetImState("provisioning").
			AddRevision(1).
			SetUpdatedAt(input.OccurredAt.UTC()).
			Save(ctx)
		if err != nil {
			return err
		}
		if updated != 1 {
			return nil
		}
		return createProvisioningOperation(
			ctx,
			tx,
			accountID,
			entity.Revision+1,
			input.ProvisioningEpoch,
			input.OccurredAt.UTC(),
		)
	})
}

func createProvisioningOperation(
	ctx context.Context,
	tx *ent.Tx,
	accountID string,
	desiredRevision int64,
	epoch string,
	at time.Time,
) error {
	operation, err := tx.TencentOperation.Create().
		SetPartitionKey(accountID).
		SetService("im").
		SetKind("im.identity.ensure").
		SetResourceType("account").
		SetResourceID(accountID).
		SetIdempotencyKey(provisioningIdempotencyKey(accountID, epoch)).
		SetDesiredRevision(desiredRevision).
		SetState("pending").
		SetAttempts(0).
		SetCreatedAt(at).
		SetUpdatedAt(at).
		Save(ctx)
	if err != nil {
		return err
	}
	_, err = tx.OutboxEvent.Create().
		SetPartitionKey(accountID).
		SetEventType("tencent.operation.ready").
		SetAggregateType("tencent_operation").
		SetAggregateID(operation.ID).
		SetState("pending").
		SetAttempts(0).
		SetAvailableAt(at).
		SetCreatedAt(at).
		Save(ctx)
	return err
}

func provisioningIdempotencyKey(accountID, epoch string) string {
	return "account:" + accountID + ":im.identity.ensure:" + epoch
}

func validProvisioningEpoch(value string) bool {
	if len(value) < 16 || len(value) > 64 {
		return false
	}
	for _, character := range value {
		if (character < 'a' || character > 'z') &&
			(character < 'A' || character > 'Z') &&
			(character < '0' || character > '9') && character != '-' && character != '_' {
			return false
		}
	}
	return true
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
