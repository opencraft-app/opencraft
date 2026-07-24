package pass

import (
	"context"
	"testing"
	"time"

	"ctl/pkg/adapter/aigateway"
	adapterfactory "ctl/pkg/adapter/factory"
	"ctl/pkg/adapter/llmgateway"
	"ctl/pkg/config"
	"ctl/pkg/logic/gatewayroute"
	modelbundle "ctl/pkg/model/bundle"
	modelpass "ctl/pkg/model/pass"
	modelgateway "ctl/pkg/model/subscriptiongateway"
	"ctl/pkg/resource"
	"ctl/test/testutil"
)

type renewalMigrationAIStub struct {
	aigateway.Adapter
	active *aigateway.Subscription
	calls  int
}

func (s *renewalMigrationAIStub) GetActiveSubscription(_ context.Context, _ string) (*aigateway.Subscription, error) {
	s.calls++
	return s.active, nil
}

type renewalMigrationLLMStub struct {
	llmgateway.Adapter
	ensureCalls int
	applyReqs   []*llmgateway.ApplySubscriptionRequest
	extendReqs  []*llmgateway.ExtendSubscriptionRequest
}

func (s *renewalMigrationLLMStub) EnsureUser(_ context.Context, userID, _ string) (*llmgateway.EnsureUserResponse, error) {
	s.ensureCalls++
	return &llmgateway.EnsureUserResponse{UserID: userID, Result: "created"}, nil
}

func (s *renewalMigrationLLMStub) ApplySubscription(_ context.Context, req *llmgateway.ApplySubscriptionRequest) (*llmgateway.Subscription, error) {
	cloned := *req
	s.applyReqs = append(s.applyReqs, &cloned)
	return &llmgateway.Subscription{ID: "sub-migrated", UserID: req.UserID, PlanID: req.PlanID, Status: "active"}, nil
}

func (s *renewalMigrationLLMStub) ExtendSubscription(_ context.Context, req *llmgateway.ExtendSubscriptionRequest) (*llmgateway.ExtendSubscriptionResponse, error) {
	cloned := *req
	s.extendReqs = append(s.extendReqs, &cloned)
	return &llmgateway.ExtendSubscriptionResponse{
		Subscription: &llmgateway.Subscription{ID: "sub-migrated", UserID: req.UserID, PlanID: "plan-pro"},
		Updated:      true,
	}, nil
}

func TestPrepareRenewalGatewayMigrationUsesWildcardAndPeriodlessEntitlement(t *testing.T) {
	originalConfig := config.ServerConf
	originalFactory := adapterfactory.DefaultAdapterFactory
	originalDB := resource.GormDB
	t.Cleanup(func() {
		config.ServerConf = originalConfig
		adapterfactory.DefaultAdapterFactory = originalFactory
		resource.GormDB = originalDB
	})

	testutil.NewSQLiteDB(t, &modelbundle.Entity{}, &modelgateway.Entity{})
	config.ServerConf = &config.GlobalConfig{AdapterConfig: &config.AdapterConfig{
		LLMGateway: &config.LLMGatewayConfig{
			Enabled:                       true,
			BaseURL:                       "https://llmgateway.example.com",
			RenewalMigrationUserAllowlist: []string{"*", "usr-explicit"},
		},
	}}
	if err := modelbundle.NewDao().Upsert(&modelbundle.Entity{
		BundleID:        "bundle-pro",
		BundleName:      "Pro",
		AiGatewayPlanID: "plan-pro",
	}); err != nil {
		t.Fatalf("seed bundle: %v", err)
	}
	if err := gatewayroute.Record(
		"usr-migrate",
		gatewayroute.GatewayAIGateway,
		"legacy-sub",
		"plan-pro",
		gatewayroute.SourceDetectActiveSubscription,
	); err != nil {
		t.Fatalf("seed legacy route: %v", err)
	}
	llm := &renewalMigrationLLMStub{}
	adapterfactory.DefaultAdapterFactory = &allocationAdapterFactory{llm: llm}

	newExpired := time.Date(2026, time.August, 31, 12, 30, 0, 0, time.UTC)
	result, err := PrepareRenewalGatewayMigration(context.Background(), RenewalGatewayMigrationInput{
		UserID:      "usr-migrate",
		PassID:      "pass-1",
		BundleID:    "bundle-pro",
		TradeFlowID: 9988,
		TimeSpan:    1,
		TimeUnit:    "m",
		NewExpired:  newExpired,
	})
	if err != nil {
		t.Fatalf("prepare renewal migration: %v", err)
	}
	if result == nil || !result.Required || result.SubscriptionID != "sub-migrated" || result.PlanID != "plan-pro" {
		t.Fatalf("unexpected migration result: %+v", result)
	}
	if llm.ensureCalls != 1 || len(llm.applyReqs) != 1 || len(llm.extendReqs) != 0 {
		t.Fatalf("unexpected llmgateway calls: ensure=%d apply=%d extend=%d", llm.ensureCalls, len(llm.applyReqs), len(llm.extendReqs))
	}
	if got := llm.applyReqs[0].IdempotencyKey; got != "renew-migrate:9988" {
		t.Fatalf("idempotency key = %q, want renew-migrate:9988", got)
	}
	if llm.applyReqs[0].PeriodValue != 0 || llm.applyReqs[0].PeriodUnit != "" || llm.applyReqs[0].PeriodEnd != nil {
		t.Fatalf("business period leaked into llmgateway request: %+v", llm.applyReqs[0])
	}
	if !llm.applyReqs[0].IsUnique {
		t.Fatal("renewal migration must ensure the user's single package entitlement")
	}
}

func TestPrepareRenewalGatewayMigrationSkipsAlreadyMigratedUser(t *testing.T) {
	originalConfig := config.ServerConf
	originalDB := resource.GormDB
	t.Cleanup(func() {
		config.ServerConf = originalConfig
		resource.GormDB = originalDB
	})
	testutil.NewSQLiteDB(t, &modelgateway.Entity{})
	config.ServerConf = &config.GlobalConfig{AdapterConfig: &config.AdapterConfig{
		LLMGateway: &config.LLMGatewayConfig{
			Enabled:                       true,
			RenewalMigrationUserAllowlist: []string{"*"},
		},
	}}
	if err := gatewayroute.Record("usr-new", gatewayroute.GatewayLLMGateway, "sub-new", "plan-new", gatewayroute.SourceApplySubscription); err != nil {
		t.Fatalf("seed llmgateway route: %v", err)
	}

	result, err := PrepareRenewalGatewayMigration(context.Background(), RenewalGatewayMigrationInput{UserID: "usr-new"})
	if err != nil {
		t.Fatalf("prepare renewal migration: %v", err)
	}
	if result == nil || result.Required {
		t.Fatalf("already migrated user should be skipped, got %+v", result)
	}
}

func TestPrepareRenewalGatewayMigrationProbesLegacyWhenRouteProjectionIsMissing(t *testing.T) {
	originalConfig := config.ServerConf
	originalFactory := adapterfactory.DefaultAdapterFactory
	originalDB := resource.GormDB
	t.Cleanup(func() {
		config.ServerConf = originalConfig
		adapterfactory.DefaultAdapterFactory = originalFactory
		resource.GormDB = originalDB
	})
	testutil.NewSQLiteDB(t, &modelbundle.Entity{}, &modelgateway.Entity{})
	config.ServerConf = &config.GlobalConfig{AdapterConfig: &config.AdapterConfig{
		AiGateway: &config.AiGatewayConfig{BaseURL: "https://legacy.example.com"},
		LLMGateway: &config.LLMGatewayConfig{
			Enabled:                       true,
			BaseURL:                       "https://llmgateway.example.com",
			RenewalMigrationUserAllowlist: []string{"*"},
		},
	}}
	if err := modelbundle.NewDao().Upsert(&modelbundle.Entity{
		BundleID:        "bundle-pro",
		BundleName:      "Pro",
		AiGatewayPlanID: "plan-pro",
	}); err != nil {
		t.Fatalf("seed bundle: %v", err)
	}
	ai := &renewalMigrationAIStub{active: &aigateway.Subscription{
		ID:     "legacy-sub",
		UserID: "usr-no-route",
		PlanID: "plan-pro",
	}}
	llm := &renewalMigrationLLMStub{}
	adapterfactory.DefaultAdapterFactory = &allocationAdapterFactory{ai: ai, llm: llm}

	result, err := PrepareRenewalGatewayMigration(context.Background(), RenewalGatewayMigrationInput{
		UserID:      "usr-no-route",
		PassID:      "pass-no-route",
		BundleID:    "bundle-pro",
		TradeFlowID: 10001,
		TimeSpan:    1,
		TimeUnit:    "m",
		NewExpired:  time.Now().UTC().AddDate(0, 1, 0),
	})
	if err != nil {
		t.Fatalf("prepare migration without route projection: %v", err)
	}
	if result == nil || !result.Required {
		t.Fatalf("legacy subscription probe should make migration required: %+v", result)
	}
	if ai.calls != 1 {
		t.Fatalf("legacy active subscription probes = %d, want 1", ai.calls)
	}
}

func TestCommitRenewalGatewayMigrationCommitsPassAndRoute(t *testing.T) {
	originalDB := resource.GormDB
	t.Cleanup(func() { resource.GormDB = originalDB })
	testutil.NewSQLiteDB(t, &modelpass.Entity{}, &modelgateway.Entity{})
	originalExpired := time.Date(2026, time.July, 31, 0, 0, 0, 0, time.UTC)
	if err := modelpass.NewDao().Create(&modelpass.Entity{
		PassID:      "pass-commit-migration",
		UserID:      "usr-commit-migration",
		BundleID:    "bundle-pro",
		ExpiredTime: originalExpired,
		RenewFlag:   modelpass.RenewFlagManual,
		Status:      modelpass.StatusRenewing,
	}); err != nil {
		t.Fatalf("seed pass: %v", err)
	}
	newExpired := originalExpired.AddDate(0, 1, 0)

	updated, err := CommitRenewalGatewayMigration(
		"pass-commit-migration",
		newExpired,
		"usr-commit-migration",
		"sub-migrated",
		"plan-pro",
	)
	if err != nil || !updated {
		t.Fatalf("commit renewal migration updated=%v err=%v", updated, err)
	}
	gotPass, err := modelpass.NewDao().GetByPassID("pass-commit-migration")
	if err != nil {
		t.Fatalf("read pass: %v", err)
	}
	if gotPass.Status != modelpass.StatusActive || !gotPass.ExpiredTime.Equal(newExpired) {
		t.Fatalf("unexpected finalized pass: %+v", gotPass)
	}
	gotRoute, err := modelgateway.NewDao().GetByUserID("usr-commit-migration")
	if err != nil {
		t.Fatalf("read route: %v", err)
	}
	if gotRoute == nil || gotRoute.Gateway != modelgateway.GatewayLLMGateway || gotRoute.SubscriptionID != "sub-migrated" || gotRoute.Source != modelgateway.SourceRenewalMigration {
		t.Fatalf("unexpected committed route: %+v", gotRoute)
	}
}

func TestCommitRenewalGatewayMigrationDoesNotWriteRouteWhenPassCASMisses(t *testing.T) {
	originalDB := resource.GormDB
	t.Cleanup(func() { resource.GormDB = originalDB })
	testutil.NewSQLiteDB(t, &modelpass.Entity{}, &modelgateway.Entity{})
	if err := modelpass.NewDao().Create(&modelpass.Entity{
		PassID:      "pass-already-active",
		UserID:      "usr-cas-miss",
		BundleID:    "bundle-pro",
		ExpiredTime: time.Now().UTC(),
		RenewFlag:   modelpass.RenewFlagManual,
		Status:      modelpass.StatusActive,
	}); err != nil {
		t.Fatalf("seed pass: %v", err)
	}

	updated, err := CommitRenewalGatewayMigration(
		"pass-already-active",
		time.Now().UTC().AddDate(0, 1, 0),
		"usr-cas-miss",
		"sub-migrated",
		"plan-pro",
	)
	if err != nil {
		t.Fatalf("commit renewal migration: %v", err)
	}
	if updated {
		t.Fatal("active pass must not match the renewing CAS")
	}
	route, err := modelgateway.NewDao().GetByUserID("usr-cas-miss")
	if err != nil {
		t.Fatalf("read route: %v", err)
	}
	if route != nil {
		t.Fatalf("route must remain unchanged after CAS miss: %+v", route)
	}
}
