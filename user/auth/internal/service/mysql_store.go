package service

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
	"golang.org/x/crypto/bcrypt"
)

type MySQLStore struct {
	db *sql.DB
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

	store := &MySQLStore{db: db}
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

func (s *MySQLStore) ValidateInvite(ctx context.Context, code string) (InviteValidation, error) {
	return InviteValidation{Code: strings.TrimSpace(code), State: "valid", Message: "邀请码校验已关闭。"}, nil
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

	user, created, err := s.findOrCreatePhoneUserTx(ctx, tx, input.Phone, strings.TrimSpace(input.Name), now)
	if err != nil {
		return nil, err
	}
	if created {
		user.InviteRequired = false
	}
	session, err := createSessionTx(ctx, tx, user, now, sessionTTL)
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit sms verification: %w", err)
	}
	return session, nil
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
		InviteRequired: false,
		CreatedAt:      now,
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
		) VALUES (?, ?, ?, NULL, ?, ?, ?)
	`, user.ID, user.Name, user.Email, false, now, now)
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
	session, err := createSessionTx(ctx, tx, user, now, sessionTTL)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit password signup: %w", err)
	}
	return session, nil
}

func (s *MySQLStore) GetPasswordUser(ctx context.Context, email string) (User, []byte, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT
			u.id,
			u.name,
			u.email,
			u.phone,
			u.avatar_object_key,
			u.avatar_source,
			u.invite_required,
			u.realname_verified_at,
			u.created_at,
			pc.password_hash
		FROM users u
		INNER JOIN password_credentials pc ON pc.user_id = u.id
		WHERE u.email = ?
	`, email)

	var user User
	var emailValue sql.NullString
	var phoneValue sql.NullString
	var avatarObjectKey sql.NullString
	var avatarSource sql.NullString
	var realnameVerifiedAt sql.NullTime
	var hash []byte
	if err := row.Scan(
		&user.ID,
		&user.Name,
		&emailValue,
		&phoneValue,
		&avatarObjectKey,
		&avatarSource,
		&user.InviteRequired,
		&realnameVerifiedAt,
		&user.CreatedAt,
		&hash,
	); errors.Is(err, sql.ErrNoRows) {
		return User{}, nil, newError("invalid_credentials", "账号或密码不正确。", 401)
	} else if err != nil {
		return User{}, nil, fmt.Errorf("query password user: %w", err)
	}
	user.Email = emailValue.String
	user.Phone = phoneValue.String
	user.AvatarObjectKey = avatarObjectKey.String
	user.AvatarSource = avatarSource.String
	user.RealnameVerified = realnameVerifiedAt.Valid
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

	session, err := createSessionTx(ctx, tx, user, now, sessionTTL)
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
	user, err := loadUserByIDTx(ctx, tx, userID)
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
	user, err := loadUserByIDTx(ctx, tx, userID)
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

	session, err := createSessionTx(ctx, tx, user, now, sessionTTL)
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

	session, err := createSessionTx(ctx, tx, user, now, sessionTTL)
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
	row := s.db.QueryRowContext(ctx, `
		SELECT
			s.token,
			s.authenticated_at,
			s.expires_at,
			s.impersonated,
			s.impersonation_reason,
			u.id,
			u.name,
			u.email,
			u.phone,
			u.avatar_object_key,
			u.avatar_source,
			u.invite_required,
			u.realname_verified_at,
			u.created_at
		FROM auth_sessions s
		INNER JOIN users u ON u.id = s.user_id
		WHERE s.token = ?
	`, strings.TrimSpace(token))

	var sessionToken string
	var authenticatedAt time.Time
	var expiresAt time.Time
	var impersonated bool
	var impersonationReason sql.NullString
	var user User
	var emailValue sql.NullString
	var phoneValue sql.NullString
	var avatarObjectKey sql.NullString
	var avatarSource sql.NullString
	var realnameVerifiedAt sql.NullTime

	err := row.Scan(
		&sessionToken,
		&authenticatedAt,
		&expiresAt,
		&impersonated,
		&impersonationReason,
		&user.ID,
		&user.Name,
		&emailValue,
		&phoneValue,
		&avatarObjectKey,
		&avatarSource,
		&user.InviteRequired,
		&realnameVerifiedAt,
		&user.CreatedAt,
	)
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

	user.Email = emailValue.String
	user.Phone = phoneValue.String
	user.AvatarObjectKey = avatarObjectKey.String
	user.AvatarSource = avatarSource.String
	user.RealnameVerified = realnameVerifiedAt.Valid
	session := &AuthSession{
		Token:               sessionToken,
		User:                user,
		AuthenticatedAt:     authenticatedAt,
		ExpiresAt:           expiresAt,
		Impersonated:        impersonated,
		ImpersonationReason: impersonationReason.String,
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
	user, err := loadUserByIDTx(ctx, tx, userID)
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

	user, err := loadUserByIDTx(ctx, tx, strings.TrimSpace(userID))
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
			updated_at = ?
		WHERE id = ?
	`, input.VerifiedAt, input.Provider, input.Result, nullableString(input.RequestID), input.NameCiphertext, input.IDCardCiphertext, input.NameMasked, input.IDCardMasked, input.VerifiedAt, userID); err != nil {
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
		SET name = ?, updated_at = ?
		WHERE id = ?
	`, strings.TrimSpace(name), now, userID); err != nil {
		return User{}, fmt.Errorf("update profile: %w", err)
	}
	user, err := loadUserByIDTx(ctx, tx, userID)
	if err != nil {
		return User{}, err
	}
	if err := tx.Commit(); err != nil {
		return User{}, fmt.Errorf("commit profile update: %w", err)
	}
	return user, nil
}

func (s *MySQLStore) SetUserAvatar(ctx context.Context, userID string, objectKey string, source string, now time.Time) (User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)

	if _, err := tx.ExecContext(ctx, `
		UPDATE users
		SET avatar_object_key = ?, avatar_source = ?, updated_at = ?
		WHERE id = ?
	`, strings.TrimSpace(objectKey), strings.TrimSpace(source), now, strings.TrimSpace(userID)); err != nil {
		return User{}, fmt.Errorf("update user avatar: %w", err)
	}
	user, err := loadUserByIDTx(ctx, tx, strings.TrimSpace(userID))
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

	if _, err := tx.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, userID); err != nil {
		return fmt.Errorf("delete user: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit delete user: %w", err)
	}
	return nil
}

func (s *MySQLStore) DeleteAdminUser(ctx context.Context, userID string, _ time.Time) error {
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

	if _, err := tx.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, existing); err != nil {
		return fmt.Errorf("delete user: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit delete user: %w", err)
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

func (s *MySQLStore) findOrCreatePhoneUserTx(ctx context.Context, tx *sql.Tx, phone string, name string, now time.Time) (User, bool, error) {
	row := tx.QueryRowContext(ctx, `
		SELECT id, name, email, phone, invite_required, realname_verified_at, created_at
		, avatar_object_key, avatar_source
		FROM users
		WHERE phone = ?
		FOR UPDATE
	`, phone)

	var user User
	var emailValue sql.NullString
	var phoneValue sql.NullString
	var realnameVerifiedAt sql.NullTime
	var avatarObjectKey sql.NullString
	var avatarSource sql.NullString
	err := row.Scan(&user.ID, &user.Name, &emailValue, &phoneValue, &user.InviteRequired, &realnameVerifiedAt, &user.CreatedAt, &avatarObjectKey, &avatarSource)
	switch {
	case err == nil:
		user.Email = emailValue.String
		user.Phone = phoneValue.String
		user.RealnameVerified = realnameVerifiedAt.Valid
		user.AvatarObjectKey = avatarObjectKey.String
		user.AvatarSource = avatarSource.String
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
		if name != "" && name != user.Name {
			if _, updateErr := tx.ExecContext(ctx, `
				UPDATE users
				SET name = ?, updated_at = ?
				WHERE id = ?
			`, name, now, user.ID); updateErr != nil {
				return User{}, false, fmt.Errorf("update phone user name: %w", updateErr)
			}
			user.Name = name
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
	row := tx.QueryRowContext(ctx, `
		SELECT
			u.id,
			u.name,
			u.email,
			u.phone,
			u.avatar_object_key,
			u.avatar_source,
			u.invite_required,
			u.realname_verified_at,
			u.created_at
		FROM oauth_identities oi
		INNER JOIN users u ON u.id = oi.user_id
		WHERE oi.provider = ? AND oi.provider_subject = ?
		FOR UPDATE
	`, input.Provider, input.ProviderSubject)

	var user User
	var emailValue sql.NullString
	var phoneValue sql.NullString
	var avatarObjectKey sql.NullString
	var avatarSource sql.NullString
	var realnameVerifiedAt sql.NullTime
	err := row.Scan(&user.ID, &user.Name, &emailValue, &phoneValue, &avatarObjectKey, &avatarSource, &user.InviteRequired, &realnameVerifiedAt, &user.CreatedAt)
	switch {
	case err == nil:
		user.Email = emailValue.String
		user.Phone = phoneValue.String
		user.AvatarObjectKey = avatarObjectKey.String
		user.AvatarSource = avatarSource.String
		user.RealnameVerified = realnameVerifiedAt.Valid
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
			if !input.EmailVerified {
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

func createSessionTx(ctx context.Context, tx *sql.Tx, user User, now time.Time, sessionTTL time.Duration) (*AuthSession, error) {
	return createSessionWithMetadataTx(ctx, tx, user, now, sessionTTL, false, "")
}

func createImpersonationSessionTx(ctx context.Context, tx *sql.Tx, user User, reason string, now time.Time, sessionTTL time.Duration) (*AuthSession, error) {
	return createSessionWithMetadataTx(ctx, tx, user, now, sessionTTL, true, strings.TrimSpace(reason))
}

func createSessionWithMetadataTx(ctx context.Context, tx *sql.Tx, user User, now time.Time, sessionTTL time.Duration, impersonated bool, reason string) (*AuthSession, error) {
	token, err := newOpaqueToken()
	if err != nil {
		return nil, fmt.Errorf("create session token: %w", err)
	}
	expiresAt := now.Add(sessionTTL)
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO auth_sessions (
			token,
			user_id,
			impersonated,
			impersonation_reason,
			authenticated_at,
			expires_at,
			created_at,
			updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`, token, user.ID, impersonated, nullableString(strings.TrimSpace(reason)), now, expiresAt, now, now); err != nil {
		return nil, fmt.Errorf("insert auth session: %w", err)
	}

	return &AuthSession{
		Token:               token,
		User:                user,
		AuthenticatedAt:     now,
		ExpiresAt:           expiresAt,
		Impersonated:        impersonated,
		ImpersonationReason: strings.TrimSpace(reason),
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

func loadUserByIDTx(ctx context.Context, tx *sql.Tx, userID string) (User, error) {
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
			created_at
		FROM users
		WHERE id = ?
		FOR UPDATE
	`, userID)

	var user User
	var emailValue sql.NullString
	var phoneValue sql.NullString
	var avatarObjectKey sql.NullString
	var avatarSource sql.NullString
	var realnameVerifiedAt sql.NullTime
	if err := row.Scan(
		&user.ID,
		&user.Name,
		&emailValue,
		&phoneValue,
		&avatarObjectKey,
		&avatarSource,
		&user.InviteRequired,
		&realnameVerifiedAt,
		&user.CreatedAt,
	); errors.Is(err, sql.ErrNoRows) {
		return User{}, newError("user_not_found", "用户不存在。", 404)
	} else if err != nil {
		return User{}, fmt.Errorf("query user: %w", err)
	}

	user.Email = emailValue.String
	user.Phone = phoneValue.String
	user.AvatarObjectKey = avatarObjectKey.String
	user.AvatarSource = avatarSource.String
	user.RealnameVerified = realnameVerifiedAt.Valid
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
			created_at
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
	if err := row.Scan(
		&user.ID,
		&user.Name,
		&emailValue,
		&phoneValue,
		&avatarObjectKey,
		&avatarSource,
		&user.InviteRequired,
		&realnameVerifiedAt,
		&user.CreatedAt,
	); errors.Is(err, sql.ErrNoRows) {
		return User{}, false, nil
	} else if err != nil {
		return User{}, false, fmt.Errorf("query user by email: %w", err)
	}

	user.Email = emailValue.String
	user.Phone = phoneValue.String
	user.AvatarObjectKey = avatarObjectKey.String
	user.AvatarSource = avatarSource.String
	user.RealnameVerified = realnameVerifiedAt.Valid
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
