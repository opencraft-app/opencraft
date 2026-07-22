package gatewayroute

import "ctl/pkg/config"

// NewAllocationGateway selects the backend for a user without an existing route.
func NewAllocationGateway(userID string) Gateway {
	if config.LLMGatewayAllowsNewUser(userID) {
		return GatewayLLMGateway
	}
	return GatewayAIGateway
}
