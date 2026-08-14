package website

import (
	"testing"

	"ctl/pkg/model/website"
	"ctl/pkg/resource"
)

// 到期隔离只做一次状态迁移：站点转 suspended，一个 COS 对象都不动。
//
// 自研反代每次请求都查站点状态，suspended 直接 403 且不回源，所以下线不需要删文件。
// 这里断言「没有登记任何操作」正是在守住这一点：只要还登记 suspend 操作，
// worker 就会去删 sites/{siteID}/，用户数据就没了。
func TestOnPassIsolatedOnlyFlipsStatusWithoutCosWork(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedSiteWithLocation(t, "ws-suspend", "user-1", website.SiteStatusActive, 1,
		"sites/ws-suspend/current/", "http://ws-suspend.sites.example/")

	l := NewLogic().(*logic)
	if err := l.OnPassIsolated("user-1"); err != nil {
		t.Fatalf("OnPassIsolated: %v", err)
	}

	site := loadSite(t, "ws-suspend")
	if site.Status != website.SiteStatusSuspended {
		t.Fatalf("site status = %q, want %q", site.Status, website.SiteStatusSuspended)
	}
	// generation 必须推进，否则一次在途的 deploy 回调会把刚隔离的站点重新置为 active。
	if site.OperationGeneration != 2 {
		t.Fatalf("operation_generation = %d, want 2", site.OperationGeneration)
	}
	// 文件永久保留，指向文件的两个字段也必须原样保留，续费后地址和内容都不变。
	if site.CloudPath != "sites/ws-suspend/current/" || site.PublicURL != "http://ws-suspend.sites.example/" {
		t.Fatalf("cloud_path/public_url must survive isolation, got %q / %q", site.CloudPath, site.PublicURL)
	}
	assertNoOperations(t, "ws-suspend")
}

// 续费只把状态改回 active：文件从没被删过，不需要从制品重新发布。
func TestOnPassRenewedOnlyFlipsStatusWithoutCosWork(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedSiteWithLocation(t, "ws-resume", "user-1", website.SiteStatusSuspended, 5,
		"sites/ws-resume/current/", "http://ws-resume.sites.example/")
	seedRelease(t, "wr-old", "ws-resume", "user-1", 1, website.ReleaseStatusSuperseded)
	seedRelease(t, "wr-current", "ws-resume", "user-1", 2, website.ReleaseStatusActive)

	l := NewLogic().(*logic)
	if err := l.OnPassRenewed("user-1"); err != nil {
		t.Fatalf("OnPassRenewed: %v", err)
	}

	site := loadSite(t, "ws-resume")
	// 立刻转 active：网关下一次请求就会回源到原来的 current/，不存在恢复空窗。
	if site.Status != website.SiteStatusActive {
		t.Fatalf("site status = %q, want %q", site.Status, website.SiteStatusActive)
	}
	if site.OperationGeneration != 6 {
		t.Fatalf("operation_generation = %d, want 6", site.OperationGeneration)
	}
	if site.CloudPath != "sites/ws-resume/current/" {
		t.Fatalf("cloud_path = %q, want it untouched", site.CloudPath)
	}
	assertNoOperations(t, "ws-resume")
}

// 从未发布过内容的站点没有制品，也不再需要任何特殊分支：同样只是一次状态迁移。
func TestOnPassRenewedActivatesNeverDeployedSite(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedSite(t, "ws-empty", "user-1", website.SiteStatusSuspended, 1)

	l := NewLogic().(*logic)
	if err := l.OnPassRenewed("user-1"); err != nil {
		t.Fatalf("OnPassRenewed: %v", err)
	}

	if got := siteStatus(t, "ws-empty"); got != website.SiteStatusActive {
		t.Fatalf("site status = %q, want %q", got, website.SiteStatusActive)
	}
	assertNoOperations(t, "ws-empty")
}

// 套餐销毁同样只改状态：不登记 delete 操作、不删 COS、不软删站点行。
//
// 站点行是桶里那些永久保留的对象唯一的归属依据，删了就只剩前缀可以猜。
func TestOnPassDestroyedOnlyFlipsStatusAndKeepsRow(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedSiteWithLocation(t, "ws-destroy", "user-1", website.SiteStatusActive, 3,
		"sites/ws-destroy/current/", "http://ws-destroy.sites.example/")

	l := NewLogic().(*logic)
	if err := l.OnPassDestroyed("user-1"); err != nil {
		t.Fatalf("OnPassDestroyed: %v", err)
	}

	site := loadSite(t, "ws-destroy")
	if site.Status != website.SiteStatusSuspended {
		t.Fatalf("site status = %q, want %q", site.Status, website.SiteStatusSuspended)
	}
	if site.DeletedTime != nil {
		t.Fatalf("deleted_time = %v, want NULL (row must survive)", site.DeletedTime)
	}
	if site.CloudPath == "" {
		t.Fatal("cloud_path must survive destroy, files are kept forever")
	}
	assertNoOperations(t, "ws-destroy")
}

// 已删除或正在删除的站点不参与套餐联动，避免把它们复活。
func TestPassLifecycleSkipsSitesInOtherStates(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedSite(t, "ws-deleting", "user-1", website.SiteStatusDeleting, 1)

	l := NewLogic().(*logic)
	if err := l.OnPassIsolated("user-1"); err != nil {
		t.Fatalf("OnPassIsolated: %v", err)
	}
	if err := l.OnPassDestroyed("user-1"); err != nil {
		t.Fatalf("OnPassDestroyed: %v", err)
	}
	if got := siteStatus(t, "ws-deleting"); got != website.SiteStatusDeleting {
		t.Fatalf("site status = %q, want it untouched (%q)", got, website.SiteStatusDeleting)
	}
}

// 真实删除能力必须留着：只有用户主动点删除才登记 delete 操作去清空 COS。
func TestUserInitiatedDeleteStillSchedulesCosCleanup(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedSite(t, "ws-real-delete", "user-1", website.SiteStatusActive, 1)

	l := NewLogic().(*logic)
	if _, err := l.DeleteSite("user-1", "ws-real-delete"); err != nil {
		t.Fatalf("DeleteSite: %v", err)
	}

	if got := siteStatus(t, "ws-real-delete"); got != website.SiteStatusDeleting {
		t.Fatalf("site status = %q, want %q", got, website.SiteStatusDeleting)
	}
	op := latestOperation(t, "ws-real-delete")
	if op.OperationType != website.OpTypeDelete {
		t.Fatalf("operation type = %q, want %q", op.OperationType, website.OpTypeDelete)
	}
	if op.Status != website.OpStatusCreated {
		t.Fatalf("operation status = %q, want %q", op.Status, website.OpStatusCreated)
	}
}

func seedSite(t *testing.T, siteID, userID, status string, generation int64) {
	t.Helper()
	seedSiteWithLocation(t, siteID, userID, status, generation, "", "")
}

func seedSiteWithLocation(t *testing.T, siteID, userID, status string, generation int64, cloudPath, publicURL string) {
	t.Helper()
	site := &website.SiteEntity{
		SiteID:              siteID,
		Status:              status,
		BundleID:            "bundle-1",
		CloudPath:           cloudPath,
		PublicURL:           publicURL,
		OperationGeneration: generation,
	}
	site.UserID = userID
	if err := resource.GormDB.Table(website.SitesTable).Create(site).Error; err != nil {
		t.Fatal(err)
	}
}

func seedRelease(t *testing.T, releaseID, siteID, userID string, version int, status string) {
	t.Helper()
	release := &website.ReleaseEntity{
		ReleaseID: releaseID,
		SiteID:    siteID,
		Version:   version,
		Status:    status,
	}
	release.UserID = userID
	if err := resource.GormDB.Table(website.ReleasesTable).Create(release).Error; err != nil {
		t.Fatal(err)
	}
}

func loadSite(t *testing.T, siteID string) website.SiteEntity {
	t.Helper()
	var site website.SiteEntity
	if err := resource.GormDB.Table(website.SitesTable).
		Where("site_id = ?", siteID).First(&site).Error; err != nil {
		t.Fatal(err)
	}
	return site
}

func siteStatus(t *testing.T, siteID string) string {
	t.Helper()
	return loadSite(t, siteID).Status
}

// assertNoOperations 守住「套餐联动不产生任何异步操作」这条线。
// 一旦有操作被登记，worker 就会去动 COS，用户数据就不再是永久保留的。
func assertNoOperations(t *testing.T, siteID string) {
	t.Helper()
	var count int64
	if err := resource.GormDB.Table(website.OperationsTable).
		Where("site_id = ?", siteID).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("expected no operation for %s, got %d", siteID, count)
	}
}

func latestOperation(t *testing.T, siteID string) website.OperationEntity {
	t.Helper()
	var op website.OperationEntity
	if err := resource.GormDB.Table(website.OperationsTable).
		Where("site_id = ?", siteID).Order("id DESC").First(&op).Error; err != nil {
		t.Fatal(err)
	}
	return op
}
