package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"

	"cvm-mock-e2b/internal/core"
)

const modifyOperationColumns = `
	id, idempotency_key, sandbox_id, instance_id, source_pool_id, target_pool_id, target_sku_id,
	target_template_class_id, target_instance_type, target_system_disk_size, status, current_step,
	last_error, started_at, updated_at, completed_at
`

// RebindAllocatedInstance moves a checked-out instance into the target pool.
//
// The instance row and its sandbox row must move together: every read path derives
// the effective spec via sandboxes.pool_id / template_class_id, so updating only
// instances.pool_id would leave the API reporting the source spec. sandboxes has no
// FK on pool_id, so nothing but this transaction keeps the two consistent.
func (s *MySQLStore) RebindAllocatedInstance(ctx context.Context, in RebindInstanceInput) (core.Instance, error) {
	instanceID := strings.TrimSpace(in.InstanceID)
	targetPoolID := strings.TrimSpace(in.TargetPoolID)
	if instanceID == "" || targetPoolID == "" {
		return core.Instance{}, errors.New("rebind requires instance id and target pool id")
	}

	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return core.Instance{}, err
	}
	var inst core.Instance
	err = tx.QueryRowContext(ctx, `
		SELECT id, pool_id, state, cloud_id, address, created_at, updated_at
		FROM instances
		WHERE id = ?
		FOR UPDATE
	`, instanceID).Scan(&inst.ID, &inst.PoolID, &inst.State, &inst.CloudID, &inst.Address, &inst.CreatedAt, &inst.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		_ = tx.Rollback()
		return core.Instance{}, core.ErrInstanceNotFound
	}
	if err != nil {
		_ = tx.Rollback()
		return core.Instance{}, err
	}
	if in.ExpectedState != "" && inst.State != in.ExpectedState {
		_ = tx.Rollback()
		return core.Instance{}, core.ErrInvalidTransition
	}
	// Already rebound: a retrying caller must see success, not a spurious conflict.
	if inst.PoolID == targetPoolID {
		_ = tx.Rollback()
		return inst, nil
	}

	now := time.Now().UTC()
	if _, err := tx.ExecContext(ctx, `
		UPDATE instances SET pool_id = ?, updated_at = ? WHERE id = ?
	`, targetPoolID, now, instanceID); err != nil {
		_ = tx.Rollback()
		return core.Instance{}, err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE sandboxes
		SET pool_id = ?, template_class_id = ?, resolution_source = ?, updated_at = ?
		WHERE instance_id = ?
	`, targetPoolID, in.TemplateClassID, in.ResolutionSource, now, instanceID); err != nil {
		_ = tx.Rollback()
		return core.Instance{}, err
	}
	inst.PoolID = targetPoolID
	inst.UpdatedAt = now
	if err := tx.Commit(); err != nil {
		return core.Instance{}, err
	}
	s.logf("RebindAllocatedInstance instance=%s pool=%s class=%s", instanceID, targetPoolID, in.TemplateClassID)
	return inst, nil
}

func (s *MySQLStore) CreateModifyOperation(ctx context.Context, op core.ModifyOperation) (core.ModifyOperation, bool, error) {
	if strings.TrimSpace(op.ID) == "" || strings.TrimSpace(op.IdempotencyKey) == "" {
		return core.ModifyOperation{}, false, errors.New("modify operation requires id and idempotency key")
	}
	for attempt := 0; attempt < 2; attempt++ {
		_, err := s.db.ExecContext(ctx, `
			INSERT INTO modify_operations (`+modifyOperationColumns+`)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, op.ID, op.IdempotencyKey, op.SandboxID, op.InstanceID, op.SourcePoolID, op.TargetPoolID, op.TargetSKUID,
			op.TargetTemplateClassID, op.TargetInstanceType, op.TargetSystemDiskSize, op.Status, op.CurrentStep,
			nullableString(op.LastError), op.StartedAt, op.UpdatedAt, op.CompletedAt)
		if err == nil {
			s.logf("CreateModifyOperation id=%s key=%s sandbox=%s", op.ID, op.IdempotencyKey, op.SandboxID)
			return op, true, nil
		}
		if !isDuplicateKeyError(err) {
			return core.ModifyOperation{}, false, err
		}

		// A duplicate can be either an idempotency replay or the per-instance
		// running-ledger guard. Resolve both to the canonical operation.
		existing, getErr := s.getModifyOperationByIdempotencyKey(ctx, op.IdempotencyKey)
		if getErr == nil {
			if err := assertSameModifyTarget(existing, op); err != nil {
				return core.ModifyOperation{}, false, err
			}
			return existing, false, nil
		}
		if !errors.Is(getErr, core.ErrModifyOperationNotFound) {
			return core.ModifyOperation{}, false, getErr
		}
		if existing, found, runningErr := s.GetRunningModifyOperationByInstance(ctx, op.InstanceID); runningErr != nil {
			return core.ModifyOperation{}, false, runningErr
		} else if found {
			if err := assertSameModifyTarget(existing, op); err != nil {
				return core.ModifyOperation{}, false, err
			}
			return existing, false, nil
		}

		// The competing running row may have completed between the duplicate-key
		// error and the lookup. Retry once so the released generated unique key can
		// admit the new operation; a primary-key collision still fails deterministically.
		if attempt == 1 {
			return core.ModifyOperation{}, false, err
		}
	}
	return core.ModifyOperation{}, false, errors.New("unreachable modify operation insert")
}

func (s *MySQLStore) GetModifyOperation(ctx context.Context, id string) (core.ModifyOperation, error) {
	return readModifyOperation(s.db.QueryRowContext(ctx, `
		SELECT `+modifyOperationColumns+` FROM modify_operations WHERE id = ?
	`, strings.TrimSpace(id)))
}

func (s *MySQLStore) GetRunningModifyOperationByInstance(ctx context.Context, instanceID string) (core.ModifyOperation, bool, error) {
	// 取最早开始的那份：正常情况下只会有一份，多出来的说明本次修复之前留下了历史数据，
	// 优先收敛最老的账本以免它一直挂着 running。
	op, err := readModifyOperation(s.db.QueryRowContext(ctx, `
		SELECT `+modifyOperationColumns+` FROM modify_operations
		WHERE instance_id = ? AND status = ?
		ORDER BY started_at ASC LIMIT 1
	`, strings.TrimSpace(instanceID), core.ModifyOperationStatusRunning))
	if errors.Is(err, core.ErrModifyOperationNotFound) {
		return core.ModifyOperation{}, false, nil
	}
	if err != nil {
		return core.ModifyOperation{}, false, err
	}
	return op, true, nil
}

func (s *MySQLStore) getModifyOperationByIdempotencyKey(ctx context.Context, key string) (core.ModifyOperation, error) {
	return readModifyOperation(s.db.QueryRowContext(ctx, `
		SELECT `+modifyOperationColumns+` FROM modify_operations WHERE idempotency_key = ?
	`, strings.TrimSpace(key)))
}

func (s *MySQLStore) UpdateModifyOperationProgress(ctx context.Context, in ModifyOperationProgress) (core.ModifyOperation, error) {
	id := strings.TrimSpace(in.ID)
	if id == "" {
		return core.ModifyOperation{}, errors.New("modify operation progress requires id")
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE modify_operations
		SET status = ?, current_step = ?, last_error = ?, updated_at = ?, completed_at = ?
		WHERE id = ?
	`, in.Status, in.CurrentStep, nullableString(in.LastError), time.Now().UTC(), in.CompletedAt, id)
	if err != nil {
		return core.ModifyOperation{}, err
	}
	if affected, err := result.RowsAffected(); err == nil && affected == 0 {
		// RowsAffected is 0 both for "row missing" and "values unchanged", so confirm
		// existence rather than guessing.
		if _, getErr := s.GetModifyOperation(ctx, id); getErr != nil {
			return core.ModifyOperation{}, getErr
		}
	}
	return s.GetModifyOperation(ctx, id)
}

func (s *MySQLStore) ListModifyOperationsByStatus(ctx context.Context, status core.ModifyOperationStatus, limit int) ([]core.ModifyOperation, error) {
	query := `SELECT ` + modifyOperationColumns + ` FROM modify_operations WHERE status = ?`
	args := []any{status}
	if total, index, ok := shardFromContext(ctx); ok {
		query += ` AND MOD(CRC32(id), ?) = ?`
		args = append(args, total, index)
	}
	query += ` ORDER BY started_at ASC`
	if limit > 0 {
		query += ` LIMIT ?`
		args = append(args, limit)
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]core.ModifyOperation, 0)
	for rows.Next() {
		op, err := readModifyOperation(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, op)
	}
	return items, rows.Err()
}

func readModifyOperation(scanner rowScanner) (core.ModifyOperation, error) {
	var (
		op          core.ModifyOperation
		lastError   sql.NullString
		completedAt sql.NullTime
	)
	err := scanner.Scan(&op.ID, &op.IdempotencyKey, &op.SandboxID, &op.InstanceID, &op.SourcePoolID,
		&op.TargetPoolID, &op.TargetSKUID, &op.TargetTemplateClassID, &op.TargetInstanceType,
		&op.TargetSystemDiskSize, &op.Status, &op.CurrentStep, &lastError, &op.StartedAt, &op.UpdatedAt, &completedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return core.ModifyOperation{}, core.ErrModifyOperationNotFound
	}
	if err != nil {
		return core.ModifyOperation{}, err
	}
	op.LastError = nullStringValue(lastError)
	if completedAt.Valid {
		ts := completedAt.Time
		op.CompletedAt = &ts
	}
	return op, nil
}

// assertSameModifyTarget rejects an idempotency key replayed with a different target.
// Silently returning the original operation there would make the caller believe it
// upgraded to a spec it never asked for.
func assertSameModifyTarget(existing, requested core.ModifyOperation) error {
	if existing.SandboxID != requested.SandboxID ||
		existing.TargetPoolID != requested.TargetPoolID ||
		existing.TargetSKUID != requested.TargetSKUID {
		return fmt.Errorf("%w: key=%s existing=(sandbox=%s pool=%s sku=%s) requested=(sandbox=%s pool=%s sku=%s)",
			core.ErrModifyOperationConflict, existing.IdempotencyKey,
			existing.SandboxID, existing.TargetPoolID, existing.TargetSKUID,
			requested.SandboxID, requested.TargetPoolID, requested.TargetSKUID)
	}
	return nil
}

func nullableString(v string) any {
	if v == "" {
		return nil
	}
	return v
}

// mysqlDuplicateEntryErrno is ER_DUP_ENTRY.
const mysqlDuplicateEntryErrno = 1062

func isDuplicateKeyError(err error) bool {
	var mysqlErr *mysql.MySQLError
	if errors.As(err, &mysqlErr) {
		return mysqlErr.Number == mysqlDuplicateEntryErrno
	}
	return false
}
