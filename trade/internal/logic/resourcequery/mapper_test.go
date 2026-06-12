package resourcequery

import (
	"testing"
	"time"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/region"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// ---- buildResourceGoodsDetail -----------------------------------------------

// 1. nil def → 返空 map（不 panic）
func TestBuildResourceGoodsDetail_NilDef(t *testing.T) {
	gd := buildResourceGoodsDetail(nil, region.Resolve("cn", ""))
	if gd == nil {
		t.Fatalf("expected empty map, got nil")
	}
	if len(gd) != 0 {
		t.Fatalf("expected empty map, got %+v", gd)
	}
}

// 2. 完整 def → 字段全到位 + sv_* 展平 + productInfo 合并
func TestBuildResourceGoodsDetail_FullDef(t *testing.T) {
	def := stdBundleDef("bundle_x")
	gd := buildResourceGoodsDetail(def, region.Resolve("cn", ""))

	if gd["productCode"] != "p_lighthouse" {
		t.Errorf("productCode mismatch: %v", gd["productCode"])
	}
	if gd["subProductCode"] != "sp_lighthouse_pass" {
		t.Errorf("subProductCode mismatch: %v", gd["subProductCode"])
	}
	if gd["pid"] != int64(40000) {
		t.Errorf("pid mismatch: %v", gd["pid"])
	}
	// Q71（2026-05-13）：sv_* 是 int64 直接透传到 jifei wire（不再 stringify）
	if gd["sv_cpu"] != int64(2) {
		t.Errorf("sv_cpu mismatch: %v", gd["sv_cpu"])
	}
	if gd["sv_mem"] != int64(4) {
		t.Errorf("sv_mem mismatch: %v", gd["sv_mem"])
	}
	// productInfo 必含"地域=广州"作为首条；def 自带的"套餐内含"附在后面
	pi, ok := gd["productInfo"].([]map[string]interface{})
	if !ok {
		t.Fatalf("productInfo not []map[string]interface{}: %T", gd["productInfo"])
	}
	if len(pi) != 2 {
		t.Fatalf("expected 2 productInfo entries, got %d: %+v", len(pi), pi)
	}
	if pi[0]["name"] != "地域" || pi[0]["value"] != "广州" {
		t.Errorf("first productInfo must be 地域=广州, got %+v", pi[0])
	}
	if pi[1]["name"] != "套餐内含" {
		t.Errorf("second productInfo must preserve def order, got %+v", pi[1])
	}
}

// 3. def.ProductInfo 为空 → productInfo 仍至少含"地域=广州"（不为空切片）
func TestBuildResourceGoodsDetail_EmptyProductInfo(t *testing.T) {
	def := &store.BundleDefinition{
		BundleID:    "b1",
		ProductCode: "p_lighthouse",
		Pid:         40000,
		SVList:      map[string]int64{},
		// ProductInfo: nil
	}
	gd := buildResourceGoodsDetail(def, region.Resolve("cn", ""))
	pi, _ := gd["productInfo"].([]map[string]interface{})
	if len(pi) != 1 {
		t.Fatalf("expected 1 productInfo (region only), got %d: %+v", len(pi), pi)
	}
	if pi[0]["value"] != "广州" {
		t.Errorf("region productInfo expected 广州, got %v", pi[0]["value"])
	}
}

// 4. SVList int64 值 → 直接透传到 goodsDetail（Q71 推翻 Q66：不再 stringify）
func TestBuildResourceGoodsDetail_SVInt64Passthrough(t *testing.T) {
	def := &store.BundleDefinition{
		BundleID:    "b1",
		ProductCode: "p_lighthouse",
		Pid:         40000,
		SVList: map[string]int64{
			"sv_cpu":  8,
			"sv_disk": 100,
			"sv_mem":  4,
		},
	}
	gd := buildResourceGoodsDetail(def, region.Resolve("cn", ""))
	if gd["sv_cpu"] != int64(8) {
		t.Errorf("sv_cpu expected int64(8), got %v (%T)", gd["sv_cpu"], gd["sv_cpu"])
	}
	if gd["sv_disk"] != int64(100) {
		t.Errorf("sv_disk expected int64(100), got %v (%T)", gd["sv_disk"], gd["sv_disk"])
	}
	if gd["sv_mem"] != int64(4) {
		t.Errorf("sv_mem expected int64(4), got %v (%T)", gd["sv_mem"], gd["sv_mem"])
	}
}

// ---- renewFlagToInt ---------------------------------------------------------

func TestRenewFlagToInt_AllVariants(t *testing.T) {
	cases := []struct {
		flag string
		want int
	}{
		{"AUTO_RENEW", 1},
		{"MANUAL_RENEW", 0},
		{"", 0},
		{"UNKNOWN_VALUE", 0}, // 设计稿 §3.3 明示"缺省 0"，非法值同走默认
	}
	for _, tc := range cases {
		t.Run(tc.flag, func(t *testing.T) {
			if got := renewFlagToInt(tc.flag); got != tc.want {
				t.Errorf("renewFlagToInt(%q): want %d, got %d", tc.flag, tc.want, got)
			}
		})
	}
}

// ---- passToResourceMap ------------------------------------------------------

// 1. nil pass → 返空 map
func TestPassToResourceMap_NilPass(t *testing.T) {
	m := passToResourceMap(nil, "100", 12345, stdBundleDef("b"), region.Resolve("cn", ""))
	if len(m) != 0 {
		t.Fatalf("expected empty map, got %+v", m)
	}
}

// 2. happy path：所有固定字段 + 时间格式化北京时间 + status=1（无 isolated）
func TestPassToResourceMap_HappyPath(t *testing.T) {
	// 用 UTC 时间构造，确认输出按北京时间格式化（+8 小时）
	created := time.Date(2026, 5, 11, 0, 0, 0, 0, time.UTC) // → 北京 08:00
	expired := time.Date(2027, 5, 11, 0, 0, 0, 0, time.UTC) // → 北京 08:00
	pass := &ctlclient.PassDetail{
		PassID:       "pass-001",
		BundleID:     "bundle_x",
		Uin:          99999, // 不应进入输出（设计稿明示用入参 uin 透传）
		AppID:        88888, // 同上
		CreatedTime:  created,
		ExpiredTime:  expired,
		IsolatedTime: nil,
		RenewFlag:    "AUTO_RENEW",
	}
	def := stdBundleDef("bundle_x")
	m := passToResourceMap(pass, "100012345678", 12345, def, region.Resolve("cn", ""))

	// 入参 uin / appId 透传（不是 pass.Uin / pass.AppID）
	if m["uin"] != "100012345678" {
		t.Errorf("uin must be input string, got %v", m["uin"])
	}
	if m["appId"] != int64(12345) {
		t.Errorf("appId must be input int64, got %v (%T)", m["appId"], m["appId"])
	}
	if m["resourceId"] != "pass-001" {
		t.Errorf("resourceId mismatch: %v", m["resourceId"])
	}
	// 固定常量
	if m["region"] != region.LighthouseRegionID {
		t.Errorf("region must be %d, got %v", region.LighthouseRegionID, m["region"])
	}
	if m["zoneId"] != region.LighthouseZoneID {
		t.Errorf("zoneId must be %d, got %v", region.LighthouseZoneID, m["zoneId"])
	}
	if m["payMode"] != fixedPayMode {
		t.Errorf("payMode must be %d, got %v", fixedPayMode, m["payMode"])
	}
	if m["instanceType"] != fixedInstanceType {
		t.Errorf("instanceType must be %d, got %v", fixedInstanceType, m["instanceType"])
	}
	if m["allowReturn"] != fixedAllowReturn {
		t.Errorf("allowReturn must be %d, got %v", fixedAllowReturn, m["allowReturn"])
	}
	if m["alias"] != "" {
		t.Errorf("alias must be empty, got %v", m["alias"])
	}
	// status：无 isolated → 1
	if m["status"] != 1 {
		t.Errorf("status without isolated must be 1, got %v", m["status"])
	}
	// renewFlag：AUTO_RENEW → 1
	if m["renewFlag"] != 1 {
		t.Errorf("renewFlag AUTO_RENEW must be 1, got %v", m["renewFlag"])
	}
	// isolatedTimestamp：nil → 占位
	if m["isolatedTimestamp"] != timeNullPlaceholder {
		t.Errorf("isolatedTimestamp nil must be %q, got %v", timeNullPlaceholder, m["isolatedTimestamp"])
	}
	// 时间格式化（北京时间，UTC+8 → 输入 0:00 UTC 应输出 08:00）
	if m["createTime"] != "2026-05-11 08:00:00" {
		t.Errorf("createTime expected '2026-05-11 08:00:00' (Beijing), got %v", m["createTime"])
	}
	if m["expireTime"] != "2027-05-11 08:00:00" {
		t.Errorf("expireTime expected '2027-05-11 08:00:00', got %v", m["expireTime"])
	}
	// goodsDetail 字段非空
	gd, _ := m["goodsDetail"].(map[string]interface{})
	if len(gd) == 0 {
		t.Errorf("goodsDetail must be non-empty, got %v", m["goodsDetail"])
	}
	if gd["pid"] != int64(40000) {
		t.Errorf("goodsDetail.pid mismatch: %v", gd["pid"])
	}
}

// 3. isolated 状态：status=2 + isolatedTimestamp 格式化
func TestPassToResourceMap_IsolatedStatus(t *testing.T) {
	isolated := time.Date(2026, 5, 11, 8, 30, 0, 0, time.UTC) // → 北京 16:30
	pass := &ctlclient.PassDetail{
		PassID:       "pass-iso",
		BundleID:     "bundle_x",
		IsolatedTime: &isolated,
		RenewFlag:    "MANUAL_RENEW",
	}
	m := passToResourceMap(pass, "uin1", 1, stdBundleDef("bundle_x"), region.Resolve("cn", ""))

	if m["status"] != 2 {
		t.Errorf("status with isolated must be 2, got %v", m["status"])
	}
	if m["isolatedTimestamp"] != "2026-05-11 16:30:00" {
		t.Errorf("isolatedTimestamp expected '2026-05-11 16:30:00', got %v", m["isolatedTimestamp"])
	}
	if m["renewFlag"] != 0 {
		t.Errorf("renewFlag MANUAL_RENEW must be 0, got %v", m["renewFlag"])
	}
}

// 4. nil bundleDef → goodsDetail 空 map（不 panic；bundle 已下架但 pass 仍持有的退化场景）
func TestPassToResourceMap_NilBundleDef(t *testing.T) {
	pass := &ctlclient.PassDetail{
		PassID:      "pass-001",
		BundleID:    "deleted-bundle",
		CreatedTime: time.Now().UTC(),
		ExpiredTime: time.Now().UTC().Add(time.Hour),
	}
	m := passToResourceMap(pass, "uin1", 1, nil, region.Resolve("cn", ""))
	gd, ok := m["goodsDetail"].(map[string]interface{})
	if !ok {
		t.Fatalf("goodsDetail must be map even when def is nil, got %T", m["goodsDetail"])
	}
	if len(gd) != 0 {
		t.Errorf("goodsDetail with nil def must be empty, got %+v", gd)
	}
	// 其他固定字段仍要在
	if m["region"] != region.LighthouseRegionID || m["zoneId"] != region.LighthouseZoneID {
		t.Errorf("fixed fields must still be present")
	}
}

// 5. zero-value time → 占位（防御 ctl 异常返回 zero time）
func TestPassToResourceMap_ZeroTimes(t *testing.T) {
	pass := &ctlclient.PassDetail{
		PassID:   "pass-zero",
		BundleID: "b1",
		// CreatedTime / ExpiredTime / IsolatedTime 全 zero
	}
	m := passToResourceMap(pass, "u", 1, nil, region.Resolve("cn", ""))
	if m["createTime"] != timeNullPlaceholder {
		t.Errorf("zero createTime must be %q, got %v", timeNullPlaceholder, m["createTime"])
	}
	if m["expireTime"] != timeNullPlaceholder {
		t.Errorf("zero expireTime must be %q, got %v", timeNullPlaceholder, m["expireTime"])
	}
}
