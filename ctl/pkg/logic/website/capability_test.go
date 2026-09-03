package website

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"ctl/pkg/errcode"
	"ctl/pkg/model/bundle"
	"ctl/pkg/model/pass"
	"ctl/pkg/model/website"
	"ctl/pkg/resource"
)

// seedPassAndBundle 补齐 capability 查询链路需要的套餐数据。
//
// pass 和 bundle 两张表用 AutoMigrate 建：它们的列很多，手写 DDL 只会在字段增删时
// 变成一处必须同步维护的重复定义。
func seedPassAndBundle(t *testing.T, userID, bundleID, staticSiteQuota string) {
	t.Helper()
	if err := resource.GormDB.AutoMigrate(&pass.Entity{}, &bundle.Entity{}); err != nil {
		t.Fatal(err)
	}
	p := &pass.Entity{
		PassID:      "pass-" + userID,
		UserID:      userID,
		BundleID:    bundleID,
		ExpiredTime: time.Now().Add(30 * 24 * time.Hour),
		Status:      pass.StatusActive,
	}
	if err := resource.GormDB.Table(pass.TableName).Create(p).Error; err != nil {
		t.Fatal(err)
	}
	b := &bundle.Entity{BundleID: bundleID, StaticSiteQuota: staticSiteQuota}
	if err := resource.GormDB.Table(bundle.TableName).Create(b).Error; err != nil {
		t.Fatal(err)
	}
}

const testQuotaJSON = `{"max_sites":3,"monthly_traffic_bytes":1000,` +
	`"storage_bytes":5368709120,"max_artifact_size":20971520,"max_files":500}`

// capability 必须同时报出流量和存储的已用量：这两个字段是前端展示的唯一来源。
func TestGetCapabilityReportsUsedTrafficAndStorage(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedPassAndBundle(t, "user-1", "bundle-1", testQuotaJSON)
	seedSite(t, "ws-a", "user-1", website.SiteStatusActive, 1)
	seedSite(t, "ws-b", "user-1", website.SiteStatusActive, 1)

	l := NewLogic().(*logic)
	if err := l.UpdateSiteStorage("ws-a", 700); err != nil {
		t.Fatal(err)
	}
	if err := l.UpdateSiteStorage("ws-b", 300); err != nil {
		t.Fatal(err)
	}
	if _, err := l.RecordTrafficUsage([]TrafficUsageReport{
		{SiteID: "ws-a", TrafficBytes: 111, RequestCount: 1},
		{SiteID: "ws-b", TrafficBytes: 222, RequestCount: 2},
	}); err != nil {
		t.Fatal(err)
	}

	got, err := l.GetCapability("user-1")
	if err != nil {
		t.Fatalf("GetCapability: %v", err)
	}
	if got.UsedTrafficBytes != 333 {
		t.Fatalf("used_traffic_bytes = %d，期望 333", got.UsedTrafficBytes)
	}
	if got.UsedStorageBytes != 1000 {
		t.Fatalf("used_storage_bytes = %d，期望 1000", got.UsedStorageBytes)
	}
	if got.MonthlyTrafficBytes != 1000 {
		t.Fatalf("monthly_traffic_bytes = %d，期望 1000（来自套餐）", got.MonthlyTrafficBytes)
	}
	if got.StorageBytes != 5368709120 {
		t.Fatalf("storage_bytes = %d", got.StorageBytes)
	}
}

// 没有任何用量时两个字段都是 0，而不是报错或缺字段。
func TestGetCapabilityReportsZeroUsageForFreshUser(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedPassAndBundle(t, "user-1", "bundle-1", testQuotaJSON)

	got, err := NewLogic().GetCapability("user-1")
	if err != nil {
		t.Fatalf("GetCapability: %v", err)
	}
	if got.UsedTrafficBytes != 0 || got.UsedStorageBytes != 0 {
		t.Fatalf("全新用户的已用量 = %d/%d，期望 0/0", got.UsedTrafficBytes, got.UsedStorageBytes)
	}
}

// ---- 网关门禁视图 ----

// 网关拿到的站点视图必须带上额度和当月已用量，否则超额门禁永远拿到 0（等于不限额）。
func TestGetSiteInternalCarriesTrafficBudget(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedPassAndBundle(t, "user-1", "bundle-1", testQuotaJSON)
	seedSite(t, "ws-a", "user-1", website.SiteStatusActive, 1)

	l := NewLogic().(*logic)
	if _, err := l.RecordTrafficUsage([]TrafficUsageReport{
		{SiteID: "ws-a", TrafficBytes: 400, RequestCount: 1},
	}); err != nil {
		t.Fatal(err)
	}

	view, err := l.GetSiteInternal("ws-a")
	if err != nil {
		t.Fatalf("GetSiteInternal: %v", err)
	}
	if view.Status != website.SiteStatusActive {
		t.Fatalf("status = %q", view.Status)
	}
	if view.MonthlyTrafficBytes != 1000 {
		t.Fatalf("monthly_traffic_bytes = %d，期望 1000", view.MonthlyTrafficBytes)
	}
	if view.UsedTrafficBytes != 400 {
		t.Fatalf("used_traffic_bytes = %d，期望 400", view.UsedTrafficBytes)
	}
}

func TestGetSiteInternalCarriesActiveCloudPath(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedPassAndBundle(t, "user-1", "bundle-1", testQuotaJSON)
	seedSiteWithLocation(t, "ws-a", "user-1", website.SiteStatusActive, 1,
		"sites/ws-a/releases/wr-0123456789abcdef/", "https://ws-a.example.test/")

	view, err := NewLogic().GetSiteInternal("ws-a")
	if err != nil {
		t.Fatalf("GetSiteInternal: %v", err)
	}
	if view.CloudPath != "sites/ws-a/releases/wr-0123456789abcdef/" {
		t.Fatalf("cloud_path = %q", view.CloudPath)
	}
}

// internal 站点状态接口是 token 保护的内部契约，可以回传所属 user_id 给下游做唯一身份关联。
func TestGetSiteInternalCarriesUserID(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedPassAndBundle(t, "user-1", "bundle-1", testQuotaJSON)
	seedSite(t, "ws-a", "user-1", website.SiteStatusActive, 1)

	view, err := NewLogic().GetSiteInternal("ws-a")
	if err != nil {
		t.Fatalf("GetSiteInternal: %v", err)
	}

	raw, err := json.Marshal(view)
	if err != nil {
		t.Fatalf("marshal view: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if payload["user_id"] != "user-1" {
		t.Fatalf("user_id = %#v，期望 user-1；payload=%s", payload["user_id"], string(raw))
	}
}

// 当月已用量是按用户跨站点汇总的：一个站点刷爆额度会把同一用户的其他站点一起闸掉。
// 这是月额度按用户计量的直接后果，必须是可观测的行为而不是意外。
func TestGetSiteInternalUsesUserWideUsage(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedPassAndBundle(t, "user-1", "bundle-1", testQuotaJSON)
	seedSite(t, "ws-a", "user-1", website.SiteStatusActive, 1)
	seedSite(t, "ws-b", "user-1", website.SiteStatusActive, 1)

	l := NewLogic().(*logic)
	if _, err := l.RecordTrafficUsage([]TrafficUsageReport{
		{SiteID: "ws-a", TrafficBytes: 1200, RequestCount: 1},
	}); err != nil {
		t.Fatal(err)
	}

	view, err := l.GetSiteInternal("ws-b")
	if err != nil {
		t.Fatalf("GetSiteInternal: %v", err)
	}
	if view.UsedTrafficBytes != 1200 {
		t.Fatalf("ws-b 的 used = %d，期望 1200（按用户汇总）", view.UsedTrafficBytes)
	}
}

// 套餐数据缺失时必须 fail-open 返回 0（不限额）：因为一次配额查不到就把用户的
// 站点整体 403，比让流量多跑一会儿糟糕得多。
func TestGetSiteInternalFailsOpenWithoutBundleQuota(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedPassAndBundle(t, "user-1", "bundle-1", "")
	seedSite(t, "ws-a", "user-1", website.SiteStatusActive, 1)

	view, err := NewLogic().GetSiteInternal("ws-a")
	if err != nil {
		t.Fatalf("GetSiteInternal 不应因配额缺失而失败: %v", err)
	}
	if view.MonthlyTrafficBytes != 0 {
		t.Fatalf("monthly_traffic_bytes = %d，期望 0（不限额）", view.MonthlyTrafficBytes)
	}
}

// 没有生效套餐的用户同样 fail-open：这类站点已经由 pass 生命周期钩子转成 suspended，
// 网关会先在状态门禁那一步拦下，不需要在这里再补一层。
func TestGetSiteInternalFailsOpenWithoutActivePass(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedSite(t, "ws-a", "user-1", website.SiteStatusSuspended, 1)

	view, err := NewLogic().GetSiteInternal("ws-a")
	if err != nil {
		t.Fatalf("GetSiteInternal: %v", err)
	}
	if view.Status != website.SiteStatusSuspended {
		t.Fatalf("status = %q", view.Status)
	}
	if view.MonthlyTrafficBytes != 0 {
		t.Fatalf("monthly_traffic_bytes = %d，期望 0", view.MonthlyTrafficBytes)
	}
}

func TestGetSiteInternalReturnsNotFoundForMissingOrDeletedSite(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedPassAndBundle(t, "user-1", "bundle-1", testQuotaJSON)
	seedSite(t, "ws-deleted", "user-1", website.SiteStatusActive, 1)

	if err := resource.GormDB.Table(website.SitesTable).
		Where("site_id = ?", "ws-deleted").
		Update("deleted_time", time.Now().UTC()).Error; err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		name   string
		siteID string
	}{
		{name: "missing", siteID: "ws-missing"},
		{name: "deleted", siteID: "ws-deleted"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := NewLogic().GetSiteInternal(tc.siteID)
			if !errors.Is(err, errcode.ErrWebsiteNotFound) {
				t.Fatalf("GetSiteInternal(%q) error = %v，期望 ErrWebsiteNotFound", tc.siteID, err)
			}
		})
	}
}
