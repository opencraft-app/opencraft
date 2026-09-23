package service

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"
)

const developerTestAccountLeaseTransactionAttempts = 5

func (s *MySQLStore) AcquireDeveloperTestAccount(
	ctx context.Context,
	candidateUserIDs []string,
	leaseOwner string,
	targetIP string,
	now time.Time,
	ttl time.Duration,
	renewalUserID string,
) (DeveloperTestAccountLease, *AuthSession, error) {
	for attempt := 0; attempt < developerTestAccountLeaseTransactionAttempts; attempt++ {
		lease, session, err := s.acquireDeveloperTestAccountOnce(ctx, candidateUserIDs, leaseOwner, targetIP, now, ttl, renewalUserID)
		if err == nil || (!isMySQLDuplicate(err) && !isMySQLRetryableTransactionError(err)) {
			return lease, session, err
		}
		if attempt+1 < developerTestAccountLeaseTransactionAttempts {
			timer := time.NewTimer(time.Duration(attempt+1) * 5 * time.Millisecond)
			select {
			case <-ctx.Done():
				timer.Stop()
				return DeveloperTestAccountLease{}, nil, ctx.Err()
			case <-timer.C:
			}
		}
	}
	return DeveloperTestAccountLease{}, nil, newError("developer_test_account_busy", "testing 账号池当前已被占满。", http.StatusConflict)
}

func (s *MySQLStore) acquireDeveloperTestAccountOnce(
	ctx context.Context,
	candidateUserIDs []string,
	leaseOwner string,
	targetIP string,
	now time.Time,
	ttl time.Duration,
	renewalUserID string,
) (DeveloperTestAccountLease, *AuthSession, error) {
	candidates := append([]string(nil), candidateUserIDs...)
	sort.Strings(candidates)
	if len(candidates) == 0 {
		return DeveloperTestAccountLease{}, nil, newError("developer_test_account_unavailable", "没有可租用的 testing 账号。", http.StatusServiceUnavailable)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return DeveloperTestAccountLease{}, nil, fmt.Errorf("begin developer test account lease: %w", err)
	}
	defer rollback(tx)
	for _, userID := range candidates {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO developer_test_account_leases (user_id, created_at, updated_at)
			VALUES (?, ?, ?)
			ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)
		`, userID, now, now); err != nil {
			return DeveloperTestAccountLease{}, nil, fmt.Errorf("ensure developer test account lease row: %w", err)
		}
	}

	placeholders := strings.TrimRight(strings.Repeat("?,", len(candidates)), ",")
	owner := strings.TrimSpace(leaseOwner)
	renewalUserID = strings.TrimSpace(renewalUserID)
	lease, found, err := scanDeveloperTestAccountLease(tx.QueryRowContext(ctx, `
			SELECT user_id, COALESCE(lease_owner, ''), COALESCE(target_ip, ''), lease_until, lease_version
			FROM developer_test_account_leases
			WHERE lease_owner = ?
			ORDER BY user_id
			LIMIT 1
			FOR UPDATE
		`, owner))
	if err != nil {
		return DeveloperTestAccountLease{}, nil, err
	}
	if found {
		eligible := false
		for _, candidate := range candidates {
			if candidate == lease.UserID {
				eligible = true
				break
			}
		}
		if !eligible {
			return DeveloperTestAccountLease{}, nil, newError("developer_test_account_unavailable", "没有可租用的 testing 账号。", http.StatusServiceUnavailable)
		}
		if lease.LeaseUntil.After(now) {
			if renewalUserID == "" || renewalUserID != lease.UserID {
				return DeveloperTestAccountLease{}, nil, newError("developer_test_account_renewal_requires_session", "续租 testing 账号需要当前租约会话。", http.StatusUnauthorized)
			}
		} else if renewalUserID != "" {
			return DeveloperTestAccountLease{}, nil, newError("developer_test_account_lease_not_found", "测试账号租约不存在或已失效。", http.StatusConflict)
		}
	} else {
		if renewalUserID != "" {
			return DeveloperTestAccountLease{}, nil, newError("developer_test_account_lease_not_found", "测试账号租约不存在或已失效。", http.StatusConflict)
		}
		args := make([]any, 0, len(candidates)+1)
		for _, candidate := range candidates {
			args = append(args, candidate)
		}
		args = append(args, now)
		query := fmt.Sprintf(`
			SELECT user_id, COALESCE(lease_owner, ''), COALESCE(target_ip, ''), lease_until, lease_version
			FROM developer_test_account_leases
			WHERE user_id IN (%s) AND (lease_until IS NULL OR lease_until <= ?)
			ORDER BY updated_at, user_id
			LIMIT 1
			FOR UPDATE SKIP LOCKED
		`, placeholders)
		lease, found, err = scanDeveloperTestAccountLease(tx.QueryRowContext(ctx, query, args...))
		if err != nil {
			return DeveloperTestAccountLease{}, nil, err
		}
	}
	if !found {
		return DeveloperTestAccountLease{}, nil, newError("developer_test_account_busy", "testing 账号池当前已被占满。", http.StatusConflict)
	}

	lease.LeaseOwner = strings.TrimSpace(leaseOwner)
	lease.TargetIP = strings.TrimSpace(targetIP)
	lease.LeaseUntil = now.Add(ttl)
	lease.LeaseVersion++
	if _, err := tx.ExecContext(ctx, `
		UPDATE developer_test_account_leases
		SET lease_owner = ?, target_ip = ?, lease_until = ?, lease_version = ?, updated_at = ?
		WHERE user_id = ?
	`, lease.LeaseOwner, lease.TargetIP, lease.LeaseUntil, lease.LeaseVersion, now, lease.UserID); err != nil {
		return DeveloperTestAccountLease{}, nil, fmt.Errorf("update developer test account lease: %w", err)
	}
	user, err := s.loadUserByIDTx(ctx, tx, lease.UserID)
	if err != nil {
		return DeveloperTestAccountLease{}, nil, err
	}
	session, err := createSessionWithMetadataTx(ctx, tx, user, now, ttl, false, "", AuthMethodDeveloperLease)
	if err != nil {
		return DeveloperTestAccountLease{}, nil, err
	}
	if err := tx.Commit(); err != nil {
		return DeveloperTestAccountLease{}, nil, fmt.Errorf("commit developer test account lease: %w", err)
	}
	return lease, session, nil
}

func (s *MySQLStore) ReleaseDeveloperTestAccount(ctx context.Context, userID string, leaseOwner string, now time.Time) (DeveloperTestAccountLease, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return DeveloperTestAccountLease{}, fmt.Errorf("begin developer test account release: %w", err)
	}
	defer rollback(tx)
	lease, found, err := scanDeveloperTestAccountLease(tx.QueryRowContext(ctx, `
		SELECT user_id, COALESCE(lease_owner, ''), COALESCE(target_ip, ''), lease_until, lease_version
		FROM developer_test_account_leases
		WHERE user_id = ?
		FOR UPDATE
	`, strings.TrimSpace(userID)))
	if err != nil {
		return DeveloperTestAccountLease{}, err
	}
	if !found || lease.LeaseOwner != strings.TrimSpace(leaseOwner) || !lease.LeaseUntil.After(now) {
		return DeveloperTestAccountLease{}, newError("developer_test_account_lease_not_found", "测试账号租约不存在或已失效。", http.StatusConflict)
	}
	lease.LeaseOwner = ""
	lease.TargetIP = ""
	lease.LeaseUntil = now
	lease.LeaseVersion++
	if _, err := tx.ExecContext(ctx, `
		UPDATE developer_test_account_leases
		SET lease_owner = NULL, target_ip = NULL, lease_until = ?, lease_version = ?, updated_at = ?
		WHERE user_id = ?
	`, now, lease.LeaseVersion, now, lease.UserID); err != nil {
		return DeveloperTestAccountLease{}, fmt.Errorf("release developer test account lease: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM auth_sessions
		WHERE user_id = ? AND auth_method = ?
	`, lease.UserID, AuthMethodDeveloperLease); err != nil {
		return DeveloperTestAccountLease{}, fmt.Errorf("revoke developer test account sessions: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return DeveloperTestAccountLease{}, fmt.Errorf("commit developer test account release: %w", err)
	}
	return lease, nil
}

func scanDeveloperTestAccountLease(row *sql.Row) (DeveloperTestAccountLease, bool, error) {
	var lease DeveloperTestAccountLease
	var leaseUntil sql.NullTime
	if err := row.Scan(&lease.UserID, &lease.LeaseOwner, &lease.TargetIP, &leaseUntil, &lease.LeaseVersion); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return DeveloperTestAccountLease{}, false, nil
		}
		return DeveloperTestAccountLease{}, false, fmt.Errorf("scan developer test account lease: %w", err)
	}
	if leaseUntil.Valid {
		lease.LeaseUntil = leaseUntil.Time
	}
	return lease, true, nil
}
