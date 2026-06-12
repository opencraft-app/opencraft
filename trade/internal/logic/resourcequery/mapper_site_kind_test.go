package resourcequery

import (
	"testing"
	"time"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/region"
)

// TestPassToResourceMap_IntlRegion 验证 v1.7.x 国际站接入 A6.1：
//   - region.Resolve("intl", "") 注入后 mapper 输出 region=9 / zoneId=900001 /
//     productInfo[地域].value="Singapore"（与 cn 站点 1/100001/广州 互不污染）
//   - 与 placeorder 出向同源，闭环合规：海外 pass 反查响应必须带海外地域标识
func TestPassToResourceMap_IntlRegion(t *testing.T) {
	pass := &ctlclient.PassDetail{
		PassID:      "pass-intl-1",
		BundleID:    "bundle_x",
		CreatedTime: time.Date(2026, 5, 11, 0, 0, 0, 0, time.UTC),
		ExpiredTime: time.Date(2027, 5, 11, 0, 0, 0, 0, time.UTC),
		RenewFlag:   "AUTO_RENEW",
	}
	def := stdBundleDef("bundle_x")
	m := passToResourceMap(pass, "800000294207", 251221987, def, region.Resolve("intl", ""))

	if m["region"] != region.LighthouseIntlRegionID {
		t.Errorf("region = %v, want %d (Singapore)", m["region"], region.LighthouseIntlRegionID)
	}
	if m["zoneId"] != region.LighthouseIntlZoneID {
		t.Errorf("zoneId = %v, want %d (Singapore-1)", m["zoneId"], region.LighthouseIntlZoneID)
	}
	gd, _ := m["goodsDetail"].(map[string]interface{})
	pi, _ := gd["productInfo"].([]map[string]interface{})
	if len(pi) == 0 {
		t.Fatalf("productInfo missing first entry")
	}
	if pi[0]["name"] != "地域" || pi[0]["value"] != region.LighthouseIntlRegionName {
		t.Errorf("first productInfo: got %+v, want name=地域 value=%q", pi[0], region.LighthouseIntlRegionName)
	}
}

// TestBuildResourceGoodsDetail_IntlRegion 单独验证 productInfo[地域].value 在 intl 站点 = "Singapore"。
func TestBuildResourceGoodsDetail_IntlRegion(t *testing.T) {
	def := stdBundleDef("bundle_x")
	gd := buildResourceGoodsDetail(def, region.Resolve("intl", ""))
	pi, _ := gd["productInfo"].([]map[string]interface{})
	if len(pi) == 0 || pi[0]["value"] != "Singapore" {
		t.Errorf("intl region productInfo[0].value: got %v, want Singapore (full=%+v)", pi, pi)
	}
}
