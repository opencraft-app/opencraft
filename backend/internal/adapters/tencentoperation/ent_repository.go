// Package tencentoperation 使用 Ent/SQLite 实现 TAT 操作租约与状态收敛。
package tencentoperation

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"chatserver/internal/database"
	"chatserver/internal/ent"
	"chatserver/internal/ent/computer"
	"chatserver/internal/ent/outboxevent"
	"chatserver/internal/ent/predicate"
	"chatserver/internal/ent/tatinstancebinding"
	"chatserver/internal/ent/tencentoperation"
	tencentoperationport "chatserver/internal/ports/tencentoperation"
	tencenttatport "chatserver/internal/ports/tencenttat"
)

// EntRepository 使用短租约、fencing 和同资源前序阻塞。
type EntRepository struct{ handle *database.Handle }

// NewEntRepository 创建 TAT operation repository。
func NewEntRepository(handle *database.Handle) (*EntRepository, error) {
	if handle == nil || handle.Client() == nil {
		return nil, errors.New("TAT operation Repository 缺少数据库 Handle")
	}
	return &EntRepository{handle: handle}, nil
}

// Claim 领取最早且没有未完成前序的到期操作。
func (repository *EntRepository) Claim(
	ctx context.Context,
	claim tencentoperationport.Claim,
) (work tencentoperationport.Work, found bool, returnErr error) {
	if err := validateClaim(claim); err != nil {
		return work, false, err
	}
	returnErr = repository.handle.WithTx(
		ctx,
		func(ctx context.Context, tx *ent.Tx) error {
			due := duePredicate(claim.Now.UTC())
			candidates, err := tx.TencentOperation.Query().
				Where(
					tencentoperation.ServiceEQ("tat"),
					tencentoperation.ResourceTypeEQ("computer"),
					due,
				).
				Order(
					ent.Asc(tencentoperation.FieldCreatedAt),
					ent.Asc(tencentoperation.FieldID),
				).
				Limit(64).
				All(ctx)
			if err != nil {
				return err
			}
			for _, operation := range candidates {
				blocked, err := hasEarlierNonterminal(ctx, tx, operation)
				if err != nil {
					return err
				}
				if blocked {
					continue
				}
				updated, err := tx.TencentOperation.Update().
					Where(tencentoperation.IDEQ(operation.ID), due).
					SetState("running").
					AddAttempts(1).
					ClearNextAttemptAt().
					SetLeaseOwner(claim.LeaseOwner).
					SetLeaseExpiresAt(claim.LeaseExpiresAt.UTC()).
					ClearLastErrorCode().
					SetUpdatedAt(claim.Now.UTC()).
					Save(ctx)
				if err != nil {
					return err
				}
				if updated != 1 {
					continue
				}
				work, err = loadWork(ctx, tx, operation, claim.LeaseOwner)
				if err != nil {
					return err
				}
				found = true
				return nil
			}
			return nil
		},
	)
	return work, found, returnErr
}

// Complete 仅允许当前未过期 leaseOwner 原子写回。
func (repository *EntRepository) Complete(
	ctx context.Context,
	completion tencentoperationport.Completion,
) error {
	if err := validateCompletion(completion); err != nil {
		return err
	}
	return repository.handle.WithTx(
		ctx,
		func(ctx context.Context, tx *ent.Tx) error {
			operation, err := tx.TencentOperation.Query().
				Where(
					tencentoperation.IDEQ(completion.OperationID),
					tencentoperation.ServiceEQ("tat"),
					tencentoperation.StateEQ("running"),
					tencentoperation.LeaseOwnerEQ(completion.LeaseOwner),
					tencentoperation.LeaseExpiresAtNotNil(),
					tencentoperation.LeaseExpiresAtGT(completion.CompletedAt.UTC()),
				).
				Only(ctx)
			if ent.IsNotFound(err) {
				return tencentoperationport.ErrLeaseLost
			}
			if err != nil {
				return err
			}
			status := completion.Status
			switch operation.ResourceType {
			case "computer":
				switch status {
				case tencentoperationport.CompletionSucceeded:
					var failureCode string
					status, failureCode, err = completeComputerSuccess(
						ctx,
						tx,
						operation,
						completion,
					)
					if failureCode != "" {
						completion.ErrorCode = failureCode
					}
				case tencentoperationport.CompletionFailed,
					tencentoperationport.CompletionUncertain:
					status, err = completeComputerFailure(
						ctx,
						tx,
						operation,
						completion.ErrorCode,
						completion.CompletedAt.UTC(),
						status,
					)
				}
			default:
				return errors.New("TAT operation 资源类型无效")
			}
			if err != nil {
				return err
			}
			if err := updateOperation(ctx, tx, operation, completion, status); err != nil {
				return err
			}
			if status != tencentoperationport.CompletionRetry {
				if err := processOutbox(
					ctx,
					tx,
					operation.ID,
					completion.CompletedAt.UTC(),
				); err != nil {
					return err
				}
			}
			return nil
		},
	)
}

func duePredicate(now time.Time) predicate.TencentOperation {
	return tencentoperation.Or(
		tencentoperation.StateEQ("pending"),
		tencentoperation.And(
			tencentoperation.StateEQ("retry_wait"),
			tencentoperation.NextAttemptAtNotNil(),
			tencentoperation.NextAttemptAtLTE(now),
		),
		tencentoperation.And(
			tencentoperation.StateEQ("running"),
			tencentoperation.LeaseExpiresAtNotNil(),
			tencentoperation.LeaseExpiresAtLTE(now),
		),
	)
}

func hasEarlierNonterminal(
	ctx context.Context,
	tx *ent.Tx,
	operation *ent.TencentOperation,
) (bool, error) {
	return tx.TencentOperation.Query().
		Where(
			tencentoperation.ServiceEQ("tat"),
			tencentoperation.ResourceTypeEQ(operation.ResourceType),
			tencentoperation.ResourceIDEQ(operation.ResourceID),
			tencentoperation.StateIn("pending", "running", "retry_wait"),
			tencentoperation.Or(
				tencentoperation.CreatedAtLT(operation.CreatedAt),
				tencentoperation.And(
					tencentoperation.CreatedAtEQ(operation.CreatedAt),
					tencentoperation.IDLT(operation.ID),
				),
			),
		).
		Exist(ctx)
}

func loadWork(
	ctx context.Context,
	tx *ent.Tx,
	operation *ent.TencentOperation,
	leaseOwner string,
) (tencentoperationport.Work, error) {
	switch operation.ResourceType {
	case "computer":
		return loadComputerWork(ctx, tx, operation, leaseOwner)
	default:
		return tencentoperationport.Work{}, errors.New(
			"TAT operation 资源类型无效",
		)
	}
}

func loadComputerWork(
	ctx context.Context,
	tx *ent.Tx,
	operation *ent.TencentOperation,
	leaseOwner string,
) (tencentoperationport.Work, error) {
	entity, err := tx.Computer.Query().
		Where(computer.IDEQ(operation.ResourceID)).
		Only(ctx)
	if err != nil {
		return tencentoperationport.Work{}, err
	}
	work := tencentoperationport.Work{
		OperationID:           operation.ID,
		LeaseOwner:            leaseOwner,
		ServerID:              entity.ServerID,
		ResourceID:            entity.ID,
		ResourceType:          operation.ResourceType,
		Kind:                  operation.Kind,
		ResourceRevision:      entity.Revision,
		ComputerActive:        entity.LifecycleState == "active",
		TATOnline:             entity.TatAgentState == "online",
		RegistrationExpiresAt: entity.RegistrationExpiresAt,
		Attempts:              operation.Attempts + 1,
		Target: tencenttatport.Target{
			Region: entity.TatRegion,
			OS:     normalizeOS(entity.OsType),
		},
	}
	if operation.DesiredRevision != nil {
		work.DesiredRevision = *operation.DesiredRevision
	} else {
		work.DesiredRevision = -1
	}
	if entity.TatInstanceID != nil {
		work.Target.InstanceID = *entity.TatInstanceID
	}
	return work, nil
}

func completeComputerSuccess(
	ctx context.Context,
	tx *ent.Tx,
	operation *ent.TencentOperation,
	completion tencentoperationport.Completion,
) (tencentoperationport.CompletionStatus, string, error) {
	entity, err := tx.Computer.Query().
		Where(computer.IDEQ(operation.ResourceID)).
		Only(ctx)
	if err != nil {
		return "", "", err
	}
	if operation.DesiredRevision == nil ||
		entity.Revision != *operation.DesiredRevision {
		return tencentoperationport.CompletionSuperseded, "", nil
	}
	at := completion.CompletedAt.UTC()
	switch operation.Kind {
	case "tat.computer.registration.reconcile":
		if !strings.HasPrefix(completion.ComputerInstanceID, "rins-") ||
			completion.ComputerOS != normalizeOS(entity.OsType) ||
			completion.ComputerTATOnline == nil ||
			!*completion.ComputerTATOnline {
			return completeComputerValidationFailure(
				ctx,
				tx,
				entity,
				at,
				"tat_registration_result_invalid",
			)
		}
		hash := bindingHash(entity.TatRegion, completion.ComputerInstanceID)
		createdBinding := false
		existing, err := tx.TATInstanceBinding.Query().
			Where(tatinstancebinding.BindingHashEQ(hash)).
			Only(ctx)
		switch {
		case err == nil:
			if existing.ServerID != entity.ServerID ||
				existing.ComputerID != entity.ID ||
				existing.TatRegion != entity.TatRegion ||
				existing.TatInstanceID != completion.ComputerInstanceID {
				return completeComputerValidationFailure(
					ctx,
					tx,
					entity,
					at,
					"tat_instance_already_bound",
				)
			}
		case ent.IsNotFound(err):
			if _, err := tx.TATInstanceBinding.Create().
				SetBindingHash(hash).
				SetTatRegion(entity.TatRegion).
				SetTatInstanceID(completion.ComputerInstanceID).
				SetServerID(entity.ServerID).
				SetComputerID(entity.ID).
				SetState("active").
				SetCreatedAt(at).
				SetUpdatedAt(at).
				Save(ctx); err != nil {
				return "", "", err
			}
			createdBinding = true
		default:
			return "", "", err
		}
		updated, err := tx.Computer.Update().
			Where(
				computer.IDEQ(entity.ID),
				computer.RevisionEQ(entity.Revision),
			).
			SetTatInstanceID(completion.ComputerInstanceID).
			SetLifecycleState("active").
			SetTatAgentState("online").
			ClearRegistrationExpiresAt().
			SetLastObservedAt(at).
			ClearLastErrorCode().
			AddRevision(1).
			SetUpdatedAt(at).
			Save(ctx)
		if err != nil {
			return "", "", err
		}
		if updated != 1 {
			if createdBinding {
				if _, err := tx.TATInstanceBinding.Delete().
					Where(
						tatinstancebinding.BindingHashEQ(hash),
						tatinstancebinding.ComputerIDEQ(entity.ID),
					).
					Exec(ctx); err != nil {
					return "", "", err
				}
			}
			return tencentoperationport.CompletionSuperseded, "", nil
		}
		return tencentoperationport.CompletionSucceeded, "", nil
	case "tat.computer.refresh":
		if entity.TatInstanceID == nil ||
			completion.ComputerTATOnline == nil ||
			completion.ComputerOS != normalizeOS(entity.OsType) {
			return completeComputerValidationFailure(
				ctx,
				tx,
				entity,
				at,
				"tat_probe_result_invalid",
			)
		}
		state := "offline"
		if *completion.ComputerTATOnline {
			state = "online"
		}
		updated, err := tx.Computer.Update().
			Where(
				computer.IDEQ(entity.ID),
				computer.RevisionEQ(entity.Revision),
			).
			SetTatAgentState(state).
			SetLastObservedAt(at).
			ClearLastErrorCode().
			AddRevision(1).
			SetUpdatedAt(at).
			Save(ctx)
		if err != nil {
			return "", "", err
		}
		if updated != 1 {
			return tencentoperationport.CompletionSuperseded, "", nil
		}
		return tencentoperationport.CompletionSucceeded, "", nil
	default:
		return completeComputerValidationFailure(
			ctx,
			tx,
			entity,
			at,
			"tat_operation_kind_invalid",
		)
	}
}

func completeComputerValidationFailure(
	ctx context.Context,
	tx *ent.Tx,
	entity *ent.Computer,
	at time.Time,
	code string,
) (tencentoperationport.CompletionStatus, string, error) {
	updated, err := tx.Computer.Update().
		Where(
			computer.IDEQ(entity.ID),
			computer.RevisionEQ(entity.Revision),
		).
		ClearRegistrationExpiresAt().
		SetLastObservedAt(at).
		SetLastErrorCode(code).
		AddRevision(1).
		SetUpdatedAt(at).
		Save(ctx)
	if err != nil {
		return "", "", err
	}
	if updated != 1 {
		return tencentoperationport.CompletionSuperseded, "", nil
	}
	return tencentoperationport.CompletionFailed, code, nil
}

func completeComputerFailure(
	ctx context.Context,
	tx *ent.Tx,
	operation *ent.TencentOperation,
	errorCode string,
	at time.Time,
	status tencentoperationport.CompletionStatus,
) (tencentoperationport.CompletionStatus, error) {
	entity, err := tx.Computer.Query().
		Where(computer.IDEQ(operation.ResourceID)).
		Only(ctx)
	if err != nil {
		return "", err
	}
	if operation.DesiredRevision == nil ||
		entity.Revision != *operation.DesiredRevision {
		return tencentoperationport.CompletionSuperseded, nil
	}
	update := tx.Computer.Update().
		Where(
			computer.IDEQ(entity.ID),
			computer.RevisionEQ(entity.Revision),
		).
		SetLastObservedAt(at).
		SetLastErrorCode(errorCode).
		AddRevision(1).
		SetUpdatedAt(at)
	if operation.Kind == "tat.computer.registration.reconcile" {
		update.ClearRegistrationExpiresAt()
	}
	updated, err := update.Save(ctx)
	if err != nil {
		return "", err
	}
	if updated != 1 {
		return tencentoperationport.CompletionSuperseded, nil
	}
	return status, nil
}

func bindingHash(region string, instanceID string) string {
	digest := sha256.Sum256([]byte(region + "\x00" + instanceID))
	return hex.EncodeToString(digest[:])
}

func updateOperation(
	ctx context.Context,
	tx *ent.Tx,
	operation *ent.TencentOperation,
	completion tencentoperationport.Completion,
	status tencentoperationport.CompletionStatus,
) error {
	update := tx.TencentOperation.Update().
		Where(
			tencentoperation.IDEQ(operation.ID),
			tencentoperation.StateEQ("running"),
			tencentoperation.LeaseOwnerEQ(completion.LeaseOwner),
			tencentoperation.LeaseExpiresAtNotNil(),
			tencentoperation.LeaseExpiresAtGT(completion.CompletedAt.UTC()),
		).
		SetState(string(status)).
		ClearLeaseOwner().
		ClearLeaseExpiresAt().
		SetUpdatedAt(completion.CompletedAt.UTC())
	switch status {
	case tencentoperationport.CompletionRetry:
		update.
			SetNextAttemptAt(completion.NextAttemptAt.UTC()).
			ClearCompletedAt()
		if completion.ErrorCode == "" {
			update.ClearLastErrorCode()
		} else {
			update.SetLastErrorCode(completion.ErrorCode)
		}
	case tencentoperationport.CompletionFailed,
		tencentoperationport.CompletionUncertain:
		update.
			ClearNextAttemptAt().
			SetLastErrorCode(completion.ErrorCode).
			SetCompletedAt(completion.CompletedAt.UTC())
	default:
		update.
			ClearNextAttemptAt().
			ClearLastErrorCode().
			SetCompletedAt(completion.CompletedAt.UTC())
	}
	updated, err := update.Save(ctx)
	if err != nil {
		return err
	}
	if updated != 1 {
		return tencentoperationport.ErrLeaseLost
	}
	return nil
}

func processOutbox(
	ctx context.Context,
	tx *ent.Tx,
	operationID string,
	at time.Time,
) error {
	_, err := tx.OutboxEvent.Update().
		Where(
			outboxevent.AggregateTypeEQ("tencent_operation"),
			outboxevent.AggregateIDEQ(operationID),
			outboxevent.StateIn("pending", "processing"),
		).
		SetState("processed").
		ClearLeaseOwner().
		ClearLeaseExpiresAt().
		ClearLastErrorCode().
		SetProcessedAt(at).
		Save(ctx)
	return err
}

func normalizeOS(value string) tencenttatport.OS {
	switch strings.ToLower(value) {
	case "linux":
		return tencenttatport.OSLinux
	case "windows":
		return tencenttatport.OSWindows
	case "macos":
		return tencenttatport.OSMacOS
	default:
		return ""
	}
}

func validateClaim(claim tencentoperationport.Claim) error {
	if strings.TrimSpace(claim.LeaseOwner) == "" ||
		claim.Now.IsZero() ||
		!claim.LeaseExpiresAt.After(claim.Now) {
		return errors.New("TAT operation 领取参数无效")
	}
	return nil
}

func validateCompletion(completion tencentoperationport.Completion) error {
	if strings.TrimSpace(completion.OperationID) == "" ||
		strings.TrimSpace(completion.LeaseOwner) == "" ||
		completion.CompletedAt.IsZero() {
		return errors.New("TAT operation 完成参数无效")
	}
	switch completion.Status {
	case tencentoperationport.CompletionRetry:
		if !completion.NextAttemptAt.After(completion.CompletedAt) {
			return errors.New("TAT operation 重试时间无效")
		}
	case tencentoperationport.CompletionFailed,
		tencentoperationport.CompletionUncertain:
		if strings.TrimSpace(completion.ErrorCode) == "" {
			return errors.New("TAT operation 失败码无效")
		}
	case tencentoperationport.CompletionSucceeded,
		tencentoperationport.CompletionSuperseded:
	default:
		return errors.New("TAT operation 完成状态无效")
	}
	return nil
}

var _ tencentoperationport.Repository = (*EntRepository)(nil)
