package inquiry

import (
	"context"
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
		name         string
		siteKind     string
		wantRegionID int
		wantZoneID   int
		wantCurrency string
	}{
		{
			name:         "cn falls back to guangzhou + CNY",
			siteKind:     "cn",
			wantRegionID: region.LighthouseRegionID,
			wantZoneID:   region.LighthouseZoneID,
			wantCurrency: "CNY",
		},
		{
			name:         "empty falls back to cn behavior",
			siteKind:     "",
			wantRegionID: region.LighthouseRegionID,
			wantZoneID:   region.LighthouseZoneID,
			wantCurrency: "CNY",
		},
		{
			name:         "intl uses singapore + USD",
			siteKind:     "intl",
			wantRegionID: region.LighthouseIntlRegionID,
			wantZoneID:   region.LighthouseIntlZoneID,
			wantCurrency: "USD",
		},
		{
			name:         "bogus value falls back to cn",
			siteKind:     "bogus",
			wantRegionID: region.LighthouseRegionID,
			wantZoneID:   region.LighthouseZoneID,
			wantCurrency: "CNY",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctl := &fakeCTL{getBundleByIDFn: func(_ context.Context, _ string) (*ctlclient.BundleDetail, error) {
				return stdBundle(), nil
			}}
			bs := &fakeBundleStore{def: stdDef()}
			jc := &fakeJifei{getPriceFn: func(_ context.Context, _ *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error) {
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
		})
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
