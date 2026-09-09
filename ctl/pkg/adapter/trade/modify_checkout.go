package trade

import (
	"context"
	"net/http"
	"strings"
)

type ModifyCheckout struct {
	DealName       string `json:"deal_name"`
	BigOrderID     string `json:"big_order_id"`
	TargetBundleID string `json:"target_bundle_id"`
	LocalStatus    string `json:"local_status"`
}
type ModifyCheckoutResult struct {
	Checkout *ModifyCheckout `json:"checkout"`
}

type ModifyCheckoutReader interface {
	FindModifyCheckout(context.Context, string, string) (*ModifyCheckoutResult, error)
}

func (a *adapter) FindModifyCheckout(ctx context.Context, userID, passID string) (*ModifyCheckoutResult, error) {
	var result ModifyCheckoutResult
	err := a.doJSON(ctx, http.MethodPost, strings.TrimRight(a.config.BaseURL, "/")+"/internal/trade/modify-checkout", map[string]string{"external_user_id": userID, "resource_id": passID}, &result)
	if err != nil {
		return nil, err
	}
	return &result, nil
}
