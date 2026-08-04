// Package accountauth 提供自然人认证 Repository 的 Ent 实现。
package accountauth

import (
	"context"
	"crypto/subtle"
	"errors"
	"time"

	"chatserver/internal/database"
	"chatserver/internal/ent"
	"chatserver/internal/ent/account"
	"chatserver/internal/ent/accountloginidentity"
	"chatserver/internal/ent/authsession"
	accountauthport "chatserver/internal/ports/accountauth"
)

// EntRepository 使用数据库 Handle 保证认证写操作的事务边界。
type EntRepository struct {
	handle *database.Handle
}

// NewEntRepository 创建认证 Repository。
func NewEntRepository(handle *database.Handle) (*EntRepository, error) {
	if handle == nil || handle.Client() == nil {
		return nil, errors.New("认证 Repository 缺少数据库 Handle")
	}
	return &EntRepository{handle: handle}, nil
}

// Register 原子创建 login registry、Account 和首个 AuthSession。
func (r *EntRepository) Register(
	ctx context.Context,
	input accountauthport.Registration,
) error {
	err := r.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		_, err := tx.AccountLoginIdentity.Create().
			SetLoginHash(input.Login.Hash).
			SetKind(input.Login.Kind).
			SetNormalizedLogin(input.Login.Normalized).
			SetAccountID(input.Account.ID).
			SetState("active").
			Save(ctx)
		if ent.IsConstraintError(err) {
			return accountauthport.ErrLoginConflict
		}
		if err != nil {
			return err
		}
		if _, err := createAccount(tx.Account.Create(), input.Account).Save(ctx); err != nil {
			return err
		}
		_, err = createSession(
			tx.AuthSession.Create(),
			input.Account.ID,
			input.Session,
			input.Session.FamilyID,
		).Save(ctx)
		if err != nil {
			return err
		}
		operation, err := tx.TencentOperation.Create().
			SetPartitionKey(input.Account.ID).
			SetService("im").
			SetKind("im.identity.ensure").
			SetResourceType("account").
			SetResourceID(input.Account.ID).
			SetIdempotencyKey("account:" + input.Account.ID + ":im.identity.ensure:v1").
			SetDesiredRevision(int64(input.Account.Revision)).
			SetState("pending").
			SetAttempts(0).
			SetCreatedAt(input.OccurredAt.UTC()).
			SetUpdatedAt(input.OccurredAt.UTC()).
			Save(ctx)
		if err != nil {
			return err
		}
		_, err = tx.OutboxEvent.Create().
			SetPartitionKey(input.Account.ID).
			SetEventType("tencent.operation.ready").
			SetAggregateType("tencent_operation").
			SetAggregateID(operation.ID).
			SetState("pending").
			SetAttempts(0).
			SetAvailableAt(input.OccurredAt.UTC()).
			SetCreatedAt(input.OccurredAt.UTC()).
			Save(ctx)
		return err
	})
	if errors.Is(err, accountauthport.ErrLoginConflict) {
		return accountauthport.ErrLoginConflict
	}
	return err
}

// FindCredentialByLogin 先点查 registry，再以 normalized_login 复核哈希碰撞。
func (r *EntRepository) FindCredentialByLogin(
	ctx context.Context,
	login accountauthport.LoginIdentity,
) (accountauthport.CredentialAccount, error) {
	identity, err := r.handle.Client().AccountLoginIdentity.Query().
		Where(
			accountloginidentity.LoginHashEQ(login.Hash),
			accountloginidentity.KindEQ(login.Kind),
			accountloginidentity.StateEQ("active"),
		).
		Only(ctx)
	if ent.IsNotFound(err) {
		return accountauthport.CredentialAccount{}, accountauthport.ErrLoginNotFound
	}
	if err != nil {
		return accountauthport.CredentialAccount{}, err
	}
	if subtle.ConstantTimeCompare(
		[]byte(identity.NormalizedLogin),
		[]byte(login.Normalized),
	) != 1 {
		return accountauthport.CredentialAccount{}, accountauthport.ErrLoginNotFound
	}
	entity, err := r.handle.Client().Account.Query().
		Where(account.IDEQ(identity.AccountID)).
		Only(ctx)
	if ent.IsNotFound(err) {
		return accountauthport.CredentialAccount{}, accountauthport.ErrLoginNotFound
	}
	if err != nil {
		return accountauthport.CredentialAccount{}, err
	}
	return accountauthport.CredentialAccount{
		Account:      mapAccount(entity),
		PasswordHash: entity.PasswordHash,
	}, nil
}

// CreateSession 创建新的独立登录 session family。
func (r *EntRepository) CreateSession(
	ctx context.Context,
	accountID string,
	session accountauthport.SessionDraft,
) error {
	_, err := createSession(
		r.handle.Client().AuthSession.Create(),
		accountID,
		session,
		session.FamilyID,
	).Save(ctx)
	return err
}

// RotateSession 对旧 token 执行单次消费并在同 family 创建下一条 session。
func (r *EntRepository) RotateSession(
	ctx context.Context,
	rotation accountauthport.Rotation,
) (result accountauthport.RotationResult, returnErr error) {
	returnErr = r.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		current, err := tx.AuthSession.Query().
			Where(
				authsession.IDEQ(rotation.SessionID),
				authsession.AccountIDEQ(rotation.AccountID),
			).
			Only(ctx)
		if ent.IsNotFound(err) {
			result.Status = accountauthport.RotationInvalid
			return nil
		}
		if err != nil {
			return err
		}
		if subtle.ConstantTimeCompare(
			current.RefreshTokenHash,
			rotation.PresentedDigest[:],
		) != 1 {
			result.Status = accountauthport.RotationInvalid
			return nil
		}
		if current.RevokedAt != nil {
			result.Status = accountauthport.RotationRevoked
			return nil
		}
		if current.UsedAt != nil {
			if _, err := tx.AuthSession.Update().
				Where(
					authsession.AccountIDEQ(current.AccountID),
					authsession.FamilyIDEQ(current.FamilyID),
					authsession.RevokedAtIsNil(),
				).
				SetRevokedAt(rotation.RotatedAt.UTC()).
				Save(ctx); err != nil {
				return err
			}
			result.Status = accountauthport.RotationReplayed
			return nil
		}
		if !rotation.RotatedAt.Before(current.ExpiresAt) {
			result.Status = accountauthport.RotationInvalid
			return nil
		}
		if _, err := tx.AuthSession.UpdateOne(current).
			SetUsedAt(rotation.RotatedAt.UTC()).
			Save(ctx); err != nil {
			return err
		}
		if _, err := createSession(
			tx.AuthSession.Create(),
			current.AccountID,
			rotation.Next,
			current.FamilyID,
		).Save(ctx); err != nil {
			return err
		}
		entity, err := tx.Account.Query().
			Where(account.IDEQ(current.AccountID)).
			Only(ctx)
		if err != nil {
			return err
		}
		result = accountauthport.RotationResult{
			Status:  accountauthport.RotationSucceeded,
			Account: mapAccount(entity),
		}
		return nil
	})
	return result, returnErr
}

// RevokeSession 幂等撤销指定账号的当前 session。
func (r *EntRepository) RevokeSession(
	ctx context.Context,
	accountID string,
	sessionID string,
	at time.Time,
) error {
	_, err := r.handle.Client().AuthSession.Update().
		Where(
			authsession.IDEQ(sessionID),
			authsession.AccountIDEQ(accountID),
			authsession.RevokedAtIsNil(),
		).
		SetRevokedAt(at.UTC()).
		Save(ctx)
	return err
}

// FindCurrentSession 校验 access token 绑定的 session 状态。
func (r *EntRepository) FindCurrentSession(
	ctx context.Context,
	accountID string,
	sessionID string,
	now time.Time,
) (accountauthport.CurrentSession, error) {
	session, err := r.handle.Client().AuthSession.Query().
		Where(
			authsession.IDEQ(sessionID),
			authsession.AccountIDEQ(accountID),
		).
		Only(ctx)
	if ent.IsNotFound(err) {
		return accountauthport.CurrentSession{
			Status: accountauthport.SessionInvalid,
		}, nil
	}
	if err != nil {
		return accountauthport.CurrentSession{}, err
	}
	switch {
	case session.RevokedAt != nil || session.UsedAt != nil:
		return accountauthport.CurrentSession{
			Status: accountauthport.SessionRevoked,
		}, nil
	case !now.UTC().Before(session.ExpiresAt):
		return accountauthport.CurrentSession{
			Status: accountauthport.SessionExpired,
		}, nil
	}
	entity, err := r.handle.Client().Account.Query().
		Where(account.IDEQ(accountID)).
		Only(ctx)
	if ent.IsNotFound(err) {
		return accountauthport.CurrentSession{
			Status: accountauthport.SessionInvalid,
		}, nil
	}
	if err != nil {
		return accountauthport.CurrentSession{}, err
	}
	return accountauthport.CurrentSession{
		Status:  accountauthport.SessionCurrent,
		Account: mapAccount(entity),
	}, nil
}

func createAccount(
	builder *ent.AccountCreate,
	input accountauthport.AccountDraft,
) *ent.AccountCreate {
	return builder.
		SetID(input.ID).
		SetEmail(input.Email).
		SetEmailNormalized(input.EmailNormalized).
		SetDisplayName(input.DisplayName).
		SetPasswordHash(input.PasswordHash).
		SetTokenVersion(int64(input.TokenVersion)).
		SetImUserID(input.IMUserID).
		SetImState(input.IMState).
		SetRevision(int64(input.Revision))
}

func createSession(
	builder *ent.AuthSessionCreate,
	accountID string,
	session accountauthport.SessionDraft,
	familyID string,
) *ent.AuthSessionCreate {
	return builder.
		SetID(session.ID).
		SetAccountID(accountID).
		SetFamilyID(familyID).
		SetRefreshTokenHash(append([]byte(nil), session.TokenDigest[:]...)).
		SetExpiresAt(session.ExpiresAt.UTC())
}

func mapAccount(entity *ent.Account) accountauthport.Account {
	tokenVersion := uint64(0)
	revision := uint64(0)
	if entity.TokenVersion >= 0 {
		tokenVersion = uint64(entity.TokenVersion)
	}
	if entity.Revision >= 0 {
		revision = uint64(entity.Revision)
	}
	return accountauthport.Account{
		ID:           entity.ID,
		Email:        entity.Email,
		DisplayName:  entity.DisplayName,
		IMUserID:     entity.ImUserID,
		IMState:      entity.ImState,
		TokenVersion: tokenVersion,
		Revision:     revision,
	}
}
