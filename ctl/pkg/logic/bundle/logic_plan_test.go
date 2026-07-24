package bundle

import (
	"context"
	"errors"
	"testing"

	"ctl/pkg/adapter/aigateway"
	adapterfactory "ctl/pkg/adapter/factory"
	"ctl/pkg/adapter/llmgateway"
	"ctl/pkg/adapter/openclawgateway"
	"ctl/pkg/adapter/sandbox"
	"ctl/pkg/adapter/shadow"
	"ctl/pkg/adapter/sts"
	"ctl/pkg/adapter/trade"
	"ctl/pkg/adapter/whitelist"
	"ctl/pkg/config"
	"ctl/pkg/errcode"
)

type planValidationStub struct {
	llmgateway.Adapter
	plan *llmgateway.Plan
}

func (s *planValidationStub) GetPlan(context.Context, string) (*llmgateway.Plan, error) {
	return s.plan, nil
}

type planValidationFactory struct {
	llmgateway llmgateway.Adapter
}

func (f *planValidationFactory) SandboxAdapter() sandbox.Adapter                 { return nil }
func (f *planValidationFactory) StsAdapter() sts.Adapter                         { return nil }
func (f *planValidationFactory) WhitelistAdapter() whitelist.Adapter             { return nil }
func (f *planValidationFactory) AiGatewayAdapter() aigateway.Adapter             { return nil }
func (f *planValidationFactory) LLMGatewayAdapter() llmgateway.Adapter           { return f.llmgateway }
func (f *planValidationFactory) OpenClawGatewayAdapter() openclawgateway.Adapter { return nil }
func (f *planValidationFactory) ShadowAdapter() shadow.Adapter                   { return nil }
func (f *planValidationFactory) TradeAdapter() trade.Adapter                     { return nil }

func installPlanValidationStub(t *testing.T, plan *llmgateway.Plan) {
	t.Helper()
	original := adapterfactory.DefaultAdapterFactory
	originalConfig := config.ServerConf
	adapterfactory.DefaultAdapterFactory = &planValidationFactory{
		llmgateway: &planValidationStub{plan: plan},
	}
	config.ServerConf = &config.GlobalConfig{
		AdapterConfig: &config.AdapterConfig{
			LLMGateway: &config.LLMGatewayConfig{Enabled: true},
		},
		Bundle: &config.BundleConfig{CreditTokenRatio: 10_000},
	}
	t.Cleanup(func() {
		adapterfactory.DefaultAdapterFactory = original
		config.ServerConf = originalConfig
	})
}

func TestValidateCreditPlanIgnoresBusinessDuration(t *testing.T) {
	installPlanValidationStub(t, &llmgateway.Plan{
		ID: "plan-1", MonthlyTokens: 20_000,
		IsActive: true, ReadyForAllSets: true, ActiveSetCount: 2, ReadySetCount: 2,
		PeriodValue: 100, PeriodUnit: "years",
	})
	if err := validateCreditPlanPeriod(2, 14, "d", "plan-1"); err != nil {
		t.Fatalf("business duration must not participate in plan matching: %v", err)
	}
}

func TestValidateCreditPlanRejectsRetiredPlan(t *testing.T) {
	installPlanValidationStub(t, &llmgateway.Plan{
		ID: "plan-retired", MonthlyTokens: 20_000,
		IsActive: false, ReadyForAllSets: true, ActiveSetCount: 2, ReadySetCount: 2,
	})

	err := validateCreditPlanPeriod(2, 30, "d", "plan-retired")
	if !errors.Is(err, errcode.ErrBundlePlanMismatch) {
		t.Fatalf("retired plan error=%v, want ErrBundlePlanMismatch", err)
	}
}

func TestValidateCreditPlanRejectsPartiallyDeliveredPlan(t *testing.T) {
	installPlanValidationStub(t, &llmgateway.Plan{
		ID: "plan-new", MonthlyTokens: 20_000,
		IsActive: true, ReadyForAllSets: false, ActiveSetCount: 2, ReadySetCount: 1,
	})

	err := validateCreditPlanPeriod(2, 30, "d", "plan-new")
	if !errors.Is(err, errcode.ErrBundleAiGatewayUnavailable) {
		t.Fatalf("partial plan error=%v, want ErrBundleAiGatewayUnavailable", err)
	}
}
