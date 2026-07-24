package pass

import (
	"context"
	"testing"

	"ctl/pkg/adapter/aigateway"
	adapterfactory "ctl/pkg/adapter/factory"
	"ctl/pkg/adapter/llmgateway"
	tradeadapter "ctl/pkg/adapter/trade"
	"ctl/pkg/config"
	"ctl/pkg/logic/gatewayroute"
)

type allocationAIGatewayStub struct {
	aigateway.Adapter
	ensureCalls int
	applyCalls  int
}

func (s *allocationAIGatewayStub) EnsureUser(_ context.Context, userID, _ string) (*aigateway.EnsureUserResponse, error) {
	s.ensureCalls++
	return &aigateway.EnsureUserResponse{UserID: userID, Result: "created"}, nil
}

func (s *allocationAIGatewayStub) ApplySubscription(_ context.Context, req *aigateway.ApplySubscriptionRequest) (*aigateway.Subscription, error) {
	s.applyCalls++
	return &aigateway.Subscription{ID: "legacy-sub", UserID: req.UserID, PlanID: req.PlanID}, nil
}

type allocationLLMGatewayStub struct {
	llmgateway.Adapter
	ensureCalls int
	applyCalls  int
	lastApply   llmgateway.ApplySubscriptionRequest
}

func (s *allocationLLMGatewayStub) EnsureUser(_ context.Context, userID, _ string) (*llmgateway.EnsureUserResponse, error) {
	s.ensureCalls++
	return &llmgateway.EnsureUserResponse{UserID: userID, Result: "created"}, nil
}

func (s *allocationLLMGatewayStub) ApplySubscription(_ context.Context, req *llmgateway.ApplySubscriptionRequest) (*llmgateway.Subscription, error) {
	s.applyCalls++
	s.lastApply = *req
	return &llmgateway.Subscription{ID: "llm-sub", UserID: req.UserID, PlanID: req.PlanID}, nil
}

type allocationAdapterFactory struct {
	adapterfactory.AdapterFactory
	ai           aigateway.Adapter
	llm          llmgateway.Adapter
	tradeAdapter tradeadapter.Adapter
}

func (f *allocationAdapterFactory) AiGatewayAdapter() aigateway.Adapter   { return f.ai }
func (f *allocationAdapterFactory) LLMGatewayAdapter() llmgateway.Adapter { return f.llm }
func (f *allocationAdapterFactory) TradeAdapter() tradeadapter.Adapter    { return f.tradeAdapter }

func TestNewPassAllocationUsesExplicitlyEnabledGateway(t *testing.T) {
	tests := []struct {
		name         string
		llmEnabled   bool
		wantGateway  gatewayroute.Gateway
		wantAICalls  int
		wantLLMCalls int
	}{
		{name: "legacy by default", wantGateway: gatewayroute.GatewayAIGateway, wantAICalls: 2},
		{name: "llmgateway when explicitly enabled", llmEnabled: true, wantGateway: gatewayroute.GatewayLLMGateway, wantLLMCalls: 2},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			originalConfig := config.ServerConf
			originalFactory := adapterfactory.DefaultAdapterFactory
			t.Cleanup(func() {
				config.ServerConf = originalConfig
				adapterfactory.DefaultAdapterFactory = originalFactory
			})

			config.ServerConf = &config.GlobalConfig{AdapterConfig: &config.AdapterConfig{
				AiGateway: &config.AiGatewayConfig{BaseURL: "https://legacy.example.com"},
				LLMGateway: &config.LLMGatewayConfig{
					Enabled:                    tt.llmEnabled,
					BaseURL:                    "https://llmgateway.example.com",
					NewAllocationUserAllowlist: []string{"*"},
				},
			}}
			aiStub := &allocationAIGatewayStub{}
			llmStub := &allocationLLMGatewayStub{}
			adapterfactory.DefaultAdapterFactory = &allocationAdapterFactory{ai: aiStub, llm: llmStub}

			created, err := ensureNewPassGatewayUser(context.Background(), "usr-test", "")
			if err != nil || !created {
				t.Fatalf("ensureNewPassGatewayUser() created=%v err=%v", created, err)
			}
			sub, err := applyNewPassGatewaySubscription(context.Background(), newPassSubscriptionRequest{
				IdempotencyKey:   "test:usr-test",
				UserID:           "usr-test",
				PlanID:           "plan-test",
				SubscriptionName: "package:usr-test:pass-test",
				PeriodValue:      1,
				PeriodUnit:       "months",
				IsUnique:         true,
			})
			if err != nil {
				t.Fatalf("applyNewPassGatewaySubscription() error = %v", err)
			}
			if sub == nil || sub.Gateway != tt.wantGateway {
				t.Fatalf("subscription = %+v, want gateway %q", sub, tt.wantGateway)
			}
			if got := aiStub.ensureCalls + aiStub.applyCalls; got != tt.wantAICalls {
				t.Fatalf("ai-gateway calls = %d, want %d", got, tt.wantAICalls)
			}
			if got := llmStub.ensureCalls + llmStub.applyCalls; got != tt.wantLLMCalls {
				t.Fatalf("llmgateway calls = %d, want %d", got, tt.wantLLMCalls)
			}
			if tt.llmEnabled {
				if llmStub.lastApply.SubscriptionName != "package:usr-test:pass-test" {
					t.Fatalf("llmgateway subscription_name = %q", llmStub.lastApply.SubscriptionName)
				}
				if !llmStub.lastApply.IsUnique {
					t.Fatalf("llmgateway is_unique = false, want true")
				}
			}
		})
	}
}

func TestCreditBalancesFromLLMSubscriptionsSeparatesFreeCredit(t *testing.T) {
	balances := creditBalancesFromLLMSubscriptions([]llmgateway.Subscription{
		{Name: "package:usr-test:pass-test", TokenTotal: 100000, TokenBalance: 60000},
		{Name: "free-credit:campaign:grant-1", TokenTotal: 30000, TokenBalance: 20000},
		{Name: "free-credit:campaign:grant-2", TokenTotal: 10000, TokenBalance: 5000},
	})

	if !balances.PackageFound {
		t.Fatalf("PackageFound = false, want true")
	}
	if balances.PackageTokenBalance != 60000 {
		t.Fatalf("PackageTokenBalance = %d, want 60000", balances.PackageTokenBalance)
	}
	if balances.FreeTokenTotal != 40000 {
		t.Fatalf("FreeTokenTotal = %d, want 40000", balances.FreeTokenTotal)
	}
	if balances.FreeTokenBalance != 25000 {
		t.Fatalf("FreeTokenBalance = %d, want 25000", balances.FreeTokenBalance)
	}
}
