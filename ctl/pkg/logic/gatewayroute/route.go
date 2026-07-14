package gatewayroute

import (
	"strings"
	"time"

	modelgateway "ctl/pkg/model/subscriptiongateway"
	"ctl/pkg/resource"

	"go.uber.org/zap"
)

type Gateway = string

const (
	GatewayAIGateway  Gateway = modelgateway.GatewayAIGateway
	GatewayLLMGateway Gateway = modelgateway.GatewayLLMGateway

	SourceApplySubscription        = modelgateway.SourceApplySubscription
	SourceDetectActiveSubscription = modelgateway.SourceDetectActiveSubscription
	SourceManual                   = modelgateway.SourceManual
)

func Get(userID string) (Gateway, bool, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return "", false, nil
	}
	if resource.GormDB == nil {
		return "", false, nil
	}
	entity, err := modelgateway.NewDao().GetByUserID(userID)
	if err != nil {
		return "", false, err
	}
	if entity == nil || strings.TrimSpace(entity.Gateway) == "" {
		return "", false, nil
	}
	return entity.Gateway, true, nil
}

func Record(userID string, gateway Gateway, subscriptionID, planID, source string) error {
	if resource.GormDB == nil {
		return nil
	}
	return modelgateway.NewDao().Upsert(&modelgateway.Entity{
		UserID:         userID,
		Gateway:        gateway,
		SubscriptionID: subscriptionID,
		PlanID:         planID,
		Source:         source,
		LastObservedAt: time.Now().UTC(),
	})
}

func Clear(userID string) error {
	userID = strings.TrimSpace(userID)
	if userID == "" || resource.GormDB == nil {
		return nil
	}
	return modelgateway.NewDao().DeleteByUserID(userID)
}

func RecordBestEffort(logger *zap.Logger, userID string, gateway Gateway, subscriptionID, planID, source string) {
	if logger == nil {
		logger = resource.ZapLogger
	}
	if logger == nil {
		logger = zap.NewNop()
	}
	if err := Record(userID, gateway, subscriptionID, planID, source); err != nil {
		logger.Warn("record user subscription gateway failed",
			zap.String("user_id", userID),
			zap.String("gateway", gateway),
			zap.String("source", source),
			zap.Error(err))
	}
}

func ClearBestEffort(logger *zap.Logger, userID string, reason string) {
	if logger == nil {
		logger = resource.ZapLogger
	}
	if logger == nil {
		logger = zap.NewNop()
	}
	if err := Clear(userID); err != nil {
		logger.Warn("clear user subscription gateway failed",
			zap.String("user_id", userID),
			zap.String("reason", reason),
			zap.Error(err))
	}
}
