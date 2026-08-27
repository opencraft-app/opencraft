package entitlementmigration

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	adapterfactory "ctl/pkg/adapter/factory"
	"ctl/pkg/adapter/llmgateway"
	tradeadapter "ctl/pkg/adapter/trade"
	"ctl/pkg/config"
	"ctl/pkg/logic/gatewayroute"
	modelbundle "ctl/pkg/model/bundle"
	modelfactory "ctl/pkg/model/factory"
	modelpass "ctl/pkg/model/pass"
	"ctl/pkg/resource"

	"go.uber.org/zap"
)

const legacyPassMigrationTimeout = 15 * time.Second

type LegacyPassMigrationResult struct {
	Migrated       bool
	SubscriptionID string
	PlanID         string
}

// EnsureLegacyPassEntitlement 为尚未在 LLMGateway 建立订阅的存量 Pass
// 重新发放一份原购买周期套餐。调用方必须先 EnsureUser。
func EnsureLegacyPassEntitlement(ctx context.Context, userID string, now time.Time) (*LegacyPassMigrationResult, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return nil, fmt.Errorf("legacy pass migration: user_id is required")
	}
	if !config.LLMGatewayEnabled() {
		return nil, fmt.Errorf("legacy pass migration: llmgateway is disabled")
	}
	if now.IsZero() {
		now = time.Now().UTC()
	} else {
		now = now.UTC()
	}

	callCtx, cancel := context.WithTimeout(ctx, legacyPassMigrationTimeout)
	defer cancel()
	llm := adapterfactory.DefaultAdapterFactory.LLMGatewayAdapter()
	if llm == nil {
		return nil, fmt.Errorf("legacy pass migration: llmgateway adapter is not configured")
	}
	active, err := llm.GetActiveSubscription(callCtx, userID)
	if err != nil {
		return nil, fmt.Errorf("legacy pass migration: get active subscription: %w", err)
	}
	if active != nil && strings.TrimSpace(active.ID) != "" {
		if err := gatewayroute.Record(userID, gatewayroute.GatewayLLMGateway, active.ID, active.PlanID, gatewayroute.SourceDetectActiveSubscription); err != nil {
			return nil, fmt.Errorf("legacy pass migration: record existing route: %w", err)
		}
		return &LegacyPassMigrationResult{SubscriptionID: active.ID, PlanID: active.PlanID}, nil
	}

	passEntity, err := activePass(userID, now)
	if err != nil {
		return nil, err
	}
	bundle, err := modelfactory.DefaultDaoFactory.BundleDao(nil).GetByBundleID(passEntity.BundleID)
	if err != nil {
		return nil, fmt.Errorf("legacy pass migration: get bundle %s: %w", passEntity.BundleID, err)
	}
	planID := strings.TrimSpace(bundle.AiGatewayPlanID)
	if planID == "" {
		return nil, fmt.Errorf("legacy pass migration: bundle %s has no gateway plan", passEntity.BundleID)
	}

	periodValue, periodUnit, err := originalPassPeriod(callCtx, passEntity.PassID, passEntity.BundleID, bundle.TimeSpan, bundle.TimeUnit)
	if err != nil {
		return nil, err
	}

	sub, err := llm.ApplySubscription(callCtx, &llmgateway.ApplySubscriptionRequest{
		IdempotencyKey: "legacy-pass-migrate:" + passEntity.PassID,
		UserID:         userID,
		PlanID:         planID,
		PeriodValue:    periodValue,
		PeriodUnit:     periodUnit,
	})
	if err != nil {
		return nil, fmt.Errorf("legacy pass migration: apply subscription: %w", err)
	}
	if sub == nil || strings.TrimSpace(sub.ID) == "" {
		return nil, fmt.Errorf("legacy pass migration: apply subscription returned no subscription")
	}
	if err := gatewayroute.Record(userID, gatewayroute.GatewayLLMGateway, sub.ID, sub.PlanID, gatewayroute.SourceLegacyPassMigration); err != nil {
		return nil, fmt.Errorf("legacy pass migration: record route: %w", err)
	}
	return &LegacyPassMigrationResult{Migrated: true, SubscriptionID: sub.ID, PlanID: sub.PlanID}, nil
}

func activePass(userID string, now time.Time) (*modelpass.Entity, error) {
	passes, err := modelfactory.DefaultDaoFactory.PassDao(nil).ListByUserID(userID)
	if err != nil {
		return nil, fmt.Errorf("legacy pass migration: list passes: %w", err)
	}
	for _, passEntity := range passes {
		if passEntity.Status == modelpass.StatusActive && passEntity.ExpiredTime.After(now) {
			return passEntity, nil
		}
	}
	return nil, fmt.Errorf("legacy pass migration: user %s has no active pass", userID)
}

func originalPassPeriod(ctx context.Context, passID, bundleID string, fallbackValue int, fallbackUnit string) (int, string, error) {
	tradeClient := adapterfactory.DefaultAdapterFactory.TradeAdapter()
	reader, ok := tradeClient.(tradeadapter.ProvisionedCreateOrderReader)
	if !ok || reader == nil {
		return 0, "", fmt.Errorf("legacy pass migration: trade adapter cannot read provisioned create orders")
	}
	order, err := reader.GetProvisionedCreateOrderByResourceID(ctx, passID)
	if err == nil {
		if order == nil || order.Period <= 0 || strings.TrimSpace(order.TimeUnit) == "" {
			return 0, "", fmt.Errorf("legacy pass migration: trade returned an invalid purchase period")
		}
		if strings.TrimSpace(order.BundleID) != strings.TrimSpace(bundleID) {
			return 0, "", fmt.Errorf("legacy pass migration: order bundle %s does not match pass bundle %s", order.BundleID, bundleID)
		}
		return order.Period, strings.TrimSpace(order.TimeUnit), nil
	}
	var tradeErr *tradeadapter.Error
	if !errors.As(err, &tradeErr) || tradeErr.Status != http.StatusNotFound {
		return 0, "", fmt.Errorf("legacy pass migration: query original order: %w", err)
	}
	if fallbackValue <= 0 || strings.TrimSpace(fallbackUnit) == "" {
		return 0, "", fmt.Errorf("legacy pass migration: original order missing and bundle period is invalid")
	}
	if resource.ZapLogger != nil {
		resource.ZapLogger.Warn("legacy pass migration uses current bundle period because original order is missing",
			zap.String("pass_id", passID),
			zap.String("bundle_id", bundleID),
			zap.Int("period_value", fallbackValue),
			zap.String("period_unit", fallbackUnit),
		)
	}
	return fallbackValue, strings.TrimSpace(fallbackUnit), nil
}

func calcPeriodEnd(start time.Time, value int, unit string) (time.Time, error) {
	if value <= 0 {
		return time.Time{}, fmt.Errorf("invalid period value: %d", value)
	}
	switch unit {
	case modelbundle.TimeUnitMonth:
		return addMonthsNatural(start, value), nil
	case modelbundle.TimeUnitDay:
		return start.AddDate(0, 0, value), nil
	case modelbundle.TimeUnitYear:
		return start.AddDate(value, 0, 0), nil
	default:
		return time.Time{}, fmt.Errorf("invalid period unit: %q", unit)
	}
}

func addMonthsNatural(start time.Time, months int) time.Time {
	year, month, day := start.Date()
	month += time.Month(months)
	for month > 12 {
		month -= 12
		year++
	}
	maxDay := time.Date(year, month+1, 0, 0, 0, 0, 0, time.UTC).Day()
	if day > maxDay {
		day = maxDay
	}
	return time.Date(year, month, day, start.Hour(), start.Minute(), start.Second(), start.Nanosecond(), start.Location())
}
