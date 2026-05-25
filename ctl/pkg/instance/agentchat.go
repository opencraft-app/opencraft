package instance

import (
	"errors"
	"strings"
	"time"

	"ctl/pkg/agentchat"
	"ctl/pkg/config"
	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	"ctl/pkg/transport"
)

func (l *logic) CreateAgentChatLaunchToken(ctx pctx.Context, instanceID string) (*transport.AgentChatLaunchTokenResponse, error) {
	entity, err := l.loadOwnedRunningInstance(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	token, expiresAt, err := agentchat.IssueLaunchToken(agentChatConfig(), ctx.GetUserID(), entity.InstanceId, time.Now())
	if err != nil {
		return nil, mapAgentChatIssueError(err)
	}
	return &transport.AgentChatLaunchTokenResponse{
		LaunchToken: token,
		ExpiresAt:   expiresAt,
	}, nil
}

func (l *logic) IntrospectAgentChatLaunchToken(ctx pctx.Context, req *transport.AgentChatIntrospectRequest) (*transport.AgentChatIntrospectResponse, error) {
	if req == nil {
		return nil, errcode.Wrap(errcode.ErrInvalidParam, "missing request body")
	}
	cfg := agentChatConfig()
	now := time.Now()
	callback := agentchat.CallbackRequest{
		LaunchToken:  strings.TrimSpace(req.LaunchToken),
		BusinessCode: strings.TrimSpace(req.BusinessCode),
		Timestamp:    req.Timestamp,
		Sign:         strings.TrimSpace(req.Sign),
	}
	if err := agentchat.VerifyCallbackSignature(cfg, callback, now); err != nil {
		return nil, mapAgentChatCallbackError(err)
	}
	claims, err := agentchat.VerifyLaunchToken(cfg, callback.LaunchToken, now)
	if err != nil {
		return nil, mapAgentChatTokenError(err)
	}
	return &transport.AgentChatIntrospectResponse{
		UserID:     claims.UserID,
		InstanceID: claims.InstanceID,
	}, nil
}

func agentChatConfig() agentchat.Config {
	cfg := config.ServerConf.AgentChat
	if cfg == nil {
		return agentchat.Config{}
	}
	return agentchat.Config{
		BusinessCode:      cfg.BusinessCode,
		SecretID:          cfg.SecretID,
		SecretKey:         cfg.SecretKey,
		LaunchTokenSecret: cfg.LaunchTokenSecret,
		LaunchTokenTTL:    time.Duration(cfg.LaunchTokenTTLSeconds) * time.Second,
		TimestampSkew:     time.Duration(cfg.TimestampSkewSeconds) * time.Second,
	}
}

func mapAgentChatIssueError(err error) error {
	switch {
	case errors.Is(err, agentchat.ErrInvalidConfig):
		return errcode.Wrap(errcode.ErrInternalServer, "agentchat config invalid")
	case errors.Is(err, agentchat.ErrInvalidRequest):
		return errcode.Wrap(errcode.ErrInvalidParam, "invalid agentchat launch token request")
	default:
		return err
	}
}

func mapAgentChatCallbackError(err error) error {
	switch {
	case errors.Is(err, agentchat.ErrInvalidConfig):
		return errcode.Wrap(errcode.ErrInternalServer, "agentchat config invalid")
	case errors.Is(err, agentchat.ErrInvalidRequest):
		return errcode.Wrap(errcode.ErrInvalidParam, "invalid agentchat callback request")
	default:
		return errcode.Wrap(errcode.ErrUnauthorized, "invalid agentchat callback signature")
	}
}

func mapAgentChatTokenError(err error) error {
	switch {
	case errors.Is(err, agentchat.ErrInvalidConfig):
		return errcode.Wrap(errcode.ErrInternalServer, "agentchat config invalid")
	default:
		return errcode.Wrap(errcode.ErrUnauthorized, "invalid agentchat launch token")
	}
}
