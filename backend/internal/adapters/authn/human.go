// Package authn 提供具体凭证到当前主体的认证适配器。
package authn

import (
	"context"
	"errors"

	"chatserver/internal/apperror"
	accountauthport "chatserver/internal/ports/accountauth"
	authnport "chatserver/internal/ports/authn"
	clockport "chatserver/internal/ports/clock"
	tokenport "chatserver/internal/ports/token"
)

// HumanAuthenticator 校验 Human access token 及数据库会话当前性。
type HumanAuthenticator struct {
	tokens tokenport.Signer
	store  accountauthport.SessionCurrentnessStore
	clock  clockport.Clock
}

// NewHumanAuthenticator 创建 Human Bearer 认证器。
func NewHumanAuthenticator(
	tokens tokenport.Signer,
	store accountauthport.SessionCurrentnessStore,
	clock clockport.Clock,
) (*HumanAuthenticator, error) {
	if tokens == nil || store == nil || clock == nil {
		return nil, errors.New("Human 认证器配置无效")
	}
	return &HumanAuthenticator{
		tokens: tokens,
		store:  store,
		clock:  clock,
	}, nil
}

// Authenticate 验证签名、用途、到期和 session/account 当前性。
func (a *HumanAuthenticator) Authenticate(
	ctx context.Context,
	candidate authnport.CredentialCandidate,
) (authnport.CurrentPrincipal, error) {
	humanCandidate, ok := candidate.(authnport.HumanBearerCandidate)
	if !ok {
		return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	claims, err := a.tokens.Verify(
		ctx,
		humanCandidate.Credential().Reveal(),
	)
	switch {
	case errors.Is(err, tokenport.ErrExpiredToken):
		return nil, apperror.New("token_expired", "登录凭证已过期", err)
	case err != nil:
		return nil, apperror.New("unauthenticated", "登录凭证无效", err)
	case claims.Kind() != tokenport.ClaimsHumanAccess:
		return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
	}

	current, err := a.store.FindCurrentSession(
		ctx,
		claims.AccountID(),
		claims.SessionID(),
		a.clock.Now().UTC(),
	)
	if err != nil {
		return nil, apperror.New("internal_error", "暂时无法验证登录会话", err)
	}
	if current.Status != accountauthport.SessionCurrent ||
		current.Account.ID != claims.AccountID() ||
		current.Account.TokenVersion != claims.Version() {
		return nil, apperror.New("session_revoked", "登录会话已失效", nil)
	}
	principal, err := authnport.NewCurrentHumanPrincipal(
		claims.AccountID(),
		claims.SessionID(),
		claims.Version(),
	)
	if err != nil {
		return nil, apperror.New("unauthenticated", "登录凭证无效", err)
	}
	return principal, nil
}
