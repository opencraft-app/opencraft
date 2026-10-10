// Package computerbootstrap persists provider bootstrap fencing on the Server shard.
package computerbootstrap

import (
	"context"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"math"
	"strconv"
	"strings"

	"chatserver/internal/database"
	"chatserver/internal/ent"
	computerentity "chatserver/internal/ent/computer"
	credentialentity "chatserver/internal/ent/computerruntimecredential"
	"chatserver/internal/ent/predicate"
	operationentity "chatserver/internal/ent/tencentoperation"
	"chatserver/internal/persistedjson"
	bootstrapport "chatserver/internal/ports/computerbootstrap"

	entsql "entgo.io/ent/dialect/sql"
	"github.com/google/uuid"
)

const (
	bootstrapOperationService = "computer-bootstrap"
	bootstrapOperationKind    = "tat.computer.bootstrap.registration"
)

type EntRepository struct{ handle *database.Handle }

func NewEntRepository(handle *database.Handle) (*EntRepository, error) {
	if handle == nil || handle.Client() == nil {
		return nil, errors.New("Computer bootstrap Repository 配置无效")
	}
	return &EntRepository{handle: handle}, nil
}

func (repository *EntRepository) GetOrCreate(
	ctx context.Context,
	command bootstrapport.StartCommand,
) (result bootstrapport.Operation, returnErr error) {
	if repository == nil || ctx == nil || !validStart(command) {
		return bootstrapport.Operation{}, bootstrapport.ErrNotEligible
	}
	returnErr = repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		computer, err := tx.Computer.Query().Where(
			computerentity.IDEQ(command.ComputerID),
			computerentity.ServerIDEQ(command.ServerID),
			computerentity.LifecycleStateEQ("provisioning"),
			computerentity.TatInstanceKindEQ("managed"),
			computerentity.TatInstanceIDIsNil(),
			computerentity.EnrollmentClaimedAtNotNil(),
			computerentity.EnrollmentCredentialVersionEQ(int64(command.CredentialVersion)),
		).Only(ctx)
		if ent.IsNotFound(err) {
			return bootstrapport.ErrNotEligible
		}
		if err != nil {
			return err
		}
		idempotencyKey := command.IdempotencyKey + ":" +
			strconv.FormatInt(computer.EnrollmentGeneration, 10) + ":" +
			strconv.FormatUint(command.CredentialVersion, 10)
		existing, err := tx.TencentOperation.Query().Where(
			operationentity.PartitionKeyEQ(command.ServerID),
			operationentity.ServiceEQ(bootstrapOperationService),
			operationentity.IdempotencyKeyEQ(idempotencyKey),
		).Only(ctx)
		if err == nil {
			result, err = mapOperation(existing)
			return err
		}
		if !ent.IsNotFound(err) {
			return err
		}
		if _, err := tx.ComputerRuntimeCredential.Query().Where(
			credentialentity.ServerIDEQ(command.ServerID),
			credentialentity.ComputerIDEQ(command.ComputerID),
			credentialentity.VersionEQ(int64(command.CredentialVersion)),
			credentialentity.StateEQ("active"),
			credentialentity.RevokedAtIsNil(),
			credentialentity.ExpiresAtGT(command.CreatedAt.UTC()),
		).Only(ctx); ent.IsNotFound(err) {
			return bootstrapport.ErrNotEligible
		} else if err != nil {
			return err
		}
		created, err := tx.TencentOperation.Create().
			SetID(command.OperationID).
			SetPartitionKey(command.ServerID).
			SetServerID(command.ServerID).
			SetService(bootstrapOperationService).
			SetKind(bootstrapOperationKind).
			SetResourceType("computer").
			SetResourceID(computer.ID).
			SetIdempotencyKey(idempotencyKey).
			SetDesiredRevision(int64(command.CredentialVersion)).
			SetState("pending").
			SetAttempts(0).
			SetDeadlineAt(command.DeadlineAt.UTC()).
			SetCreatedAt(command.CreatedAt.UTC()).
			SetUpdatedAt(command.CreatedAt.UTC()).
			Save(ctx)
		if err != nil {
			return err
		}
		result, err = mapOperation(created)
		return err
	})
	if ent.IsConstraintError(returnErr) {
		computer, computerErr := repository.handle.Client().Computer.Query().Where(
			computerentity.IDEQ(command.ComputerID),
			computerentity.ServerIDEQ(command.ServerID),
		).Only(ctx)
		if computerErr != nil {
			return bootstrapport.Operation{}, computerErr
		}
		idempotencyKey := command.IdempotencyKey + ":" +
			strconv.FormatInt(computer.EnrollmentGeneration, 10) + ":" +
			strconv.FormatUint(command.CredentialVersion, 10)
		entity, err := repository.handle.Client().TencentOperation.Query().Where(
			operationentity.PartitionKeyEQ(command.ServerID),
			operationentity.ServiceEQ(bootstrapOperationService),
			operationentity.IdempotencyKeyEQ(idempotencyKey),
		).Only(ctx)
		if err != nil {
			return bootstrapport.Operation{}, err
		}
		return mapOperation(entity)
	}
	return result, returnErr
}

func (repository *EntRepository) TryLease(
	ctx context.Context,
	command bootstrapport.LeaseCommand,
) (bool, error) {
	if repository == nil || ctx == nil || !uuidV7(command.OperationID) ||
		!uuidV7(command.LeaseOwner) || !command.LeaseExpiresAt.After(command.Now) ||
		command.MaxAttempts < 1 {
		return false, bootstrapport.ErrLeaseLost
	}
	updated, err := repository.handle.Client().TencentOperation.Update().Where(
		operationentity.IDEQ(command.OperationID),
		operationentity.KindEQ(bootstrapOperationKind),
		operationentity.AttemptsLT(command.MaxAttempts),
		operationentity.DeadlineAtGT(command.Now.UTC()),
		operationentity.Or(
			operationentity.StateEQ("pending"),
			operationentity.And(
				operationentity.StateEQ("retry_wait"),
				operationentity.Or(
					operationentity.NextAttemptAtIsNil(),
					operationentity.NextAttemptAtLTE(command.Now.UTC()),
				),
			),
			operationentity.And(
				operationentity.StateEQ("running"),
				operationentity.LeaseExpiresAtLTE(command.Now.UTC()),
			),
		),
	).SetState("running").SetLeaseOwner(command.LeaseOwner).
		SetLeaseExpiresAt(command.LeaseExpiresAt.UTC()).
		ClearNextAttemptAt().ClearLastErrorCode().AddAttempts(1).
		SetUpdatedAt(command.Now.UTC()).Save(ctx)
	if err != nil {
		return false, err
	}
	return updated == 1, nil
}

// ClaimNext 只领取独立 computer-bootstrap service 下最早到期的操作。
// HTTP 请求不调用本方法，外部 provider 副作用只能由后台 Worker 触发。
func (repository *EntRepository) ClaimNext(
	ctx context.Context,
	command bootstrapport.ClaimCommand,
) (result bootstrapport.Operation, found bool, returnErr error) {
	if repository == nil || ctx == nil || !uuidV7(command.LeaseOwner) ||
		!command.LeaseExpiresAt.After(command.Now) || command.MaxAttempts < 1 {
		return result, false, bootstrapport.ErrLeaseLost
	}
	now := command.Now.UTC()
	due := operationentity.And(
		operationentity.ServiceEQ(bootstrapOperationService),
		operationentity.KindEQ(bootstrapOperationKind),
		operationentity.AttemptsLT(command.MaxAttempts),
		operationentity.DeadlineAtGT(now),
		operationentity.Or(
			operationentity.StateEQ("pending"),
			operationentity.And(
				operationentity.StateEQ("retry_wait"),
				operationentity.Or(
					operationentity.NextAttemptAtIsNil(),
					operationentity.NextAttemptAtLTE(now),
				),
			),
			operationentity.And(
				operationentity.StateEQ("running"),
				operationentity.LeaseExpiresAtLTE(now),
			),
		),
	)
	returnErr = repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		candidates, err := tx.TencentOperation.Query().Where(due).
			Order(ent.Asc(operationentity.FieldCreatedAt), ent.Asc(operationentity.FieldID)).
			Limit(32).All(ctx)
		if err != nil {
			return err
		}
		for _, candidate := range candidates {
			updated, err := tx.TencentOperation.Update().Where(
				operationentity.IDEQ(candidate.ID), due,
			).SetState("running").SetLeaseOwner(command.LeaseOwner).
				SetLeaseExpiresAt(command.LeaseExpiresAt.UTC()).ClearNextAttemptAt().
				ClearLastErrorCode().AddAttempts(1).SetUpdatedAt(now).Save(ctx)
			if err != nil {
				return err
			}
			if updated != 1 {
				continue
			}
			claimed, err := tx.TencentOperation.Query().Where(
				operationentity.IDEQ(candidate.ID),
				operationentity.LeaseOwnerEQ(command.LeaseOwner),
			).Only(ctx)
			if err != nil {
				return err
			}
			result, err = mapOperation(claimed)
			if err != nil {
				return err
			}
			found = true
			return nil
		}
		return nil
	})
	return result, found, returnErr
}

func (repository *EntRepository) Complete(
	ctx context.Context,
	command bootstrapport.CompleteCommand,
) error {
	if repository == nil || ctx == nil || !uuidV7(command.OperationID) ||
		!uuidV7(command.LeaseOwner) || strings.TrimSpace(command.EncryptedResult) == "" ||
		!command.ResultExpiresAt.After(command.CompletedAt) {
		return bootstrapport.ErrLeaseLost
	}
	resultJSON, err := persistedjson.EncodeResultSnapshot(
		bootstrapOperationService,
		bootstrapOperationKind,
		command.EncryptedResult,
	)
	if err != nil {
		return err
	}
	updated, err := repository.handle.Client().TencentOperation.Update().Where(
		operationentity.IDEQ(command.OperationID),
		operationentity.KindEQ(bootstrapOperationKind),
		operationentity.StateEQ("running"),
		operationentity.LeaseOwnerEQ(command.LeaseOwner),
		operationentity.LeaseExpiresAtGT(command.CompletedAt.UTC()),
	).SetState("succeeded").SetResultJSON(resultJSON).
		SetDeadlineAt(command.ResultExpiresAt.UTC()).SetCompletedAt(command.CompletedAt.UTC()).
		ClearLeaseOwner().ClearLeaseExpiresAt().ClearNextAttemptAt().ClearLastErrorCode().
		SetUpdatedAt(command.CompletedAt.UTC()).Save(ctx)
	if err != nil {
		return err
	}
	if updated != 1 {
		return bootstrapport.ErrLeaseLost
	}
	return nil
}

func (repository *EntRepository) Retry(
	ctx context.Context,
	command bootstrapport.RetryCommand,
) error {
	if repository == nil || ctx == nil || !uuidV7(command.OperationID) ||
		!uuidV7(command.LeaseOwner) || strings.TrimSpace(command.ErrorCode) == "" {
		return bootstrapport.ErrLeaseLost
	}
	update := repository.handle.Client().TencentOperation.Update().Where(
		operationentity.IDEQ(command.OperationID),
		operationentity.KindEQ(bootstrapOperationKind),
		operationentity.StateEQ("running"),
		operationentity.LeaseOwnerEQ(command.LeaseOwner),
		operationentity.LeaseExpiresAtGT(command.FailedAt.UTC()),
	).SetLastErrorCode(command.ErrorCode).ClearLeaseOwner().ClearLeaseExpiresAt().
		SetUpdatedAt(command.FailedAt.UTC())
	if command.Terminal {
		update.SetState("failed").SetCompletedAt(command.FailedAt.UTC()).ClearNextAttemptAt()
	} else {
		update.SetState("retry_wait").SetNextAttemptAt(command.NextAttemptAt.UTC())
	}
	updated, err := update.Save(ctx)
	if err != nil {
		return err
	}
	if updated != 1 {
		return bootstrapport.ErrLeaseLost
	}
	return nil
}

func (repository *EntRepository) RenewExpired(
	ctx context.Context,
	command bootstrapport.RenewExpiredCommand,
) (bootstrapport.Operation, bool, error) {
	if repository == nil || ctx == nil || !validRenewExpired(command) {
		return bootstrapport.Operation{}, false, bootstrapport.ErrNotEligible
	}
	expectedResultJSON, err := persistedjson.EncodeResultSnapshot(
		bootstrapOperationService,
		bootstrapOperationKind,
		command.ExpectedEncryptedResult,
	)
	if err != nil {
		return bootstrapport.Operation{}, false, bootstrapport.ErrNotEligible
	}
	updated, err := repository.handle.Client().TencentOperation.Update().Where(
		operationentity.PartitionKeyEQ(command.ServerID),
		operationentity.IDEQ(command.OperationID),
		operationentity.ServerIDEQ(command.ServerID),
		operationentity.ServiceEQ(bootstrapOperationService),
		operationentity.KindEQ(bootstrapOperationKind),
		operationentity.ResourceTypeEQ("computer"),
		operationentity.ResourceIDEQ(command.ComputerID),
		operationentity.DesiredRevisionEQ(int64(command.CredentialVersion)),
		operationentity.StateEQ("succeeded"),
		operationentity.ResultJSONEQ(expectedResultJSON),
		renewalFence(command),
	).SetState("pending").SetAttempts(0).
		ClearNextAttemptAt().ClearLeaseOwner().ClearLeaseExpiresAt().
		ClearLastErrorCode().ClearResultJSON().ClearCompletedAt().
		SetDeadlineAt(command.DeadlineAt.UTC()).SetUpdatedAt(command.RenewedAt.UTC()).
		Save(ctx)
	if err != nil {
		return bootstrapport.Operation{}, false, err
	}
	entity, err := repository.handle.Client().TencentOperation.Query().Where(
		operationentity.PartitionKeyEQ(command.ServerID),
		operationentity.IDEQ(command.OperationID),
	).Only(ctx)
	if err != nil {
		return bootstrapport.Operation{}, false, err
	}
	current, err := mapOperation(entity)
	if err != nil {
		return bootstrapport.Operation{}, false, err
	}
	if updated == 0 && current.State == "succeeded" &&
		subtle.ConstantTimeCompare(
			[]byte(current.EncryptedResult), []byte(command.ExpectedEncryptedResult),
		) == 1 {
		return bootstrapport.Operation{}, false, bootstrapport.ErrNotEligible
	}
	return current, updated == 1, nil
}

// EnsureReconcile 把当前 provider 密文版本幂等桥接到既有 TAT Worker。
// 每一份新密文只创建一个对账 Operation；重放同一份密文不会再次增加 Computer revision。
func (repository *EntRepository) EnsureReconcile(
	ctx context.Context,
	command bootstrapport.EnsureReconcileCommand,
) (returnErr error) {
	if repository == nil || ctx == nil || !validEnsureReconcile(command) {
		return bootstrapport.ErrNotEligible
	}
	idempotencyKey := reconcileIdempotencyKey(command)
	returnErr = repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		existing, err := tx.TencentOperation.Query().Where(
			operationentity.PartitionKeyEQ(command.ServerID),
			operationentity.ServiceEQ("tat"),
			operationentity.IdempotencyKeyEQ(idempotencyKey),
		).Only(ctx)
		if err == nil {
			return validateReconcileOperation(existing, command)
		}
		if !ent.IsNotFound(err) {
			return err
		}
		computer, err := tx.Computer.Query().Where(
			computerentity.IDEQ(command.ComputerID),
			computerentity.ServerIDEQ(command.ServerID),
			computerentity.LifecycleStateEQ("provisioning"),
			computerentity.TatInstanceKindEQ("managed"),
			computerentity.TatInstanceIDIsNil(),
			computerentity.EnrollmentClaimedAtNotNil(),
			computerentity.EnrollmentCredentialVersionEQ(int64(command.CredentialVersion)),
		).Only(ctx)
		if ent.IsNotFound(err) {
			return bootstrapport.ErrNotEligible
		}
		if err != nil {
			return err
		}
		if _, err := tx.ComputerRuntimeCredential.Query().Where(
			credentialentity.ServerIDEQ(command.ServerID),
			credentialentity.ComputerIDEQ(command.ComputerID),
			credentialentity.VersionEQ(int64(command.CredentialVersion)),
			credentialentity.StateEQ("active"),
			credentialentity.RevokedAtIsNil(),
			credentialentity.ExpiresAtGT(command.CreatedAt.UTC()),
		).Only(ctx); ent.IsNotFound(err) {
			return bootstrapport.ErrNotEligible
		} else if err != nil {
			return err
		}
		if computer.Revision == math.MaxInt64 {
			return bootstrapport.ErrNotEligible
		}
		nextRevision := computer.Revision + 1
		updated, err := tx.Computer.Update().Where(
			computerentity.IDEQ(computer.ID),
			computerentity.ServerIDEQ(command.ServerID),
			computerentity.RevisionEQ(computer.Revision),
			computerentity.LifecycleStateEQ("provisioning"),
			computerentity.TatInstanceIDIsNil(),
		).SetRegistrationExpiresAt(command.MaterialExpiresAt.UTC()).
			SetRevision(nextRevision).SetUpdatedAt(command.CreatedAt.UTC()).Save(ctx)
		if err != nil {
			return err
		}
		if updated != 1 {
			return bootstrapport.ErrNotEligible
		}
		operation, err := tx.TencentOperation.Create().
			SetID(command.ReconcileOperationID).
			SetPartitionKey(command.ServerID).
			SetServerID(command.ServerID).
			SetService("tat").
			SetKind("tat.computer.registration.reconcile").
			SetResourceType("computer").
			SetResourceID(command.ComputerID).
			SetIdempotencyKey(idempotencyKey).
			SetDesiredRevision(nextRevision).
			SetState("pending").
			SetAttempts(0).
			SetDeadlineAt(command.MaterialExpiresAt.UTC()).
			SetCreatedAt(command.CreatedAt.UTC()).
			SetUpdatedAt(command.CreatedAt.UTC()).
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
			SetAvailableAt(command.CreatedAt.UTC()).
			SetCreatedAt(command.CreatedAt.UTC()).
			Save(ctx); err != nil {
			return err
		}
		return nil
	})
	if !ent.IsConstraintError(returnErr) {
		return returnErr
	}
	existing, err := repository.handle.Client().TencentOperation.Query().Where(
		operationentity.PartitionKeyEQ(command.ServerID),
		operationentity.ServiceEQ("tat"),
		operationentity.IdempotencyKeyEQ(idempotencyKey),
	).Only(ctx)
	if err != nil {
		return err
	}
	return validateReconcileOperation(existing, command)
}

func reconcileIdempotencyKey(command bootstrapport.EnsureReconcileCommand) string {
	return "tat.computer.registration.reconcile:bootstrap:v1:" +
		command.BootstrapOperationID + ":" + hex.EncodeToString(command.MaterialFingerprint[:])
}

func validateReconcileOperation(
	operation *ent.TencentOperation,
	command bootstrapport.EnsureReconcileCommand,
) error {
	if operation == nil || operation.ServerID == nil || *operation.ServerID != command.ServerID ||
		operation.Service != "tat" || operation.Kind != "tat.computer.registration.reconcile" ||
		operation.ResourceType != "computer" || operation.ResourceID != command.ComputerID ||
		operation.DesiredRevision == nil || *operation.DesiredRevision <= 0 {
		return bootstrapport.ErrNotEligible
	}
	return nil
}

func renewalFence(command bootstrapport.RenewExpiredCommand) predicate.TencentOperation {
	return func(selector *entsql.Selector) {
		computerTable := entsql.Table(computerentity.Table)
		credentialTable := entsql.Table(credentialentity.Table)
		computerEligible := entsql.Select(computerTable.C(computerentity.FieldID)).
			From(computerTable).
			Where(entsql.And(
				entsql.EQ(computerTable.C(computerentity.FieldID), command.ComputerID),
				entsql.EQ(computerTable.C(computerentity.FieldServerID), command.ServerID),
				entsql.EQ(computerTable.C(computerentity.FieldLifecycleState), "provisioning"),
				entsql.EQ(computerTable.C(computerentity.FieldTatInstanceKind), "managed"),
				entsql.IsNull(computerTable.C(computerentity.FieldTatInstanceID)),
				entsql.NotNull(computerTable.C(computerentity.FieldEnrollmentClaimedAt)),
				entsql.EQ(
					computerTable.C(computerentity.FieldEnrollmentCredentialVersion),
					int64(command.CredentialVersion),
				),
			))
		credentialEligible := entsql.Select(credentialTable.C(credentialentity.FieldID)).
			From(credentialTable).
			Where(entsql.And(
				entsql.EQ(credentialTable.C(credentialentity.FieldServerID), command.ServerID),
				entsql.EQ(credentialTable.C(credentialentity.FieldComputerID), command.ComputerID),
				entsql.EQ(
					credentialTable.C(credentialentity.FieldVersion),
					int64(command.CredentialVersion),
				),
				entsql.EQ(credentialTable.C(credentialentity.FieldState), "active"),
				entsql.IsNull(credentialTable.C(credentialentity.FieldRevokedAt)),
				entsql.GT(credentialTable.C(credentialentity.FieldExpiresAt), command.RenewedAt.UTC()),
			))
		selector.Where(entsql.And(
			entsql.Exists(computerEligible),
			entsql.Exists(credentialEligible),
		))
	}
}

func validStart(command bootstrapport.StartCommand) bool {
	return uuidV7(command.ServerID) && uuidV7(command.ComputerID) &&
		uuidV7(command.OperationID) && command.CredentialVersion > 0 &&
		command.CredentialVersion <= math.MaxInt64 && strings.TrimSpace(command.IdempotencyKey) != "" &&
		command.DeadlineAt.After(command.CreatedAt)
}

func validRenewExpired(command bootstrapport.RenewExpiredCommand) bool {
	return uuidV7(command.OperationID) && uuidV7(command.ServerID) &&
		uuidV7(command.ComputerID) && command.CredentialVersion > 0 &&
		command.CredentialVersion <= math.MaxInt64 &&
		strings.TrimSpace(command.ExpectedEncryptedResult) != "" &&
		!command.RenewedAt.IsZero() && command.DeadlineAt.After(command.RenewedAt)
}

func validEnsureReconcile(command bootstrapport.EnsureReconcileCommand) bool {
	if !uuidV7(command.BootstrapOperationID) || !uuidV7(command.ReconcileOperationID) ||
		!uuidV7(command.ServerID) || !uuidV7(command.ComputerID) ||
		command.CredentialVersion == 0 || command.CredentialVersion > math.MaxInt64 ||
		command.CreatedAt.IsZero() || !command.MaterialExpiresAt.After(command.CreatedAt) {
		return false
	}
	var nonzero byte
	for _, value := range command.MaterialFingerprint {
		nonzero |= value
	}
	return nonzero != 0
}

func mapOperation(entity *ent.TencentOperation) (bootstrapport.Operation, error) {
	if entity == nil || entity.ServerID == nil || entity.DesiredRevision == nil ||
		*entity.DesiredRevision <= 0 || entity.Kind != bootstrapOperationKind ||
		entity.ResourceType != "computer" || entity.DeadlineAt == nil {
		return bootstrapport.Operation{}, errors.New("Computer bootstrap operation 数据无效")
	}
	result := bootstrapport.Operation{
		ID: entity.ID, ServerID: *entity.ServerID, ComputerID: entity.ResourceID,
		CredentialVersion: uint64(*entity.DesiredRevision), State: entity.State,
		Attempts: entity.Attempts, NextAttemptAt: entity.NextAttemptAt,
		ResultExpiresAt: entity.DeadlineAt.UTC(),
	}
	if entity.LeaseOwner != nil {
		result.LeaseOwner = *entity.LeaseOwner
	}
	if entity.ResultJSON != nil {
		if _, err := persistedjson.DecodeResultSnapshot(
			*entity.ResultJSON,
			bootstrapOperationService,
			bootstrapOperationKind,
			&result.EncryptedResult,
		); err != nil {
			return bootstrapport.Operation{}, err
		}
	}
	return result, nil
}

func uuidV7(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed != uuid.Nil && parsed.Version() == 7
}
