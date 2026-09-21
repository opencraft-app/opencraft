package authn

import (
	"context"
	"crypto/subtle"
	"errors"

	"git.woa.com/wisp/mono2/collaboration/internal/apperror"
	authnport "git.woa.com/wisp/mono2/collaboration/internal/ports/authn"
)

// GatewayHumanResolver maps one verified LightVela subject to a local actor.
type GatewayHumanResolver interface {
	ResolveOrCreate(context.Context, string) (string, error)
}

// GatewayHumanAuthenticator authenticates the private service-gateway hop.
type GatewayHumanAuthenticator struct {
	token    []byte
	resolver GatewayHumanResolver
}

func NewGatewayHumanAuthenticator(
	token []byte,
	resolver GatewayHumanResolver,
) (*GatewayHumanAuthenticator, error) {
	if len(token) < 20 || resolver == nil {
		return nil, errors.New("LightVela gateway Human 认证器配置无效")
	}
	return &GatewayHumanAuthenticator{
		token:    append([]byte(nil), token...),
		resolver: resolver,
	}, nil
}

func (authenticator *GatewayHumanAuthenticator) Authenticate(
	ctx context.Context,
	candidate authnport.CredentialCandidate,
) (authnport.CurrentPrincipal, error) {
	gatewayCandidate, ok := candidate.(authnport.GatewayHumanCandidate)
	if !ok {
		return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	presented := []byte(gatewayCandidate.Credential().Reveal())
	if len(presented) != len(authenticator.token) ||
		subtle.ConstantTimeCompare(presented, authenticator.token) != 1 {
		return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	accountID, err := authenticator.resolver.ResolveOrCreate(
		ctx,
		gatewayCandidate.ExternalSubject(),
	)
	if err != nil {
		return nil, apperror.New("internal_error", "暂时无法映射 LightVela 账号", err)
	}
	principal, err := authnport.NewCurrentGatewayHumanPrincipal(
		accountID,
		gatewayCandidate.ExternalSubject(),
	)
	if err != nil {
		return nil, apperror.New("unauthenticated", "登录凭证无效", err)
	}
	return principal, nil
}
