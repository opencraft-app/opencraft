package gatewayroute

import (
	"testing"

	"ctl/pkg/config"
)

func TestNewAllocationGatewayRequiresEnablementAndUserAllowlist(t *testing.T) {
	original := config.ServerConf
	t.Cleanup(func() { config.ServerConf = original })

	config.ServerConf = &config.GlobalConfig{AdapterConfig: &config.AdapterConfig{
		AiGateway: &config.AiGatewayConfig{BaseURL: "https://legacy.example.com"},
		LLMGateway: &config.LLMGatewayConfig{
			BaseURL:                    "https://llmgateway.example.com",
			NewAllocationUserAllowlist: []string{"usr-canary"},
		},
	}}
	if got := NewAllocationGateway("usr-canary"); got != GatewayAIGateway {
		t.Fatalf("NewAllocationGateway(canary) = %q, want %q", got, GatewayAIGateway)
	}

	config.ServerConf.AdapterConfig.LLMGateway.Enabled = true
	if got := NewAllocationGateway("usr-canary"); got != GatewayLLMGateway {
		t.Fatalf("NewAllocationGateway(canary) = %q, want %q", got, GatewayLLMGateway)
	}
	if got := NewAllocationGateway("usr-other"); got != GatewayAIGateway {
		t.Fatalf("NewAllocationGateway(other) = %q, want %q", got, GatewayAIGateway)
	}
}

func TestNewAllocationGatewaySupportsExplicitWildcard(t *testing.T) {
	original := config.ServerConf
	t.Cleanup(func() { config.ServerConf = original })

	config.ServerConf = &config.GlobalConfig{AdapterConfig: &config.AdapterConfig{
		LLMGateway: &config.LLMGatewayConfig{
			Enabled:                    true,
			NewAllocationUserAllowlist: []string{"*"},
		},
	}}
	if got := NewAllocationGateway("usr-any"); got != GatewayLLMGateway {
		t.Fatalf("NewAllocationGateway(any) = %q, want %q", got, GatewayLLMGateway)
	}
}
