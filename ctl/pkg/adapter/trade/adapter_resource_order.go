package trade

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// ProvisionedCreateOrder is the immutable purchase data needed to reissue a
// legacy Pass entitlement in LLMGateway.
type ProvisionedCreateOrder struct {
	DealName string `json:"deal_name"`
	BundleID string `json:"bundle_id"`
	Period   int    `json:"period"`
	TimeUnit string `json:"time_unit"`
}

// ProvisionedCreateOrderReader is optional so existing trade adapter fakes do
// not need to implement a migration-only operation.
type ProvisionedCreateOrderReader interface {
	GetProvisionedCreateOrderByResourceID(ctx context.Context, resourceID string) (*ProvisionedCreateOrder, error)
}

func (a *adapter) GetProvisionedCreateOrderByResourceID(ctx context.Context, resourceID string) (*ProvisionedCreateOrder, error) {
	if a.config.BaseURL == "" {
		return nil, fmt.Errorf("trade adapter: base_url not configured")
	}
	resourceID = strings.TrimSpace(resourceID)
	if resourceID == "" {
		return nil, fmt.Errorf("trade adapter: resourceID is required")
	}
	endpoint := strings.TrimRight(a.config.BaseURL, "/") +
		"/internal/trade/orders/by-resource/" + url.PathEscape(resourceID)

	var result ProvisionedCreateOrder
	if err := a.doJSON(ctx, http.MethodGet, endpoint, nil, &result); err != nil {
		return nil, err
	}
	return &result, nil
}
