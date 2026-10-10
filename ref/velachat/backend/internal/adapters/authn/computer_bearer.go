package authn

import (
	"context"
	"errors"

	"chatserver/internal/apperror"
	authnport "chatserver/internal/ports/authn"
	computerauthport "chatserver/internal/ports/computerauth"
	tokenport "chatserver/internal/ports/token"
)

type ComputerBearerAuthenticator struct {
	tokens     tokenport.Signer
	repository computerauthport.Repository
}

func NewComputerBearerAuthenticator(
	tokens tokenport.Signer,
	repository computerauthport.Repository,
) (*ComputerBearerAuthenticator, error) {
	if tokens == nil || repository == nil {
		return nil, errors.New("Computer Bearer 认证器配置无效")
	}
	return &ComputerBearerAuthenticator{tokens: tokens, repository: repository}, nil
}

func (authenticator *ComputerBearerAuthenticator) Authenticate(
	ctx context.Context,
	candidate authnport.CredentialCandidate,
) (authnport.CurrentPrincipal, error) {
	typed, ok := candidate.(authnport.ComputerBearerCandidate)
	if !ok || authenticator == nil || authenticator.tokens == nil || authenticator.repository == nil {
		return nil, invalidComputerCredential(nil)
	}
	claims, err := authenticator.tokens.Verify(ctx, typed.Credential().Reveal())
	if err != nil || claims.Kind() != tokenport.ClaimsComputerAccess {
		return nil, invalidComputerCredential(err)
	}
	route := computerauthport.Route{
		ServerID:   claims.ServerID(),
		ComputerID: claims.ComputerID(),
		Version:    claims.Version(),
	}
	current, err := authenticator.repository.ConfirmCurrent(ctx, route)
	if err != nil {
		return nil, apperror.New("internal_error", "暂时无法验证 Computer 会话", err)
	}
	if !current {
		return nil, apperror.New("computer_credential_revoked", "Computer 会话对应凭据已失效", computerauthport.ErrCredentialNotCurrent)
	}
	principal, err := authnport.NewCurrentComputerPrincipal(
		route.ServerID,
		route.ComputerID,
		route.Version,
	)
	if err != nil {
		return nil, invalidComputerCredential(err)
	}
	return principal, nil
}
