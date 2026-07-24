package pass

import (
	"context"
	"testing"
	"time"

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

	"go.uber.org/zap"
)

type legacyPeriodAlignmentStub struct {
	aigateway.Adapter
	calls int
	req   *aigateway.ExtendSubscriptionRequest
}

func (s *legacyPeriodAlignmentStub) ExtendSubscription(_ context.Context, req *aigateway.ExtendSubscriptionRequest) (*aigateway.ExtendSubscriptionResponse, error) {
	s.calls++
	s.req = req
	return &aigateway.ExtendSubscriptionResponse{
		Subscription: &aigateway.Subscription{ID: "legacy-sub", UserID: req.UserID, PlanID: "legacy-plan"},
		Updated:      true,
	}, nil
}

func (s *legacyPeriodAlignmentStub) GetActiveSubscription(context.Context, string) (*aigateway.Subscription, error) {
	return &aigateway.Subscription{ID: "legacy-sub", UserID: "user-1", PlanID: "legacy-plan"}, nil
}

type periodlessLLMStub struct {
	llmgateway.Adapter
}

type periodAlignmentFactory struct {
	legacy aigateway.Adapter
	llm    llmgateway.Adapter
}

func (f *periodAlignmentFactory) SandboxAdapter() sandbox.Adapter                 { return nil }
func (f *periodAlignmentFactory) StsAdapter() sts.Adapter                         { return nil }
func (f *periodAlignmentFactory) WhitelistAdapter() whitelist.Adapter             { return nil }
func (f *periodAlignmentFactory) AiGatewayAdapter() aigateway.Adapter             { return f.legacy }
func (f *periodAlignmentFactory) LLMGatewayAdapter() llmgateway.Adapter           { return f.llm }
func (f *periodAlignmentFactory) OpenClawGatewayAdapter() openclawgateway.Adapter { return nil }
func (f *periodAlignmentFactory) ShadowAdapter() shadow.Adapter                   { return nil }
func (f *periodAlignmentFactory) TradeAdapter() trade.Adapter                     { return nil }

func installPeriodAlignmentFactory(t *testing.T, factory adapterfactory.AdapterFactory) {
	t.Helper()
	original := adapterfactory.DefaultAdapterFactory
	adapterfactory.DefaultAdapterFactory = factory
	t.Cleanup(func() { adapterfactory.DefaultAdapterFactory = original })
}

func TestAlignSubscriptionPeriodEndKeepsLegacyGatewayBehavior(t *testing.T) {
	originalConfig := config.ServerConf
	config.ServerConf = &config.GlobalConfig{AdapterConfig: &config.AdapterConfig{
		LLMGateway: &config.LLMGatewayConfig{Enabled: false},
	}}
	t.Cleanup(func() { config.ServerConf = originalConfig })

	legacy := &legacyPeriodAlignmentStub{}
	installPeriodAlignmentFactory(t, &periodAlignmentFactory{legacy: legacy})
	want := time.Date(2026, time.August, 31, 12, 30, 0, 0, time.UTC)

	if err := AlignAiGatewaySubscriptionPeriodEnd(zap.NewNop(), "user-1", "pass-1", want); err != nil {
		t.Fatalf("align legacy period: %v", err)
	}
	if legacy.calls != 1 || legacy.req == nil || !legacy.req.NewPeriodEnd.Equal(want) {
		t.Fatalf("legacy alignment calls=%d req=%+v", legacy.calls, legacy.req)
	}
}

func TestAlignSubscriptionPeriodEndDoesNotExtendLLMGateway(t *testing.T) {
	originalConfig := config.ServerConf
	config.ServerConf = &config.GlobalConfig{AdapterConfig: &config.AdapterConfig{
		LLMGateway: &config.LLMGatewayConfig{
			Enabled:                    true,
			NewAllocationUserAllowlist: []string{"*"},
		},
	}}
	t.Cleanup(func() { config.ServerConf = originalConfig })

	llm := &periodlessLLMStub{}
	installPeriodAlignmentFactory(t, &periodAlignmentFactory{llm: llm})

	if err := AlignAiGatewaySubscriptionPeriodEnd(
		zap.NewNop(),
		"user-1",
		"pass-1",
		time.Now().UTC().AddDate(0, 1, 0),
	); err != nil {
		t.Fatalf("periodless llmgateway alignment: %v", err)
	}
}
