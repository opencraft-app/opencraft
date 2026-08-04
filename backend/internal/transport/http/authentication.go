package httptransport

import (
	"context"
	"errors"
	"strings"

	appauthn "chatserver/internal/app/authn"
	"chatserver/internal/apperror"
	authnport "chatserver/internal/ports/authn"

	"github.com/getkin/kin-openapi/openapi3filter"
)

const (
	humanBearerScheme        = "HumanBearer"
	runtimeBearerScheme      = "RuntimeBearer"
	agentCredentialScheme    = "AgentCredentialAuth"
	computerBearerScheme     = "ComputerBearer"
	computerCredentialScheme = "ComputerCredentialAuth"
	computerBootstrapScheme  = "ComputerBootstrapAuth"
	enrollmentScheme         = "EnrollmentAuth"
)

// ErrAuthenticationServiceRequired 表示 transport 未配置认证应用服务。
var ErrAuthenticationServiceRequired = errors.New("认证应用服务不能为空")

// AuthenticationHook 把 OpenAPI security scheme 转换为统一认证调用。
type AuthenticationHook struct {
	service *appauthn.Service
}

// NewAuthenticationHook 创建 OpenAPI authentication hook。
func NewAuthenticationHook(service *appauthn.Service) (*AuthenticationHook, error) {
	if service == nil {
		return nil, ErrAuthenticationServiceRequired
	}
	return &AuthenticationHook{service: service}, nil
}

// Authenticate 实现 kin-openapi AuthenticationFunc。
func (h *AuthenticationHook) Authenticate(
	_ context.Context,
	input *openapi3filter.AuthenticationInput,
) error {
	if h == nil || h.service == nil ||
		input == nil ||
		input.RequestValidationInput == nil ||
		input.RequestValidationInput.Request == nil {
		return apperror.New("internal_error", "认证请求上下文无效", nil)
	}

	request := input.RequestValidationInput.Request
	state, ok := authStateFromContext(request.Context())
	if !ok {
		return apperror.New("internal_error", "认证状态尚未初始化", nil)
	}
	if input.SecuritySchemeName == enrollmentScheme {
		token, ok := parseAuthorization(
			request.Header.Get("Authorization"), "Enrollment",
		)
		if !ok || len(token) > 256 || !strings.HasPrefix(token, "cen1.") {
			return apperror.New("enrollment_invalid", "Computer 接入凭证无效", nil)
		}
		if err := state.setEnrollmentToken(token); err != nil {
			return apperror.New("internal_error", "认证状态写入失败", err)
		}
		return nil
	}

	candidate, err := candidateFromAuthorization(
		input.SecuritySchemeName,
		request.Header.Get("Authorization"),
	)
	if err != nil {
		return err
	}
	principal, err := h.service.Authenticate(request.Context(), candidate)
	if err != nil {
		return err
	}
	if err := state.setPrincipal(principal); err != nil {
		return apperror.New("internal_error", "认证状态写入失败", err)
	}
	return nil
}

func candidateFromAuthorization(
	scheme string,
	authorization string,
) (authnport.CredentialCandidate, error) {
	switch scheme {
	case humanBearerScheme:
		token, ok := parseAuthorization(authorization, "Bearer")
		if !ok {
			return nil, apperror.New("unauthenticated", "缺少 Human Bearer 凭证", nil)
		}
		candidate, err := authnport.NewHumanBearerCandidate(token)
		if err != nil {
			return nil, apperror.New("unauthenticated", "Human Bearer 凭证无效", err)
		}
		return candidate, nil
	case runtimeBearerScheme:
		token, ok := parseAuthorization(authorization, "Bearer")
		if !ok {
			return nil, apperror.New(
				"runtime_credential_invalid",
				"缺少 Runtime Bearer 凭证",
				nil,
			)
		}
		candidate, err := authnport.NewRuntimeBearerCandidate(token)
		if err != nil {
			return nil, apperror.New(
				"runtime_credential_invalid",
				"Runtime Bearer 凭证无效",
				err,
			)
		}
		return candidate, nil
	case agentCredentialScheme:
		secret, ok := parseAuthorization(authorization, "AgentCredential")
		if !ok {
			return nil, apperror.New(
				"runtime_credential_invalid",
				"缺少 Agent credential",
				nil,
			)
		}
		candidate, err := authnport.NewAgentCredentialCandidate(
			secret,
			credentialRoutePrefix(secret),
		)
		if err != nil {
			return nil, apperror.New(
				"runtime_credential_invalid",
				"Agent credential 无效",
				err,
			)
		}
		return candidate, nil
	case computerBearerScheme:
		token, ok := parseAuthorization(authorization, "Bearer")
		if !ok {
			return nil, apperror.New("computer_credential_invalid", "缺少 Computer Bearer 凭证", nil)
		}
		candidate, err := authnport.NewComputerBearerCandidate(token)
		if err != nil {
			return nil, apperror.New("computer_credential_invalid", "Computer Bearer 凭证无效", err)
		}
		return candidate, nil
	case computerCredentialScheme, computerBootstrapScheme:
		secret, ok := parseAuthorization(authorization, "ComputerCredential")
		if !ok {
			return nil, apperror.New("computer_credential_invalid", "缺少 Computer credential", nil)
		}
		candidate, err := authnport.NewComputerCredentialCandidate(
			secret,
			computerCredentialRoutePrefix(secret),
		)
		if err != nil {
			return nil, apperror.New("computer_credential_invalid", "Computer credential 无效", err)
		}
		return candidate, nil
	default:
		return nil, apperror.New("internal_error", "OpenAPI 认证方案未配置", nil)
	}
}

func parseAuthorization(value string, expectedScheme string) (string, bool) {
	parts := strings.Fields(value)
	if len(parts) != 2 || !strings.EqualFold(parts[0], expectedScheme) {
		return "", false
	}
	if parts[1] == "" {
		return "", false
	}
	return parts[1], true
}

func credentialRoutePrefix(secret string) string {
	first, _, ok := strings.Cut(secret, ".")
	if !ok || !strings.HasPrefix(first, "arc_") {
		return ""
	}
	serverID := strings.TrimPrefix(first, "arc_")
	if serverID == "" {
		return ""
	}
	return serverID
}

func computerCredentialRoutePrefix(secret string) string {
	first, _, ok := strings.Cut(secret, ".")
	if !ok || !strings.HasPrefix(first, "crc_") {
		return ""
	}
	return strings.TrimPrefix(first, "crc_")
}
