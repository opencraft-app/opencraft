package creditorder

import (
	"context"
	"errors"
	"testing"

	"git.woa.com/wisp/mono/trade/internal/jifeiclient"
	"git.woa.com/wisp/mono/trade/internal/shadowclient"
	"git.woa.com/wisp/mono/trade/internal/store"
)

type fakeCreditDefStore struct {
	def *store.CreditDefinition
	err error
}

func (s fakeCreditDefStore) GetCreditDefinitionByProductID(_ context.Context, productID string) (*store.CreditDefinition, error) {
	if s.err != nil {
		return nil, s.err
	}
	if s.def == nil || s.def.ProductID != productID {
		return nil, store.ErrCreditDefinitionNotFound
	}
	cp := *s.def
	return &cp, nil
}

func (s fakeCreditDefStore) ListCreditDefinitions(context.Context, string, string) ([]*store.CreditDefinition, error) {
	return nil, errors.New("not used")
}

type fakeOrderWriter struct {
	in store.CreateOrderInput
}

func (w *fakeOrderWriter) CreateOrder(_ context.Context, in store.CreateOrderInput) error {
	w.in = in
	return nil
}

func (w *fakeOrderWriter) MarkOrderProvisioned(context.Context, string, string) error {
	return errors.New("not used")
}

func (w *fakeOrderWriter) UpdatePayURL(context.Context, string, string) error {
	return errors.New("not used")
}

func (w *fakeOrderWriter) MarkOrderCancelled(context.Context, string) error {
	return errors.New("not used")
}

type fakeShadow struct{}

func (fakeShadow) GetBindingByExternalUserID(_ context.Context, externalUserID string) (*shadowclient.Binding, error) {
	return &shadowclient.Binding{UserID: externalUserID, Uin: "700000164995", AppID: "1300000001"}, nil
}

type fakeJifei struct {
	lastPriceReq       *jifeiclient.GetPriceRequest
	lastDealsReq       *jifeiclient.GenerateDealsRequest
	lastDealsAndPayReq *jifeiclient.GenerateDealsAndPayRequest
	dealsAndPayResp    *jifeiclient.GenerateDealsAndPayResponse
}

func (f *fakeJifei) GetPrice(_ context.Context, req *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error) {
	f.lastPriceReq = req
	return &jifeiclient.GetPriceResponse{Data: []jifeiclient.GetPriceData{
		{Price: "10.00", TotalCost: "10.00", RealTotalCost: "8.00", Currency: "CNY", PolicyDetail: &jifeiclient.PolicyDetail{Total: 0.8}},
	}}, nil
}

func (f *fakeJifei) GenerateDeals(_ context.Context, req *jifeiclient.GenerateDealsRequest) (*jifeiclient.GenerateDealsResponse, error) {
	f.lastDealsReq = req
	return &jifeiclient.GenerateDealsResponse{BigDealID: "big-1", DealNames: []string{"deal-1"}}, nil
}

func (f *fakeJifei) GenerateDealsAndPay(_ context.Context, req *jifeiclient.GenerateDealsAndPayRequest) (*jifeiclient.GenerateDealsAndPayResponse, error) {
	f.lastDealsAndPayReq = req
	if f.dealsAndPayResp != nil {
		return f.dealsAndPayResp, nil
	}
	return &jifeiclient.GenerateDealsAndPayResponse{BigDealIDs: []string{"big-1"}, DealNames: []string{"deal-1"}}, nil
}

func (f *fakeJifei) GetMidasEarmarking(context.Context, *jifeiclient.GetMidasEarmarkingRequest) (*jifeiclient.GetMidasEarmarkingResponse, error) {
	return nil, errors.New("not used")
}

func (f *fakeJifei) ModifyResourceStatus(context.Context, *jifeiclient.ModifyResourceStatusRequest) (*jifeiclient.ModifyResourceStatusResponse, error) {
	return nil, errors.New("not used")
}

func (f *fakeJifei) GetDealsByKeyIndex(context.Context, *jifeiclient.GetDealsByKeyIndexRequest) (*jifeiclient.GetDealsByKeyIndexResponse, error) {
	return nil, errors.New("not used")
}

func (f *fakeJifei) OnlineRefund(context.Context, *jifeiclient.OnlineRefundRequest) (*jifeiclient.OnlineRefundResponse, error) {
	return nil, errors.New("not used")
}

func stdCreditDefinition() *store.CreditDefinition {
	return &store.CreditDefinition{
		ProductID:      "credit_prod_100",
		ProductCode:    "p_lightvela_credit",
		SubProductCode: "sp_credit_100",
		Pid:            10001,
		CategoryIDs: []store.CategoryIDEntry{
			{Scene: "purchase", Category: 2026001},
			{Scene: "renew", Category: 2026002},
		},
		SVList:      map[string]int64{"sv_credit_plan": 100},
		ProductInfo: []map[string]interface{}{{"name": "type", "value": "credit"}},
	}
}

func TestQuoteBuildsCreditGoodsDetail(t *testing.T) {
	jifei := &fakeJifei{}
	svc := New(Deps{
		CreditDefinitionStore: fakeCreditDefStore{def: stdCreditDefinition()},
		JifeiClient:           jifei,
		OrderWriter:           &fakeOrderWriter{},
	})

	got, err := svc.Quote(context.Background(), Request{
		ExternalUserID: "usr_1",
		Uin:            "700000164995",
		AppID:          "1300000001",
		ProductID:      "credit_prod_100",
	})
	if err != nil {
		t.Fatalf("quote: %v", err)
	}
	if got.ProductID != "credit_prod_100" || got.RealTotalCost != "8.00" {
		t.Fatalf("unexpected quote result: %+v", got)
	}
	detail := jifei.lastPriceReq.ResInfo[0].GoodsDetail
	if got := jifei.lastPriceReq.ResInfo[0].GoodsCategoryID; got != 2026001 {
		t.Fatalf("goodsCategoryId=%d, want 2026001", got)
	}
	if detail["productId"] != "credit_prod_100" || detail["externalUserId"] != "usr_1" || detail["sv_credit_plan"] != int64(100) {
		t.Fatalf("unexpected goodsDetail: %+v", detail)
	}
	if detail["timeSpan"] != 1 || detail["timeUnit"] != "p" || detail["packageTimeSpan"] != 1 || detail["packageTimeUnit"] != "m" {
		t.Fatalf("resource package goodsDetail has wrong billing periods: %+v", detail)
	}
}

func TestPlaceOrderUsesShadowBindingAndWritesCreditOrder(t *testing.T) {
	jifei := &fakeJifei{}
	writer := &fakeOrderWriter{}
	svc := New(Deps{
		CreditDefinitionStore: fakeCreditDefStore{def: stdCreditDefinition()},
		JifeiClient:           jifei,
		OrderWriter:           writer,
		ShadowClient:          fakeShadow{},
	})

	res, err := svc.PlaceOrder(context.Background(), Request{
		ExternalUserID: "usr_1",
		ProductID:      "credit_prod_100",
	})
	if err != nil {
		t.Fatalf("place order: %v", err)
	}
	if res.DealName != "deal-1" || res.BigOrderID != "big-1" {
		t.Fatalf("unexpected order result: %+v", res)
	}
	if jifei.lastDealsReq == nil || jifei.lastDealsReq.AppID != 1300000001 {
		t.Fatalf("expected app id from shadow binding, got %+v", jifei.lastDealsReq)
	}
	if got := jifei.lastDealsReq.Goods[0].GoodsCategoryID; got != 2026001 {
		t.Fatalf("goodsCategoryId=%d, want 2026001", got)
	}
	if writer.in.ResourceType != "credit_package" || writer.in.BundleID != "credit_prod_100" || writer.in.Uin != "700000164995" {
		t.Fatalf("unexpected trade_order input: %+v", writer.in)
	}
}

func TestPlaceOrderDefaultsCreditPeriodIntoGoodsDetail(t *testing.T) {
	jifei := &fakeJifei{}
	writer := &fakeOrderWriter{}
	svc := New(Deps{
		CreditDefinitionStore: fakeCreditDefStore{def: stdCreditDefinition()},
		JifeiClient:           jifei,
		OrderWriter:           writer,
	})

	_, err := svc.PlaceOrder(context.Background(), Request{
		ExternalUserID: "usr_1",
		Uin:            "700000164995",
		AppID:          "1300000001",
		ProductID:      "credit_prod_100",
	})
	if err != nil {
		t.Fatalf("place order: %v", err)
	}
	if writer.in.Period != 1 || writer.in.TimeUnit != "m" {
		t.Fatalf("unexpected persisted period: %+v", writer.in)
	}
	detail := jifei.lastDealsReq.Goods[0].GoodsDetail
	if detail["timeSpan"] != 1 || detail["timeUnit"] != "p" || detail["packageTimeSpan"] != 1 || detail["packageTimeUnit"] != "m" {
		t.Fatalf("goodsDetail should use fixed resource-package billing period and carry the real period, got %+v", detail)
	}
}

func TestPlaceOrderAndPayPersistsSynchronousDeliveryAsProvisioned(t *testing.T) {
	jifei := &fakeJifei{
		dealsAndPayResp: &jifeiclient.GenerateDealsAndPayResponse{
			BigDealIDs: []string{"big-1"},
			DealNames:  []string{"deal-1"},
			ResourceIDs: map[string][]string{
				"deal-1": {"cpkg-1"},
			},
			DealDeliverResults: map[string]map[string]interface{}{
				"deal-1": {"state": "0"},
			},
		},
	}
	writer := &fakeOrderWriter{}
	svc := New(Deps{
		CreditDefinitionStore: fakeCreditDefStore{def: stdCreditDefinition()},
		JifeiClient:           jifei,
		OrderWriter:           writer,
	})

	res, err := svc.PlaceOrderAndPay(context.Background(), Request{
		ExternalUserID: "usr_1",
		Uin:            "700000164995",
		AppID:          "1300000001",
		ProductID:      "credit_prod_100",
	})
	if err != nil {
		t.Fatalf("place order and pay: %v", err)
	}
	if res.DealName != "deal-1" || res.BigOrderID != "big-1" {
		t.Fatalf("unexpected order result: %+v", res)
	}
	if writer.in.Status != store.OrderStatusProvisioned {
		t.Fatalf("status=%q, want %q", writer.in.Status, store.OrderStatusProvisioned)
	}
	if writer.in.ResourceID != "cpkg-1" {
		t.Fatalf("resource_id=%q, want cpkg-1", writer.in.ResourceID)
	}
	if got := jifei.lastDealsAndPayReq.Goods[0].GoodsCategoryID; got != 2026001 {
		t.Fatalf("goodsCategoryId=%d, want 2026001", got)
	}
}

func TestPlaceOrderAndPayKeepsPendingUntilSynchronousDeliveryCompletes(t *testing.T) {
	tests := []struct {
		name        string
		state       string
		resourceIDs []string
	}{
		{name: "delivery in progress", state: "1", resourceIDs: []string{"cpkg-1"}},
		{name: "resource id missing", state: "0"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			jifei := &fakeJifei{
				dealsAndPayResp: &jifeiclient.GenerateDealsAndPayResponse{
					BigDealIDs: []string{"big-1"},
					DealNames:  []string{"deal-1"},
					ResourceIDs: map[string][]string{
						"deal-1": tt.resourceIDs,
					},
					DealDeliverResults: map[string]map[string]interface{}{
						"deal-1": {"state": tt.state},
					},
				},
			}
			writer := &fakeOrderWriter{}
			svc := New(Deps{
				CreditDefinitionStore: fakeCreditDefStore{def: stdCreditDefinition()},
				JifeiClient:           jifei,
				OrderWriter:           writer,
			})

			_, err := svc.PlaceOrderAndPay(context.Background(), Request{
				ExternalUserID: "usr_1",
				Uin:            "700000164995",
				AppID:          "1300000001",
				ProductID:      "credit_prod_100",
			})
			if err != nil {
				t.Fatalf("place order and pay: %v", err)
			}
			if writer.in.Status != store.OrderStatusPaidPendingProvision {
				t.Fatalf("status=%q, want %q", writer.in.Status, store.OrderStatusPaidPendingProvision)
			}
			if writer.in.ResourceID != "" {
				t.Fatalf("resource_id=%q, want empty", writer.in.ResourceID)
			}
		})
	}
}

func TestValidatePeriodSupportsAllResourcePackageUnits(t *testing.T) {
	for _, unit := range []string{"y", "m", "d", "h", "M", "s"} {
		t.Run(unit, func(t *testing.T) {
			if err := validatePeriod(1, unit); err != nil {
				t.Fatalf("validatePeriod(%q): %v", unit, err)
			}
		})
	}
}
