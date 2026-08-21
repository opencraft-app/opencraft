package inquiry

import (
	"context"
	"strings"
	"testing"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/jifeiclient"
	"git.woa.com/wisp/mono/trade/internal/region"
)

// TestQuote_IntlSiteRegionAndCurrency 验证 v1.7.x 国际站接入 A6.1 + A5：
//   - Deps.SiteKind="intl" 时 Quote 出向 jifei envelope.resInfo.regionId/zoneId/currency
//     全部使用国际站常量（Singapore 9/900001 + USD），合规要求资源落海外地域
//   - Deps.SiteKind="cn"（缺省 / 兼容老调用方）时仍是国内常量（广州 1/100001 + CNY），
//     与 v1.7.x 接入前行为 100% 一致
//
// 测试方式：通过 fakeJifei.lastGetPriceArgs 捕获 trade 给 jifei 的 GetPriceRequest，
// 直接断言 ResInfo[0] 的 RegionID/ZoneID/Currency 三字段。
func TestQuote_IntlSiteRegionAndCurrency(t *testing.T) {
	cases := []struct {
		name            string
		siteKind        string
		wantRegionID    int
		wantZoneID      int
		wantCurrency    string
		wantPointOfSale bool
	}{
		{
			name:            "cn falls back to guangzhou + CNY",
			siteKind:        "cn",
			wantRegionID:    region.LighthouseRegionID,
			wantZoneID:      region.LighthouseZoneID,
			wantCurrency:    "CNY",
			wantPointOfSale: false,
		},
		{
			name:            "empty falls back to cn behavior",
			siteKind:        "",
			wantRegionID:    region.LighthouseRegionID,
			wantZoneID:      region.LighthouseZoneID,
			wantCurrency:    "CNY",
			wantPointOfSale: false,
		},
		{
			name:            "intl uses singapore + USD",
			siteKind:        "intl",
			wantRegionID:    region.LighthouseIntlRegionID,
			wantZoneID:      region.LighthouseIntlZoneID,
			wantCurrency:    "USD",
			wantPointOfSale: true,
		},
		{
			name:            "bogus value falls back to cn",
			siteKind:        "bogus",
			wantRegionID:    region.LighthouseRegionID,
			wantZoneID:      region.LighthouseZoneID,
			wantCurrency:    "CNY",
			wantPointOfSale: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctl := &fakeCTL{getBundleByIDFn: func(_ context.Context, _ string) (*ctlclient.BundleDetail, error) {
				return stdBundle(), nil
			}}
			bs := &fakeBundleStore{def: stdDef()}
			jc := &fakeJifei{getPriceFn: func(_ context.Context, _ *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error) {
				if tc.siteKind == "intl" {
					return stdIntlJifeiPriceResp(), nil
				}
				return stdJifeiPriceResp(), nil
			}}
			svc := New(Deps{
				CTLClient:   ctl,
				BundleStore: bs,
				JifeiClient: jc,
				SiteKind:    tc.siteKind,
			})

			if _, err := svc.Quote(context.Background(), stdQuoteReq()); err != nil {
				t.Fatalf("Quote: %v", err)
			}
			if jc.lastGetPriceArgs == nil || len(jc.lastGetPriceArgs.ResInfo) == 0 {
				t.Fatalf("lastGetPriceArgs not captured")
			}
			got := jc.lastGetPriceArgs.ResInfo[0]
			if got.RegionID != tc.wantRegionID {
				t.Errorf("ResInfo[0].RegionID = %d, want %d", got.RegionID, tc.wantRegionID)
			}
			if got.ZoneID != tc.wantZoneID {
				t.Errorf("ResInfo[0].ZoneID = %d, want %d", got.ZoneID, tc.wantZoneID)
			}
			if got.Currency != tc.wantCurrency {
				t.Errorf("ResInfo[0].Currency = %q, want %q", got.Currency, tc.wantCurrency)
			}
			if tc.wantPointOfSale {
				assertIntlPointOfSale(t, got.GoodsDetail)
			} else {
				assertNoPointOfSale(t, got.GoodsDetail)
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

// TestResolveCurrency 单独覆盖 resolveCurrency helper（adapter 删除后该映射唯一来源）。
func TestResolveCurrency(t *testing.T) {
	cases := []struct {
		siteKind string
		want     string
	}{
		{"cn", "CNY"},
		{"", "CNY"},
		{"bogus", "CNY"},
		{"INTL", "CNY"}, // helper 不做规范化（上游 config.normalizeSiteKind 负责）
		{"intl", "USD"},
	}
	for _, tc := range cases {
		if got := resolveCurrency(tc.siteKind); got != tc.want {
			t.Errorf("resolveCurrency(%q) = %q, want %q", tc.siteKind, got, tc.want)
		}
	}
}

func TestQuote_IntlHighPrecisionPriceUsesCentsContract(t *testing.T) {
	ctl := &fakeCTL{getBundleByIDFn: func(_ context.Context, _ string) (*ctlclient.BundleDetail, error) {
		return stdBundle(), nil
	}}
	bs := &fakeBundleStore{def: stdRenewDef()}
	jc := &fakeJifei{getPriceFn: func(_ context.Context, _ *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error) {
		return &jifeiclient.GetPriceResponse{
			Data: []jifeiclient.GetPriceData{
				{
					Price:         "999999",
					TotalCost:     "999999",
					RealTotalCost: "999999",
					Currency:      "USD",
					TaxDetail:     &jifeiclient.TaxDetail{TaxRate: "0.07"},
					HighPrecisionPrice: &jifeiclient.HighPrecisionPrice{
						PriceHigh:         "650000000",
						TotalCostHigh:     "1400000000",
						RealTotalCostHigh: "1200000000",
					},
				},
			},
		}, nil
	}}
	svc := New(Deps{
		CTLClient:   ctl,
		BundleStore: bs,
		JifeiClient: jc,
		SiteKind:    "intl",
	})

	got, err := svc.Quote(context.Background(), stdQuoteReq())
	if err != nil {
		t.Fatalf("Quote: %v", err)
	}
	if got.Price != "650" || got.TotalCost != "1400" || got.TaxPrice != "84" || got.RealTotalCost != "1284" {
		t.Fatalf("Quote amounts = price:%s total:%s tax:%s real:%s, want 650/1400/84/1284",
			got.Price, got.TotalCost, got.TaxPrice, got.RealTotalCost)
	}

	renewGot, err := svc.QuoteRenew(context.Background(), stdQuoteRenewReq())
	if err != nil {
		t.Fatalf("QuoteRenew: %v", err)
	}
	if renewGot.Price != "650" || renewGot.TotalCost != "1400" || renewGot.TaxPrice != "84" || renewGot.RealTotalCost != "1284" {
		t.Fatalf("QuoteRenew amounts = price:%s total:%s tax:%s real:%s, want 650/1400/84/1284",
			renewGot.Price, renewGot.TotalCost, renewGot.TaxPrice, renewGot.RealTotalCost)
	}
}

func TestQuote_IntlRejectsInvalidTaxRate(t *testing.T) {
	tests := []struct {
		name      string
		taxDetail *jifeiclient.TaxDetail
	}{
		{name: "missing tax detail"},
		{name: "missing tax rate", taxDetail: &jifeiclient.TaxDetail{}},
		{name: "malformed tax rate", taxDetail: &jifeiclient.TaxDetail{TaxRate: "bad"}},
		{name: "negative tax rate", taxDetail: &jifeiclient.TaxDetail{TaxRate: "-0.01"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctl := &fakeCTL{getBundleByIDFn: func(context.Context, string) (*ctlclient.BundleDetail, error) {
				return stdBundle(), nil
			}}
			jc := &fakeJifei{getPriceFn: func(context.Context, *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error) {
				return &jifeiclient.GetPriceResponse{Data: []jifeiclient.GetPriceData{{
					Currency:  "USD",
					TaxDetail: tt.taxDetail,
					HighPrecisionPrice: &jifeiclient.HighPrecisionPrice{
						PriceHigh: "650000000", TotalCostHigh: "650000000", RealTotalCostHigh: "650000000",
					},
				}}}, nil
			}}
			svc := New(Deps{CTLClient: ctl, BundleStore: &fakeBundleStore{def: stdDef()}, JifeiClient: jc, SiteKind: "intl"})

			_, err := svc.Quote(context.Background(), stdQuoteReq())
			if err == nil || !strings.Contains(err.Error(), "tax") {
				t.Fatalf("Quote error = %v, want tax error", err)
			}
		})
	}
}

func TestQuote_CNHighPrecisionPriceIgnored(t *testing.T) {
	ctl := &fakeCTL{getBundleByIDFn: func(_ context.Context, _ string) (*ctlclient.BundleDetail, error) {
		return stdBundle(), nil
	}}
	bs := &fakeBundleStore{def: stdDef()}
	jc := &fakeJifei{getPriceFn: func(_ context.Context, _ *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error) {
		return &jifeiclient.GetPriceResponse{
			Data: []jifeiclient.GetPriceData{
				{
					Price:         "3900",
					TotalCost:     "3900",
					RealTotalCost: "3510",
					Currency:      "CNY",
					HighPrecisionPrice: &jifeiclient.HighPrecisionPrice{
						PriceHigh:         "650000000",
						TotalCostHigh:     "1400000000",
						RealTotalCostHigh: "1200000000",
					},
				},
			},
		}, nil
	}}
	svc := New(Deps{
		CTLClient:   ctl,
		BundleStore: bs,
		JifeiClient: jc,
	})

	got, err := svc.Quote(context.Background(), stdQuoteReq())
	if err != nil {
		t.Fatalf("Quote: %v", err)
	}
	if got.Price != "3900" || got.TotalCost != "3900" || got.RealTotalCost != "3510" {
		t.Fatalf("Quote amounts = price:%s total:%s real:%s, want original 3900/3900/3510",
			got.Price, got.TotalCost, got.RealTotalCost)
	}
	if got.TaxPrice != "0" {
		t.Fatalf("TaxPrice = %q, want 0", got.TaxPrice)
	}
}

func TestHighPrecisionAmountToCents(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"650000000", "650"},
		{"1400000000", "1400"},
		{"1200000000", "1200"},
		{"750000000.0", "750"},
		{"1", "0.000001"},
		{"", ""},
		{"bad", ""},
	}
	for _, tc := range cases {
		if got := highPrecisionAmountToCents(tc.in); got != tc.want {
			t.Errorf("highPrecisionAmountToCents(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
