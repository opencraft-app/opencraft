package instance

import (
	"fmt"
	"strings"

	pllmgateway "ctl/pkg/adapter/llmgateway"
	pctx "ctl/pkg/context"
	"ctl/pkg/logic/gatewayroute"
	"ctl/pkg/transport"

	"go.uber.org/zap"
)

func (l *logic) ResetLLMGatewayUserQuota(ctx pctx.Context, dryRun bool) (*transport.UserGatewayQuotaResetResponse, error) {
	if ctx == nil || strings.TrimSpace(ctx.GetUserID()) == "" {
		return nil, fmt.Errorf("user_id is required")
	}
	if err := l.requireActivePass(ctx); err != nil {
		return nil, activePassGuardError("reset llmgateway quota", err)
	}
	resetter, ok := l.llmGatewayAdapter.(pllmgateway.UserQuotaResetter)
	if !ok || resetter == nil {
		return nil, fmt.Errorf("llmgateway quota reset is not configured")
	}
	result, err := resetter.ResetUserQuota(ctx, ctx.GetUserID(), dryRun)
	if err != nil {
		return nil, err
	}
	if result == nil {
		return nil, fmt.Errorf("llmgateway quota reset returned no result")
	}
	response := &transport.UserGatewayQuotaResetResponse{
		UserID: result.UserID, Gateway: gatewayroute.GatewayLLMGateway,
		SetID: result.SetID, UpstreamUserID: result.UpstreamUserID,
		PlanID: result.PlanID, UpstreamPlanID: result.UpstreamPlanID,
		SubscriptionID:   result.SubscriptionID,
		AmountUsedBefore: result.AmountUsedBefore, AmountUsedAfter: result.AmountUsedAfter,
		NextResetTime: result.NextResetTime, EndTime: result.EndTime,
		DryRun: result.DryRun, Status: result.Status, ScheduleUnchanged: result.ScheduleUnchanged,
	}
	l.logger.Info("llmgateway user quota reset operation completed",
		zap.String("user_id", response.UserID),
		zap.String("set_id", response.SetID),
		zap.String("subscription_id", response.SubscriptionID),
		zap.Bool("dry_run", response.DryRun),
		zap.String("status", response.Status))
	return response, nil
}
