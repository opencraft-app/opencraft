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

	// Legacy ai-gateway reset revokes the previous instance key, so every
	// sibling Profile would lose authentication before it can be rewritten.
	// LLMGateway resolves the stable user/default purpose and returns the same
	// active key, allowing the caller to repair only the selected Profile.
	if backend == gatewayBackendAiGateway {
		profiles, err := l.listHermesProfiles(ctx, instanceID, entity.DisplayName)
		if err != nil {
			return nil, err
		}
		if len(profiles) != 1 || !profiles[0].IsDefault {
			return nil, errcode.ErrInstanceConfigResetMultiBot
		}
	}

	apiKeyResp, err := l.createAiGatewayApiKey(ctx, backend, ctx.GetUserID(), entity.InstanceId)
	if err != nil {
		return nil, err
	}

	previousKeyID := strings.TrimSpace(entity.AiGatewayKeyID)
	if previousKeyID != "" && previousKeyID != apiKeyResp.KeyID {
		if err := l.revokeGatewayAPIKey(ctx, backend, previousKeyID); err != nil {
			_ = l.revokeGatewayAPIKey(ctx, backend, apiKeyResp.KeyID)
			return nil, fmt.Errorf("revoke previous ai-gateway key after config reset: %w", err)
		}
	}

	if err := l.persistAiGatewayKeyIDWithStatuses(ctx, entity, apiKeyResp.KeyID, []string{modelinstance.InstanceStatusRunning}); err != nil {
		_ = l.revokeGatewayAPIKey(ctx, backend, apiKeyResp.KeyID)
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
