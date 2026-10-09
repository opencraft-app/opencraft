package authn

import (
	"context"
	"errors"

	"chatserver/internal/apperror"
	authnport "chatserver/internal/ports/authn"
	runtimeauthport "chatserver/internal/ports/runtimeauth"
	tokenport "chatserver/internal/ports/token"
)

// RuntimeBearerAuthenticator 校验短期 Runtime JWT 和凭据当前版本。
type RuntimeBearerAuthenticator struct {
	tokens     tokenport.Signer
	repository runtimeauthport.Repository
}

// NewRuntimeBearerAuthenticator 创建 Runtime Bearer 认证器。
func NewRuntimeBearerAuthenticator(
	tokens tokenport.Signer,
	repository runtimeauthport.Repository,
) (*RuntimeBearerAuthenticator, error) {
	if tokens == nil || repository == nil {
		return nil, errors.New("Runtime Bearer 认证器配置无效")
	}
	return &RuntimeBearerAuthenticator{
		tokens:     tokens,
		repository: repository,
	}, nil
}

// Authenticate 严格拒绝 Human access token，并实时复核 credential version。
func (a *RuntimeBearerAuthenticator) Authenticate(
	ctx context.Context,
	candidate authnport.CredentialCandidate,
) (authnport.CurrentPrincipal, error) {
	typed, ok := candidate.(authnport.RuntimeBearerCandidate)
	if !ok || a == nil || a.tokens == nil || a.repository == nil {
		return nil, invalidRuntimeBearer(nil)
	}
	claims, err := a.tokens.Verify(ctx, typed.Credential().Reveal())
	if err != nil || claims.Kind() != tokenport.ClaimsRuntimeAccess ||
		!claims.HasLaunchFence() {
		return nil, invalidRuntimeBearer(err)
	}
	route := runtimeauthport.LaunchRoute{
		ServerID:          claims.ServerID(),
		ComputerID:        claims.ComputerID(),
		AgentID:           claims.AgentID(),
		LaunchID:          claims.LaunchID(),
		AssignmentEpoch:   claims.AssignmentEpoch(),
		ConfigGeneration:  claims.ConfigGeneration(),
		CredentialVersion: claims.Version(),
		Attempt:           claims.Attempt(),
	}
	current, err := a.repository.ConfirmCurrentLaunch(ctx, route)
	if err != nil {
		return nil, apperror.New(
			"internal_error",
			"暂时无法验证 Runtime 会话",
			err,
		)
	}
	if !current {
		return nil, apperror.New(
			"runtime_credential_revoked",
			"Runtime 会话对应凭据已失效",
			runtimeauthport.ErrCredentialNotCurrent,
		)
	}
	principal, err := authnport.NewCurrentRuntimeLaunchPrincipal(
		route.ServerID,
		route.ComputerID,
		route.AgentID,
		route.LaunchID,
		route.AssignmentEpoch,
		route.ConfigGeneration,
		route.CredentialVersion,
		route.Attempt,
	)
	if err != nil {
		return nil, invalidRuntimeBearer(err)
	}
	return principal, nil
}

func invalidRuntimeBearer(cause error) error {
	return apperror.New(
		"runtime_credential_invalid",
		"Runtime 凭证无效",
		cause,
	)
}
