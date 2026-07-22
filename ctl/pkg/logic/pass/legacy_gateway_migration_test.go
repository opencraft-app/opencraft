package pass

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	adapterfactory "ctl/pkg/adapter/factory"
	"ctl/pkg/adapter/llmgateway"
	tradeadapter "ctl/pkg/adapter/trade"
	"ctl/pkg/config"
	entitlementmigration "ctl/pkg/logic/entitlementmigration"
	"ctl/pkg/logic/gatewayroute"
	modelbundle "ctl/pkg/model/bundle"
	modelpass "ctl/pkg/model/pass"
	modelgateway "ctl/pkg/model/subscriptiongateway"
	"ctl/pkg/resource"
	"ctl/test/testutil"
)

type legacyOrderReaderStub struct {
	tradeadapter.Adapter
	order *tradeadapter.ProvisionedCreateOrder
	err   error
	calls int
}

func (s *legacyOrderReaderStub) GetProvisionedCreateOrderByResourceID(_ context.Context, _ string) (*tradeadapter.ProvisionedCreateOrder, error) {
	s.calls++
	return s.order, s.err
}

type legacyMigrationLLMStub struct {
	llmgateway.Adapter
	active    *llmgateway.Subscription
	activeErr error
	applyErr  error
	applyReqs []*llmgateway.ApplySubscriptionRequest
}

func (s *legacyMigrationLLMStub) GetActiveSubscription(_ context.Context, _ string) (*llmgateway.Subscription, error) {
	return s.active, s.activeErr
}

func (s *legacyMigrationLLMStub) ApplySubscription(_ context.Context, req *llmgateway.ApplySubscriptionRequest) (*llmgateway.Subscription, error) {
	cloned := *req
	s.applyReqs = append(s.applyReqs, &cloned)
	if s.applyErr != nil {
		return nil, s.applyErr
	}
	return &llmgateway.Subscription{ID: "sub-legacy-migrated", UserID: req.UserID, PlanID: req.PlanID, Status: "active"}, nil
}

func setupLegacyPassMigrationTest(t *testing.T, userID, passID string, expiredAt time.Time) {
	t.Helper()
	testutil.NewSQLiteDB(t, &modelpass.Entity{}, &modelbundle.Entity{}, &modelgateway.Entity{})
	config.ServerConf = &config.GlobalConfig{AdapterConfig: &config.AdapterConfig{
		LLMGateway: &config.LLMGatewayConfig{Enabled: true, BaseURL: "https://llmgateway.example.com"},
	}}
	if err := modelbundle.NewDao().Upsert(&modelbundle.Entity{
		BundleID:        "bundle-launch",
		BundleName:      "Launch",
		AiGatewayPlanID: "plan-launch",
		TimeSpan:        1,
		TimeUnit:        "m",
	}); err != nil {
		t.Fatalf("seed bundle: %v", err)
	}
	if err := modelpass.NewDao().Create(&modelpass.Entity{
		PassID:      passID,
		UserID:      userID,
		BundleID:    "bundle-launch",
		ExpiredTime: expiredAt,
		Status:      modelpass.StatusActive,
	}); err != nil {
		t.Fatalf("seed pass: %v", err)
	}
}

func TestEnsureLegacyPassEntitlementUsesOriginalOrderPeriod(t *testing.T) {
	originalConfig := config.ServerConf
	originalFactory := adapterfactory.DefaultAdapterFactory
	originalDB := resource.GormDB
	t.Cleanup(func() {
		config.ServerConf = originalConfig
		adapterfactory.DefaultAdapterFactory = originalFactory
		resource.GormDB = originalDB
	})

	now := time.Date(2026, time.July, 21, 12, 0, 0, 0, time.UTC)
	setupLegacyPassMigrationTest(t, "usr-14d", "pass-14d", now.AddDate(0, 0, 10))

	llm := &legacyMigrationLLMStub{}
	orders := &legacyOrderReaderStub{order: &tradeadapter.ProvisionedCreateOrder{
		DealName: "deal-14d",
		BundleID: "bundle-launch",
		Period:   14,
		TimeUnit: "d",
	}}
	adapterfactory.DefaultAdapterFactory = &allocationAdapterFactory{llm: llm, tradeAdapter: orders}

	result, err := entitlementmigration.EnsureLegacyPassEntitlement(context.Background(), "usr-14d", now)
	if err != nil {
		t.Fatalf("ensure legacy pass entitlement: %v", err)
	}
	if result == nil || !result.Migrated || result.SubscriptionID != "sub-legacy-migrated" {
		t.Fatalf("unexpected migration result: %+v", result)
	}
	if len(llm.applyReqs) != 1 {
		t.Fatalf("apply calls = %d, want 1", len(llm.applyReqs))
	}
	apply := llm.applyReqs[0]
	if apply.PeriodValue != 14 || apply.PeriodUnit != "d" {
		t.Fatalf("applied period = %d%s, want 14d", apply.PeriodValue, apply.PeriodUnit)
	}
	if apply.IdempotencyKey != "legacy-pass-migrate:pass-14d" {
		t.Fatalf("idempotency key = %q", apply.IdempotencyKey)
	}
	route, ok, err := gatewayroute.Get("usr-14d")
	if err != nil {
		t.Fatalf("get route: %v", err)
	}
	if !ok || route != gatewayroute.GatewayLLMGateway {
		t.Fatalf("route = %q, want llmgateway", route)
	}
}

func TestEnsureLegacyPassEntitlementRejectsShorterReissue(t *testing.T) {
	originalConfig := config.ServerConf
	originalFactory := adapterfactory.DefaultAdapterFactory
	originalDB := resource.GormDB
	t.Cleanup(func() {
		config.ServerConf = originalConfig
		adapterfactory.DefaultAdapterFactory = originalFactory
		resource.GormDB = originalDB
	})

	now := time.Date(2026, time.July, 21, 12, 0, 0, 0, time.UTC)
	setupLegacyPassMigrationTest(t, "usr-long", "pass-long", now.AddDate(0, 0, 30))
	llm := &legacyMigrationLLMStub{}
	orders := &legacyOrderReaderStub{order: &tradeadapter.ProvisionedCreateOrder{
		DealName: "deal-long", BundleID: "bundle-launch", Period: 14, TimeUnit: "d",
	}}
	adapterfactory.DefaultAdapterFactory = &allocationAdapterFactory{llm: llm, tradeAdapter: orders}

	_, err := entitlementmigration.EnsureLegacyPassEntitlement(context.Background(), "usr-long", now)
	if !errors.Is(err, entitlementmigration.ErrWouldShortenEntitlement) {
		t.Fatalf("error = %v, want ErrWouldShortenEntitlement", err)
	}
	if len(llm.applyReqs) != 0 {
		t.Fatalf("apply calls = %d, want 0", len(llm.applyReqs))
	}
	if _, ok, routeErr := gatewayroute.Get("usr-long"); routeErr != nil || ok {
		t.Fatalf("route must not be written: ok=%v err=%v", ok, routeErr)
	}
}

func TestEnsureLegacyPassEntitlementReusesExistingSubscription(t *testing.T) {
	originalConfig := config.ServerConf
	originalFactory := adapterfactory.DefaultAdapterFactory
	originalDB := resource.GormDB
	t.Cleanup(func() {
		config.ServerConf = originalConfig
		adapterfactory.DefaultAdapterFactory = originalFactory
		resource.GormDB = originalDB
	})

	testutil.NewSQLiteDB(t, &modelgateway.Entity{})
	config.ServerConf = &config.GlobalConfig{AdapterConfig: &config.AdapterConfig{
		LLMGateway: &config.LLMGatewayConfig{Enabled: true, BaseURL: "https://llmgateway.example.com"},
	}}
	llm := &legacyMigrationLLMStub{active: &llmgateway.Subscription{ID: "sub-existing", UserID: "usr-existing", PlanID: "plan-existing"}}
	orders := &legacyOrderReaderStub{}
	adapterfactory.DefaultAdapterFactory = &allocationAdapterFactory{llm: llm, tradeAdapter: orders}

	result, err := entitlementmigration.EnsureLegacyPassEntitlement(context.Background(), "usr-existing", time.Now().UTC())
	if err != nil {
		t.Fatalf("reuse existing subscription: %v", err)
	}
	if result.Migrated || result.SubscriptionID != "sub-existing" {
		t.Fatalf("unexpected result: %+v", result)
	}
	if orders.calls != 0 || len(llm.applyReqs) != 0 {
		t.Fatalf("unexpected migration work: order calls=%d apply calls=%d", orders.calls, len(llm.applyReqs))
	}
}

func TestEnsureLegacyPassEntitlementFallsBackOnlyOnOrderNotFound(t *testing.T) {
	originalConfig := config.ServerConf
	originalFactory := adapterfactory.DefaultAdapterFactory
	originalDB := resource.GormDB
	t.Cleanup(func() {
		config.ServerConf = originalConfig
		adapterfactory.DefaultAdapterFactory = originalFactory
		resource.GormDB = originalDB
	})

	now := time.Date(2026, time.July, 21, 12, 0, 0, 0, time.UTC)
	setupLegacyPassMigrationTest(t, "usr-fallback", "pass-fallback", now.AddDate(0, 0, 10))
	llm := &legacyMigrationLLMStub{}
	orders := &legacyOrderReaderStub{err: &tradeadapter.Error{Status: http.StatusNotFound, Code: "OrderNotFound"}}
	adapterfactory.DefaultAdapterFactory = &allocationAdapterFactory{llm: llm, tradeAdapter: orders}

	_, err := entitlementmigration.EnsureLegacyPassEntitlement(context.Background(), "usr-fallback", now)
	if err != nil {
		t.Fatalf("fallback to bundle period: %v", err)
	}
	if len(llm.applyReqs) != 1 || llm.applyReqs[0].PeriodValue != 1 || llm.applyReqs[0].PeriodUnit != "m" {
		t.Fatalf("unexpected fallback apply: %+v", llm.applyReqs)
	}

	resource.GormDB.Exec("DELETE FROM user_subscription_gateway")
	llm.applyReqs = nil
	orders.err = errors.New("trade timeout")
	_, err = entitlementmigration.EnsureLegacyPassEntitlement(context.Background(), "usr-fallback", now)
	if err == nil || !strings.Contains(err.Error(), "trade timeout") {
		t.Fatalf("error = %v, want trade timeout", err)
	}
	if len(llm.applyReqs) != 0 {
		t.Fatalf("transient failure must not apply subscription: %+v", llm.applyReqs)
	}
}
