package authn

import (
	"context"
	"crypto/subtle"
	"errors"

	"git.woa.com/wisp/mono2/collaboration/internal/apperror"
	authnport "git.woa.com/wisp/mono2/collaboration/internal/ports/authn"
)

// AdminBearerAuthenticator 校验管理后台 BFF 的服务端 Token。
type AdminBearerAuthenticator struct {
	token []byte
}

func NewAdminBearerAuthenticator(token []byte) (*AdminBearerAuthenticator, error) {
	if len(token) < 24 {
		return nil, errors.New("管理员 Token 至少 24 字节")
	}
	return &AdminBearerAuthenticator{token: append([]byte(nil), token...)}, nil
}

func (authenticator *AdminBearerAuthenticator) Authenticate(
	_ context.Context,
	candidate authnport.CredentialCandidate,
) (authnport.CurrentPrincipal, error) {
	admin, ok := candidate.(authnport.AdminBearerCandidate)
	if !ok {
		return nil, apperror.New("unauthenticated", "管理员 Token 无效", nil)
	}
	presented := []byte(admin.Credential().Reveal())
	if len(presented) != len(authenticator.token) || subtle.ConstantTimeCompare(presented, authenticator.token) != 1 {
		return nil, apperror.New("unauthenticated", "管理员 Token 无效", nil)
	}
	return authnport.NewCurrentAdminPrincipal(), nil
}
