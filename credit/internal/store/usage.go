package store

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

func (s *MySQLStore) ListDueUsages(ctx context.Context, now time.Time, limit int) ([]*CreditPackageUsage, error) {
	if limit <= 0 || limit > 50 {
		limit = 50
	}
	rows, err := s.db.QueryContext(ctx, usageSelectSQL()+`
		 WHERE next_retry_time <= ? AND package_expired_time > ?
		 ORDER BY next_retry_time ASC, id ASC LIMIT ?`, now.UTC(), now.UTC(), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]*CreditPackageUsage, 0, limit)
	for rows.Next() {
		item, err := scanUsage(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *MySQLStore) TryClaimUsage(ctx context.Context, id int64, expectedNextRetry time.Time, owner string, leaseUntil, now time.Time) (bool, error) {
	result, err := s.db.ExecContext(ctx, `
		UPDATE credit_package_usage
		   SET push_status = ?, lease_owner = ?, next_retry_time = ?, updated_time = ?
		 WHERE id = ? AND next_retry_time = ?
		   AND next_retry_time <= ? AND package_expired_time > ?`,
		UsagePushStatusPending, owner, leaseUntil.UTC(), now.UTC(), id, expectedNextRetry.UTC(), now.UTC(), now.UTC())
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	return affected == 1, err
}

func (s *MySQLStore) SaveUsageSnapshot(ctx context.Context, id int64, owner string, update UsageSnapshotUpdate) error {
	result, err := s.db.ExecContext(ctx, `
		UPDATE credit_package_usage
		   SET usage_date = ?, calc_date = ?, credit_total = ?, credit_used_total = ?,
		       credit_used_day = ?, credit_left = ?, snapshot_time = ?, request_payload = ?, updated_time = ?
		 WHERE id = ? AND push_status = ? AND lease_owner = ?`,
		update.UsageDate, update.CalcDate, update.CreditTotal, update.CreditUsedTotal,
		update.CreditUsedDay, update.CreditLeft, update.SnapshotTime.UTC(), nullableJSON(update.RequestPayload), update.SnapshotTime.UTC(),
		id, UsagePushStatusPending, owner)
	if err != nil {
		return err
	}
	return requireOneUsageRow(result)
}

func (s *MySQLStore) MarkUsageSuccess(ctx context.Context, id int64, owner string, nextRetry time.Time, response []byte, now time.Time) error {
	result, err := s.db.ExecContext(ctx, `
		UPDATE credit_package_usage
		   SET push_status = ?, push_attempts = 0, next_retry_time = ?, lease_owner = '',
		       last_error = '', response_payload = ?, sent_time = ?, updated_time = ?
		 WHERE id = ? AND push_status = ? AND lease_owner = ?`,
		UsagePushStatusSuccess, nextRetry.UTC(), nullableJSON(response), now.UTC(), now.UTC(),
		id, UsagePushStatusPending, owner)
	if err != nil {
		return err
	}
	return requireOneUsageRow(result)
}

func (s *MySQLStore) MarkUsageBaseline(ctx context.Context, id int64, owner string, nextRetry, now time.Time) error {
	result, err := s.db.ExecContext(ctx, `
		UPDATE credit_package_usage
		   SET push_status = ?, push_attempts = 0, next_retry_time = ?, lease_owner = '',
		       last_error = '', request_payload = NULL, response_payload = NULL,
		       sent_time = NULL, updated_time = ?
		 WHERE id = ? AND push_status = ? AND lease_owner = ?`,
		UsagePushStatusSuccess, nextRetry.UTC(), now.UTC(), id, UsagePushStatusPending, owner)
	if err != nil {
		return err
	}
	return requireOneUsageRow(result)
}

func (s *MySQLStore) MarkUsageFailure(ctx context.Context, id int64, owner string, nextRetry time.Time, message string, now time.Time) error {
	result, err := s.db.ExecContext(ctx, `
		UPDATE credit_package_usage
		   SET push_status = ?, push_attempts = push_attempts + 1, next_retry_time = ?,
		       lease_owner = '', last_error = ?, updated_time = ?
		 WHERE id = ? AND push_status = ? AND lease_owner = ?`,
		UsagePushStatusFailed, nextRetry.UTC(), message, now.UTC(), id, UsagePushStatusPending, owner)
	if err != nil {
		return err
	}
	return requireOneUsageRow(result)
}

func requireOneUsageRow(result sql.Result) error {
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return fmt.Errorf("credit package usage ownership lost")
	}
	return nil
}

func usageSelectSQL() string {
	return `SELECT id, package_id, user_id, product_id, deal_name, uin, app_id,
		usage_date, calc_date, package_expired_time, credit_total, credit_used_total,
		credit_used_day, credit_left, snapshot_time, push_status, push_attempts,
		next_retry_time, lease_owner, last_error, request_payload, response_payload,
		sent_time, created_time, updated_time FROM credit_package_usage`
}

func scanUsage(row scanner) (*CreditPackageUsage, error) {
	var item CreditPackageUsage
	err := row.Scan(&item.ID, &item.PackageID, &item.UserID, &item.ProductID, &item.DealName, &item.Uin, &item.AppID,
		&item.UsageDate, &item.CalcDate, &item.PackageExpiredTime, &item.CreditTotal, &item.CreditUsedTotal,
		&item.CreditUsedDay, &item.CreditLeft, &item.SnapshotTime, &item.PushStatus, &item.PushAttempts,
		&item.NextRetryTime, &item.LeaseOwner, &item.LastError, &item.RequestPayload, &item.ResponsePayload,
		&item.SentTime, &item.CreatedTime, &item.UpdatedTime)
	return &item, err
}
