package pass

import (
	"context"
	"testing"

	adapterfactory "ctl/pkg/adapter/factory"
	tradeadapter "ctl/pkg/adapter/trade"
	"ctl/pkg/resource"
	"ctl/pkg/transport"

	"go.uber.org/zap"
)

type orderURLTradeStub struct {
	tradeadapter.Adapter
	gotDealName string
	gotOpts     *tradeadapter.GeneratePayURLOptions
}

func (s *orderURLTradeStub) GeneratePayURL(_ context.Context, dealName string, opts *tradeadapter.GeneratePayURLOptions) (*tradeadapter.PayURLResult, error) {
	s.gotDealName = dealName
	s.gotOpts = opts
	return &tradeadapter.PayURLResult{
		PayURL:     "https://buy.cloud.tencent.com/midas?token=real",
		NeedCharge: 1,
	}, nil
}

func TestCreatePassOrderUrlPassesRedirectURLsToTrade(t *testing.T) {
	originalFactory := adapterfactory.DefaultAdapterFactory
	originalLogger := resource.ZapLogger
	t.Cleanup(func() {
		adapterfactory.DefaultAdapterFactory = originalFactory
		resource.ZapLogger = originalLogger
	})

	resource.ZapLogger = zap.NewNop()
	tradeStub := &orderURLTradeStub{}
	adapterfactory.DefaultAdapterFactory = &allocationAdapterFactory{tradeAdapter: tradeStub}

	result, err := NewLogic().CreatePassOrderUrl("usr-order-url", &transport.CreatePassOrderUrlRequest{
		DealNames: []string{"deal-redirect-1"},
		Platform:  "mobile",
		WxOpenID:  "openid-1",
		CancelURL: "https://intl-sandbox-kr-1.preview.lightclaw.tech/subscribe?pay=cancel",
		ReturnURL: "https://intl-sandbox-kr-1.preview.lightclaw.tech/subscribe?pay=return",
	})
	if err != nil {
		t.Fatalf("CreatePassOrderUrl: %v", err)
	}
	if result.DealName != "deal-redirect-1" {
		t.Fatalf("DealName = %q", result.DealName)
	}
	if tradeStub.gotDealName != "deal-redirect-1" {
		t.Fatalf("trade dealName = %q", tradeStub.gotDealName)
	}
	if tradeStub.gotOpts == nil {
		t.Fatal("GeneratePayURL opts is nil")
	}
	if tradeStub.gotOpts.CancelURL != "https://intl-sandbox-kr-1.preview.lightclaw.tech/subscribe?pay=cancel" {
		t.Fatalf("CancelURL = %q", tradeStub.gotOpts.CancelURL)
	}
	if tradeStub.gotOpts.ReturnURL != "https://intl-sandbox-kr-1.preview.lightclaw.tech/subscribe?pay=return" {
		t.Fatalf("ReturnURL = %q", tradeStub.gotOpts.ReturnURL)
	}
}
