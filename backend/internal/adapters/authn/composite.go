package authn

import (
	"context"
	"errors"

	"chatserver/internal/apperror"
	authnport "chatserver/internal/ports/authn"
)

// CompositeAuthenticator 按 CandidateKind 精确分派到单一认证器。
type CompositeAuthenticator struct {
	byKind map[authnport.CandidateKind]authnport.Authenticator
}

// NewCompositeAuthenticator 复制并冻结候选类型到认证器的映射。
func NewCompositeAuthenticator(
	byKind map[authnport.CandidateKind]authnport.Authenticator,
) (*CompositeAuthenticator, error) {
	if len(byKind) == 0 {
		return nil, errors.New("组合认证器至少需要一个认证器")
	}
	copied := make(
		map[authnport.CandidateKind]authnport.Authenticator,
		len(byKind),
	)
	for kind, authenticator := range byKind {
		if !knownCandidateKind(kind) || authenticator == nil {
			return nil, errors.New("组合认证器注册无效")
		}
		copied[kind] = authenticator
	}
	return &CompositeAuthenticator{byKind: copied}, nil
}

// Authenticate 只调用与候选种类完全对应的认证器。
func (a *CompositeAuthenticator) Authenticate(
	ctx context.Context,
	candidate authnport.CredentialCandidate,
) (authnport.CurrentPrincipal, error) {
	if a == nil || candidate == nil {
		return nil, apperror.New("internal_error", "认证服务暂不可用", nil)
	}
	authenticator, ok := a.byKind[candidate.Kind()]
	if !ok {
		return nil, unsupportedCandidate(candidate.Kind())
	}
	return authenticator.Authenticate(ctx, candidate)
}

func knownCandidateKind(kind authnport.CandidateKind) bool {
	switch kind {
	case authnport.CandidateAnonymous,
		authnport.CandidateHumanBearer,
		authnport.CandidateRuntimeBearer,
		authnport.CandidateAgentCredential,
		authnport.CandidateComputerBearer,
		authnport.CandidateComputerCredential:
		return true
	default:
		return false
	}
}

func unsupportedCandidate(kind authnport.CandidateKind) error {
	if kind == authnport.CandidateRuntimeBearer ||
		kind == authnport.CandidateAgentCredential ||
		kind == authnport.CandidateComputerBearer ||
		kind == authnport.CandidateComputerCredential {
		return apperror.New(
			"runtime_credential_invalid",
			"Runtime 或 Agent 凭证无效",
			nil,
		)
	}
	return apperror.New("unauthenticated", "登录凭证无效", nil)
}
