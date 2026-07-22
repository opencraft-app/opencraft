package gateway

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

func (s *MySQLStore) TryAcquireSetOperationLease(
	ctx context.Context,
	setID string,
	operation string,
	owner string,
	slots int,
	ttl time.Duration,
	now time.Time,
) (SetOperationLease, bool, error) {
	setID = strings.TrimSpace(setID)
	operation = strings.TrimSpace(operation)
	owner = strings.TrimSpace(owner)
	if setID == "" || operation == "" || owner == "" || slots <= 0 || ttl <= 0 {
		return SetOperationLease{}, false, fmt.Errorf("set operation lease requires set, operation, owner, slots and ttl")
	}
	now = now.UTC()
	leaseUntil := now.Add(ttl)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SetOperationLease{}, false, err
	}
	defer tx.Rollback()
	var generation int64
	var status, adminAccessToken, admissionStatus, adminHealthStatus string
	var setup bool
	var adminUserID, maxUsers, warnUsers, reservedUsers int
	err = tx.QueryRowContext(ctx, `
		SELECT status, setup, admin_user_id, admin_access_token, admission_status,
			admin_health_status, max_users, warn_users, reserved_users, lifecycle_generation
		FROM llmgateway_sets WHERE id = ? FOR UPDATE
	`, setID).Scan(&status, &setup, &adminUserID, &adminAccessToken, &admissionStatus,
		&adminHealthStatus, &maxUsers, &warnUsers, &reservedUsers, &generation)
	if errors.Is(err, sql.ErrNoRows) {
		return SetOperationLease{}, false, nil
	}
	if err != nil {
		return SetOperationLease{}, false, err
	}
	ready := status == SetStatusActive && setup && adminUserID > 0 && adminAccessToken != "" && adminHealthStatus != SetAdminHealthUnhealthy
	if operation != SetOperationGroupRatioWrite && admissionStatus != SetAdmissionStatusPassed {
		ready = ready && admissionStatus != SetAdmissionStatusPending && admissionStatus != SetAdmissionStatusFailed && maxUsers <= 0 && warnUsers <= 0 && reservedUsers <= 0
	}
	if !ready {
		return SetOperationLease{}, false, nil
	}
	for slot := 0; slot < slots; slot++ {
		result, err := tx.ExecContext(ctx, `
			INSERT IGNORE INTO llmgateway_set_operation_leases (
				set_id, operation_name, slot_number, owner, lifecycle_generation, lease_until, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)
		`, setID, operation, slot, owner, generation, leaseUntil, now)
		if err != nil {
			return SetOperationLease{}, false, err
		}
		if affected, err := result.RowsAffected(); err != nil {
			return SetOperationLease{}, false, err
		} else if affected == 1 {
			if err := tx.Commit(); err != nil {
				return SetOperationLease{}, false, err
			}
			return SetOperationLease{SetID: setID, Operation: operation, Slot: slot, Owner: owner, LifecycleGeneration: generation, LeaseUntil: leaseUntil, UpdatedAt: now}, true, nil
		}

		result, err = tx.ExecContext(ctx, `
			UPDATE llmgateway_set_operation_leases
			SET owner = ?, lifecycle_generation = ?, lease_until = ?, updated_at = ?
			WHERE set_id = ? AND operation_name = ? AND slot_number = ?
			  AND (owner = '' OR owner = ? OR lease_until IS NULL OR lease_until <= ?)
		`, owner, generation, leaseUntil, now, setID, operation, slot, owner, now)
		if err != nil {
			return SetOperationLease{}, false, err
		}
		if affected, err := result.RowsAffected(); err != nil {
			return SetOperationLease{}, false, err
		} else if affected == 1 {
			if err := tx.Commit(); err != nil {
				return SetOperationLease{}, false, err
			}
			return SetOperationLease{SetID: setID, Operation: operation, Slot: slot, Owner: owner, LifecycleGeneration: generation, LeaseUntil: leaseUntil, UpdatedAt: now}, true, nil
		}
	}
	return SetOperationLease{}, false, nil
}

func (s *MySQLStore) RenewSetOperationLease(ctx context.Context, lease SetOperationLease, ttl time.Duration, now time.Time) (bool, error) {
	now = now.UTC()
	result, err := s.db.ExecContext(ctx, `
		UPDATE llmgateway_set_operation_leases leases
		JOIN llmgateway_sets managed_sets ON managed_sets.id = leases.set_id
		SET leases.lease_until = ?, leases.updated_at = ?
		WHERE leases.set_id = ? AND leases.operation_name = ? AND leases.slot_number = ? AND leases.owner = ?
			AND leases.lifecycle_generation = ?
			AND managed_sets.lifecycle_generation = ?
			AND managed_sets.status = 'active'
			AND managed_sets.setup = TRUE
			AND managed_sets.admin_user_id > 0
			AND managed_sets.admin_access_token <> ''
			AND managed_sets.admin_health_status <> 'unhealthy'
			AND (
				leases.operation_name = 'group_ratio_write'
				OR managed_sets.admission_status = 'passed'
				OR (
					managed_sets.admission_status NOT IN ('pending', 'failed')
					AND managed_sets.max_users <= 0 AND managed_sets.warn_users <= 0 AND managed_sets.reserved_users <= 0
				)
			)
	`, now.Add(ttl), now, lease.SetID, lease.Operation, lease.Slot, lease.Owner,
		lease.LifecycleGeneration, lease.LifecycleGeneration)
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	return affected == 1, err
}

func (s *MySQLStore) ReleaseSetOperationLease(ctx context.Context, lease SetOperationLease) (bool, error) {
	result, err := s.db.ExecContext(ctx, `
		UPDATE llmgateway_set_operation_leases
		SET owner = '', lease_until = NULL, updated_at = ?
		WHERE set_id = ? AND operation_name = ? AND slot_number = ? AND owner = ?
	`, time.Now().UTC(), lease.SetID, lease.Operation, lease.Slot, lease.Owner)
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	return affected == 1, err
}
