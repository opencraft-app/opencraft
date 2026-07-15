package pass

import (
	"context"
	"testing"

	"ctl/pkg/adapter/aigateway"
	adapterfactory "ctl/pkg/adapter/factory"
	"ctl/pkg/adapter/llmgateway"
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
}

func (s *allocationLLMGatewayStub) EnsureUser(_ context.Context, userID, _ string) (*llmgateway.EnsureUserResponse, error) {
	s.ensureCalls++
	return &llmgateway.EnsureUserResponse{UserID: userID, Result: "created"}, nil
}

func (s *allocationLLMGatewayStub) ApplySubscription(_ context.Context, req *llmgateway.ApplySubscriptionRequest) (*llmgateway.Subscription, error) {
	s.applyCalls++
	return &llmgateway.Subscription{ID: "llm-sub", UserID: req.UserID, PlanID: req.PlanID}, nil
}

type allocationAdapterFactory struct {
	adapterfactory.AdapterFactory
	ai  aigateway.Adapter
	llm llmgateway.Adapter
}

func (f *allocationAdapterFactory) AiGatewayAdapter() aigateway.Adapter   { return f.ai }
func (f *allocationAdapterFactory) LLMGatewayAdapter() llmgateway.Adapter { return f.llm }

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
				AiGateway:  &config.AiGatewayConfig{BaseURL: "https://legacy.example.com"},
				LLMGateway: &config.LLMGatewayConfig{Enabled: tt.llmEnabled, BaseURL: "https://llmgateway.example.com"},
			}}
			aiStub := &allocationAIGatewayStub{}
			llmStub := &allocationLLMGatewayStub{}
			adapterfactory.DefaultAdapterFactory = &allocationAdapterFactory{ai: aiStub, llm: llmStub}

			created, err := ensureNewPassGatewayUser(context.Background(), "usr-test", "")
			if err != nil || !created {
				t.Fatalf("ensureNewPassGatewayUser() created=%v err=%v", created, err)
			}
			sub, err := applyNewPassGatewaySubscription(context.Background(), newPassSubscriptionRequest{
				IdempotencyKey: "test:usr-test",
				UserID:         "usr-test",
				PlanID:         "plan-test",
				PeriodValue:    1,
				PeriodUnit:     "months",
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
		})
	}
}
