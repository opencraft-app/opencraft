package instance

import (
	"fmt"
	"strings"

	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	modelinstance "ctl/pkg/model/instance"
	"ctl/pkg/transport"
)

func (l *logic) ResetInstanceConfig(ctx pctx.Context, instanceID string) (*transport.InstanceConfigResetResponse, error) {
	entity, err := l.loadOwnedRunningInstance(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	if !l.aiGatewayProvisioningEnabled() {
		return nil, errcode.Wrap(errcode.ErrInternalServer, "ai-gateway adapter not configured")
	}

	backend := l.resolveProvisionGateway(ctx, ctx.GetUserID(), entity.InstanceId)
	gwConf, err := l.gatewayRuntimeConfig(backend)
	if err != nil || strings.TrimSpace(gwConf.DefaultBaseURL) == "" || strings.TrimSpace(gwConf.DefaultModelID) == "" {
		return nil, errcode.Wrap(errcode.ErrInternalServer, "default_base_url or default_model_id not configured")
	}

	if err := l.ensureAiGatewayUser(ctx, backend, ctx.GetUserID(), "", entity.InstanceId); err != nil {
		return nil, err
	}

	apiKeyResp, err := l.createAiGatewayApiKey(ctx, backend, ctx.GetUserID(), entity.InstanceId)
	if err != nil {
		return nil, err
	}

	previousKeyID := strings.TrimSpace(entity.AiGatewayKeyID)
	if previousKeyID != "" && previousKeyID != apiKeyResp.KeyID {
		if err := l.revokeAiGatewayApiKey(ctx, previousKeyID); err != nil && !isAiGatewayKeyNotFound(err) {
			_ = l.revokeAiGatewayApiKey(ctx, apiKeyResp.KeyID)
			return nil, fmt.Errorf("revoke previous ai-gateway key after config reset: %w", err)
		}
	}

	if err := l.persistAiGatewayKeyIDWithStatuses(ctx, entity, apiKeyResp.KeyID, []string{modelinstance.InstanceStatusRunning}); err != nil {
		_ = l.revokeAiGatewayApiKey(ctx, apiKeyResp.KeyID)
		return nil, fmt.Errorf("persist reset ai-gateway key id: %w", err)
	}

	return &transport.InstanceConfigResetResponse{
		KeyID:     apiKeyResp.KeyID,
		KeyPrefix: apiKeyResp.KeyPrefix,
		Config: &transport.InstanceConfigResetProvider{
			ProviderName: hermesDefaultProviderName,
			BaseURL:      strings.TrimSpace(gwConf.DefaultBaseURL),
			ModelID:      strings.TrimSpace(gwConf.DefaultModelID),
			API:          mapHermesProviderAPI(gwConf.DefaultCompatibility),
			APIKey:       apiKeyResp.APIKey,
		},
	}, nil
}
