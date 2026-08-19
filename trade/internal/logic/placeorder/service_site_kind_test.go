package placeorder

import (
	"context"
	"testing"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/jifeiclient"
	"git.woa.com/wisp/mono/trade/internal/region"
)

// newStdDepsWithSiteKind 与 newStdDeps 行为一致，但允许测试显式注入 deps.SiteKind。
//
// SiteKind="" / "cn" / "bogus" → region.Resolve 兜底为广州；"intl" → 新加坡。
// 复用 service_test.go 的 fakes / std fixtures（stdBundle / stdDef / stdJifeiDealsResp），
// 避免重新搭建 mock 体系。
func newStdDepsWithSiteKind(siteKind string) *stdDeps {
	d := &stdDeps{
		ctl: &fakeCTL{
			getBundleByIDFn: func(_ context.Context, _ string) (*ctlclient.BundleDetail, error) {
				return stdBundle(), nil
			},
		},
		bundle: &fakeBundleStore{def: stdDef()},
		jifei: &fakeJifei{
			generateDealsFn: func(_ context.Context, _ *jifeiclient.GenerateDealsRequest) (*jifeiclient.GenerateDealsResponse, error) {
				return stdJifeiDealsResp(), nil
			},
		},
		writer: &fakeOrderWriter{},
		store:  &fakeOrderStore{},
	}
	d.service = New(Deps{
		CTLClient:   d.ctl,
		BundleStore: d.bundle,
		JifeiClient: d.jifei,
		OrderWriter: d.writer,
		OrderStore:  d.store,
		SiteKind:    siteKind,
	})
	return d
}

// TestPlaceOrder_IntlSiteRegion 验证 v1.7.x 国际站接入 A6.1：
//   - Deps.SiteKind="intl" 时 PlaceOrder 出向 jifei envelope.resInfo.regionId/zoneId
//     使用国际站常量（Singapore 9/900001）
//   - 同步 trade_order.region_id 也跟随出向 envelope 同源（合规留痕，海外资源）
//
// 通过 fakeJifei.lastGenerateDealsReq 和 fakeOrderWriter.lastCreateOrderInput 直接断言。
func TestPlaceOrder_IntlSiteRegion(t *testing.T) {
	cases := []struct {
		name            string
		siteKind        string
		wantRegionID    int
		wantZoneID      int
		wantPointOfSale bool
	}{
		{
			name:            "cn falls back to guangzhou",
			siteKind:        "cn",
			wantRegionID:    region.LighthouseRegionID,
			wantZoneID:      region.LighthouseZoneID,
			wantPointOfSale: false,
		},
		{
			name:            "empty falls back to cn behavior",
			siteKind:        "",
			wantRegionID:    region.LighthouseRegionID,
			wantZoneID:      region.LighthouseZoneID,
			wantPointOfSale: false,
		},
		{
			name:            "intl uses singapore",
			siteKind:        "intl",
			wantRegionID:    region.LighthouseIntlRegionID,
			wantZoneID:      region.LighthouseIntlZoneID,
			wantPointOfSale: true,
		},
		{
			name:            "bogus value falls back to cn",
			siteKind:        "bogus",
			wantRegionID:    region.LighthouseRegionID,
			wantZoneID:      region.LighthouseZoneID,
			wantPointOfSale: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := newStdDepsWithSiteKind(tc.siteKind)
			if _, err := d.service.PlaceOrder(context.Background(), stdPlaceOrderReq()); err != nil {
				t.Fatalf("PlaceOrder: %v", err)
			}
			// 1) jifei envelope.resInfo[0] 维度断言
			if d.jifei.lastGenerateDealsReq == nil ||
				len(d.jifei.lastGenerateDealsReq.Goods) == 0 {
				t.Fatalf("lastGenerateDealsReq not captured")
			}
			gi := d.jifei.lastGenerateDealsReq.Goods[0]
			if gi.RegionID != tc.wantRegionID {
				t.Errorf("envelope.resInfo[0].RegionID = %d, want %d", gi.RegionID, tc.wantRegionID)
			}
			if gi.ZoneID != tc.wantZoneID {
				t.Errorf("envelope.resInfo[0].ZoneID = %d, want %d", gi.ZoneID, tc.wantZoneID)
			}
			if tc.wantPointOfSale {
				assertIntlPointOfSale(t, gi.GoodsDetail)
			} else {
				assertNoPointOfSale(t, gi.GoodsDetail)
			}
			// 2) trade_order.region_id 维度断言（与出向 envelope 同源 — A6.1 合规留痕）
			if d.writer.lastCreateOrderInput.RegionID != tc.wantRegionID {
				t.Errorf("trade_order.region_id = %d, want %d (same as envelope.resInfo)",
					d.writer.lastCreateOrderInput.RegionID, tc.wantRegionID)
			}
		})
	}
}

func assertIntlPointOfSale(t *testing.T, goodsDetail map[string]interface{}) {
	t.Helper()
	billingParam, ok := goodsDetail["billingParam"].(map[string]interface{})
	if !ok {
		t.Fatalf("goodsDetail.billingParam = %#v, want object", goodsDetail["billingParam"])
	}
	if got := billingParam["pointOfSale"]; got != "intlSaaSLightvela" {
		t.Fatalf("goodsDetail.billingParam.pointOfSale = %#v, want intlSaaSLightvela", got)
	}
}

func assertNoPointOfSale(t *testing.T, goodsDetail map[string]interface{}) {
	t.Helper()
	billingParam, ok := goodsDetail["billingParam"].(map[string]interface{})
	if !ok {
		return
	}
	if got, exists := billingParam["pointOfSale"]; exists {
		t.Fatalf("goodsDetail.billingParam.pointOfSale = %#v, want absent", got)
	}
}
