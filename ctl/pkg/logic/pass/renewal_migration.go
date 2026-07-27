package pass

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	adapterfactory "ctl/pkg/adapter/factory"
	"ctl/pkg/adapter/llmgateway"
	"ctl/pkg/config"
	"ctl/pkg/logic/gatewayroute"
	modelfactory "ctl/pkg/model/factory"
	modelpass "ctl/pkg/model/pass"
	modelgateway "ctl/pkg/model/subscriptiongateway"
	"ctl/pkg/resource"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const renewalGatewayMigrationTimeout = 30 * time.Second

const RenewalMigrationTargetGateway = gatewayroute.GatewayLLMGateway

type RenewalGatewayMigrationInput struct {
	UserID      string
	PassID      string
	BundleID    string
	TradeFlowID int64
	TimeSpan    int
	TimeUnit    string
	NewExpired  time.Time
}

type RenewalGatewayMigrationResult struct {
	Required       bool
	SubscriptionID string
	PlanID         string
}

// PrepareRenewalGatewayMigration creates the target LLMGateway entitlement but
// does not change ctl's gateway route. The caller may safely retry this method;
// the idempotency key is stable for the renewal command.
func PrepareRenewalGatewayMigration(ctx context.Context, input RenewalGatewayMigrationInput) (*RenewalGatewayMigrationResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	userID := strings.TrimSpace(input.UserID)
	if !config.LLMGatewayAllowsRenewalMigration(userID) {
		return &RenewalGatewayMigrationResult{}, nil
	}
	current, ok, err := gatewayroute.Get(userID)
	if err != nil {
		return nil, fmt.Errorf("get current gateway route: %w", err)
	}
	if ok && current != gatewayroute.GatewayAIGateway {
		return &RenewalGatewayMigrationResult{}, nil
	}
	if !ok {
		legacyAdapter := adapterfactory.DefaultAdapterFactory.AiGatewayAdapter()
		if legacyAdapter == nil {
			return &RenewalGatewayMigrationResult{}, nil
		}
		legacySub, err := legacyAdapter.GetActiveSubscription(ctx, userID)
		if err != nil {
			return nil, fmt.Errorf("probe legacy subscription for renewal migration: %w", err)
		}
		if legacySub == nil || strings.TrimSpace(legacySub.ID) == "" {
			return &RenewalGatewayMigrationResult{}, nil
		}
		if err := gatewayroute.Record(
			userID,
			gatewayroute.GatewayAIGateway,
			legacySub.ID,
			legacySub.PlanID,
			gatewayroute.SourceDetectActiveSubscription,
		); err != nil {
			return nil, fmt.Errorf("record probed legacy gateway route: %w", err)
		}
	}
	if strings.TrimSpace(input.PassID) == "" || strings.TrimSpace(input.BundleID) == "" {
		return nil, fmt.Errorf("pass_id and bundle_id are required for renewal migration")
	}
	if input.TimeSpan <= 0 || strings.TrimSpace(input.TimeUnit) == "" || input.NewExpired.IsZero() {
		return nil, fmt.Errorf("renewal period and new expiry are required for renewal migration")
	}

	bundle, err := modelfactory.DefaultDaoFactory.BundleDao(nil).GetByBundleID(input.BundleID)
	if err != nil {
		return nil, fmt.Errorf("get bundle for renewal migration: %w", err)
	}
	planID := strings.TrimSpace(bundle.AiGatewayPlanID)
	if planID == "" {
		return nil, fmt.Errorf("bundle %s has no gateway plan", input.BundleID)
	}
	adapter := adapterfactory.DefaultAdapterFactory.LLMGatewayAdapter()
	if adapter == nil {
		return nil, fmt.Errorf("llmgateway adapter is not configured")
	}
	callCtx, cancel := context.WithTimeout(ctx, renewalGatewayMigrationTimeout)
	defer cancel()

	if _, err := adapter.EnsureUser(callCtx, userID, ""); err != nil {
		return nil, fmt.Errorf("ensure llmgateway user for renewal migration: %w", err)
	}
	sub, err := adapter.ApplySubscription(callCtx, &llmgateway.ApplySubscriptionRequest{
		IdempotencyKey: renewalMigrationIdempotencyKey(input),
		UserID:         userID,
		PlanID:         planID,
		IsUnique:       true,
	})
	if err != nil {
		return nil, fmt.Errorf("apply llmgateway subscription for renewal migration: %w", err)
	}
	if sub == nil || strings.TrimSpace(sub.ID) == "" {
		return nil, fmt.Errorf("apply llmgateway subscription for renewal migration returned no subscription")
	}
	return &RenewalGatewayMigrationResult{
		Required:       true,
		SubscriptionID: strings.TrimSpace(sub.ID),
		PlanID:         planID,
	}, nil
}

func renewalMigrationIdempotencyKey(input RenewalGatewayMigrationInput) string {
	if input.TradeFlowID > 0 {
		return "renew-migrate:" + strconv.FormatInt(input.TradeFlowID, 10)
	}
	return fmt.Sprintf("renew-migrate:%s:%d", strings.TrimSpace(input.PassID), input.NewExpired.UTC().Unix())
}

// CommitRenewalGatewayMigration is the local commit point after all Agent
// child tasks have accepted the new key. The pass and route share ctl's MySQL,
// so both projections are changed in one transaction.
func CommitRenewalGatewayMigration(passID string, newExpired time.Time, userID, subscriptionID, planID string) (bool, error) {
	passID = strings.TrimSpace(passID)
	userID = strings.TrimSpace(userID)
	subscriptionID = strings.TrimSpace(subscriptionID)
	planID = strings.TrimSpace(planID)
	if passID == "" || userID == "" || subscriptionID == "" || planID == "" || newExpired.IsZero() {
		return false, fmt.Errorf("pass, user, subscription, plan and expiry are required for renewal migration commit")
	}
	if resource.GormDB == nil {
		return false, fmt.Errorf("database is not configured")
	}
	var updated bool
	err := resource.GormDB.Transaction(func(tx *gorm.DB) error {
		result := tx.Table(modelpass.TableName).
			Model(&modelpass.Entity{}).
			Where(modelpass.ColumnPassID+" = ? AND "+modelpass.ColumnStatus+" = ?", passID, modelpass.StatusRenewing).
			Updates(map[string]interface{}{
				modelpass.ColumnStatus:       modelpass.StatusActive,
				modelpass.ColumnExpiredTime:  newExpired,
				modelpass.ColumnIsolatedTime: gorm.Expr("NULL"),
			})
		if result.Error != nil {
			return fmt.Errorf("finalize renewal during gateway switch: %w", result.Error)
		}
		if result.RowsAffected != 1 {
			return nil
		}
		updated = true
		route := &modelgateway.Entity{
			UserID:         userID,
			Gateway:        modelgateway.GatewayLLMGateway,
			SubscriptionID: subscriptionID,
			PlanID:         planID,
			Source:         modelgateway.SourceRenewalMigration,
			LastObservedAt: time.Now().UTC(),
		}
		return tx.Table(modelgateway.TableName).Clauses(clause.OnConflict{
			Columns: []clause.Column{{Name: modelgateway.ColumnUserID}},
			DoUpdates: clause.AssignmentColumns([]string{
				modelgateway.ColumnGateway,
				modelgateway.ColumnSubscriptionID,
				modelgateway.ColumnPlanID,
				modelgateway.ColumnSource,
				modelgateway.ColumnLastObservedAt,
			}),
		}).Create(route).Error
	})
	if err != nil {
		return false, fmt.Errorf("commit renewal gateway migration: %w", err)
	}
	return updated, nil
}
