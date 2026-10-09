package authn

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"strconv"
	"strings"

	"chatserver/internal/apperror"
	authnport "chatserver/internal/ports/authn"
	runtimeauthport "chatserver/internal/ports/runtimeauth"

	"github.com/google/uuid"
)

const agentCredentialPrefix = "arc_"

// AgentCredentialAuthenticator 校验长期 Agent credential 及数据库当前性。
type AgentCredentialAuthenticator struct {
	repository runtimeauthport.Repository
}

// NewAgentCredentialAuthenticator 创建 Agent credential 认证器。
func NewAgentCredentialAuthenticator(
	repository runtimeauthport.Repository,
) (*AgentCredentialAuthenticator, error) {
	if repository == nil {
		return nil, errors.New("Agent credential Repository 不能为空")
	}
	return &AgentCredentialAuthenticator{repository: repository}, nil
}

// Authenticate 先点查公开路由键，再校验完整摘要并二次确认当前性。
func (a *AgentCredentialAuthenticator) Authenticate(
	ctx context.Context,
	candidate authnport.CredentialCandidate,
) (authnport.CurrentPrincipal, error) {
	typed, ok := candidate.(authnport.AgentCredentialCandidate)
	if !ok || a == nil || a.repository == nil {
		return nil, invalidAgentCredential(nil)
	}
	raw := typed.Credential().Reveal()
	route, err := parseAgentCredentialRoute(raw)
	if err != nil {
		return nil, invalidAgentCredential(err)
	}
	if hint := strings.TrimSpace(typed.RoutePrefix()); hint != "" &&
		hint != route.ServerID {
		return nil, invalidAgentCredential(runtimeauthport.ErrInvalidRoute)
	}

	stored, err := a.repository.FindCurrent(ctx, route)
	switch {
	case errors.Is(err, runtimeauthport.ErrCredentialNotCurrent):
		return nil, invalidAgentCredential(err)
	case err != nil:
		return nil, apperror.New(
			"internal_error",
			"暂时无法验证 Agent credential",
			err,
		)
	case stored.Route != route:
		return nil, invalidAgentCredential(runtimeauthport.ErrCredentialNotCurrent)
	}
	actual := sha256.Sum256([]byte(raw))
	if subtle.ConstantTimeCompare(
		actual[:],
		stored.SecretDigest[:],
	) != 1 {
		return nil, invalidAgentCredential(nil)
	}

	current, err := a.repository.ConfirmCurrent(ctx, route)
	if err != nil {
		return nil, apperror.New(
			"internal_error",
			"暂时无法确认 Agent credential",
			err,
		)
	}
	if !current {
		return nil, invalidAgentCredential(runtimeauthport.ErrCredentialNotCurrent)
	}
	principal, err := authnport.NewCurrentAgentCredentialPrincipal(
		route.ServerID,
		route.AgentID,
		route.Version,
	)
	if err != nil {
		return nil, invalidAgentCredential(err)
	}
	return principal, nil
}

func parseAgentCredentialRoute(raw string) (runtimeauthport.Route, error) {
	parts := strings.Split(raw, ".")
	if len(parts) != 4 || !strings.HasPrefix(parts[0], agentCredentialPrefix) {
		return runtimeauthport.Route{}, runtimeauthport.ErrInvalidRoute
	}
	serverID := strings.TrimPrefix(parts[0], agentCredentialPrefix)
	if !isUUIDv7(serverID) || !isUUIDv7(parts[1]) {
		return runtimeauthport.Route{}, runtimeauthport.ErrInvalidRoute
	}
	version, err := strconv.ParseUint(parts[2], 10, 64)
	if err != nil || version == 0 || strconv.FormatUint(version, 10) != parts[2] {
		return runtimeauthport.Route{}, runtimeauthport.ErrInvalidRoute
	}
	secret, err := base64.RawURLEncoding.Strict().DecodeString(parts[3])
	if err != nil || len(secret) != 32 {
		return runtimeauthport.Route{}, runtimeauthport.ErrInvalidRoute
	}
	return runtimeauthport.Route{
		ServerID: serverID,
		AgentID:  parts[1],
		Version:  version,
	}, nil
}

func isUUIDv7(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed != uuid.Nil && parsed.Version() == 7
}

func invalidAgentCredential(cause error) error {
	return apperror.New(
		"runtime_credential_invalid",
		"Agent credential 无效或已失效",
		cause,
	)
}
