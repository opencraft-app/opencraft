package instance

import (
	"errors"
	"fmt"
	"strings"

	paigateway "ctl/pkg/adapter/aigateway"
	pctx "ctl/pkg/context"
	"ctl/pkg/logic/gatewayroute"
	modelinstance "ctl/pkg/model/instance"
	modelgateway "ctl/pkg/model/subscriptiongateway"
	"ctl/pkg/resource"
	"ctl/pkg/transport"

	"go.uber.org/zap"
)

var ErrLegacyGatewaySubscriptionNotFound = errors.New("legacy ai-gateway subscription not found")
var ErrGatewayMigrationRequiresSingleInstance = errors.New("gateway migration requires exactly one non-terminal instance")

type migrationSource struct {
	gateway        string
	subscriptionID string
	planID         string
	source         string
}

// MigrateInstanceToLLMGateway moves one running instance and its existing Pass
// entitlement to LLMGateway. Runtime configuration is updated before the new
// key ID is committed, so a failed Hermes command cannot revoke the old key.
func (l *logic) MigrateInstanceToLLMGateway(ctx pctx.Context, instanceID string, dryRun bool) (*transport.InstanceGatewayMigrationResponse, error) {
	entity, err := l.loadOwnedRunningInstance(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	if err := l.requireSingleMigrationInstance(entity); err != nil {
		return nil, err
	}
	if !l.aiGatewayProvisioningEnabled() || l.llmGatewayAdapter == nil {
		return nil, fmt.Errorf("llmgateway adapter not configured")
	}
	if _, err := l.gatewayRuntimeConfig(gatewayBackendLLMGateway); err != nil {
		return nil, err
	}

	source, err := l.detectMigrationSource(ctx, entity.UserId)
	if err != nil {
		return nil, err
	}
	result := &transport.InstanceGatewayMigrationResponse{
		UserID:          entity.UserId,
		InstanceID:      entity.InstanceId,
		PreviousGateway: source.gateway,
		TargetGateway:   gatewayroute.GatewayLLMGateway,
		DryRun:          dryRun,
	}
	if source.gateway == gatewayroute.GatewayLLMGateway {
		result.AlreadyMigrated = true
	}
	if source.gateway != gatewayroute.GatewayAIGateway && source.gateway != gatewayroute.GatewayLLMGateway {
		return nil, fmt.Errorf("unsupported source gateway %q", source.gateway)
	}
	if dryRun {
		return result, nil
	}

	apiKey, err := l.createAiGatewayApiKey(ctx, gatewayBackendLLMGateway, entity.UserId, entity.InstanceId)
	if err != nil {
		l.restoreMigrationSource(entity.UserId, source)
		return nil, err
	}
	gwConf, err := l.gatewayRuntimeConfig(gatewayBackendLLMGateway)
	if err != nil {
		l.restoreMigrationSource(entity.UserId, source)
		return nil, err
	}
	if err := l.configureGatewayRuntimeAndRestart(ctx, entity.SandboxId, apiKey.APIKey, gwConf); err != nil {
		l.restoreMigrationSource(entity.UserId, source)
		return nil, fmt.Errorf("configure migrated Hermes runtime: %w", err)
	}
	oldKeyID := strings.TrimSpace(entity.AiGatewayKeyID)
	if err := l.persistAiGatewayKeyIDWithStatuses(ctx, entity, apiKey.KeyID, []string{modelinstance.InstanceStatusRunning}); err != nil {
		// Hermes is already using the VelaGW key. Keep the VelaGW route so the
		// running instance remains usable; a retry/reset can repair the stale
		// instance key metadata without routing traffic back to ai-gateway.
		return nil, fmt.Errorf("persist migrated llmgateway key id: %w", err)
	}

	result.Migrated = true
	result.KeyID = apiKey.KeyID
	result.KeyPrefix = apiKey.KeyPrefix
	if source.gateway == gatewayroute.GatewayLLMGateway {
		return result, nil
	}
	if oldKeyID == "" || oldKeyID == apiKey.KeyID {
		result.LegacyKeyRevoked = true
		return result, nil
	}
	if err := l.revokeLegacyAiGatewayAPIKey(ctx, oldKeyID); err != nil {
		l.logger.Warn("instance gateway migration completed but legacy key revoke failed",
			zap.String("user_id", entity.UserId),
			zap.String("instance_id", entity.InstanceId),
			zap.String("legacy_key_id", oldKeyID),
			zap.Error(err))
		return result, nil
	}
	result.LegacyKeyRevoked = true
	return result, nil
}

func (l *logic) requireSingleMigrationInstance(target *modelinstance.Entity) error {
	if target == nil {
		return ErrGatewayMigrationRequiresSingleInstance
	}
	instances, err := l.instanceDao.ListAllByUserIDForIsolate(strings.TrimSpace(target.UserId))
	if err != nil {
		return fmt.Errorf("list user instances before gateway migration: %w", err)
	}
	if len(instances) != 1 || instances[0] == nil || instances[0].InstanceId != target.InstanceId {
		return fmt.Errorf("%w: found %d", ErrGatewayMigrationRequiresSingleInstance, len(instances))
	}
	return nil
}

func (l *logic) detectMigrationSource(ctx pctx.Context, userID string) (migrationSource, error) {
	if resource.GormDB != nil {
		record, err := modelgateway.NewDao().GetByUserID(userID)
		if err != nil {
			return migrationSource{}, err
		}
		if record != nil {
			return migrationSource{
				gateway: record.Gateway, subscriptionID: record.SubscriptionID,
				planID: record.PlanID, source: record.Source,
			}, nil
		}
	}
	if l.aiGatewayAdapter != nil {
		sub, err := l.aiGatewayAdapter.GetActiveSubscription(ctx, userID)
		if err != nil && !errors.Is(err, paigateway.ErrAiGatewayNotConfigured) {
			return migrationSource{}, fmt.Errorf("get legacy ai-gateway subscription: %w", err)
		}
		if sub != nil && strings.TrimSpace(sub.ID) != "" {
			return migrationSource{
				gateway: gatewayroute.GatewayAIGateway, subscriptionID: sub.ID,
				planID: sub.PlanID, source: gatewayroute.SourceDetectActiveSubscription,
			}, nil
		}
	}
	if l.llmGatewayAdapter != nil {
		sub, err := l.llmGatewayAdapter.GetActiveSubscription(ctx, userID)
		if err != nil {
			return migrationSource{}, fmt.Errorf("get llmgateway subscription: %w", err)
		}
		if sub != nil && strings.TrimSpace(sub.ID) != "" {
			return migrationSource{
				gateway: gatewayroute.GatewayLLMGateway, subscriptionID: sub.ID,
				planID: sub.PlanID, source: gatewayroute.SourceDetectActiveSubscription,
			}, nil
		}
	}
	return migrationSource{}, ErrLegacyGatewaySubscriptionNotFound
}

func (l *logic) restoreMigrationSource(userID string, source migrationSource) {
	if source.gateway == "" {
		gatewayroute.ClearBestEffort(l.logger, userID, "instance gateway migration failed")
		return
	}
	if err := gatewayroute.Record(userID, source.gateway, source.subscriptionID, source.planID, source.source); err != nil && l.logger != nil {
		l.logger.Warn("restore instance gateway route after migration failure",
			zap.String("user_id", userID), zap.String("gateway", source.gateway), zap.Error(err))
	}
}
