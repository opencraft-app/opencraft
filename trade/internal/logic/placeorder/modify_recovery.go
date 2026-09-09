package placeorder

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"git.woa.com/wisp/mono/trade/internal/store"
)

var ErrModifyCheckoutConflict = errors.New("multiple unfinished modify orders; contact support")

type ModifyCheckout struct {
	DealName       string `json:"deal_name"`
	BigOrderID     string `json:"big_order_id"`
	TargetBundleID string `json:"target_bundle_id"`
	LocalStatus    string `json:"local_status"`
}
type ModifyCheckoutResult struct {
	Checkout *ModifyCheckout `json:"checkout"`
}

func (s *Service) FindModifyCheckout(ctx context.Context, userID, passID string) (*ModifyCheckoutResult, error) {
	if strings.TrimSpace(userID) == "" || strings.TrimSpace(passID) == "" {
		return nil, ErrInvalidInput
	}
	reader, ok := s.deps.OrderStore.(store.ModifyCheckoutStore)
	if !ok {
		return nil, fmt.Errorf("modify checkout reader unavailable")
	}
	orders, err := reader.FindUnfinishedModifyOrders(ctx, userID, passID)
	if err != nil {
		return nil, err
	}
	if len(orders) > 1 {
		return nil, ErrModifyCheckoutConflict
	}
	out := &ModifyCheckoutResult{}
	if len(orders) == 1 {
		o := orders[0]
		out.Checkout = &ModifyCheckout{DealName: o.DealName, BigOrderID: o.BigOrderID, TargetBundleID: o.BundleID, LocalStatus: o.Status}
	}
	return out, nil
}
