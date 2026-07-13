package service

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/shadowbinding"
)

func (s *MySQLStore) FindReusableRealnameFaceIDAttempt(ctx context.Context, userID string, identityHash string, phoneHash string, now time.Time) (RealnameFaceIDAttempt, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT attempt_id, user_id, state, COALESCE(name_ciphertext, ''), COALESCE(id_card_ciphertext, ''), COALESCE(name_masked, ''), COALESCE(id_card_masked, ''),
		       COALESCE(identity_hash, ''), COALESCE(current_phone_hash, ''), COALESCE(phone_verified_hash, ''), COALESCE(biz_token_ciphertext, ''), COALESCE(biz_token_hash, ''),
		       COALESCE(verify_url_ciphertext, ''), COALESCE(rule_id, ''), COALESCE(account_id, ''), COALESCE(provider_extra, ''), COALESCE(detect_auth_request_id, ''), COALESCE(last_get_info_request_id, ''),
		       face_verified_at, phone_verified_at, business_expires_at, COALESCE(lease_owner, ''), lease_until, lease_version, COALESCE(client_ip_ciphertext, ''), COALESCE(client_ua_ciphertext, ''), scrubbed_at, created_at, updated_at
		FROM realname_faceid_attempts
		WHERE user_id = ? AND identity_hash = ? AND current_phone_hash = ? AND scrubbed_at IS NULL
		  AND business_expires_at > ?
		  AND state IN (?, ?, ?, ?, ?)
		ORDER BY created_at DESC
		LIMIT 1
	`, userID, identityHash, phoneHash, now, RealnameFaceIDStatePending, RealnameFaceIDStateChecking, RealnameFaceIDStateFaceSucceeded, RealnameFaceIDStatePhonePending, RealnameFaceIDStateShadowPending)
	return scanRealnameFaceIDAttempt(row)
}

func (s *MySQLStore) FindCurrentRealnameFaceIDAttempt(ctx context.Context, userID string, now time.Time) (RealnameFaceIDAttempt, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT attempt_id, user_id, state, COALESCE(name_ciphertext, ''), COALESCE(id_card_ciphertext, ''), COALESCE(name_masked, ''), COALESCE(id_card_masked, ''),
		       COALESCE(identity_hash, ''), COALESCE(current_phone_hash, ''), COALESCE(phone_verified_hash, ''), COALESCE(biz_token_ciphertext, ''), COALESCE(biz_token_hash, ''),
		       COALESCE(verify_url_ciphertext, ''), COALESCE(rule_id, ''), COALESCE(account_id, ''), COALESCE(provider_extra, ''), COALESCE(detect_auth_request_id, ''), COALESCE(last_get_info_request_id, ''),
		       face_verified_at, phone_verified_at, business_expires_at, COALESCE(lease_owner, ''), lease_until, lease_version, COALESCE(client_ip_ciphertext, ''), COALESCE(client_ua_ciphertext, ''), scrubbed_at, created_at, updated_at
		FROM realname_faceid_attempts
		WHERE user_id = ? AND scrubbed_at IS NULL AND business_expires_at > ?
		  AND state IN (?, ?, ?, ?, ?)
		ORDER BY created_at DESC
		LIMIT 1
	`, strings.TrimSpace(userID), now, RealnameFaceIDStatePending, RealnameFaceIDStateChecking, RealnameFaceIDStateFaceSucceeded, RealnameFaceIDStatePhonePending, RealnameFaceIDStateShadowPending)
	return scanRealnameFaceIDAttempt(row)
}

func (s *MySQLStore) CountNewRealnameFaceIDAttempts(ctx context.Context, userID string, windowStart time.Time, windowEnd time.Time) (int, error) {
	var count int
	if err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(1)
		FROM realname_faceid_attempts
		WHERE user_id = ? AND created_at >= ? AND created_at < ?
	`, userID, windowStart, windowEnd).Scan(&count); err != nil {
		return 0, fmt.Errorf("count realname faceid attempts: %w", err)
	}
	return count, nil
}

func (s *MySQLStore) CreateRealnameFaceIDAttempt(ctx context.Context, attempt RealnameFaceIDAttempt) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO realname_faceid_attempts (
			attempt_id, user_id, state, name_ciphertext, id_card_ciphertext, name_masked, id_card_masked,
			identity_hash, current_phone_hash, phone_verified_hash, biz_token_ciphertext, biz_token_hash,
			verify_url_ciphertext, rule_id, account_id, provider_extra, detect_auth_request_id, last_get_info_request_id,
			face_verified_at, phone_verified_at, business_expires_at, lease_owner, lease_until, lease_version,
			client_ip_ciphertext, client_ua_ciphertext, scrubbed_at, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, attempt.AttemptID, attempt.UserID, attempt.State, nullableString(attempt.NameCiphertext), nullableString(attempt.IDCardCiphertext), nullableString(attempt.NameMasked), nullableString(attempt.IDCardMasked), nullableString(attempt.IdentityHash), nullableString(attempt.CurrentPhoneHash), nullableString(attempt.PhoneVerifiedHash), nullableString(attempt.BizTokenCiphertext), nullableString(attempt.BizTokenHash), nullableString(attempt.VerifyURLCiphertext), nullableString(attempt.RuleID), nullableString(attempt.AccountID), nullableString(attempt.ProviderExtra), nullableString(attempt.DetectAuthRequestID), nullableString(attempt.LastGetInfoRequestID), attempt.FaceVerifiedAt, attempt.PhoneVerifiedAt, attempt.BusinessExpiresAt, nullableString(attempt.LeaseOwner), attempt.LeaseUntil, attempt.LeaseVersion, nullableString(attempt.ClientIPCiphertext), nullableString(attempt.ClientUACiphertext), attempt.ScrubbedAt, attempt.CreatedAt, attempt.UpdatedAt)
	if err != nil {
		return fmt.Errorf("create realname faceid attempt: %w", err)
	}
	return nil
}

func (s *MySQLStore) ApplyRealnameFaceIDTransitionWithAudit(ctx context.Context, attempt RealnameFaceIDAttempt, expectedState string, expectedLeaseVersion int64, event RealnameFaceIDAuditEvent) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("begin realname faceid transition: %w", err)
	}
	defer rollback(tx)
	result, err := tx.ExecContext(ctx, `
		UPDATE realname_faceid_attempts
		SET state = ?, name_ciphertext = ?, id_card_ciphertext = ?, name_masked = ?, id_card_masked = ?,
		    identity_hash = ?, current_phone_hash = ?, phone_verified_hash = ?, biz_token_ciphertext = ?, biz_token_hash = ?,
		    verify_url_ciphertext = ?, rule_id = ?, account_id = ?, provider_extra = ?, detect_auth_request_id = ?, last_get_info_request_id = ?,
		    face_verified_at = ?, phone_verified_at = ?, business_expires_at = ?, lease_owner = ?, lease_until = ?, lease_version = ?,
		    client_ip_ciphertext = ?, client_ua_ciphertext = ?, scrubbed_at = ?, updated_at = ?
		WHERE attempt_id = ? AND state = ? AND lease_version = ? AND scrubbed_at IS NULL
	`, attempt.State, nullableString(attempt.NameCiphertext), nullableString(attempt.IDCardCiphertext), nullableString(attempt.NameMasked), nullableString(attempt.IDCardMasked), nullableString(attempt.IdentityHash), nullableString(attempt.CurrentPhoneHash), nullableString(attempt.PhoneVerifiedHash), nullableString(attempt.BizTokenCiphertext), nullableString(attempt.BizTokenHash), nullableString(attempt.VerifyURLCiphertext), nullableString(attempt.RuleID), nullableString(attempt.AccountID), nullableString(attempt.ProviderExtra), nullableString(attempt.DetectAuthRequestID), nullableString(attempt.LastGetInfoRequestID), attempt.FaceVerifiedAt, attempt.PhoneVerifiedAt, attempt.BusinessExpiresAt, nullableString(attempt.LeaseOwner), attempt.LeaseUntil, attempt.LeaseVersion, nullableString(attempt.ClientIPCiphertext), nullableString(attempt.ClientUACiphertext), attempt.ScrubbedAt, attempt.UpdatedAt, attempt.AttemptID, expectedState, expectedLeaseVersion)
	if err != nil {
		return false, fmt.Errorf("apply realname faceid transition: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("read realname faceid transition result: %w", err)
	}
	if rows == 0 {
		if err := tx.Commit(); err != nil {
			return false, fmt.Errorf("commit stale realname faceid transition: %w", err)
		}
		return false, nil
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO realname_faceid_audit_events (
			attempt_id, user_id, event_type, state, rule_id, account_id, request_id,
			identity_hash, phone_hash, biz_token_hash, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, nullableString(event.AttemptID), nullableString(event.UserID), event.EventType, nullableString(event.State),
		nullableString(event.RuleID), nullableString(event.AccountID), nullableString(event.RequestID),
		nullableString(event.IdentityHash), nullableString(event.PhoneHash), nullableString(event.BizTokenHash), event.CreatedAt); err != nil {
		return false, fmt.Errorf("insert realname faceid transition audit: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("commit realname faceid transition: %w", err)
	}
	return true, nil
}

func (s *MySQLStore) ApplyRealnameFaceIDReconcile(ctx context.Context, attempt RealnameFaceIDAttempt, expectedLeaseVersion int64, expectedLeaseOwner string) (bool, error) {
	result, err := s.db.ExecContext(ctx, `
		UPDATE realname_faceid_attempts
		SET state = ?, name_ciphertext = ?, id_card_ciphertext = ?, name_masked = ?, id_card_masked = ?,
		    identity_hash = ?, current_phone_hash = ?, phone_verified_hash = ?, biz_token_ciphertext = ?, biz_token_hash = ?,
		    verify_url_ciphertext = ?, rule_id = ?, account_id = ?, provider_extra = ?, detect_auth_request_id = ?, last_get_info_request_id = ?,
		    face_verified_at = ?, phone_verified_at = ?, business_expires_at = ?, lease_owner = ?, lease_until = ?,
		    client_ip_ciphertext = ?, client_ua_ciphertext = ?, scrubbed_at = ?, updated_at = ?
		WHERE attempt_id = ? AND lease_version = ? AND lease_owner = ?
	`, attempt.State, nullableString(attempt.NameCiphertext), nullableString(attempt.IDCardCiphertext), nullableString(attempt.NameMasked), nullableString(attempt.IDCardMasked), nullableString(attempt.IdentityHash), nullableString(attempt.CurrentPhoneHash), nullableString(attempt.PhoneVerifiedHash), nullableString(attempt.BizTokenCiphertext), nullableString(attempt.BizTokenHash), nullableString(attempt.VerifyURLCiphertext), nullableString(attempt.RuleID), nullableString(attempt.AccountID), nullableString(attempt.ProviderExtra), nullableString(attempt.DetectAuthRequestID), nullableString(attempt.LastGetInfoRequestID), attempt.FaceVerifiedAt, attempt.PhoneVerifiedAt, attempt.BusinessExpiresAt, nullableString(attempt.LeaseOwner), attempt.LeaseUntil, nullableString(attempt.ClientIPCiphertext), nullableString(attempt.ClientUACiphertext), attempt.ScrubbedAt, attempt.UpdatedAt, attempt.AttemptID, expectedLeaseVersion, strings.TrimSpace(expectedLeaseOwner))
	if err != nil {
		return false, fmt.Errorf("apply realname faceid reconcile: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("read realname faceid reconcile result: %w", err)
	}
	return rows == 1, nil
}

func (s *MySQLStore) GetRealnameFaceIDAttempt(ctx context.Context, attemptID string) (RealnameFaceIDAttempt, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT attempt_id, user_id, state, COALESCE(name_ciphertext, ''), COALESCE(id_card_ciphertext, ''), COALESCE(name_masked, ''), COALESCE(id_card_masked, ''),
		       COALESCE(identity_hash, ''), COALESCE(current_phone_hash, ''), COALESCE(phone_verified_hash, ''), COALESCE(biz_token_ciphertext, ''), COALESCE(biz_token_hash, ''),
		       COALESCE(verify_url_ciphertext, ''), COALESCE(rule_id, ''), COALESCE(account_id, ''), COALESCE(provider_extra, ''), COALESCE(detect_auth_request_id, ''), COALESCE(last_get_info_request_id, ''),
		       face_verified_at, phone_verified_at, business_expires_at, COALESCE(lease_owner, ''), lease_until, lease_version, COALESCE(client_ip_ciphertext, ''), COALESCE(client_ua_ciphertext, ''), scrubbed_at, created_at, updated_at
		FROM realname_faceid_attempts
		WHERE attempt_id = ?
	`, strings.TrimSpace(attemptID))
	return scanRealnameFaceIDAttempt(row)
}

func (s *MySQLStore) ClaimRealnameFaceIDAttempt(ctx context.Context, attemptID string, tokenHash string, owner string, leaseTTL time.Duration, now time.Time) (RealnameFaceIDAttempt, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return RealnameFaceIDAttempt{}, false, fmt.Errorf("begin claim realname faceid attempt: %w", err)
	}
	defer rollback(tx)

	query := `
		SELECT attempt_id, user_id, state, COALESCE(name_ciphertext, ''), COALESCE(id_card_ciphertext, ''), COALESCE(name_masked, ''), COALESCE(id_card_masked, ''),
		       COALESCE(identity_hash, ''), COALESCE(current_phone_hash, ''), COALESCE(phone_verified_hash, ''), COALESCE(biz_token_ciphertext, ''), COALESCE(biz_token_hash, ''),
		       COALESCE(verify_url_ciphertext, ''), COALESCE(rule_id, ''), COALESCE(account_id, ''), COALESCE(provider_extra, ''), COALESCE(detect_auth_request_id, ''), COALESCE(last_get_info_request_id, ''),
		       face_verified_at, phone_verified_at, business_expires_at, COALESCE(lease_owner, ''), lease_until, lease_version, COALESCE(client_ip_ciphertext, ''), COALESCE(client_ua_ciphertext, ''), scrubbed_at, created_at, updated_at
		FROM realname_faceid_attempts
		WHERE %s
		FOR UPDATE`
	condition := "attempt_id = ?"
	arg := any(strings.TrimSpace(attemptID))
	if strings.TrimSpace(attemptID) == "" {
		condition = "biz_token_hash = ?"
		arg = tokenHash
	}
	row := tx.QueryRowContext(ctx, fmt.Sprintf(query, condition), arg)
	attempt, err := scanRealnameFaceIDAttempt(row)
	if err != nil {
		return RealnameFaceIDAttempt{}, false, err
	}
	switch attempt.State {
	case RealnameFaceIDStatePending, RealnameFaceIDStateChecking:
	default:
		if err := tx.Commit(); err != nil {
			return RealnameFaceIDAttempt{}, false, fmt.Errorf("commit terminal realname faceid claim: %w", err)
		}
		return attempt, false, nil
	}
	if attempt.LeaseUntil != nil && attempt.LeaseUntil.After(now) && attempt.LeaseOwner != owner {
		if err := tx.Commit(); err != nil {
			return RealnameFaceIDAttempt{}, false, fmt.Errorf("commit busy realname faceid claim: %w", err)
		}
		return attempt, false, nil
	}
	leaseUntil := now.Add(leaseTTL)
	attempt.State = RealnameFaceIDStateChecking
	attempt.LeaseOwner = owner
	attempt.LeaseUntil = &leaseUntil
	attempt.LeaseVersion++
	attempt.UpdatedAt = now
	if _, err := tx.ExecContext(ctx, `
		UPDATE realname_faceid_attempts
		SET state = ?, lease_owner = ?, lease_until = ?, lease_version = ?, updated_at = ?
		WHERE attempt_id = ?
	`, attempt.State, nullableString(attempt.LeaseOwner), attempt.LeaseUntil, attempt.LeaseVersion, attempt.UpdatedAt, attempt.AttemptID); err != nil {
		return RealnameFaceIDAttempt{}, false, fmt.Errorf("update realname faceid lease: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return RealnameFaceIDAttempt{}, false, fmt.Errorf("commit realname faceid claim: %w", err)
	}
	return attempt, true, nil
}

func (s *MySQLStore) ListReconcileableRealnameFaceIDAttempts(ctx context.Context, now time.Time, limit int) ([]RealnameFaceIDAttempt, error) {
	if limit <= 0 {
		limit = 20
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT attempt_id, user_id, state, COALESCE(name_ciphertext, ''), COALESCE(id_card_ciphertext, ''), COALESCE(name_masked, ''), COALESCE(id_card_masked, ''),
		       COALESCE(identity_hash, ''), COALESCE(current_phone_hash, ''), COALESCE(phone_verified_hash, ''), COALESCE(biz_token_ciphertext, ''), COALESCE(biz_token_hash, ''),
		       COALESCE(verify_url_ciphertext, ''), COALESCE(rule_id, ''), COALESCE(account_id, ''), COALESCE(provider_extra, ''), COALESCE(detect_auth_request_id, ''), COALESCE(last_get_info_request_id, ''),
		       face_verified_at, phone_verified_at, business_expires_at, COALESCE(lease_owner, ''), lease_until, lease_version, COALESCE(client_ip_ciphertext, ''), COALESCE(client_ua_ciphertext, ''), scrubbed_at, created_at, updated_at
		FROM realname_faceid_attempts
		WHERE scrubbed_at IS NULL
		  AND biz_token_hash IS NOT NULL
		  AND state IN (?, ?)
		  AND (lease_until IS NULL OR lease_until <= ?)
		ORDER BY created_at ASC
		LIMIT ?
	`, RealnameFaceIDStatePending, RealnameFaceIDStateChecking, now, limit)
	if err != nil {
		return nil, fmt.Errorf("list reconcileable realname faceid attempts: %w", err)
	}
	defer rows.Close()

	var attempts []RealnameFaceIDAttempt
	for rows.Next() {
		attempt, err := scanRealnameFaceIDAttempt(rows)
		if err != nil {
			return nil, err
		}
		attempts = append(attempts, attempt)
	}
	return attempts, rows.Err()
}

func (s *MySQLStore) ExpireRealnameFaceIDAttempts(ctx context.Context, now time.Time, limit int) (int, error) {
	if limit <= 0 {
		limit = 20
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("begin faceid expiry sweep: %w", err)
	}
	defer rollback(tx)
	states := []any{
		RealnameFaceIDStateCreated, RealnameFaceIDStatePending, RealnameFaceIDStateChecking,
		RealnameFaceIDStateFaceSucceeded, RealnameFaceIDStatePhonePending, RealnameFaceIDStateShadowPending,
	}
	insertArgs := append([]any{RealnameFaceIDStateExpired, now}, states...)
	insertArgs = append(insertArgs, now, limit)
	res, err := tx.ExecContext(ctx, `
		INSERT INTO realname_faceid_audit_events (
			attempt_id, user_id, event_type, state, rule_id, account_id,
			request_id, identity_hash, phone_hash, biz_token_hash, created_at
		)
		SELECT attempt_id, user_id, 'attempt_expired', ?, rule_id, account_id,
		       last_get_info_request_id, identity_hash, COALESCE(phone_verified_hash, current_phone_hash), biz_token_hash, ?
		FROM realname_faceid_attempts
		WHERE scrubbed_at IS NULL AND state IN (?, ?, ?, ?, ?, ?) AND business_expires_at <= ?
		ORDER BY created_at ASC
		LIMIT ?
	`, insertArgs...)
	if err != nil {
		return 0, fmt.Errorf("insert faceid expiry audits: %w", err)
	}
	audited, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("read faceid expiry audit count: %w", err)
	}
	updateArgs := append([]any{RealnameFaceIDStateExpired, now, now}, states...)
	updateArgs = append(updateArgs, now, limit)
	res, err = tx.ExecContext(ctx, `
		UPDATE realname_faceid_attempts
		SET state = ?, name_ciphertext = NULL, id_card_ciphertext = NULL, biz_token_ciphertext = NULL,
		    verify_url_ciphertext = NULL, client_ip_ciphertext = NULL, client_ua_ciphertext = NULL,
		    lease_owner = NULL, lease_until = NULL, lease_version = lease_version + 1,
		    scrubbed_at = ?, updated_at = ?
		WHERE scrubbed_at IS NULL AND state IN (?, ?, ?, ?, ?, ?) AND business_expires_at <= ?
		ORDER BY created_at ASC
		LIMIT ?
	`, updateArgs...)
	if err != nil {
		return 0, fmt.Errorf("expire faceid attempts: %w", err)
	}
	updated, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("read faceid expiry count: %w", err)
	}
	if updated != audited {
		return 0, fmt.Errorf("faceid expiry audit mismatch: audited=%d updated=%d", audited, updated)
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit faceid expiry sweep: %w", err)
	}
	return int(updated), nil
}

func (s *MySQLStore) AppendRealnameFaceIDAuditEvent(ctx context.Context, event RealnameFaceIDAuditEvent) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO realname_faceid_audit_events (
			attempt_id, user_id, event_type, state, rule_id, account_id, request_id, identity_hash, phone_hash, biz_token_hash, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, nullableString(event.AttemptID), nullableString(event.UserID), event.EventType, nullableString(event.State), nullableString(event.RuleID), nullableString(event.AccountID), nullableString(event.RequestID), nullableString(event.IdentityHash), nullableString(event.PhoneHash), nullableString(event.BizTokenHash), event.CreatedAt)
	if err != nil {
		return fmt.Errorf("append realname faceid audit event: %w", err)
	}
	return nil
}

func (s *MySQLStore) ApplyRealnameFaceIDReconcileWithAudit(ctx context.Context, attempt RealnameFaceIDAttempt, expectedLeaseVersion int64, expectedLeaseOwner string, event RealnameFaceIDAuditEvent) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("begin realname faceid reconcile with audit: %w", err)
	}
	defer rollback(tx)
	res, err := tx.ExecContext(ctx, `
		UPDATE realname_faceid_attempts
		SET state = ?, name_ciphertext = ?, id_card_ciphertext = ?, name_masked = ?, id_card_masked = ?,
		    identity_hash = ?, current_phone_hash = ?, phone_verified_hash = ?, biz_token_ciphertext = ?, biz_token_hash = ?,
		    verify_url_ciphertext = ?, rule_id = ?, account_id = ?, provider_extra = ?, detect_auth_request_id = ?, last_get_info_request_id = ?,
		    face_verified_at = ?, phone_verified_at = ?, business_expires_at = ?, lease_owner = ?, lease_until = ?,
		    client_ip_ciphertext = ?, client_ua_ciphertext = ?, scrubbed_at = ?, updated_at = ?
		WHERE attempt_id = ? AND lease_version = ? AND lease_owner = ?
	`, attempt.State, nullableString(attempt.NameCiphertext), nullableString(attempt.IDCardCiphertext), nullableString(attempt.NameMasked), nullableString(attempt.IDCardMasked), nullableString(attempt.IdentityHash), nullableString(attempt.CurrentPhoneHash), nullableString(attempt.PhoneVerifiedHash), nullableString(attempt.BizTokenCiphertext), nullableString(attempt.BizTokenHash), nullableString(attempt.VerifyURLCiphertext), nullableString(attempt.RuleID), nullableString(attempt.AccountID), nullableString(attempt.ProviderExtra), nullableString(attempt.DetectAuthRequestID), nullableString(attempt.LastGetInfoRequestID), attempt.FaceVerifiedAt, attempt.PhoneVerifiedAt, attempt.BusinessExpiresAt, nullableString(attempt.LeaseOwner), attempt.LeaseUntil, nullableString(attempt.ClientIPCiphertext), nullableString(attempt.ClientUACiphertext), attempt.ScrubbedAt, attempt.UpdatedAt, attempt.AttemptID, expectedLeaseVersion, strings.TrimSpace(expectedLeaseOwner))
	if err != nil {
		return false, fmt.Errorf("apply realname faceid reconcile with audit: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("read realname faceid reconcile with audit result: %w", err)
	}
	if affected == 0 {
		if err := tx.Commit(); err != nil {
			return false, fmt.Errorf("commit stale realname faceid reconcile with audit: %w", err)
		}
		return false, nil
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO realname_faceid_audit_events (
			attempt_id, user_id, event_type, state, rule_id, account_id, request_id,
			identity_hash, phone_hash, biz_token_hash, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, nullableString(event.AttemptID), nullableString(event.UserID), event.EventType, nullableString(event.State),
		nullableString(event.RuleID), nullableString(event.AccountID), nullableString(event.RequestID),
		nullableString(event.IdentityHash), nullableString(event.PhoneHash), nullableString(event.BizTokenHash), event.CreatedAt); err != nil {
		return false, fmt.Errorf("insert realname faceid reconcile audit: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("commit realname faceid reconcile with audit: %w", err)
	}
	return true, nil
}

func (s *MySQLStore) ActivateRealnameFaceIDAttempt(ctx context.Context, userID string, attemptID string, currentPhone string, identityHash string, phoneHash string, faceVerifiedAt time.Time, phoneVerifiedAt time.Time, now time.Time) (User, RealnameFaceIDAttempt, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, RealnameFaceIDAttempt{}, fmt.Errorf("begin faceid activation: %w", err)
	}
	defer rollback(tx)

	attemptRow := tx.QueryRowContext(ctx, `
		SELECT attempt_id, user_id, state, COALESCE(name_ciphertext, ''), COALESCE(id_card_ciphertext, ''), COALESCE(name_masked, ''), COALESCE(id_card_masked, ''),
		       COALESCE(identity_hash, ''), COALESCE(current_phone_hash, ''), COALESCE(phone_verified_hash, ''), COALESCE(biz_token_ciphertext, ''), COALESCE(biz_token_hash, ''),
		       COALESCE(verify_url_ciphertext, ''), COALESCE(rule_id, ''), COALESCE(account_id, ''), COALESCE(provider_extra, ''), COALESCE(detect_auth_request_id, ''), COALESCE(last_get_info_request_id, ''),
		       face_verified_at, phone_verified_at, business_expires_at, COALESCE(lease_owner, ''), lease_until, lease_version, COALESCE(client_ip_ciphertext, ''), COALESCE(client_ua_ciphertext, ''), scrubbed_at, created_at, updated_at
		FROM realname_faceid_attempts
		WHERE attempt_id = ?
		FOR UPDATE
	`, attemptID)
	attempt, err := scanRealnameFaceIDAttempt(attemptRow)
	if err != nil {
		return User{}, RealnameFaceIDAttempt{}, err
	}
	if attempt.UserID != userID || attempt.State != RealnameFaceIDStateShadowPending || attempt.FaceVerifiedAt == nil || attempt.PhoneVerifiedAt == nil || attempt.IdentityHash != identityHash || attempt.PhoneVerifiedHash != phoneHash {
		return User{}, RealnameFaceIDAttempt{}, newError("realname_faceid_activation_invariant_failed", "实名认证状态不匹配，请重新认证。", http.StatusConflict)
	}
	var storedPhone string
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(phone, '') FROM users WHERE id = ? FOR UPDATE`, userID).Scan(&storedPhone); err != nil {
		return User{}, RealnameFaceIDAttempt{}, fmt.Errorf("lock faceid activation user: %w", err)
	}
	if normalizePhone(storedPhone) != normalizePhone(currentPhone) {
		return User{}, RealnameFaceIDAttempt{}, newError("realname_phone_mismatch", "当前手机号已变更，请重新开始实名认证。", http.StatusConflict)
	}
	var basicAuthStatus, sourceAttemptID, shadowIdentityHash, shadowPhoneHash string
	if err := tx.QueryRowContext(ctx, `
		SELECT COALESCE(basic_auth_status, ''), COALESCE(basic_auth_source_attempt_id, ''), COALESCE(basic_auth_identity_hash, ''), COALESCE(basic_auth_phone_hash, '')
		FROM shadow_bindings
		WHERE user_id = ?
		FOR UPDATE
	`, userID).Scan(&basicAuthStatus, &sourceAttemptID, &shadowIdentityHash, &shadowPhoneHash); err != nil {
		return User{}, RealnameFaceIDAttempt{}, fmt.Errorf("lock faceid activation shadow binding: %w", err)
	}
	if basicAuthStatus != shadowbinding.BasicAuthStatusSucceeded || sourceAttemptID != attemptID || shadowIdentityHash != identityHash || shadowPhoneHash != phoneHash {
		return User{}, RealnameFaceIDAttempt{}, newError("shadow_basic_auth_invariant_failed", "Lightvela 实名信息同步状态不匹配，请稍后重试。", http.StatusConflict)
	}

	if _, err := tx.ExecContext(ctx, `
		UPDATE users
		SET realname_verified_at = ?, realname_verify_provider = ?, realname_verify_result = ?, realname_request_id = ?,
		    realname_name_ciphertext = ?, realname_id_card_ciphertext = ?, realname_name_masked = ?, realname_id_card_masked = ?,
		    realname_level = ?, realname_final_attempt_id = ?, realname_face_verified_at = ?, realname_phone_verified_at = ?,
		    realname_identity_hash = ?, realname_phone_hash = ?, updated_at = ?
		WHERE id = ?
	`, now, "tencent_faceid", "0", nullableString(attempt.LastGetInfoRequestID),
		attempt.NameCiphertext, attempt.IDCardCiphertext, attempt.NameMasked, attempt.IDCardMasked,
		RealnameLevelPhone3FA, attemptID, faceVerifiedAt, phoneVerifiedAt, identityHash, phoneHash, now, userID); err != nil {
		return User{}, RealnameFaceIDAttempt{}, fmt.Errorf("update faceid final user projection: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO user_realname_history (
			user_id, realname_verified_at, realname_verify_provider, realname_verify_result,
			realname_request_id, realname_name_ciphertext, realname_id_card_ciphertext,
			realname_name_masked, realname_id_card_masked, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, userID, now, "tencent_faceid", "0", nullableString(attempt.LastGetInfoRequestID),
		attempt.NameCiphertext, attempt.IDCardCiphertext, attempt.NameMasked, attempt.IDCardMasked, now); err != nil {
		return User{}, RealnameFaceIDAttempt{}, fmt.Errorf("insert faceid realname history: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE realname_faceid_attempts
		SET state = ?, name_ciphertext = NULL, id_card_ciphertext = NULL, biz_token_ciphertext = NULL, verify_url_ciphertext = NULL, client_ip_ciphertext = NULL, client_ua_ciphertext = NULL, scrubbed_at = ?, updated_at = ?
		WHERE attempt_id = ?
	`, RealnameFaceIDStateSucceeded, now, now, attemptID); err != nil {
		return User{}, RealnameFaceIDAttempt{}, fmt.Errorf("mark faceid attempt succeeded: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO realname_faceid_audit_events (
			attempt_id, user_id, event_type, state, rule_id, account_id, request_id,
			identity_hash, phone_hash, biz_token_hash, created_at
		) VALUES (?, ?, 'activated', ?, ?, ?, ?, ?, ?, ?, ?)
	`, attempt.AttemptID, attempt.UserID, RealnameFaceIDStateSucceeded, nullableString(attempt.RuleID), nullableString(attempt.AccountID),
		nullableString(attempt.LastGetInfoRequestID), attempt.IdentityHash, attempt.PhoneVerifiedHash, nullableString(attempt.BizTokenHash), now); err != nil {
		return User{}, RealnameFaceIDAttempt{}, fmt.Errorf("insert faceid activation audit: %w", err)
	}
	row := tx.QueryRowContext(ctx, `
		SELECT `+mysqlUserSelectColumns("", s.contentAuditEnabled)+`
		FROM users
		WHERE id = ?
	`, userID)
	user, err := s.scanUserRow(row)
	if err != nil {
		return User{}, RealnameFaceIDAttempt{}, err
	}
	attemptRow = tx.QueryRowContext(ctx, `
		SELECT attempt_id, user_id, state, COALESCE(name_ciphertext, ''), COALESCE(id_card_ciphertext, ''), COALESCE(name_masked, ''), COALESCE(id_card_masked, ''),
		       COALESCE(identity_hash, ''), COALESCE(current_phone_hash, ''), COALESCE(phone_verified_hash, ''), COALESCE(biz_token_ciphertext, ''), COALESCE(biz_token_hash, ''),
		       COALESCE(verify_url_ciphertext, ''), COALESCE(rule_id, ''), COALESCE(account_id, ''), COALESCE(provider_extra, ''), COALESCE(detect_auth_request_id, ''), COALESCE(last_get_info_request_id, ''),
		       face_verified_at, phone_verified_at, business_expires_at, COALESCE(lease_owner, ''), lease_until, lease_version, COALESCE(client_ip_ciphertext, ''), COALESCE(client_ua_ciphertext, ''), scrubbed_at, created_at, updated_at
		FROM realname_faceid_attempts
		WHERE attempt_id = ?
	`, attemptID)
	attempt, err = scanRealnameFaceIDAttempt(attemptRow)
	if err != nil {
		return User{}, RealnameFaceIDAttempt{}, err
	}
	if err := tx.Commit(); err != nil {
		return User{}, RealnameFaceIDAttempt{}, fmt.Errorf("commit faceid activation: %w", err)
	}
	return user, attempt, nil
}

type scanRow interface {
	Scan(dest ...any) error
}

func scanRealnameFaceIDAttempt(row scanRow) (RealnameFaceIDAttempt, error) {
	var attempt RealnameFaceIDAttempt
	var faceVerifiedAt sql.NullTime
	var phoneVerifiedAt sql.NullTime
	var leaseUntil sql.NullTime
	var scrubbedAt sql.NullTime
	err := row.Scan(
		&attempt.AttemptID,
		&attempt.UserID,
		&attempt.State,
		&attempt.NameCiphertext,
		&attempt.IDCardCiphertext,
		&attempt.NameMasked,
		&attempt.IDCardMasked,
		&attempt.IdentityHash,
		&attempt.CurrentPhoneHash,
		&attempt.PhoneVerifiedHash,
		&attempt.BizTokenCiphertext,
		&attempt.BizTokenHash,
		&attempt.VerifyURLCiphertext,
		&attempt.RuleID,
		&attempt.AccountID,
		&attempt.ProviderExtra,
		&attempt.DetectAuthRequestID,
		&attempt.LastGetInfoRequestID,
		&faceVerifiedAt,
		&phoneVerifiedAt,
		&attempt.BusinessExpiresAt,
		&attempt.LeaseOwner,
		&leaseUntil,
		&attempt.LeaseVersion,
		&attempt.ClientIPCiphertext,
		&attempt.ClientUACiphertext,
		&scrubbedAt,
		&attempt.CreatedAt,
		&attempt.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return RealnameFaceIDAttempt{}, newError("realname_faceid_not_found", "实名认证尝试不存在。", http.StatusNotFound)
	}
	if err != nil {
		return RealnameFaceIDAttempt{}, fmt.Errorf("scan realname faceid attempt: %w", err)
	}
	if faceVerifiedAt.Valid {
		attempt.FaceVerifiedAt = &faceVerifiedAt.Time
	}
	if phoneVerifiedAt.Valid {
		attempt.PhoneVerifiedAt = &phoneVerifiedAt.Time
	}
	if leaseUntil.Valid {
		attempt.LeaseUntil = &leaseUntil.Time
	}
	if scrubbedAt.Valid {
		attempt.ScrubbedAt = &scrubbedAt.Time
	}
	return attempt, nil
}
