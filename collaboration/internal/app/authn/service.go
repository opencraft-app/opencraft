// Package authn 实现统一的凭证 currentness 认证门禁。
package authn

import (
	"context"
	"errors"

	"git.woa.com/wisp/mono2/collaboration/internal/apperror"
	authnport "git.woa.com/wisp/mono2/collaboration/internal/ports/authn"
)

// ErrAuthenticatorRequired 表示应用未配置认证器。
var ErrAuthenticatorRequired = errors.New("认证器不能为空")

// Service 把凭证认证集中在一个应用入口。
type Service struct {
	authenticator authnport.Authenticator
}

// NewService 创建认证服务。
func NewService(authenticator authnport.Authenticator) (*Service, error) {
	if authenticator == nil {
		return nil, ErrAuthenticatorRequired
	}
	return &Service{authenticator: authenticator}, nil
}

// Authenticate 验证候选凭证，并再次核对候选与主体类型。
func (s *Service) Authenticate(
	ctx context.Context,
	candidate authnport.CredentialCandidate,
) (authnport.CurrentPrincipal, error) {
	if s == nil || s.authenticator == nil || candidate == nil {
		return nil, apperror.New("internal_error", "认证服务暂不可用", nil)
	}

	principal, err := s.authenticator.Authenticate(ctx, candidate)
	if err != nil {
		return nil, err
	}
	if principal == nil || !principalMatchesCandidate(principal, candidate) {
		return nil, candidateMismatchError(candidate.Kind())
	}
	return principal, nil
}

func principalMatchesCandidate(
	principal authnport.CurrentPrincipal,
	candidate authnport.CredentialCandidate,
) bool {
	switch candidate.Kind() {
	case authnport.CandidateAnonymous:
		return principal.Kind() == authnport.PrincipalAnonymous
	case authnport.CandidateHumanBearer, authnport.CandidateGatewayHuman:
		return principal.Kind() == authnport.PrincipalHuman
	case authnport.CandidateRuntimeBearer:
		return principal.Kind() == authnport.PrincipalRuntime
	case authnport.CandidateAgentCredential:
		return principal.Kind() == authnport.PrincipalAgentCredential
	case authnport.CandidateComputerBearer,
		authnport.CandidateComputerCredential:
		return principal.Kind() == authnport.PrincipalComputer
	case authnport.CandidateBotCredential:
		return principal.Kind() == authnport.PrincipalBotCredential
	case authnport.CandidateBotRuntimeBearer:
		return principal.Kind() == authnport.PrincipalBotRuntime
	case authnport.CandidateAdminBearer:
		return principal.Kind() == authnport.PrincipalAdmin
	default:
		return false
	}
}

func candidateMismatchError(kind authnport.CandidateKind) error {
	if kind == authnport.CandidateComputerBearer ||
		kind == authnport.CandidateComputerCredential {
		return apperror.New(
			"computer_credential_invalid",
			"Computer 凭证无效",
			nil,
		)
	}
	if kind == authnport.CandidateRuntimeBearer ||
		kind == authnport.CandidateAgentCredential ||
		kind == authnport.CandidateBotCredential ||
		kind == authnport.CandidateBotRuntimeBearer {
		return apperror.New(
			"runtime_credential_invalid",
			"Runtime 或 Agent 凭证无效",
			nil,
		)
	}
	return apperror.New("unauthenticated", "登录凭证无效", nil)
}
