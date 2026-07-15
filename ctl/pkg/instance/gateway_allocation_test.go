package instance

import (
	"testing"

	"ctl/pkg/config"
	"ctl/pkg/resource"
	"ctl/test/testutil"

	"go.uber.org/zap"
)

func TestResolveProvisionGatewayUsesExplicitAllocationGate(t *testing.T) {
	original := config.ServerConf
	originalDB := resource.GormDB
	t.Cleanup(func() {
		config.ServerConf = original
		resource.GormDB = originalDB
	})
	resource.GormDB = nil
	ctx := testutil.NewContext(t, "usr-gateway-allocation")
	logic := &logic{logger: zap.NewNop()}

	config.ServerConf = &config.GlobalConfig{AdapterConfig: &config.AdapterConfig{
		AiGateway:  &config.AiGatewayConfig{BaseURL: "https://legacy.example.com"},
		LLMGateway: &config.LLMGatewayConfig{BaseURL: "https://llmgateway.example.com"},
	}}
	if got := logic.resolveProvisionGateway(ctx, ctx.GetUserID(), "ins-legacy"); got != gatewayBackendAiGateway {
		t.Fatalf("resolveProvisionGateway() = %q, want %q", got, gatewayBackendAiGateway)
	}

	config.ServerConf.AdapterConfig.LLMGateway.Enabled = true
	if got := logic.resolveProvisionGateway(ctx, ctx.GetUserID(), "ins-llm"); got != gatewayBackendLLMGateway {
		t.Fatalf("resolveProvisionGateway() = %q, want %q", got, gatewayBackendLLMGateway)
	}
}
