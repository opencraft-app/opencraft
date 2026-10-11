package httptransport

import (
	"context"
	"errors"
	"net/http"
	"sync"

	authnport "chatserver/internal/ports/authn"
)

var (
	errAuthStateMissing               = errors.New("请求缺少 AuthState")
	errPrincipalMissing               = errors.New("认证结果缺少 Principal")
	errPrincipalAlreadySet            = errors.New("AuthState 已写入 Principal")
	errEnrollmentTokenSet             = errors.New("AuthState 已写入 Enrollment token")
	errComputerPreflightCredentialSet = errors.New("AuthState 已写入 Computer preflight credential")
)

type authStateContextKey struct{}

// AuthState 保存单个请求的认证结果。
//
// 值只能由认证 hook 写入一次；该对象不得跨请求复用。
type AuthState struct {
	mu                                  sync.RWMutex
	principal                           authnport.CurrentPrincipal
	assigned                            bool
	enrollmentToken                     string
	enrollmentTokenAssigned             bool
	computerPreflightCredential         string
	computerPreflightCredentialAssigned bool
}

// CurrentComputerPreflightCredential 返回只供只读 preflight 应用服务验证的原始 credential。
// 它没有经过 currentness 门禁，也不构成平台 Principal。
func CurrentComputerPreflightCredential(ctx context.Context) (string, bool) {
	state, ok := authStateFromContext(ctx)
	if !ok {
		return "", false
	}
	return state.currentComputerPreflightCredential()
}

// CurrentEnrollmentToken 返回只在当前请求内保存的短期安装令牌。
// 它不是平台 Principal，完整授权仍由 enrollment 应用服务按分片校验。
func CurrentEnrollmentToken(ctx context.Context) (string, bool) {
	state, ok := authStateFromContext(ctx)
	if !ok {
		return "", false
	}
	return state.currentEnrollmentToken()
}

// WithAuthState 为每个请求创建独立的空认证状态。
func WithAuthState(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		state := &AuthState{}
		ctx := context.WithValue(request.Context(), authStateContextKey{}, state)
		next.ServeHTTP(writer, request.WithContext(ctx))
	})
}

// CurrentPrincipal 返回已通过认证和 currentness 校验的主体。
func CurrentPrincipal(
	ctx context.Context,
) (authnport.CurrentPrincipal, bool) {
	state, ok := authStateFromContext(ctx)
	if !ok {
		return nil, false
	}
	return state.currentPrincipal()
}

// CurrentHumanPrincipal 返回经过认证的自然人主体。
func CurrentHumanPrincipal(
	ctx context.Context,
) (authnport.CurrentHumanPrincipal, bool) {
	principal, ok := CurrentPrincipal(ctx)
	if !ok {
		return authnport.CurrentHumanPrincipal{}, false
	}
	typed, ok := principal.(authnport.CurrentHumanPrincipal)
	return typed, ok
}

// CurrentRuntimePrincipal 返回经过认证的 Runtime 主体。
func CurrentRuntimePrincipal(
	ctx context.Context,
) (authnport.CurrentRuntimePrincipal, bool) {
	principal, ok := CurrentPrincipal(ctx)
	if !ok {
		return authnport.CurrentRuntimePrincipal{}, false
	}
	typed, ok := principal.(authnport.CurrentRuntimePrincipal)
	return typed, ok
}

// CurrentAgentCredentialPrincipal 返回经过认证的 Agent credential 主体。
func CurrentAgentCredentialPrincipal(
	ctx context.Context,
) (authnport.CurrentAgentCredentialPrincipal, bool) {
	principal, ok := CurrentPrincipal(ctx)
	if !ok {
		return authnport.CurrentAgentCredentialPrincipal{}, false
	}
	typed, ok := principal.(authnport.CurrentAgentCredentialPrincipal)
	return typed, ok
}

// CurrentComputerPrincipal 返回经过认证和 currentness 校验的 Computer 主体。
func CurrentComputerPrincipal(
	ctx context.Context,
) (authnport.CurrentComputerPrincipal, bool) {
	principal, ok := CurrentPrincipal(ctx)
	if !ok {
		return authnport.CurrentComputerPrincipal{}, false
	}
	typed, ok := principal.(authnport.CurrentComputerPrincipal)
	return typed, ok
}

func authStateFromContext(ctx context.Context) (*AuthState, bool) {
	if ctx == nil {
		return nil, false
	}
	state, ok := ctx.Value(authStateContextKey{}).(*AuthState)
	return state, ok && state != nil
}

func (s *AuthState) setPrincipal(
	principal authnport.CurrentPrincipal,
) error {
	if s == nil {
		return errAuthStateMissing
	}
	if principal == nil {
		return errPrincipalMissing
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.assigned {
		return errPrincipalAlreadySet
	}
	s.principal = principal
	s.assigned = true
	return nil
}

func (s *AuthState) currentPrincipal() (authnport.CurrentPrincipal, bool) {
	if s == nil {
		return nil, false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.principal, s.assigned && s.principal != nil
}

func (s *AuthState) setEnrollmentToken(token string) error {
	if s == nil {
		return errAuthStateMissing
	}
	if token == "" {
		return errPrincipalMissing
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.enrollmentTokenAssigned {
		return errEnrollmentTokenSet
	}
	s.enrollmentToken = token
	s.enrollmentTokenAssigned = true
	return nil
}

func (s *AuthState) currentEnrollmentToken() (string, bool) {
	if s == nil {
		return "", false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.enrollmentToken, s.enrollmentTokenAssigned && s.enrollmentToken != ""
}

func (s *AuthState) setComputerPreflightCredential(credential string) error {
	if s == nil {
		return errAuthStateMissing
	}
	if credential == "" {
		return errPrincipalMissing
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.computerPreflightCredentialAssigned {
		return errComputerPreflightCredentialSet
	}
	s.computerPreflightCredential = credential
	s.computerPreflightCredentialAssigned = true
	return nil
}

func (s *AuthState) currentComputerPreflightCredential() (string, bool) {
	if s == nil {
		return "", false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.computerPreflightCredential,
		s.computerPreflightCredentialAssigned && s.computerPreflightCredential != ""
}
