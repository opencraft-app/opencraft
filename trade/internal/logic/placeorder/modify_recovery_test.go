package placeorder

import (
	"context"
	"errors"
	"git.woa.com/wisp/mono/trade/internal/store"
	"testing"
)

type recoveryStore struct {
	store.OrderStore
	orders []*store.TradeOrder
}

func (s *recoveryStore) FindUnfinishedModifyOrders(context.Context, string, string) ([]*store.TradeOrder, error) {
	return s.orders, nil
}
func TestModifyRecoveryNeverSilentlySelectsMultipleOrders(t *testing.T) {
	d := newStdDeps()
	reader := &recoveryStore{}
	d.service.deps.OrderStore = reader
	out, err := d.service.FindModifyCheckout(context.Background(), "owner", "pass")
	if err != nil || out.Checkout != nil {
		t.Fatalf("out=%+v err=%v", out, err)
	}
	reader.orders = []*store.TradeOrder{{DealName: "a", BundleID: "target", Status: store.OrderStatusPendingPay}}
	out, err = d.service.FindModifyCheckout(context.Background(), "owner", "pass")
	if err != nil || out.Checkout.DealName != "a" {
		t.Fatalf("out=%+v err=%v", out, err)
	}
	reader.orders = append(reader.orders, &store.TradeOrder{DealName: "b"})
	if _, err = d.service.FindModifyCheckout(context.Background(), "owner", "pass"); !errors.Is(err, ErrModifyCheckoutConflict) {
		t.Fatalf("err=%v", err)
	}
}
