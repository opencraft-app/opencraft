package pass

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"ctl/pkg/adapter/aigateway"
	adapterfactory "ctl/pkg/adapter/factory"
	"ctl/pkg/logic/gatewayroute"

	"go.uber.org/zap"
)

const aiGatewayEntitlementCallTimeout = 10 * time.Second

// EnsureAiGatewayEntitlement 确保用户持有指定 Plan 的长期订阅。
// 业务有效期由 ctl 管理，因此请求中不携带套餐购买时长。
func EnsureAiGatewayEntitlement(
	logger *zap.Logger,
	userID, planID, idempotencyKey string,
) (*aigateway.Subscription, error) {
	userID = strings.TrimSpace(userID)
	planID = strings.TrimSpace(planID)
	idempotencyKey = strings.TrimSpace(idempotencyKey)
	if userID == "" {
		return nil, fmt.Errorf("ensure ai-gateway entitlement: user_id is empty")
	}
	if planID == "" {
		return nil, fmt.Errorf("ensure ai-gateway entitlement: plan_id is empty")
	}
	if idempotencyKey == "" {
		return nil, fmt.Errorf("ensure ai-gateway entitlement: idempotency_key is empty")
	}
	if logger == nil {
		logger = renewLogger()
	}

	ctx, cancel := context.WithTimeout(context.Background(), aiGatewayEntitlementCallTimeout)
	defer cancel()
	subscription, err := applyNewPassGatewaySubscription(ctx, newPassSubscriptionRequest{
		IdempotencyKey: idempotencyKey,
		UserID:         userID,
		PlanID:         planID,
		IsUnique:       true,
	})
	if err != nil {
		return nil, err
	}
	if subscription == nil {
		return nil, fmt.Errorf("ensure gateway entitlement returned empty subscription")
	}
	gatewayroute.RecordBestEffort(
		logger,
		userID,
		subscription.Gateway,
		subscription.ID,
		subscription.PlanID,
		gatewayroute.SourceApplySubscription,
	)
	logger.Info("ai-gateway entitlement ensured",
		zap.String("user_id", userID),
		zap.String("plan_id", planID),
		zap.String("gateway", string(subscription.Gateway)),
	)
	return &aigateway.Subscription{
		ID:     subscription.ID,
		UserID: userID,
		PlanID: subscription.PlanID,
		Status: "active",
	}, nil
}

// CancelAiGatewayEntitlement 可靠取消用户的所有有效订阅。
// 调用失败必须由上层重试，不能推进 isolated/deleted 等本地终态。
func CancelAiGatewayEntitlement(logger *zap.Logger, userID string) error {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return fmt.Errorf("cancel ai-gateway entitlement: user_id is empty")
	}
	if logger == nil {
		logger = renewLogger()
	}

	ctx, cancel := context.WithTimeout(context.Background(), aiGatewayEntitlementCallTimeout)
	defer cancel()
	target := gatewayroute.NewAllocationGateway(userID)
	if recorded, ok, err := gatewayroute.Get(userID); err != nil {
		return fmt.Errorf("read gateway route before entitlement cancel: %w", err)
	} else if ok {
		target = recorded
	} else if legacy := adapterfactory.DefaultAdapterFactory.AiGatewayAdapter(); legacy != nil {
		subscription, probeErr := legacy.GetActiveSubscription(ctx, userID)
		switch {
		case probeErr == nil && subscription != nil:
			target = gatewayroute.GatewayAIGateway
			gatewayroute.RecordBestEffort(
				logger,
				userID,
				target,
				subscription.ID,
				subscription.PlanID,
				gatewayroute.SourceDetectActiveSubscription,
			)
		case probeErr != nil && !errors.Is(probeErr, aigateway.ErrAiGatewayNotConfigured):
			return fmt.Errorf("probe legacy entitlement before cancel: %w", probeErr)
		}
	}

	var err error
	switch target {
	case gatewayroute.GatewayLLMGateway:
		err = adapterfactory.DefaultAdapterFactory.LLMGatewayAdapter().CancelSubscription(ctx, userID)
	case gatewayroute.GatewayAIGateway:
		err = adapterfactory.DefaultAdapterFactory.AiGatewayAdapter().CancelSubscription(ctx, userID)
	default:
		err = fmt.Errorf("unsupported gateway route %q", target)
	}
	if err != nil {
		return err
	}
	gatewayroute.ClearBestEffort(logger, userID, "entitlement_cancel")
	logger.Info("ai-gateway entitlement canceled",
		zap.String("user_id", userID),
		zap.String("gateway", string(target)),
	)
	return nil
}

func compensateEnsuredEntitlement(
	logger *zap.Logger,
	userID string,
	entitlementEnsured bool,
	localErr error,
) error {
	if !entitlementEnsured {
		return localErr
	}
	if cancelErr := CancelAiGatewayEntitlement(logger, userID); cancelErr != nil {
		return errors.Join(
			localErr,
			fmt.Errorf("compensate ai-gateway entitlement: %w", cancelErr),
		)
	}
	return localErr
}
