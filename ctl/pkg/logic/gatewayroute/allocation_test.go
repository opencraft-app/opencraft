package gatewayroute

import (
	"testing"

	"ctl/pkg/config"
)

func TestNewAllocationGatewayRequiresExplicitLLMGatewayEnablement(t *testing.T) {
	original := config.ServerConf
	t.Cleanup(func() { config.ServerConf = original })

	config.ServerConf = &config.GlobalConfig{AdapterConfig: &config.AdapterConfig{
		AiGateway:  &config.AiGatewayConfig{BaseURL: "https://legacy.example.com"},
		LLMGateway: &config.LLMGatewayConfig{BaseURL: "https://llmgateway.example.com"},
	}}
	if got := NewAllocationGateway(); got != GatewayAIGateway {
		t.Fatalf("NewAllocationGateway() = %q, want %q", got, GatewayAIGateway)
	}

	config.ServerConf.AdapterConfig.LLMGateway.Enabled = true
	if got := NewAllocationGateway(); got != GatewayLLMGateway {
		t.Fatalf("NewAllocationGateway() = %q, want %q", got, GatewayLLMGateway)
	}
}
