package gatewayroute

import "ctl/pkg/config"

// NewAllocationGateway selects the backend for users without an existing route.
func NewAllocationGateway() Gateway {
	if config.LLMGatewayEnabled() {
		return GatewayLLMGateway
	}
	return GatewayAIGateway
}
