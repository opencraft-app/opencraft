package service

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
	"golang.org/x/crypto/bcrypt"
)

type MySQLStore struct {
	db                  *sql.DB
	contentAuditEnabled bool
}

func NewMySQLStore(dsn string, opts StoreOptions) (*MySQLStore, error) {
	normalizedDSN, err := normalizeMySQLDSN(dsn)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open("mysql", normalizedDSN)
	if err != nil {
		return nil, fmt.Errorf("open mysql: %w", err)
	}
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping mysql: %w", err)
	}

	store := &MySQLStore{db: db, contentAuditEnabled: opts.ContentAuditEnabled}
	if opts.SeedDefaultInvites {
		if err := store.seedDefaultInvites(opts.Now); err != nil {
			_ = db.Close()
			return nil, err
		}
	}
	if opts.SeedDemoUser {
		if err := store.seedDemoUser(opts.Now); err != nil {
			_ = db.Close()
			return nil, err
		}
	}
	return store, nil
}

type sqlScanner interface {
	Scan(dest ...any) error
}

func mysqlUserSelectColumns(prefix string, includeAudit bool) string {
	columns := []string{
		prefix + "id",
		prefix + "name",
	}
	if includeAudit {
		columns = append(columns,
			prefix+"pending_name",
			prefix+"name_audit_status",
			prefix+"pending_avatar_object_key",
			prefix+"pending_avatar_source",
			prefix+"avatar_audit_status",
		)
	}
	columns = append(columns,
		prefix+"email",
		prefix+"email_verified",
		prefix+"phone",
		prefix+"avatar_object_key",
		prefix+"avatar_source",
		prefix+"invite_required",
		prefix+"realname_verified_at",
		prefix+"realname_level",
		prefix+"realname_final_attempt_id",
		prefix+"realname_face_verified_at",
		prefix+"realname_phone_verified_at",
		prefix+"realname_identity_hash",
		prefix+"realname_phone_hash",
		prefix+"created_at",
		prefix+"updated_at",
	)
	return strings.Join(columns, ",\n\t\t\t")
}

func mysqlUserScanDest(user *User, includeAudit bool, pendingName *sql.NullString, nameAuditStatus *sql.NullString, pendingAvatarObjectKey *sql.NullString, pendingAvatarSource *sql.NullString, avatarAuditStatus *sql.NullString, emailValue *sql.NullString, emailVerified *sql.NullBool, phoneValue *sql.NullString, avatarObjectKey *sql.NullString, avatarSource *sql.NullString, realnameVerifiedAt *sql.NullTime, realnameLevel *sql.NullString, realnameFinalAttemptID *sql.NullString, realnameFaceVerifiedAt *sql.NullTime, realnamePhoneVerifiedAt *sql.NullTime, realnameIdentityHash *sql.NullString, realnamePhoneHash *sql.NullString) []any {
	dest := []any{&user.ID, &user.Name}
	if includeAudit {
		dest = append(dest, pendingName, nameAuditStatus, pendingAvatarObjectKey, pendingAvatarSource, avatarAuditStatus)
	}
	dest = append(dest,
		emailValue,
		emailVerified,
		phoneValue,
		avatarObjectKey,
		avatarSource,
		&user.InviteRequired,
		realnameVerifiedAt,
		realnameLevel,
		realnameFinalAttemptID,
		realnameFaceVerifiedAt,
		realnamePhoneVerifiedAt,
		realnameIdentityHash,
		realnamePhoneHash,
		&user.CreatedAt,
		&user.UpdatedAt,
	)
	return dest
}

func applyMySQLUserFields(user *User, includeAudit bool, pendingName sql.NullString, nameAuditStatus sql.NullString, pendingAvatarObjectKey sql.NullString, pendingAvatarSource sql.NullString, avatarAuditStatus sql.NullString, emailValue sql.NullString, emailVerified sql.NullBool, phoneValue sql.NullString, avatarObjectKey sql.NullString, avatarSource sql.NullString, realnameVerifiedAt sql.NullTime, realnameLevel sql.NullString, realnameFinalAttemptID sql.NullString, realnameFaceVerifiedAt sql.NullTime, realnamePhoneVerifiedAt sql.NullTime, realnameIdentityHash sql.NullString, realnamePhoneHash sql.NullString) {
	user.Email = emailValue.String
	user.EmailVerified = emailVerified.Valid && emailVerified.Bool
	if includeAudit {
		user.PendingName = pendingName.String
		user.NameAuditStatus = nameAuditStatus.String
		user.PendingAvatarObjectKey = pendingAvatarObjectKey.String
		user.PendingAvatarSource = pendingAvatarSource.String
		user.AvatarAuditStatus = avatarAuditStatus.String
	}
	user.Phone = phoneValue.String
	user.AvatarObjectKey = avatarObjectKey.String
	user.AvatarSource = avatarSource.String
	user.RealnameVerified = realnameVerifiedAt.Valid || isAtLeastRealnameLevel(realnameLevel.String, RealnameLevelIDCard2FA)
	user.RealnameLevel = normalizeRealnameLevel(realnameLevel.String, user.RealnameVerified)
	if realnameVerifiedAt.Valid {
		user.realnameVerifiedAt = &realnameVerifiedAt.Time
	} else {
		user.realnameVerifiedAt = nil
	}
	user.realnameFinalAttemptID = realnameFinalAttemptID.String
	if realnameFaceVerifiedAt.Valid {
		user.realnameFaceVerifiedAt = &realnameFaceVerifiedAt.Time
	} else {
		user.realnameFaceVerifiedAt = nil
	}
	if realnamePhoneVerifiedAt.Valid {
		user.realnamePhoneVerifiedAt = &realnamePhoneVerifiedAt.Time
	} else {
		user.realnamePhoneVerifiedAt = nil
	}
	user.realnameIdentityHash = realnameIdentityHash.String
	user.realnamePhoneHash = realnamePhoneHash.String
}

func (s *MySQLStore) scanUserRow(row sqlScanner) (User, error) {
	var user User
	var pendingName sql.NullString
	var nameAuditStatus sql.NullString
	var pendingAvatarObjectKey sql.NullString
	var pendingAvatarSource sql.NullString
	var avatarAuditStatus sql.NullString
	var emailValue sql.NullString
	var emailVerified sql.NullBool
	var phoneValue sql.NullString
	var avatarObjectKey sql.NullString
	var avatarSource sql.NullString
	var realnameVerifiedAt sql.NullTime
	var realnameLevel sql.NullString
	var realnameFinalAttemptID sql.NullString
	var realnameFaceVerifiedAt sql.NullTime
	var realnamePhoneVerifiedAt sql.NullTime
	var realnameIdentityHash sql.NullString
	var realnamePhoneHash sql.NullString
	if err := row.Scan(mysqlUserScanDest(&user, s.contentAuditEnabled, &pendingName, &nameAuditStatus, &pendingAvatarObjectKey, &pendingAvatarSource, &avatarAuditStatus, &emailValue, &emailVerified, &phoneValue, &avatarObjectKey, &avatarSource, &realnameVerifiedAt, &realnameLevel, &realnameFinalAttemptID, &realnameFaceVerifiedAt, &realnamePhoneVerifiedAt, &realnameIdentityHash, &realnamePhoneHash)...); err != nil {
		return User{}, err
	}
	applyMySQLUserFields(&user, s.contentAuditEnabled, pendingName, nameAuditStatus, pendingAvatarObjectKey, pendingAvatarSource, avatarAuditStatus, emailValue, emailVerified, phoneValue, avatarObjectKey, avatarSource, realnameVerifiedAt, realnameLevel, realnameFinalAttemptID, realnameFaceVerifiedAt, realnamePhoneVerifiedAt, realnameIdentityHash, realnamePhoneHash)
	return user, nil
}

func (s *MySQLStore) requireContentAuditEnabled() error {
	if !s.contentAuditEnabled {
		return newError("content_audit_disabled", "内容安全审核未启用。", 400)
	}
	return nil
}

func (s *MySQLStore) ValidateInvite(ctx context.Context, code string) (InviteValidation, error) {
	return InviteValidation{Code: strings.TrimSpace(code), State: "valid", Message: "邀请码校验已关闭。"}, nil
}

func (s *MySQLStore) FindUserByPhone(ctx context.Context, phone string) (User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)

	user, err := s.loadUserByPhoneTx(ctx, tx, phone)
	if err != nil {
		return User{}, err
	}
	if err := tx.Commit(); err != nil {
		return User{}, fmt.Errorf("commit find user by phone: %w", err)
	}
	return user, nil
}

func (s *MySQLStore) SendVerificationCode(ctx context.Context, phone string, code string, now time.Time, ttl time.Duration, cooldown time.Duration) (time.Duration, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)

	var cooldownUntil time.Time
	err = tx.QueryRowContext(ctx, `
		SELECT cooldown_until
		FROM sms_challenges
		WHERE phone = ?
		FOR UPDATE
	`, phone).Scan(&cooldownUntil)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, fmt.Errorf("query sms challenge: %w", err)
	}
	if err == nil && cooldownUntil.After(now) {
		return 0, &Error{
			Code:       "sms_cooldown",
			Message:    "验证码发送过于频繁，请稍后再试。",
			Status:     429,
			RetryAfter: cooldownUntil.Sub(now),
		}
	}

	_, err = tx.ExecContext(ctx, `
		INSERT INTO sms_challenges (
			phone,
			code,
			expires_at,
			cooldown_until,
			remaining_retries,
			created_at,
			updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			code = VALUES(code),
			expires_at = VALUES(expires_at),
			cooldown_until = VALUES(cooldown_until),
			remaining_retries = VALUES(remaining_retries),
			updated_at = VALUES(updated_at)
	`, phone, code, now.Add(ttl), now.Add(cooldown), 5, now, now)
	if err != nil {
		return 0, fmt.Errorf("upsert sms challenge: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit sms challenge: %w", err)
	}
	return cooldown, nil
}

func (s *MySQLStore) CompleteSMSVerification(ctx context.Context, input VerifySMSInput, now time.Time, sessionTTL time.Duration) (*AuthSession, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)

	if err := consumeSMSChallengeTx(ctx, tx, input.Phone, input.Code, now); err != nil {
		return nil, err
	}

	user, created, err := s.findOrCreatePhoneUserTx(ctx, tx, input.Phone, strings.TrimSpace(input.Name), now, true)
	if err != nil {
		return nil, err
	}
	if created {
		user.InviteRequired = false
	}
	session, err := createSessionTx(ctx, tx, user, now, sessionTTL, AuthMethodSMS)
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit sms verification: %w", err)
	}
	return session, nil
}

func (s *MySQLStore) FindOrCreatePhoneAuthUser(ctx context.Context, phone string, name string, now time.Time) (User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)

	user, _, err := s.findOrCreatePhoneUserTx(ctx, tx, phone, strings.TrimSpace(name), now, false)
	if err != nil {
		return User{}, err
	}
	if err := tx.Commit(); err != nil {
		return User{}, fmt.Errorf("commit phone auth user: %w", err)
	}
	return user, nil
}

func (s *MySQLStore) SendPhoneAuthChallenge(ctx context.Context, challenge PhoneAuthChallenge, now time.Time, ttl time.Duration, cooldown time.Duration) (time.Duration, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)

	var cooldownUntil time.Time
	err = tx.QueryRowContext(ctx, `
		SELECT cooldown_until
		FROM phone_auth_challenges
		WHERE phone = ?
		FOR UPDATE
	`, challenge.Phone).Scan(&cooldownUntil)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, fmt.Errorf("query phone auth challenge: %w", err)
	}
	if err == nil && cooldownUntil.After(now) {
		return 0, &Error{
			Code:       "sms_cooldown",
			Message:    "验证码发送过于频繁，请稍后再试。",
			Status:     http.StatusTooManyRequests,
			RetryAfter: cooldownUntil.Sub(now),
		}
	}

	_, err = tx.ExecContext(ctx, `
		INSERT INTO phone_auth_challenges (
			phone,
			user_id,
			flow,
			code_hash,
			expires_at,
			cooldown_until,
			remaining_retries,
			created_at,
			updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			user_id = VALUES(user_id),
			flow = VALUES(flow),
			code_hash = VALUES(code_hash),
			expires_at = VALUES(expires_at),
			cooldown_until = VALUES(cooldown_until),
			remaining_retries = VALUES(remaining_retries),
			updated_at = VALUES(updated_at)
	`, challenge.Phone, nullableString(challenge.UserID), challenge.Flow, nullableString(challenge.CodeHash), now.Add(ttl), now.Add(cooldown), 5, now, now)
	if err != nil {
		return 0, fmt.Errorf("upsert phone auth challenge: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit phone auth challenge: %w", err)
	}
	return cooldown, nil
}

func (s *MySQLStore) GetPhoneAuthChallenge(ctx context.Context, phone string) (PhoneAuthChallenge, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT phone, COALESCE(user_id, ''), flow, COALESCE(code_hash, ''), expires_at, cooldown_until, remaining_retries, created_at, updated_at
		FROM phone_auth_challenges
		WHERE phone = ?
	`, phone)
	return scanPhoneAuthChallenge(row, "get phone auth challenge")
}

func (s *MySQLStore) ConsumePhoneAuthChallengePreview(ctx context.Context, phone string, now time.Time) (PhoneAuthChallenge, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return PhoneAuthChallenge{}, fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)
	challenge, err := validatePhoneAuthChallengeTx(ctx, tx, phone, now)
	if err != nil {
		return PhoneAuthChallenge{}, err
	}
	if err := tx.Commit(); err != nil {
		return PhoneAuthChallenge{}, fmt.Errorf("commit preview phone auth challenge: %w", err)
	}
	return challenge, nil
}

func (s *MySQLStore) VerifyAndConsumePhoneAuthChallenge(ctx context.Context, phone string, code string, now time.Time) (PhoneAuthChallenge, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return PhoneAuthChallenge{}, fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)
	challenge, err := verifyPhoneAuthChallengeTx(ctx, tx, phone, code, now)
	if err != nil {
		return PhoneAuthChallenge{}, err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM phone_auth_challenges WHERE phone = ?`, phone); err != nil {
		return PhoneAuthChallenge{}, fmt.Errorf("delete phone auth challenge: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return PhoneAuthChallenge{}, fmt.Errorf("commit consume phone auth challenge: %w", err)
	}
	return challenge, nil
}

func (s *MySQLStore) ConsumePhoneAuthChallenge(ctx context.Context, phone string, now time.Time) (PhoneAuthChallenge, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return PhoneAuthChallenge{}, fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)
	challenge, err := validatePhoneAuthChallengeTx(ctx, tx, phone, now)
	if err != nil {
		return PhoneAuthChallenge{}, err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM phone_auth_challenges WHERE phone = ?`, phone); err != nil {
		return PhoneAuthChallenge{}, fmt.Errorf("delete phone auth challenge: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return PhoneAuthChallenge{}, fmt.Errorf("commit consume phone auth challenge: %w", err)
	}
	return challenge, nil
}

func (s *MySQLStore) FailPhoneAuthChallenge(ctx context.Context, phone string, now time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)

	challenge, err := validatePhoneAuthChallengeTx(ctx, tx, phone, now)
	if err != nil {
		return nil
	}
	challenge.RemainingRetries--
	if challenge.RemainingRetries <= 0 {
		if _, err := tx.ExecContext(ctx, `DELETE FROM phone_auth_challenges WHERE phone = ?`, phone); err != nil {
			return fmt.Errorf("delete exhausted phone auth challenge: %w", err)
		}
	} else {
		if _, err := tx.ExecContext(ctx, `
			UPDATE phone_auth_challenges
			SET remaining_retries = ?, updated_at = ?
			WHERE phone = ?
		`, challenge.RemainingRetries, now, phone); err != nil {
			return fmt.Errorf("update phone auth retries: %w", err)
		}
	}
	return tx.Commit()
}

func (s *MySQLStore) DeletePhoneAuthChallenge(ctx context.Context, phone string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM phone_auth_challenges WHERE phone = ?`, phone)
	if err != nil {
		return fmt.Errorf("delete phone auth challenge: %w", err)
	}
	return nil
}

func (s *MySQLStore) VerifyCurrentUserPhoneChallenge(ctx context.Context, token string, code string, now time.Time) (User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)

	userID, err := currentSessionUserIDTx(ctx, tx, strings.TrimSpace(token), now)
	if err != nil {
		return User{}, err
	}
	user, err := s.loadUserByIDTx(ctx, tx, userID)
	if err != nil {
		return User{}, err
	}
	if user.Phone == "" {
		return User{}, newError("phone_required", "当前账号未绑定手机号。", http.StatusBadRequest)
	}
	if err := validateSMSChallengeTx(ctx, tx, user.Phone, code, now); err != nil {
		return User{}, err
	}
	if err := consumeSMSChallengeTx(ctx, tx, user.Phone, code, now); err != nil {
		return User{}, err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE users
		SET realname_level = ?, updated_at = ?
		WHERE id = ?
	`, RealnameLevelPhone3FA, now, user.ID); err != nil {
		return User{}, fmt.Errorf("update realname level: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return User{}, fmt.Errorf("commit phone realname verification: %w", err)
	}
	user.RealnameLevel = RealnameLevelPhone3FA
	user.RealnameVerified = true
	return user, nil
}

func (s *MySQLStore) ConsumeCurrentUserPhoneChallenge(ctx context.Context, token string, code string, now time.Time) (User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)

	userID, err := currentSessionUserIDTx(ctx, tx, strings.TrimSpace(token), now)
	if err != nil {
		return User{}, err
	}
	user, err := s.loadUserByIDTx(ctx, tx, userID)
	if err != nil {
		return User{}, err
	}
	if strings.TrimSpace(user.Phone) == "" {
		return User{}, newError("phone_required", "当前账号未绑定手机号。", http.StatusBadRequest)
	}
	if err := consumeSMSChallengeTx(ctx, tx, user.Phone, code, now); err != nil {
		return User{}, err
	}
	if err := tx.Commit(); err != nil {
		return User{}, fmt.Errorf("commit phone challenge consumption: %w", err)
	}
	return user, nil
}

func (s *MySQLStore) MarkCurrentUserPhoneRealnameVerified(ctx context.Context, token string, now time.Time) (User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)
	user, err := s.currentUserWithPhoneRealnamePrerequisitesTx(ctx, tx, token, now)
	if err != nil {
		return User{}, err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE users
		SET realname_verified_at = ?, realname_level = ?, updated_at = ?
		WHERE id = ?
	`, now, RealnameLevelPhone3FA, now, user.ID); err != nil {
		return User{}, fmt.Errorf("update realname level: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return User{}, fmt.Errorf("commit phone realname verification: %w", err)
	}
	user.RealnameLevel = RealnameLevelPhone3FA
	user.RealnameVerified = true
	user.UpdatedAt = now
	return user, nil
}

func (s *MySQLStore) ValidateCurrentUserPhoneChallenge(ctx context.Context, token string, code string, now time.Time) (User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)
	user, err := s.validateCurrentUserPhoneChallengeTx(ctx, tx, token, code, now)
	if err != nil {
		return User{}, err
	}
	if err := tx.Commit(); err != nil {
		return User{}, fmt.Errorf("commit phone realname precheck: %w", err)
	}
	return user, nil
}

func (s *MySQLStore) ValidatePhoneChange(ctx context.Context, token string, newPhone string, code string, now time.Time) (User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)
	user, err := s.validatePhoneChangeTx(ctx, tx, token, newPhone, code, now)
	if err != nil {
		return User{}, err
	}
	if err := tx.Commit(); err != nil {
		return User{}, fmt.Errorf("commit phone change precheck: %w", err)
	}
	return user, nil
}

func (s *MySQLStore) ValidatePhoneChangeTarget(ctx context.Context, token string, newPhone string, now time.Time) (User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)
	user, err := s.validatePhoneChangeTargetTx(ctx, tx, token, newPhone, now)
	if err != nil {
		return User{}, err
	}
	if err := tx.Commit(); err != nil {
		return User{}, fmt.Errorf("commit phone change target validation: %w", err)
	}
	return user, nil
}

func (s *MySQLStore) UpdateCurrentUserPhone(ctx context.Context, token string, newPhone string, now time.Time) (User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)
	user, err := s.validatePhoneChangeTargetTx(ctx, tx, token, newPhone, now)
	if err != nil {
		return User{}, err
	}
	if err := revokeActiveRealnameFaceIDAttemptsTx(ctx, tx, user.ID, now); err != nil {
		return User{}, err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE users
			SET phone = ?, realname_final_attempt_id = NULL, realname_face_verified_at = NULL,
			    realname_phone_verified_at = NULL, realname_identity_hash = NULL, realname_phone_hash = NULL,
			    updated_at = ?
		WHERE id = ?
	`, newPhone, now, user.ID); err != nil {
		if isMySQLDuplicate(err) {
			return User{}, newError("phone_in_use", "该手机号已绑定其他账号。", http.StatusConflict)
		}
		return User{}, fmt.Errorf("update user phone: %w", err)
	}
	user, err = s.loadUserByIDTx(ctx, tx, user.ID)
	if err != nil {
		return User{}, err
	}
	if err := tx.Commit(); err != nil {
		return User{}, fmt.Errorf("commit external phone change: %w", err)
	}
	return user, nil
}

func (s *MySQLStore) CompletePhoneChange(ctx context.Context, token string, newPhone string, code string, now time.Time) (User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)
	user, err := s.validatePhoneChangeTx(ctx, tx, token, newPhone, code, now)
	if err != nil {
		return User{}, err
	}
	if err := consumeSMSChallengeTx(ctx, tx, newPhone, code, now); err != nil {
		return User{}, err
	}
	if err := revokeActiveRealnameFaceIDAttemptsTx(ctx, tx, user.ID, now); err != nil {
		return User{}, err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE users
			SET phone = ?, realname_final_attempt_id = NULL, realname_face_verified_at = NULL,
			    realname_phone_verified_at = NULL, realname_identity_hash = NULL, realname_phone_hash = NULL,
			    updated_at = ?
		WHERE id = ?
	`, newPhone, now, user.ID); err != nil {
		if isMySQLDuplicate(err) {
			return User{}, newError("phone_in_use", "该手机号已绑定其他账号。", http.StatusConflict)
		}
		return User{}, fmt.Errorf("update user phone: %w", err)
	}
	user, err = s.loadUserByIDTx(ctx, tx, user.ID)
	if err != nil {
		return User{}, err
	}
	if err := tx.Commit(); err != nil {
		return User{}, fmt.Errorf("commit phone change: %w", err)
	}
	return user, nil
}

func (s *MySQLStore) CreatePasswordSession(ctx context.Context, input PasswordSignUpInput, passwordHash []byte, now time.Time, sessionTTL time.Duration) (*AuthSession, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)

	userID, err := newPrefixedID("usr")
	if err != nil {
		return nil, fmt.Errorf("generate user id: %w", err)
	}
	user := User{
		ID:             userID,
		Name:           strings.TrimSpace(input.Name),
		Email:          input.Email,
		EmailVerified:  true,
		InviteRequired: false,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO users (
			id,
			name,
			email,
			email_verified,
			phone,
			invite_required,
			created_at,
			updated_at
		) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
	`, user.ID, user.Name, user.Email, true, false, now, now)
	if err != nil {
		if isMySQLDuplicate(err) {
			return nil, newError("email_in_use", "该邮箱已注册，请直接登录。", 409)
		}
		return nil, fmt.Errorf("insert user: %w", err)
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO password_credentials (
			user_id,
			password_hash,
			created_at,
			updated_at
		) VALUES (?, ?, ?, ?)
	`, user.ID, passwordHash, now, now); err != nil {
		return nil, fmt.Errorf("insert password credential: %w", err)
	}
	session, err := createSessionTx(ctx, tx, user, now, sessionTTL, AuthMethodPassword)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit password signup: %w", err)
	}
	return session, nil
}

func (s *MySQLStore) GetPasswordUser(ctx context.Context, email string) (User, []byte, error) {
	row := s.db.QueryRowContext(ctx, fmt.Sprintf(`
		SELECT
			%s,
			pc.password_hash
		FROM users u
		INNER JOIN password_credentials pc ON pc.user_id = u.id
		WHERE u.email = ?
	`, mysqlUserSelectColumns("u.", s.contentAuditEnabled)), email)

	var user User
	var pendingName sql.NullString
	var nameAuditStatus sql.NullString
	var pendingAvatarObjectKey sql.NullString
	var pendingAvatarSource sql.NullString
	var avatarAuditStatus sql.NullString
	var emailValue sql.NullString
	var emailVerified sql.NullBool
	var phoneValue sql.NullString
	var avatarObjectKey sql.NullString
	var avatarSource sql.NullString
	var realnameVerifiedAt sql.NullTime
	var realnameLevel sql.NullString
	var realnameFinalAttemptID sql.NullString
	var realnameFaceVerifiedAt sql.NullTime
	var realnamePhoneVerifiedAt sql.NullTime
	var realnameIdentityHash sql.NullString
	var realnamePhoneHash sql.NullString
	var hash []byte
	dest := mysqlUserScanDest(&user, s.contentAuditEnabled, &pendingName, &nameAuditStatus, &pendingAvatarObjectKey, &pendingAvatarSource, &avatarAuditStatus, &emailValue, &emailVerified, &phoneValue, &avatarObjectKey, &avatarSource, &realnameVerifiedAt, &realnameLevel, &realnameFinalAttemptID, &realnameFaceVerifiedAt, &realnamePhoneVerifiedAt, &realnameIdentityHash, &realnamePhoneHash)
	dest = append(dest, &hash)
	if err := row.Scan(dest...); errors.Is(err, sql.ErrNoRows) {
		return User{}, nil, newError("invalid_credentials", "账号或密码不正确。", 401)
	} else if err != nil {
		return User{}, nil, fmt.Errorf("query password user: %w", err)
	}
	applyMySQLUserFields(&user, s.contentAuditEnabled, pendingName, nameAuditStatus, pendingAvatarObjectKey, pendingAvatarSource, avatarAuditStatus, emailValue, emailVerified, phoneValue, avatarObjectKey, avatarSource, realnameVerifiedAt, realnameLevel, realnameFinalAttemptID, realnameFaceVerifiedAt, realnamePhoneVerifiedAt, realnameIdentityHash, realnamePhoneHash)
	return user, hash, nil
}

func (s *MySQLStore) CreateOAuthSession(ctx context.Context, input OAuthSignInInput, now time.Time, sessionTTL time.Duration) (*AuthSession, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)

	user, created, err := s.findOrCreateOAuthUserTx(ctx, tx, input, now)
	if err != nil {
		return nil, err
	}
	if created {
		user.InviteRequired = false
	}

	session, err := createSessionTx(ctx, tx, user, now, sessionTTL, AuthMethodOAuth)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit oauth session: %w", err)
	}
	return session, nil
}

func (s *MySQLStore) ActivateInviteForCurrentUser(ctx context.Context, token string, code string, now time.Time) (User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)

	userID, err := currentSessionUserIDTx(ctx, tx, strings.TrimSpace(token), now)
	if err != nil {
		return User{}, err
	}
	user, err := s.loadUserByIDTx(ctx, tx, userID)
	if err != nil {
		return User{}, err
	}
	if user.InviteRequired {
		if _, err := tx.ExecContext(ctx, `
			UPDATE users
			SET invite_required = ?, updated_at = ?
			WHERE id = ?
		`, false, now, user.ID); err != nil {
			return User{}, fmt.Errorf("update invite_required: %w", err)
		}
		user.InviteRequired = false
	}
	if err := tx.Commit(); err != nil {
		return User{}, fmt.Errorf("commit invite activation: %w", err)
	}
	return user, nil
}

func (s *MySQLStore) BindOAuthSession(ctx context.Context, token string, input OAuthSignInInput, now time.Time, sessionTTL time.Duration) (*AuthSession, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)

	userID, err := currentSessionUserIDTx(ctx, tx, strings.TrimSpace(token), now)
	if err != nil {
		return nil, err
	}
	user, err := s.loadUserByIDTx(ctx, tx, userID)
	if err != nil {
		return nil, err
	}

	var existingUserID string
	err = tx.QueryRowContext(ctx, `
		SELECT user_id
		FROM oauth_identities
		WHERE provider = ? AND provider_subject = ?
		FOR UPDATE
	`, input.Provider, input.ProviderSubject).Scan(&existingUserID)
	switch {
	case err == nil:
		if existingUserID != user.ID {
			return nil, newError("oauth_identity_conflict", "第三方账号绑定冲突，请稍后重试。", 409)
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE oauth_identities
			SET email = ?, email_verified = ?, name = ?, avatar_url = ?, updated_at = ?
			WHERE provider = ? AND provider_subject = ?
		`, nullableString(input.Email), input.EmailVerified, nullableString(input.Name), nullableString(input.AvatarURL), now, input.Provider, input.ProviderSubject); err != nil {
			return nil, fmt.Errorf("update oauth identity: %w", err)
		}
	case errors.Is(err, sql.ErrNoRows):
		identityID, identityErr := newPrefixedID("oid")
		if identityErr != nil {
			return nil, fmt.Errorf("generate oauth identity id: %w", identityErr)
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO oauth_identities (
				id,
				user_id,
				provider,
				provider_subject,
				email,
				email_verified,
				name,
				avatar_url,
				created_at,
				updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, identityID, user.ID, input.Provider, input.ProviderSubject, nullableString(input.Email), input.EmailVerified, nullableString(input.Name), nullableString(input.AvatarURL), now, now); err != nil {
			if isMySQLDuplicate(err) {
				return nil, newError("oauth_identity_conflict", "第三方账号绑定冲突，请稍后重试。", 409)
			}
			return nil, fmt.Errorf("insert oauth identity: %w", err)
		}
	default:
		return nil, fmt.Errorf("query oauth identity: %w", err)
	}

	session, err := createSessionTx(ctx, tx, user, now, sessionTTL, AuthMethodOAuth)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit oauth bind: %w", err)
	}
	return session, nil
}

func (s *MySQLStore) CreateSession(ctx context.Context, user User, now time.Time, sessionTTL time.Duration) (*AuthSession, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)

	session, err := createSessionTx(ctx, tx, user, now, sessionTTL, AuthMethodUnknown)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit create session: %w", err)
	}
	return session, nil
}

func (s *MySQLStore) CreateImpersonationSession(ctx context.Context, user User, reason string, now time.Time, sessionTTL time.Duration) (*AuthSession, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)

	session, err := createImpersonationSessionTx(ctx, tx, user, strings.TrimSpace(reason), now, sessionTTL)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit create impersonation session: %w", err)
	}
	return session, nil
}

func (s *MySQLStore) CurrentSession(ctx context.Context, token string, now time.Time) (*AuthSession, error) {
	row := s.db.QueryRowContext(ctx, fmt.Sprintf(`
		SELECT
			s.token,
			s.authenticated_at,
			s.expires_at,
			s.impersonated,
			s.impersonation_reason,
			s.auth_method,
			%s
		FROM auth_sessions s
		INNER JOIN users u ON u.id = s.user_id
		WHERE s.token = ?
	`, mysqlUserSelectColumns("u.", s.contentAuditEnabled)), strings.TrimSpace(token))

	var sessionToken string
	var authenticatedAt time.Time
	var expiresAt time.Time
	var impersonated bool
	var impersonationReason sql.NullString
	var authMethod sql.NullString
	var user User
	var pendingName sql.NullString
	var nameAuditStatus sql.NullString
	var pendingAvatarObjectKey sql.NullString
	var pendingAvatarSource sql.NullString
	var avatarAuditStatus sql.NullString
	var emailValue sql.NullString
	var emailVerified sql.NullBool
	var phoneValue sql.NullString
	var avatarObjectKey sql.NullString
	var avatarSource sql.NullString
	var realnameVerifiedAt sql.NullTime
	var realnameLevel sql.NullString
	var realnameFinalAttemptID sql.NullString
	var realnameFaceVerifiedAt sql.NullTime
	var realnamePhoneVerifiedAt sql.NullTime
	var realnameIdentityHash sql.NullString
	var realnamePhoneHash sql.NullString

	dest := []any{
		&sessionToken,
		&authenticatedAt,
		&expiresAt,
		&impersonated,
		&impersonationReason,
		&authMethod,
	}
	dest = append(dest, mysqlUserScanDest(&user, s.contentAuditEnabled, &pendingName, &nameAuditStatus, &pendingAvatarObjectKey, &pendingAvatarSource, &avatarAuditStatus, &emailValue, &emailVerified, &phoneValue, &avatarObjectKey, &avatarSource, &realnameVerifiedAt, &realnameLevel, &realnameFinalAttemptID, &realnameFaceVerifiedAt, &realnamePhoneVerifiedAt, &realnameIdentityHash, &realnamePhoneHash)...)
	err := row.Scan(dest...)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, newError("unauthorized", "未登录或登录已失效。", 401)
	}
	if err != nil {
		return nil, fmt.Errorf("query session: %w", err)
	}
	if expiresAt.Before(now) {
		if _, deleteErr := s.db.ExecContext(ctx, `DELETE FROM auth_sessions WHERE token = ?`, sessionToken); deleteErr != nil {
			return nil, fmt.Errorf("delete expired session: %w", deleteErr)
		}
		return nil, newError("session_expired", "登录已过期，请重新登录。", 401)
	}

	applyMySQLUserFields(&user, s.contentAuditEnabled, pendingName, nameAuditStatus, pendingAvatarObjectKey, pendingAvatarSource, avatarAuditStatus, emailValue, emailVerified, phoneValue, avatarObjectKey, avatarSource, realnameVerifiedAt, realnameLevel, realnameFinalAttemptID, realnameFaceVerifiedAt, realnamePhoneVerifiedAt, realnameIdentityHash, realnamePhoneHash)
	resolvedAuthMethod := AuthMethodUnknown
	if authMethod.Valid && strings.TrimSpace(authMethod.String) != "" {
		resolvedAuthMethod = strings.TrimSpace(authMethod.String)
	}
	session := &AuthSession{
		Token:               sessionToken,
		User:                user,
		AuthenticatedAt:     authenticatedAt,
		ExpiresAt:           expiresAt,
		Impersonated:        impersonated,
		ImpersonationReason: impersonationReason.String,
		AuthMethod:          resolvedAuthMethod,
	}
	return session, nil
}

func (s *MySQLStore) CurrentProfile(ctx context.Context, token string, now time.Time) (User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)

	userID, err := currentSessionUserIDTx(ctx, tx, strings.TrimSpace(token), now)
	if err != nil {
		return User{}, err
	}
	user, err := s.loadUserByIDTx(ctx, tx, userID)
	if err != nil {
		return User{}, err
	}
	if err := tx.Commit(); err != nil {
		return User{}, fmt.Errorf("commit current profile: %w", err)
	}
	return user, nil
}

func (s *MySQLStore) FindUserByID(ctx context.Context, userID string) (User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)

	user, err := s.loadUserByIDTx(ctx, tx, strings.TrimSpace(userID))
	if err != nil {
		return User{}, err
	}
	if err := tx.Commit(); err != nil {
		return User{}, fmt.Errorf("commit find user by id: %w", err)
	}
	return user, nil
}

func (s *MySQLStore) UpdateRealname(ctx context.Context, token string, input UpdateRealnameInput) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)

	userID, err := currentSessionUserIDTx(ctx, tx, strings.TrimSpace(token), input.VerifiedAt)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE users
		SET
			realname_verified_at = ?,
			realname_verify_provider = ?,
			realname_verify_result = ?,
			realname_request_id = ?,
			realname_name_ciphertext = ?,
			realname_id_card_ciphertext = ?,
			realname_name_masked = ?,
			realname_id_card_masked = ?,
			realname_level = ?,
			updated_at = ?
		WHERE id = ?
	`, input.VerifiedAt, input.Provider, input.Result, nullableString(input.RequestID), input.NameCiphertext, input.IDCardCiphertext, input.NameMasked, input.IDCardMasked, RealnameLevelIDCard2FA, input.VerifiedAt, userID); err != nil {
		return fmt.Errorf("update realname: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO user_realname_history (
			user_id,
			realname_verified_at,
			realname_verify_provider,
			realname_verify_result,
			realname_request_id,
			realname_name_ciphertext,
			realname_id_card_ciphertext,
			realname_name_masked,
			realname_id_card_masked,
			created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, userID, input.VerifiedAt, input.Provider, input.Result, nullableString(input.RequestID), input.NameCiphertext, input.IDCardCiphertext, input.NameMasked, input.IDCardMasked, input.VerifiedAt); err != nil {
		return fmt.Errorf("insert realname history: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit realname update: %w", err)
	}
	return nil
}

func (s *MySQLStore) GetUserRealname(ctx context.Context, userID string) (StoredRealname, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return StoredRealname{}, fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)

	var nameCiphertext sql.NullString
	var idCardCiphertext sql.NullString
	err = tx.QueryRowContext(ctx, `
		SELECT
			realname_name_ciphertext,
			realname_id_card_ciphertext
		FROM users
		WHERE id = ?
		FOR UPDATE
	`, strings.TrimSpace(userID)).Scan(&nameCiphertext, &idCardCiphertext)
	if errors.Is(err, sql.ErrNoRows) {
		return StoredRealname{}, newError("realname_not_found", "用户尚未完成实名认证。", http.StatusNotFound)
	}
	if err != nil {
		return StoredRealname{}, fmt.Errorf("query user realname: %w", err)
	}
	if !nameCiphertext.Valid || strings.TrimSpace(nameCiphertext.String) == "" || !idCardCiphertext.Valid || strings.TrimSpace(idCardCiphertext.String) == "" {
		return StoredRealname{}, newError("realname_incomplete", "实名认证信息不完整。", http.StatusConflict)
	}

	if err := tx.Commit(); err != nil {
		return StoredRealname{}, fmt.Errorf("commit get user realname: %w", err)
	}
	return StoredRealname{
		NameCiphertext:   nameCiphertext.String,
		IDCardCiphertext: idCardCiphertext.String,
	}, nil
}

func (s *MySQLStore) UpdateProfile(ctx context.Context, token string, name string, now time.Time) (User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)

	userID, err := currentSessionUserIDTx(ctx, tx, strings.TrimSpace(token), now)
	if err != nil {
		return User{}, err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE users
		SET name = ?, pending_name = NULL, name_audit_status = NULL, updated_at = ?
		WHERE id = ?
	`, strings.TrimSpace(name), now, userID); err != nil {
		return User{}, fmt.Errorf("update profile: %w", err)
	}
	user, err := s.loadUserByIDTx(ctx, tx, userID)
	if err != nil {
		return User{}, err
	}
	if err := tx.Commit(); err != nil {
		return User{}, fmt.Errorf("commit profile update: %w", err)
	}
	return user, nil
}

func (s *MySQLStore) QueueNameAudit(ctx context.Context, token string, input CreateNameAuditInput, now time.Time) (User, error) {
	if err := s.requireContentAuditEnabled(); err != nil {
		return User{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)

	userID, err := currentSessionUserIDTx(ctx, tx, strings.TrimSpace(token), now)
	if err != nil {
		return User{}, err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE content_audit_tasks
		SET status = 'cancelled', updated_at = ?
		WHERE biz_type = ? AND biz_id = ? AND status IN ('pending', 'submitted', 'error')
	`, now, contentauditBizTypeUserName, userID); err != nil {
		return User{}, fmt.Errorf("cancel previous name audit tasks: %w", err)
	}
	name := strings.TrimSpace(input.Name)
	if _, err := tx.ExecContext(ctx, `
		UPDATE users
		SET pending_name = ?, name_audit_status = 'pending', updated_at = ?
		WHERE id = ?
	`, name, now, userID); err != nil {
		return User{}, fmt.Errorf("queue pending name: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO content_audit_tasks (
			biz_type, biz_id, biz_detail, product_id, sid, content_digest, content_text,
			media_type, status, created_at, updated_at
		) VALUES (?, ?, 'name', ?, ?, ?, ?, ?, 'pending', ?, ?)
	`, contentauditBizTypeUserName, userID, strings.TrimSpace(input.ProductID), strings.TrimSpace(input.SID), truncateString(name, 200), name, contentauditMediaTypeText, now, now); err != nil {
		return User{}, fmt.Errorf("create name audit task: %w", err)
	}
	user, err := s.loadUserByIDTx(ctx, tx, userID)
	if err != nil {
		return User{}, err
	}
	if err := tx.Commit(); err != nil {
		return User{}, fmt.Errorf("commit name audit queue: %w", err)
	}
	return user, nil
}

func (s *MySQLStore) QueueAvatarAudit(ctx context.Context, userID string, input CreateAvatarAuditInput, now time.Time) (User, error) {
	if err := s.requireContentAuditEnabled(); err != nil {
		return User{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)

	trimmedUserID := strings.TrimSpace(userID)
	if _, err := tx.ExecContext(ctx, `
		UPDATE content_audit_tasks
		SET status = 'cancelled', updated_at = ?
		WHERE biz_type = ? AND biz_id = ? AND status IN ('pending', 'submitted', 'error')
	`, now, contentauditBizTypeUserAvatar, trimmedUserID); err != nil {
		return User{}, fmt.Errorf("cancel previous avatar audit tasks: %w", err)
	}
	objectKey := strings.TrimSpace(input.ObjectKey)
	source := strings.TrimSpace(input.Source)
	contentURL := strings.TrimSpace(input.ContentURL)
	if _, err := tx.ExecContext(ctx, `
		UPDATE users
		SET pending_avatar_object_key = ?, pending_avatar_source = ?, avatar_audit_status = 'pending', updated_at = ?
		WHERE id = ?
	`, objectKey, source, now, trimmedUserID); err != nil {
		return User{}, fmt.Errorf("queue pending avatar: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO content_audit_tasks (
			biz_type, biz_id, biz_detail, product_id, sid, content_digest, content_text,
			content_url, media_type, status, created_at, updated_at
		) VALUES (?, ?, 'avatar', ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
	`, contentauditBizTypeUserAvatar, trimmedUserID, strings.TrimSpace(input.ProductID), strings.TrimSpace(input.SID), truncateString(objectKey, 200), objectKey, contentURL, contentauditMediaTypeImage, now, now); err != nil {
		return User{}, fmt.Errorf("create avatar audit task: %w", err)
	}
	user, err := s.loadUserByIDTx(ctx, tx, trimmedUserID)
	if err != nil {
		return User{}, err
	}
	if err := tx.Commit(); err != nil {
		return User{}, fmt.Errorf("commit avatar audit queue: %w", err)
	}
	return user, nil
}

func (s *MySQLStore) ListPendingContentAuditTasks(ctx context.Context, limit int) ([]ContentAuditTask, error) {
	if err := s.requireContentAuditEnabled(); err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 20
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, biz_type, biz_id, COALESCE(biz_detail, ''), product_id, sid,
		       COALESCE(content_text, ''), COALESCE(content_url, ''), COALESCE(media_type, 'text'),
		       status, COALESCE(request_id, ''),
		       COALESCE(result_code, 0), COALESCE(result_type, 0), attempts,
		       COALESCE(last_error, ''), submitted_at, created_at, updated_at
		FROM content_audit_tasks
		WHERE status IN ('pending', 'error') AND attempts < 3
		ORDER BY created_at ASC
		LIMIT ?
	`, limit)
	if err != nil {
		return nil, fmt.Errorf("list pending content audit tasks: %w", err)
	}
	defer rows.Close()
	return scanContentAuditTasks(rows)
}

func (s *MySQLStore) ListTimeoutContentAuditTasks(ctx context.Context, cutoff time.Time, limit int) ([]ContentAuditTask, error) {
	if err := s.requireContentAuditEnabled(); err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, biz_type, biz_id, COALESCE(biz_detail, ''), product_id, sid,
		       COALESCE(content_text, ''), COALESCE(content_url, ''), COALESCE(media_type, 'text'),
		       status, COALESCE(request_id, ''),
		       COALESCE(result_code, 0), COALESCE(result_type, 0), attempts,
		       COALESCE(last_error, ''), submitted_at, created_at, updated_at
		FROM content_audit_tasks
		WHERE status = 'submitted' AND submitted_at IS NOT NULL AND submitted_at < ?
		ORDER BY submitted_at ASC
		LIMIT ?
	`, cutoff, limit)
	if err != nil {
		return nil, fmt.Errorf("list timeout content audit tasks: %w", err)
	}
	defer rows.Close()
	return scanContentAuditTasks(rows)
}

func (s *MySQLStore) FindContentAuditTaskByRequestID(ctx context.Context, requestID string) (*ContentAuditTask, error) {
	if err := s.requireContentAuditEnabled(); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, biz_type, biz_id, COALESCE(biz_detail, ''), product_id, sid,
		       COALESCE(content_text, ''), COALESCE(content_url, ''), COALESCE(media_type, 'text'),
		       status, COALESCE(request_id, ''),
		       COALESCE(result_code, 0), COALESCE(result_type, 0), attempts,
		       COALESCE(last_error, ''), submitted_at, created_at, updated_at
		FROM content_audit_tasks
		WHERE request_id = ?
		LIMIT 1
	`, strings.TrimSpace(requestID))
	if err != nil {
		return nil, fmt.Errorf("find content audit task: %w", err)
	}
	defer rows.Close()
	tasks, err := scanContentAuditTasks(rows)
	if err != nil {
		return nil, err
	}
	if len(tasks) == 0 {
		return nil, nil
	}
	return &tasks[0], nil
}

func (s *MySQLStore) MarkContentAuditTaskSubmitted(ctx context.Context, taskID int64, requestID string, now time.Time) error {
	if err := s.requireContentAuditEnabled(); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE content_audit_tasks
		SET status = 'submitted', request_id = ?, attempts = attempts + 1,
		    last_error = NULL, submitted_at = ?, updated_at = ?
		WHERE id = ?
	`, strings.TrimSpace(requestID), now, now, taskID)
	if err != nil {
		return fmt.Errorf("mark content audit submitted: %w", err)
	}
	return nil
}

func (s *MySQLStore) MarkContentAuditTaskPassed(ctx context.Context, taskID int64, requestID string, passSource string, now time.Time) error {
	return s.finishContentAuditTask(ctx, taskID, func(tx *sql.Tx, task ContentAuditTask) error {
		if _, err := tx.ExecContext(ctx, `
			UPDATE content_audit_tasks
			SET status = 'passed', request_id = COALESCE(NULLIF(?, ''), request_id),
			    result_code = 2, pass_source = ?, audited_at = ?, updated_at = ?
			WHERE id = ? AND status IN ('pending', 'submitted', 'error')
		`, strings.TrimSpace(requestID), strings.TrimSpace(passSource), now, now, taskID); err != nil {
			return fmt.Errorf("mark content audit passed: %w", err)
		}
		if task.BizType == contentauditBizTypeUserName {
			if _, err := tx.ExecContext(ctx, `
				UPDATE users
				SET name = ?, pending_name = NULL, name_audit_status = 'passed', updated_at = ?
				WHERE id = ? AND pending_name = ?
			`, task.ContentText, now, task.BizID, task.ContentText); err != nil {
				return fmt.Errorf("apply passed name audit: %w", err)
			}
		} else if task.BizType == contentauditBizTypeUserAvatar {
			if _, err := tx.ExecContext(ctx, `
				UPDATE users
				SET avatar_object_key = pending_avatar_object_key,
				    avatar_source = pending_avatar_source,
				    pending_avatar_object_key = NULL,
				    pending_avatar_source = NULL,
				    avatar_audit_status = 'passed',
				    updated_at = ?
				WHERE id = ? AND pending_avatar_object_key = ?
			`, now, task.BizID, task.ContentText); err != nil {
				return fmt.Errorf("apply passed avatar audit: %w", err)
			}
		}
		return nil
	})
}

func (s *MySQLStore) MarkContentAuditTaskFailed(ctx context.Context, taskID int64, requestID string, resultCode int, resultType int, resultDetail string, now time.Time) error {
	return s.finishContentAuditTask(ctx, taskID, func(tx *sql.Tx, task ContentAuditTask) error {
		if _, err := tx.ExecContext(ctx, `
			UPDATE content_audit_tasks
			SET status = 'failed', request_id = COALESCE(NULLIF(?, ''), request_id),
			    result_code = ?, result_type = ?, result_detail = ?, audited_at = ?, updated_at = ?
			WHERE id = ? AND status IN ('pending', 'submitted', 'error')
		`, strings.TrimSpace(requestID), resultCode, resultType, truncateString(resultDetail, 512), now, now, taskID); err != nil {
			return fmt.Errorf("mark content audit failed: %w", err)
		}
		if task.BizType == contentauditBizTypeUserName {
			if _, err := tx.ExecContext(ctx, `
				UPDATE users
				SET pending_name = NULL, name_audit_status = 'failed', updated_at = ?
				WHERE id = ? AND pending_name = ?
			`, now, task.BizID, task.ContentText); err != nil {
				return fmt.Errorf("apply failed name audit: %w", err)
			}
		} else if task.BizType == contentauditBizTypeUserAvatar {
			if _, err := tx.ExecContext(ctx, `
				UPDATE users
				SET pending_avatar_object_key = NULL,
				    pending_avatar_source = NULL,
				    avatar_audit_status = 'failed',
				    updated_at = ?
				WHERE id = ? AND pending_avatar_object_key = ?
			`, now, task.BizID, task.ContentText); err != nil {
				return fmt.Errorf("apply failed avatar audit: %w", err)
			}
		}
		return nil
	})
}

func (s *MySQLStore) MarkContentAuditTaskError(ctx context.Context, taskID int64, errMsg string, now time.Time) error {
	if err := s.requireContentAuditEnabled(); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE content_audit_tasks
		SET status = 'error', attempts = attempts + 1, last_error = ?, updated_at = ?
		WHERE id = ?
	`, truncateString(errMsg, 512), now, taskID)
	if err != nil {
		return fmt.Errorf("mark content audit error: %w", err)
	}
	return nil
}

func (s *MySQLStore) SetUserAvatar(ctx context.Context, userID string, objectKey string, source string, now time.Time) (User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)

	if _, err := tx.ExecContext(ctx, `
		UPDATE users
		SET avatar_object_key = ?, avatar_source = ?,
		    pending_avatar_object_key = NULL, pending_avatar_source = NULL, avatar_audit_status = NULL,
		    updated_at = ?
		WHERE id = ?
	`, strings.TrimSpace(objectKey), strings.TrimSpace(source), now, strings.TrimSpace(userID)); err != nil {
		return User{}, fmt.Errorf("update user avatar: %w", err)
	}
	user, err := s.loadUserByIDTx(ctx, tx, strings.TrimSpace(userID))
	if err != nil {
		return User{}, err
	}
	if err := tx.Commit(); err != nil {
		return User{}, fmt.Errorf("commit avatar update: %w", err)
	}
	return user, nil
}

func (s *MySQLStore) CurrentSubscription(ctx context.Context, token string, now time.Time) (*PlanSelection, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)

	userID, err := currentSessionUserIDTx(ctx, tx, strings.TrimSpace(token), now)
	if err != nil {
		return nil, err
	}

	plan, err := loadPlanSelectionTx(ctx, tx, userID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit current subscription: %w", err)
	}
	return plan, nil
}

func (s *MySQLStore) UpdateSubscription(ctx context.Context, token string, tier string, now time.Time) (*PlanSelection, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)

	userID, err := currentSessionUserIDTx(ctx, tx, strings.TrimSpace(token), now)
	if err != nil {
		return nil, err
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO subscriptions (
			user_id,
			tier,
			confirmed_at,
			created_at,
			updated_at
		) VALUES (?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			tier = VALUES(tier),
			confirmed_at = VALUES(confirmed_at),
			updated_at = VALUES(updated_at)
	`, userID, tier, now, now, now); err != nil {
		return nil, fmt.Errorf("upsert subscription: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit subscription update: %w", err)
	}
	return &PlanSelection{Tier: tier, ConfirmedAt: now}, nil
}

func (s *MySQLStore) ConfirmFreePlan(ctx context.Context, token string, now time.Time) (*PlanSelection, error) {
	return s.UpdateSubscription(ctx, token, "free", now)
}

func (s *MySQLStore) DeleteSession(ctx context.Context, token string) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM auth_sessions WHERE token = ?`, strings.TrimSpace(token)); err != nil {
		return fmt.Errorf("delete session: %w", err)
	}
	return nil
}

func (s *MySQLStore) DeleteCurrentUser(ctx context.Context, token string, now time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)

	userID, err := currentSessionUserIDTx(ctx, tx, strings.TrimSpace(token), now)
	if err != nil {
		return err
	}
	if err := scrubDeletedUserRealnameFaceIDTx(ctx, tx, userID, now); err != nil {
		return err
	}

	if _, err := tx.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, userID); err != nil {
		return fmt.Errorf("delete user: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit delete user: %w", err)
	}
	return nil
}

func (s *MySQLStore) DeleteAdminUser(ctx context.Context, userID string, now time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)

	var existing string
	switch err := tx.QueryRowContext(ctx, `SELECT id FROM users WHERE id = ? LIMIT 1`, strings.TrimSpace(userID)).Scan(&existing); err {
	case nil:
	case sql.ErrNoRows:
		return newError("user_not_found", "用户不存在。", 404)
	default:
		return fmt.Errorf("find user: %w", err)
	}
	if err := scrubDeletedUserRealnameFaceIDTx(ctx, tx, existing, now); err != nil {
		return err
	}

	if _, err := tx.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, existing); err != nil {
		return fmt.Errorf("delete user: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit delete user: %w", err)
	}
	return nil
}

func scrubDeletedUserRealnameFaceIDTx(ctx context.Context, tx *sql.Tx, userID string, now time.Time) error {
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO realname_faceid_audit_events (
			attempt_id, user_id, event_type, state, rule_id, account_id,
			identity_hash, phone_hash, biz_token_hash, created_at
		)
		SELECT attempt_id, user_id, 'account_deleted_scrubbed', ?, rule_id, account_id,
		       identity_hash, COALESCE(phone_verified_hash, current_phone_hash), biz_token_hash, ?
		FROM realname_faceid_attempts
		WHERE user_id = ?
	`, RealnameFaceIDStateRevoked, now, userID); err != nil {
		return fmt.Errorf("append deleted-user faceid audit: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE realname_faceid_attempts
		SET state = ?, name_ciphertext = NULL, id_card_ciphertext = NULL,
		    biz_token_ciphertext = NULL, verify_url_ciphertext = NULL,
		    client_ip_ciphertext = NULL, client_ua_ciphertext = NULL,
		    lease_owner = NULL, lease_until = NULL, lease_version = lease_version + 1,
		    scrubbed_at = ?, updated_at = ?
		WHERE user_id = ?
	`, RealnameFaceIDStateRevoked, now, now, userID); err != nil {
		return fmt.Errorf("scrub deleted-user faceid attempts: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM shadow_bindings WHERE user_id = ?`, userID); err != nil {
		return fmt.Errorf("delete deleted-user shadow binding: %w", err)
	}
	return nil
}

func revokeActiveRealnameFaceIDAttemptsTx(ctx context.Context, tx *sql.Tx, userID string, now time.Time) error {
	states := []any{
		RealnameFaceIDStateCreated,
		RealnameFaceIDStatePending,
		RealnameFaceIDStateChecking,
		RealnameFaceIDStateFaceSucceeded,
		RealnameFaceIDStatePhonePending,
		RealnameFaceIDStateShadowPending,
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO realname_faceid_audit_events (
			attempt_id, user_id, event_type, state, rule_id, account_id,
			identity_hash, phone_hash, biz_token_hash, created_at
		)
		SELECT attempt_id, user_id, 'phone_changed_revoked', ?, rule_id, account_id,
		       identity_hash, COALESCE(phone_verified_hash, current_phone_hash), biz_token_hash, ?
		FROM realname_faceid_attempts
		WHERE user_id = ? AND state IN (?, ?, ?, ?, ?, ?)
	`, append([]any{RealnameFaceIDStateRevoked, now, userID}, states...)...); err != nil {
		return fmt.Errorf("append phone-change faceid audit: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE realname_faceid_attempts
		SET state = ?, name_ciphertext = NULL, id_card_ciphertext = NULL,
		    biz_token_ciphertext = NULL, verify_url_ciphertext = NULL,
		    client_ip_ciphertext = NULL, client_ua_ciphertext = NULL,
		    lease_owner = NULL, lease_until = NULL, lease_version = lease_version + 1,
		    scrubbed_at = ?, updated_at = ?
		WHERE user_id = ? AND state IN (?, ?, ?, ?, ?, ?)
	`, append([]any{RealnameFaceIDStateRevoked, now, now, userID}, states...)...); err != nil {
		return fmt.Errorf("revoke phone-change faceid attempts: %w", err)
	}
	return nil
}

func (s *MySQLStore) ListAdminUsers(ctx context.Context, search string, limit int) ([]AdminUser, error) {
	pattern := "%"
	if trimmed := strings.TrimSpace(search); trimmed != "" {
		pattern = "%" + trimmed + "%"
	}

	rows, err := s.db.QueryContext(ctx, `
		SELECT
			id,
			name,
			COALESCE(email, ''),
			COALESCE(phone, ''),
			COALESCE((
				SELECT provider_subject
				FROM oauth_identities
				WHERE user_id = users.id AND provider = 'qq'
				ORDER BY created_at ASC
				LIMIT 1
			), ''),
			COALESCE((
				SELECT provider_subject
				FROM oauth_identities
				WHERE user_id = users.id AND provider = 'wechat'
				ORDER BY created_at ASC
				LIMIT 1
			), ''),
			invite_required,
			created_at,
			updated_at
		FROM users
		WHERE (? = '%%' OR id LIKE ? OR name LIKE ? OR COALESCE(email, '') LIKE ? OR COALESCE(phone, '') LIKE ?)
		ORDER BY created_at DESC
		LIMIT ?
	`, pattern, pattern, pattern, pattern, pattern, limit)
	if err != nil {
		return nil, fmt.Errorf("list admin users: %w", err)
	}
	defer rows.Close()

	items := make([]AdminUser, 0)
	for rows.Next() {
		var item AdminUser
		if err := rows.Scan(&item.ID, &item.Name, &item.Email, &item.Phone, &item.QQOpenID, &item.WeChatSubject, &item.InviteRequired, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan admin user: %w", err)
		}
		item.AuthMethods = adminUserAuthMethods(item.Email, item.Phone, item.QQOpenID, item.WeChatSubject)
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate admin users: %w", err)
	}
	return items, nil
}

func (s *MySQLStore) ListAdminSMSChallenges(ctx context.Context, search string, limit int) ([]AdminSMSChallenge, error) {
	pattern := "%"
	if trimmed := strings.TrimSpace(search); trimmed != "" {
		pattern = "%" + trimmed + "%"
	}

	rows, err := s.db.QueryContext(ctx, `
		SELECT phone, code, expires_at, cooldown_until, remaining_retries, created_at, updated_at
		FROM sms_challenges
		WHERE (? = '%%' OR phone LIKE ?)
		ORDER BY updated_at DESC
		LIMIT ?
	`, pattern, pattern, limit)
	if err != nil {
		return nil, fmt.Errorf("list sms challenges: %w", err)
	}
	defer rows.Close()

	items := make([]AdminSMSChallenge, 0)
	for rows.Next() {
		var item AdminSMSChallenge
		if err := rows.Scan(&item.Phone, &item.Code, &item.ExpiresAt, &item.CooldownUntil, &item.RemainingRetries, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan sms challenge: %w", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate sms challenges: %w", err)
	}
	return items, nil
}

func (s *MySQLStore) DeleteAdminSMSChallenge(ctx context.Context, phone string) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM sms_challenges WHERE phone = ?`, phone); err != nil {
		return fmt.Errorf("delete sms challenge: %w", err)
	}
	return nil
}

func (s *MySQLStore) ListAdminInvites(ctx context.Context, search string, state string, limit int) ([]AdminInvite, error) {
	pattern := "%"
	if trimmed := strings.TrimSpace(search); trimmed != "" {
		pattern = "%" + trimmed + "%"
	}

	rows, err := s.db.QueryContext(ctx, `
		SELECT code, state, message, COALESCE(used_by_user_id, ''), COALESCE(used_via, ''), used_at, created_at, updated_at
		FROM invites
		WHERE (? = '%%' OR code LIKE ? OR message LIKE ? OR state LIKE ?)
		  AND (? = '' OR state = ?)
		ORDER BY updated_at DESC, code DESC
		LIMIT ?
	`, pattern, pattern, pattern, pattern, state, state, limit)
	if err != nil {
		return nil, fmt.Errorf("list invites: %w", err)
	}
	defer rows.Close()

	items := make([]AdminInvite, 0)
	for rows.Next() {
		var item AdminInvite
		var usedAt sql.NullTime
		if err := rows.Scan(&item.Code, &item.State, &item.Message, &item.UsedByUserID, &item.UsedVia, &usedAt, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan invite: %w", err)
		}
		if usedAt.Valid {
			value := usedAt.Time
			item.UsedAt = &value
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate invites: %w", err)
	}
	return items, nil
}

func (s *MySQLStore) CreateAdminInvite(ctx context.Context, code string, message string, now time.Time) (*AdminInvite, error) {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO invites (code, state, message, created_at, updated_at)
		VALUES (?, 'valid', ?, ?, ?)
	`, code, message, now, now)
	if err != nil {
		if isMySQLDuplicate(err) {
			return nil, newError("invite_exists", "邀请码已存在。", 409)
		}
		return nil, fmt.Errorf("create invite: %w", err)
	}
	return &AdminInvite{
		Code:      code,
		State:     "valid",
		Message:   message,
		CreatedAt: now,
		UpdatedAt: now,
	}, nil
}

func (s *MySQLStore) DisableAdminInvite(ctx context.Context, code string, now time.Time) error {
	result, err := s.db.ExecContext(ctx, `
		UPDATE invites
		SET state = 'disabled', message = '邀请码已禁用。', updated_at = ?
		WHERE code = ? AND state = 'valid'
	`, now, code)
	if err != nil {
		return fmt.Errorf("disable invite: %w", err)
	}
	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("invite rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return newError("invite_not_found", "邀请码不存在或不可禁用。", 404)
	}
	return nil
}

func (s *MySQLStore) seedDefaultInvites(nowFn func() time.Time) error {
	now := time.Now().UTC()
	if nowFn != nil {
		now = nowFn().UTC()
	}
	defaultInvites := []InviteValidation{
		{Code: "VALID2026", State: "valid", Message: "邀请码有效，可加入 Lightclaw 内测。"},
		{Code: "EXPIRED2026", State: "expired", Message: "邀请码已过期，请申请新的邀请码。"},
		{Code: "USED2026", State: "used", Message: "邀请码已被使用。"},
	}
	for _, invite := range defaultInvites {
		if _, err := s.db.Exec(`
			INSERT INTO invites (code, state, message, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?)
			ON DUPLICATE KEY UPDATE
				state = VALUES(state),
				message = VALUES(message),
				updated_at = VALUES(updated_at)
		`, invite.Code, invite.State, invite.Message, now, now); err != nil {
			return fmt.Errorf("seed invite %s: %w", invite.Code, err)
		}
	}
	return nil
}

func (s *MySQLStore) seedDemoUser(nowFn func() time.Time) error {
	now := time.Now().UTC()
	if nowFn != nil {
		now = nowFn().UTC()
	}
	hash, err := bcrypt.GenerateFromPassword([]byte("demo2026!"), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("hash demo password: %w", err)
	}
	userID, err := newPrefixedID("usr")
	if err != nil {
		return fmt.Errorf("generate demo user id: %w", err)
	}

	tx, err := s.db.BeginTx(context.Background(), nil)
	if err != nil {
		return fmt.Errorf("begin demo user tx: %w", err)
	}
	defer rollback(tx)

	_, err = tx.Exec(`
		INSERT INTO users (id, name, email, phone, invite_required, created_at, updated_at)
		VALUES (?, ?, ?, NULL, ?, ?, ?)
	`, userID, "Demo", "demo@lightclaw.ai", true, now, now)
	if err != nil {
		if isMySQLDuplicate(err) {
			return nil
		}
		return fmt.Errorf("insert demo user: %w", err)
	}

	if _, err := tx.Exec(`
		INSERT INTO password_credentials (user_id, password_hash, created_at, updated_at)
		VALUES (?, ?, ?, ?)
	`, userID, hash, now, now); err != nil {
		return fmt.Errorf("insert demo credential: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit demo user: %w", err)
	}
	return nil
}

func (s *MySQLStore) ensureInviteValidTx(ctx context.Context, tx *sql.Tx, code string) error {
	normalized := normalizeInvite(code)
	if normalized == "" {
		return newError("invite_required", "请先输入邀请码。", 400)
	}

	var state string
	var message string
	err := tx.QueryRowContext(ctx, `
		SELECT state, message
		FROM invites
		WHERE code = ?
		FOR UPDATE
	`, normalized).Scan(&state, &message)
	if errors.Is(err, sql.ErrNoRows) {
		return newError("invite_invalid", "邀请码不存在，请检查输入。", 400)
	}
	if err != nil {
		return fmt.Errorf("query invite: %w", err)
	}
	if state != "valid" {
		return newError("invite_"+state, message, 400)
	}
	return nil
}

func (s *MySQLStore) consumeInviteTx(ctx context.Context, tx *sql.Tx, code string, userID string, via string, now time.Time) error {
	if err := s.ensureInviteValidTx(ctx, tx, code); err != nil {
		return err
	}

	if _, err := tx.ExecContext(ctx, `
		UPDATE invites
		SET
			state = 'used',
			message = '邀请码已被使用。',
			used_by_user_id = ?,
			used_via = ?,
			used_at = ?,
			updated_at = ?
		WHERE code = ?
	`, nullableString(userID), nullableString(via), now, now, normalizeInvite(code)); err != nil {
		return fmt.Errorf("consume invite: %w", err)
	}
	return nil
}

func consumeSMSChallengeTx(ctx context.Context, tx *sql.Tx, phone string, code string, now time.Time) error {
	row := tx.QueryRowContext(ctx, `
		SELECT code, expires_at, remaining_retries
		FROM sms_challenges
		WHERE phone = ?
		FOR UPDATE
	`, phone)
	var expected string
	var expiresAt time.Time
	var remainingRetries int
	if err := row.Scan(&expected, &expiresAt, &remainingRetries); errors.Is(err, sql.ErrNoRows) {
		return newError("sms_code_not_found", "请先获取验证码。", 400)
	} else if err != nil {
		return fmt.Errorf("query sms challenge: %w", err)
	}
	if !expiresAt.After(now) {
		_, _ = tx.ExecContext(ctx, `DELETE FROM sms_challenges WHERE phone = ?`, phone)
		return newError("sms_code_expired", "验证码已过期，请重新获取。", 400)
	}
	if strings.TrimSpace(code) == "" || expected != strings.TrimSpace(code) {
		remainingRetries--
		if remainingRetries <= 0 {
			_, _ = tx.ExecContext(ctx, `DELETE FROM sms_challenges WHERE phone = ?`, phone)
		} else {
			_, _ = tx.ExecContext(ctx, `UPDATE sms_challenges SET remaining_retries = ?, updated_at = ? WHERE phone = ?`, remainingRetries, now, phone)
		}
		return newError("invalid_sms_code", "验证码不正确。", 400)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM sms_challenges WHERE phone = ?`, phone); err != nil {
		return fmt.Errorf("consume sms challenge: %w", err)
	}
	return nil
}

func (s *MySQLStore) validateCurrentUserPhoneChallengeTx(ctx context.Context, tx *sql.Tx, token string, code string, now time.Time) (User, error) {
	user, err := s.currentUserWithPhoneRealnamePrerequisitesTx(ctx, tx, token, now)
	if err != nil {
		return User{}, err
	}
	if err := validateSMSChallengeTx(ctx, tx, user.Phone, code, now); err != nil {
		return User{}, err
	}
	return user, nil
}

func (s *MySQLStore) currentUserWithPhoneRealnamePrerequisitesTx(ctx context.Context, tx *sql.Tx, token string, now time.Time) (User, error) {
	userID, err := currentSessionUserIDTx(ctx, tx, strings.TrimSpace(token), now)
	if err != nil {
		return User{}, err
	}
	user, err := s.loadUserByIDTx(ctx, tx, userID)
	if err != nil {
		return User{}, err
	}
	if user.Phone == "" {
		return User{}, newError("phone_required", "当前账号未绑定手机号。", 400)
	}
	if !isAtLeastRealnameLevel(user.RealnameLevel, RealnameLevelIDCard2FA) && !user.RealnameVerified {
		return User{}, newError("realname_required", "请先完成实名认证。", 403)
	}
	return user, nil
}

func (s *MySQLStore) validatePhoneChangeTargetTx(ctx context.Context, tx *sql.Tx, token string, newPhone string, now time.Time) (User, error) {
	userID, err := currentSessionUserIDTx(ctx, tx, strings.TrimSpace(token), now)
	if err != nil {
		return User{}, err
	}
	user, err := s.loadUserByIDTx(ctx, tx, userID)
	if err != nil {
		return User{}, err
	}
	row := tx.QueryRowContext(ctx, `
		SELECT id
		FROM users
		WHERE phone = ?
		FOR UPDATE
	`, newPhone)
	var existingUserID string
	if err := row.Scan(&existingUserID); err == nil {
		if existingUserID != user.ID {
			return User{}, newError("phone_in_use", "该手机号已绑定其他账号。", http.StatusConflict)
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return User{}, fmt.Errorf("query phone owner: %w", err)
	}
	return user, nil
}

func (s *MySQLStore) validatePhoneChangeTx(ctx context.Context, tx *sql.Tx, token string, newPhone string, code string, now time.Time) (User, error) {
	user, err := s.validatePhoneChangeTargetTx(ctx, tx, token, newPhone, now)
	if err != nil {
		return User{}, err
	}
	if err := validateSMSChallengeTx(ctx, tx, newPhone, code, now); err != nil {
		return User{}, err
	}
	return user, nil
}

func validateSMSChallengeTx(ctx context.Context, tx *sql.Tx, phone string, code string, now time.Time) error {
	row := tx.QueryRowContext(ctx, `
		SELECT code, expires_at
		FROM sms_challenges
		WHERE phone = ?
	`, phone)
	var expected string
	var expiresAt time.Time
	if err := row.Scan(&expected, &expiresAt); errors.Is(err, sql.ErrNoRows) {
		return newError("sms_code_not_found", "请先获取验证码。", 400)
	} else if err != nil {
		return fmt.Errorf("query sms challenge: %w", err)
	}
	if !expiresAt.After(now) {
		_, _ = tx.ExecContext(ctx, `DELETE FROM sms_challenges WHERE phone = ?`, phone)
		return newError("sms_code_expired", "验证码已过期，请重新获取。", 400)
	}
	if strings.TrimSpace(code) == "" || expected != strings.TrimSpace(code) {
		return newError("invalid_sms_code", "验证码不正确。", 400)
	}
	return nil
}

func scanPhoneAuthChallenge(row *sql.Row, operation string) (PhoneAuthChallenge, error) {
	var challenge PhoneAuthChallenge
	if err := row.Scan(
		&challenge.Phone,
		&challenge.UserID,
		&challenge.Flow,
		&challenge.CodeHash,
		&challenge.ExpiresAt,
		&challenge.CooldownUntil,
		&challenge.RemainingRetries,
		&challenge.CreatedAt,
		&challenge.UpdatedAt,
	); errors.Is(err, sql.ErrNoRows) {
		return PhoneAuthChallenge{}, newError("sms_code_not_found", "请先获取验证码。", http.StatusBadRequest)
	} else if err != nil {
		return PhoneAuthChallenge{}, fmt.Errorf("%s: %w", operation, err)
	}
	return challenge, nil
}

func validatePhoneAuthChallengeTx(ctx context.Context, tx *sql.Tx, phone string, now time.Time) (PhoneAuthChallenge, error) {
	row := tx.QueryRowContext(ctx, `
		SELECT phone, COALESCE(user_id, ''), flow, COALESCE(code_hash, ''), expires_at, cooldown_until, remaining_retries, created_at, updated_at
		FROM phone_auth_challenges
		WHERE phone = ?
		FOR UPDATE
	`, phone)
	challenge, err := scanPhoneAuthChallenge(row, "query phone auth challenge")
	if err != nil {
		return PhoneAuthChallenge{}, err
	}
	if !challenge.ExpiresAt.After(now) {
		_, _ = tx.ExecContext(ctx, `DELETE FROM phone_auth_challenges WHERE phone = ?`, phone)
		return PhoneAuthChallenge{}, newError("sms_code_expired", "验证码已过期，请重新获取。", http.StatusBadRequest)
	}
	return challenge, nil
}

func verifyPhoneAuthChallengeTx(ctx context.Context, tx *sql.Tx, phone string, code string, now time.Time) (PhoneAuthChallenge, error) {
	challenge, err := validatePhoneAuthChallengeTx(ctx, tx, phone, now)
	if err != nil {
		return PhoneAuthChallenge{}, err
	}
	if strings.TrimSpace(code) == "" || bcrypt.CompareHashAndPassword([]byte(challenge.CodeHash), []byte(strings.TrimSpace(code))) != nil {
		challenge.RemainingRetries--
		if challenge.RemainingRetries <= 0 {
			if _, execErr := tx.ExecContext(ctx, `DELETE FROM phone_auth_challenges WHERE phone = ?`, phone); execErr != nil {
				return PhoneAuthChallenge{}, fmt.Errorf("delete exhausted phone auth challenge: %w", execErr)
			}
		} else {
			if _, execErr := tx.ExecContext(ctx, `
				UPDATE phone_auth_challenges
				SET remaining_retries = ?, updated_at = ?
				WHERE phone = ?
			`, challenge.RemainingRetries, now, phone); execErr != nil {
				return PhoneAuthChallenge{}, fmt.Errorf("update phone auth retries: %w", execErr)
			}
		}
		return PhoneAuthChallenge{}, newError("invalid_sms_code", "验证码不正确。", http.StatusBadRequest)
	}
	return challenge, nil
}

func (s *MySQLStore) findOrCreatePhoneUserTx(ctx context.Context, tx *sql.Tx, phone string, name string, now time.Time, updateExistingName bool) (User, bool, error) {
	row := tx.QueryRowContext(ctx, fmt.Sprintf(`
		SELECT
			%s
		FROM users
		WHERE phone = ?
		FOR UPDATE
	`, mysqlUserSelectColumns("", s.contentAuditEnabled)), phone)

	var user User
	var pendingName sql.NullString
	var nameAuditStatus sql.NullString
	var pendingAvatarObjectKey sql.NullString
	var pendingAvatarSource sql.NullString
	var avatarAuditStatus sql.NullString
	var emailValue sql.NullString
	var emailVerified sql.NullBool
	var phoneValue sql.NullString
	var realnameVerifiedAt sql.NullTime
	var realnameLevel sql.NullString
	var avatarObjectKey sql.NullString
	var avatarSource sql.NullString
	var realnameFinalAttemptID sql.NullString
	var realnameFaceVerifiedAt sql.NullTime
	var realnamePhoneVerifiedAt sql.NullTime
	var realnameIdentityHash sql.NullString
	var realnamePhoneHash sql.NullString
	err := row.Scan(mysqlUserScanDest(&user, s.contentAuditEnabled, &pendingName, &nameAuditStatus, &pendingAvatarObjectKey, &pendingAvatarSource, &avatarAuditStatus, &emailValue, &emailVerified, &phoneValue, &avatarObjectKey, &avatarSource, &realnameVerifiedAt, &realnameLevel, &realnameFinalAttemptID, &realnameFaceVerifiedAt, &realnamePhoneVerifiedAt, &realnameIdentityHash, &realnamePhoneHash)...)
	switch {
	case err == nil:
		applyMySQLUserFields(&user, s.contentAuditEnabled, pendingName, nameAuditStatus, pendingAvatarObjectKey, pendingAvatarSource, avatarAuditStatus, emailValue, emailVerified, phoneValue, avatarObjectKey, avatarSource, realnameVerifiedAt, realnameLevel, realnameFinalAttemptID, realnameFaceVerifiedAt, realnamePhoneVerifiedAt, realnameIdentityHash, realnamePhoneHash)
		if updateExistingName && name != "" && user.Name != name {
			if _, updateErr := tx.ExecContext(ctx, `
				UPDATE users
				SET name = ?, updated_at = ?
				WHERE id = ?
			`, name, now, user.ID); updateErr != nil {
				return User{}, false, fmt.Errorf("update phone user name: %w", updateErr)
			}
			user.Name = name
			user.UpdatedAt = now
		}
		if user.InviteRequired {
			if _, updateErr := tx.ExecContext(ctx, `
				UPDATE users
				SET invite_required = ?, updated_at = ?
				WHERE id = ?
			`, false, now, user.ID); updateErr != nil {
				return User{}, false, fmt.Errorf("clear phone user invite_required: %w", updateErr)
			}
			user.InviteRequired = false
		}
		return user, false, nil
	case !errors.Is(err, sql.ErrNoRows):
		return User{}, false, fmt.Errorf("query phone user: %w", err)
	}

	fallbackName := name
	if fallbackName == "" {
		fallbackName = "用户" + phone[len(phone)-4:]
	}
	userID, err := newPrefixedID("usr")
	if err != nil {
		return User{}, false, fmt.Errorf("generate user id: %w", err)
	}
	user = User{
		ID:             userID,
		Name:           fallbackName,
		Phone:          phone,
		InviteRequired: false,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO users (
			id,
			name,
			email,
			phone,
			invite_required,
			created_at,
			updated_at
		) VALUES (?, ?, NULL, ?, ?, ?, ?)
	`, user.ID, user.Name, user.Phone, false, now, now)
	if err != nil {
		return User{}, false, fmt.Errorf("insert phone user: %w", err)
	}
	return user, true, nil
}

func (s *MySQLStore) findOrCreateOAuthUserTx(ctx context.Context, tx *sql.Tx, input OAuthSignInInput, now time.Time) (User, bool, error) {
	row := tx.QueryRowContext(ctx, fmt.Sprintf(`
		SELECT
			%s
		FROM oauth_identities oi
		INNER JOIN users u ON u.id = oi.user_id
		WHERE oi.provider = ? AND oi.provider_subject = ?
		FOR UPDATE
	`, mysqlUserSelectColumns("u.", s.contentAuditEnabled)), input.Provider, input.ProviderSubject)

	var user User
	var pendingName sql.NullString
	var nameAuditStatus sql.NullString
	var pendingAvatarObjectKey sql.NullString
	var pendingAvatarSource sql.NullString
	var avatarAuditStatus sql.NullString
	var emailValue sql.NullString
	var emailVerified sql.NullBool
	var phoneValue sql.NullString
	var avatarObjectKey sql.NullString
	var avatarSource sql.NullString
	var realnameVerifiedAt sql.NullTime
	var realnameLevel sql.NullString
	var realnameFinalAttemptID sql.NullString
	var realnameFaceVerifiedAt sql.NullTime
	var realnamePhoneVerifiedAt sql.NullTime
	var realnameIdentityHash sql.NullString
	var realnamePhoneHash sql.NullString
	err := row.Scan(mysqlUserScanDest(&user, s.contentAuditEnabled, &pendingName, &nameAuditStatus, &pendingAvatarObjectKey, &pendingAvatarSource, &avatarAuditStatus, &emailValue, &emailVerified, &phoneValue, &avatarObjectKey, &avatarSource, &realnameVerifiedAt, &realnameLevel, &realnameFinalAttemptID, &realnameFaceVerifiedAt, &realnamePhoneVerifiedAt, &realnameIdentityHash, &realnamePhoneHash)...)
	switch {
	case err == nil:
		applyMySQLUserFields(&user, s.contentAuditEnabled, pendingName, nameAuditStatus, pendingAvatarObjectKey, pendingAvatarSource, avatarAuditStatus, emailValue, emailVerified, phoneValue, avatarObjectKey, avatarSource, realnameVerifiedAt, realnameLevel, realnameFinalAttemptID, realnameFaceVerifiedAt, realnamePhoneVerifiedAt, realnameIdentityHash, realnamePhoneHash)
		if user.InviteRequired {
			if _, updateErr := tx.ExecContext(ctx, `
				UPDATE users
				SET invite_required = ?, updated_at = ?
				WHERE id = ?
			`, false, now, user.ID); updateErr != nil {
				return User{}, false, fmt.Errorf("clear oauth user invite_required: %w", updateErr)
			}
			user.InviteRequired = false
		}
		if _, updateErr := tx.ExecContext(ctx, `
			UPDATE oauth_identities
			SET email = ?, email_verified = ?, name = ?, avatar_url = ?, updated_at = ?
			WHERE provider = ? AND provider_subject = ?
		`, nullableString(input.Email), input.EmailVerified, nullableString(input.Name), nullableString(input.AvatarURL), now, input.Provider, input.ProviderSubject); updateErr != nil {
			return User{}, false, fmt.Errorf("update oauth identity: %w", updateErr)
		}
		return user, false, nil
	case !errors.Is(err, sql.ErrNoRows):
		return User{}, false, fmt.Errorf("query oauth identity: %w", err)
	}

	if strings.TrimSpace(input.Email) != "" {
		existingUser, found, err := findUserByEmailTx(ctx, tx, input.Email)
		if err != nil {
			return User{}, false, err
		}
		if found {
			if !canAutoLinkOAuthEmail(input) {
				return User{}, false, newError("oauth_email_conflict", "第三方账号邮箱已被使用，请先使用已有方式登录后再绑定。", 409)
			}
			if err := insertOAuthIdentityTx(ctx, tx, existingUser.ID, input, now); err != nil {
				return User{}, false, err
			}
			return existingUser, false, nil
		}
	}

	userID, err := newPrefixedID("usr")
	if err != nil {
		return User{}, false, fmt.Errorf("generate oauth user id: %w", err)
	}
	user = User{
		ID:             userID,
		Name:           input.Name,
		Email:          input.Email,
		InviteRequired: false,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO users (
			id,
			name,
			email,
			phone,
			invite_required,
			created_at,
			updated_at
		) VALUES (?, ?, ?, NULL, ?, ?, ?)
	`, user.ID, user.Name, nullableString(user.Email), false, now, now); err != nil {
		return User{}, false, fmt.Errorf("insert oauth user: %w", err)
	}

	if err := insertOAuthIdentityTx(ctx, tx, user.ID, input, now); err != nil {
		return User{}, false, err
	}

	return user, true, nil
}

func insertOAuthIdentityTx(ctx context.Context, tx *sql.Tx, userID string, input OAuthSignInInput, now time.Time) error {
	identityID, err := newPrefixedID("oid")
	if err != nil {
		return fmt.Errorf("generate oauth identity id: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO oauth_identities (
			id,
			user_id,
			provider,
			provider_subject,
			email,
			email_verified,
			name,
			avatar_url,
			created_at,
			updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, identityID, userID, input.Provider, input.ProviderSubject, nullableString(input.Email), input.EmailVerified, nullableString(input.Name), nullableString(input.AvatarURL), now, now); err != nil {
		if isMySQLDuplicate(err) {
			return newError("oauth_identity_conflict", "第三方账号绑定冲突，请稍后重试。", 409)
		}
		return fmt.Errorf("insert oauth identity: %w", err)
	}
	return nil
}

func createSessionTx(ctx context.Context, tx *sql.Tx, user User, now time.Time, sessionTTL time.Duration, authMethod string) (*AuthSession, error) {
	return createSessionWithMetadataTx(ctx, tx, user, now, sessionTTL, false, "", authMethod)
}

func createImpersonationSessionTx(ctx context.Context, tx *sql.Tx, user User, reason string, now time.Time, sessionTTL time.Duration) (*AuthSession, error) {
	return createSessionWithMetadataTx(ctx, tx, user, now, sessionTTL, true, strings.TrimSpace(reason), AuthMethodImpersonation)
}

func createSessionWithMetadataTx(ctx context.Context, tx *sql.Tx, user User, now time.Time, sessionTTL time.Duration, impersonated bool, reason string, authMethod string) (*AuthSession, error) {
	token, err := newOpaqueToken()
	if err != nil {
		return nil, fmt.Errorf("create session token: %w", err)
	}
	expiresAt := now.Add(sessionTTL)
	normalizedAuthMethod := strings.TrimSpace(authMethod)
	if normalizedAuthMethod == "" {
		normalizedAuthMethod = AuthMethodUnknown
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO auth_sessions (
			token,
			user_id,
			impersonated,
			impersonation_reason,
			auth_method,
			authenticated_at,
			expires_at,
			created_at,
			updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, token, user.ID, impersonated, nullableString(strings.TrimSpace(reason)), normalizedAuthMethod, now, expiresAt, now, now); err != nil {
		return nil, fmt.Errorf("insert auth session: %w", err)
	}

	return &AuthSession{
		Token:               token,
		User:                user,
		AuthenticatedAt:     now,
		ExpiresAt:           expiresAt,
		Impersonated:        impersonated,
		ImpersonationReason: strings.TrimSpace(reason),
		AuthMethod:          normalizedAuthMethod,
	}, nil
}

func loadPlanSelectionTx(ctx context.Context, tx *sql.Tx, userID string) (*PlanSelection, error) {
	row := tx.QueryRowContext(ctx, `
		SELECT tier, confirmed_at
		FROM subscriptions
		WHERE user_id = ?
	`, userID)

	var tier string
	var confirmedAt time.Time
	if err := row.Scan(&tier, &confirmedAt); errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	} else if err != nil {
		return nil, fmt.Errorf("query subscription: %w", err)
	}

	return &PlanSelection{
		Tier:        tier,
		ConfirmedAt: confirmedAt,
	}, nil
}

func scanContentAuditTasks(rows *sql.Rows) ([]ContentAuditTask, error) {
	var tasks []ContentAuditTask
	for rows.Next() {
		var task ContentAuditTask
		var submittedAt sql.NullTime
		if err := rows.Scan(
			&task.ID,
			&task.BizType,
			&task.BizID,
			&task.BizDetail,
			&task.ProductID,
			&task.SID,
			&task.ContentText,
			&task.ContentURL,
			&task.MediaType,
			&task.Status,
			&task.RequestID,
			&task.ResultCode,
			&task.ResultType,
			&task.Attempts,
			&task.LastError,
			&submittedAt,
			&task.CreatedAt,
			&task.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan content audit task: %w", err)
		}
		if submittedAt.Valid {
			task.SubmittedAt = &submittedAt.Time
		}
		tasks = append(tasks, task)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate content audit tasks: %w", err)
	}
	return tasks, nil
}

func (s *MySQLStore) finishContentAuditTask(ctx context.Context, taskID int64, finish func(*sql.Tx, ContentAuditTask) error) error {
	if err := s.requireContentAuditEnabled(); err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)

	rows, err := tx.QueryContext(ctx, `
		SELECT id, biz_type, biz_id, COALESCE(biz_detail, ''), product_id, sid,
		       COALESCE(content_text, ''), COALESCE(content_url, ''), COALESCE(media_type, 'text'),
		       status, COALESCE(request_id, ''),
		       COALESCE(result_code, 0), COALESCE(result_type, 0), attempts,
		       COALESCE(last_error, ''), submitted_at, created_at, updated_at
		FROM content_audit_tasks
		WHERE id = ?
		FOR UPDATE
	`, taskID)
	if err != nil {
		return fmt.Errorf("query content audit task: %w", err)
	}
	tasks, scanErr := scanContentAuditTasks(rows)
	closeErr := rows.Close()
	if scanErr != nil {
		return scanErr
	}
	if closeErr != nil {
		return fmt.Errorf("close content audit task rows: %w", closeErr)
	}
	if len(tasks) == 0 || isTerminalAuditStatus(tasks[0].Status) {
		return nil
	}
	if err := finish(tx, tasks[0]); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit content audit task: %w", err)
	}
	return nil
}

func (s *MySQLStore) loadUserByIDTx(ctx context.Context, tx *sql.Tx, userID string) (User, error) {
	row := tx.QueryRowContext(ctx, fmt.Sprintf(`
		SELECT
			%s
		FROM users
		WHERE id = ?
		FOR UPDATE
	`, mysqlUserSelectColumns("", s.contentAuditEnabled)), userID)

	user, err := s.scanUserRow(row)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, newError("user_not_found", "用户不存在。", 404)
	} else if err != nil {
		return User{}, fmt.Errorf("query user: %w", err)
	}

	return user, nil
}

func (s *MySQLStore) loadUserByPhoneTx(ctx context.Context, tx *sql.Tx, phone string) (User, error) {
	row := tx.QueryRowContext(ctx, fmt.Sprintf(`
		SELECT
			%s
		FROM users
		WHERE phone = ?
		FOR UPDATE
	`, mysqlUserSelectColumns("", s.contentAuditEnabled)), phone)

	user, err := s.scanUserRow(row)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, newError("user_not_found", "用户不存在。", http.StatusNotFound)
	} else if err != nil {
		return User{}, fmt.Errorf("query phone user: %w", err)
	}
	return user, nil
}

func findUserByEmailTx(ctx context.Context, tx *sql.Tx, email string) (User, bool, error) {
	row := tx.QueryRowContext(ctx, `
		SELECT
			id,
			name,
			email,
			phone,
			avatar_object_key,
			avatar_source,
			invite_required,
			realname_verified_at,
			realname_level,
			created_at,
			updated_at
		FROM users
		WHERE email = ?
		FOR UPDATE
	`, strings.TrimSpace(email))

	var user User
	var emailValue sql.NullString
	var phoneValue sql.NullString
	var avatarObjectKey sql.NullString
	var avatarSource sql.NullString
	var realnameVerifiedAt sql.NullTime
	var realnameLevel sql.NullString
	if err := row.Scan(
		&user.ID,
		&user.Name,
		&emailValue,
		&phoneValue,
		&avatarObjectKey,
		&avatarSource,
		&user.InviteRequired,
		&realnameVerifiedAt,
		&realnameLevel,
		&user.CreatedAt,
		&user.UpdatedAt,
	); errors.Is(err, sql.ErrNoRows) {
		return User{}, false, nil
	} else if err != nil {
		return User{}, false, fmt.Errorf("query user by email: %w", err)
	}

	user.Email = emailValue.String
	user.Phone = phoneValue.String
	user.AvatarObjectKey = avatarObjectKey.String
	user.AvatarSource = avatarSource.String
	user.RealnameVerified = realnameVerifiedAt.Valid || isAtLeastRealnameLevel(realnameLevel.String, RealnameLevelIDCard2FA)
	user.RealnameLevel = normalizeRealnameLevel(realnameLevel.String, user.RealnameVerified)
	return user, true, nil
}

func currentSessionUserIDTx(ctx context.Context, tx *sql.Tx, token string, now time.Time) (string, error) {
	var userID string
	var expiresAt time.Time
	err := tx.QueryRowContext(ctx, `
		SELECT user_id, expires_at
		FROM auth_sessions
		WHERE token = ?
		FOR UPDATE
	`, token).Scan(&userID, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return "", newError("unauthorized", "未登录或登录已失效。", 401)
	}
	if err != nil {
		return "", fmt.Errorf("query session: %w", err)
	}
	if expiresAt.Before(now) {
		if _, deleteErr := tx.ExecContext(ctx, `DELETE FROM auth_sessions WHERE token = ?`, token); deleteErr != nil {
			return "", fmt.Errorf("delete expired session: %w", deleteErr)
		}
		if err := tx.Commit(); err != nil {
			return "", fmt.Errorf("commit expired session cleanup: %w", err)
		}
		return "", newError("session_expired", "登录已过期，请重新登录。", 401)
	}
	return userID, nil
}

func rollback(tx *sql.Tx) {
	if tx != nil {
		_ = tx.Rollback()
	}
}

func isMySQLDuplicate(err error) bool {
	var mysqlErr *mysql.MySQLError
	return errors.As(err, &mysqlErr) && mysqlErr.Number == 1062
}

func nullableString(value string) any {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return trimmed
}

func normalizeMySQLDSN(dsn string) (string, error) {
	cfg, err := mysql.ParseDSN(strings.TrimSpace(dsn))
	if err != nil {
		return "", fmt.Errorf("parse mysql dsn: %w", err)
	}
	cfg.ParseTime = true
	cfg.Loc = time.UTC
	if cfg.Params == nil {
		cfg.Params = make(map[string]string)
	}
	cfg.Params["time_zone"] = "'+00:00'"
	return cfg.FormatDSN(), nil
}

func (s *MySQLStore) DB() *sql.DB {
	if s == nil {
		return nil
	}
	return s.db
}
