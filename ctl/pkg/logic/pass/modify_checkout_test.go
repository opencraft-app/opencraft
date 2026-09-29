package pass

import (
	"context"
	"errors"
	"fmt"
	"testing"

	adapterfactory "ctl/pkg/adapter/factory"
	tradeadapter "ctl/pkg/adapter/trade"
	"ctl/pkg/authcode"
	"ctl/pkg/errcode"
	bundlemodel "ctl/pkg/model/bundle"
	passmodel "ctl/pkg/model/pass"
	"ctl/pkg/transport"
	"ctl/test/testutil"
)

type modifyCheckoutTrade struct {
	tradeadapter.Adapter
	calls    int
	opts     *tradeadapter.GeneratePayURLOptions
	payErr   error
	recovery *tradeadapter.ModifyCheckoutResult
	orders   int
}

func (s *modifyCheckoutTrade) FindModifyCheckout(context.Context, string, string) (*tradeadapter.ModifyCheckoutResult, error) {
	return s.recovery, nil
}

func (s *modifyCheckoutTrade) GeneratePayURL(_ context.Context, deal string, opts *tradeadapter.GeneratePayURLOptions) (*tradeadapter.PayURLResult, error) {
	s.calls++
	s.opts = opts
	if deal != "existing-deal" {
		return nil, errors.New("unexpected deal")
	}
	return &tradeadapter.PayURLResult{NeedCharge: 0}, s.payErr
}
func (s *modifyCheckoutTrade) PlaceModifyOrder(context.Context, *tradeadapter.ModifyOrderRequest) (*tradeadapter.PlaceOrderResult, error) {
	s.orders++
	return &tradeadapter.PlaceOrderResult{DealName: fmt.Sprintf("new-deal-%d", s.orders), BigOrderID: "big"}, nil
}

type modifyCheckoutTickets struct{ ticket *authcode.Ticket }

func (s *modifyCheckoutTickets) Issue(_ context.Context, t *authcode.Ticket) (string, error) {
	s.ticket = t
	return "fresh-ticket", nil
}
func (*modifyCheckoutTickets) Consume(context.Context, string) (*authcode.Ticket, error) {
	panic("unexpected Consume")
}
func (*modifyCheckoutTickets) Revoke(context.Context, string) error { return nil }

func TestModifyCheckoutRetryAndTicketRefreshUseExistingOrder(t *testing.T) {
	db := testutil.NewSQLiteDB(t, &passmodel.Entity{}, &bundlemodel.Entity{})
	if err := db.Create(&bundlemodel.Entity{BundleID: "bundle_cruise_01"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(modifyTestPass()).Error; err != nil {
		t.Fatal(err)
	}
	oldFactory, oldTickets := adapterfactory.DefaultAdapterFactory, authcode.DefaultStore
	t.Cleanup(func() { adapterfactory.DefaultAdapterFactory = oldFactory; authcode.DefaultStore = oldTickets })
	stub := &modifyCheckoutTrade{}
	adapterfactory.DefaultAdapterFactory = &allocationAdapterFactory{tradeAdapter: stub}
	tickets := &modifyCheckoutTickets{}
	authcode.DefaultStore = tickets
	req := &transport.ModifyPassOrderUrlRequest{DealNames: []string{"existing-deal"}, Platform: "mobile", WxOpenID: "openid"}
	l := NewLogic()
	stub.payErr = errors.New("temporary upstream failure")
	if _, err := l.ModifyPassOrderUrl("usr_test", "lhpass-r1", req); err == nil {
		t.Fatal("expected upstream failure")
	}
	stub.payErr = nil
	result, err := l.ModifyPassOrderUrl("usr_test", "lhpass-r1", req)
	if err != nil || result.NeedCharge != 0 {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	if stub.calls != 2 || stub.opts.ExternalUserID != "usr_test" || stub.opts.ResourceID != "lhpass-r1" || stub.opts.OrderType != "modify" || len(stub.opts.AllowedBundleIDs) != 3 || stub.opts.AllowedBundleIDs[0] != "bundle_cruise_01" || stub.opts.AllowedBundleIDs[1] != "bundle_launch_ai_01" || stub.opts.AllowedBundleIDs[2] != "bundle_cruise_ai_01" || stub.opts.WxOpenID != "openid" {
		t.Fatalf("lost binding: %+v", stub.opts)
	}
	refresh, err := l.ModifyPassPaymentAuthorization("usr_test", "lhpass-r1", req)
	if err != nil || refresh.AuthCode != "fresh-ticket" || !stub.opts.AuthorizationOnly {
		t.Fatalf("refresh=%+v err=%v", refresh, err)
	}
	if tickets.ticket.PassID != "lhpass-r1" || tickets.ticket.DealNames[0] != "existing-deal" || tickets.ticket.UserID != "usr_test" {
		t.Fatalf("ticket binding=%+v", tickets.ticket)
	}
	before := stub.calls
	if _, err := l.ModifyPassOrderUrl("other-user", "lhpass-r1", req); err == nil {
		t.Fatal("wrong owner accepted")
	}
	if stub.calls != before {
		t.Fatal("wrong owner reached trade")
	}
	stub.payErr = &tradeadapter.Error{Status: 409, Code: "OrderNotPayable", Message: "refresh order status"}
	tickets.ticket = nil
	if _, err := l.ModifyPassOrderUrl("usr_test", "lhpass-r1", req); !errors.Is(err, errcode.ErrOrderNotPayable) {
		t.Fatalf("checkout must map 409, got %v", err)
	}
	if _, err := l.ModifyPassPaymentAuthorization("usr_test", "lhpass-r1", req); !errors.Is(err, errcode.ErrOrderNotPayable) {
		t.Fatalf("refresh must map 409, got %v", err)
	}
	if tickets.ticket != nil {
		t.Fatal("nonpayable order issued ticket")
	}
	stub.payErr = nil
	stub.recovery = &tradeadapter.ModifyCheckoutResult{Checkout: &tradeadapter.ModifyCheckout{DealName: "existing-deal", BigOrderID: "big", TargetBundleID: "bundle_cruise_01", LocalStatus: "pending_pay"}}
	for i := 1; i <= 2; i++ {
		created, err := l.ModifyPassOrder("usr_test", "lhpass-r1", &transport.ModifyPassOrderRequest{TargetBundleID: "bundle_cruise_01"})
		if err != nil || created.DealName != fmt.Sprintf("new-deal-%d", i) || created.AuthCode != "fresh-ticket" {
			t.Fatalf("explicit checkout %d: result=%+v err=%v", i, created, err)
		}
	}
	if _, err := l.ModifyPassOrder("usr_test", "lhpass-r1", &transport.ModifyPassOrderRequest{TargetBundleID: "other"}); !errors.Is(err, errcode.ErrPassModifyTargetNotAllowed) {
		t.Fatalf("illegal target=%v", err)
	}
}
