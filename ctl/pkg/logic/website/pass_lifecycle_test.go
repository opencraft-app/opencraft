package website

import (
	"testing"

	"ctl/pkg/model/website"
	"ctl/pkg/resource"
)

// 套餐到期必须真正下线站点：v2 移除了平台反向代理，用户拿到的是 CloudBase 原生地址，
// 平台不在访问路径上，只改 DB 状态站点依然全网可访问。
// 因此 OnPassIsolated 必须登记 suspend 操作交给 worker 删除线上文件。
func TestOnPassIsolatedSchedulesSuspendWork(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedSite(t, "ws-suspend", "user-1", website.SiteStatusActive, 1)

	l := NewLogic().(*logic)
	if err := l.OnPassIsolated("user-1"); err != nil {
		t.Fatalf("OnPassIsolated: %v", err)
	}

	// 站点状态立即收敛，用户和前端马上看到准确状态。
	if got := siteStatus(t, "ws-suspend"); got != website.SiteStatusSuspended {
		t.Fatalf("site status = %q, want %q", got, website.SiteStatusSuspended)
	}

	op := latestOperation(t, "ws-suspend")
	if op.OperationType != website.OpTypeSuspend {
		t.Fatalf("operation type = %q, want %q", op.OperationType, website.OpTypeSuspend)
	}
	if op.Status != website.OpStatusCreated {
		t.Fatalf("operation status = %q, want %q", op.Status, website.OpStatusCreated)
	}
	// generation 必须推进，否则在途的旧 deploy 回调仍会被当作有效，
	// 把刚下线的站点内容又写回去。
	if op.SiteGeneration != 2 {
		t.Fatalf("site_generation = %d, want 2", op.SiteGeneration)
	}
}

// 续费恢复必须带上要恢复的版本，并且在文件真正上线前不能把站点显示为可用。
func TestOnPassRenewedSchedulesResumeWithActiveRelease(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedSite(t, "ws-resume", "user-1", website.SiteStatusSuspended, 5)
	seedRelease(t, "wr-old", "ws-resume", "user-1", 1, website.ReleaseStatusSuperseded)
	seedRelease(t, "wr-current", "ws-resume", "user-1", 2, website.ReleaseStatusActive)

	l := NewLogic().(*logic)
	if err := l.OnPassRenewed("user-1"); err != nil {
		t.Fatalf("OnPassRenewed: %v", err)
	}

	// 恢复期间保持 suspended，避免出现「状态可用但内容还没上线」的空窗。
	if got := siteStatus(t, "ws-resume"); got != website.SiteStatusSuspended {
		t.Fatalf("site status = %q, want it to stay %q until files are back",
			got, website.SiteStatusSuspended)
	}

	op := latestOperation(t, "ws-resume")
	if op.OperationType != website.OpTypeResume {
		t.Fatalf("operation type = %q, want %q", op.OperationType, website.OpTypeResume)
	}
	// 必须恢复最新的版本，不能是任何历史版本。
	if op.ReleaseID != "wr-current" {
		t.Fatalf("resume release = %q, want wr-current", op.ReleaseID)
	}
	if op.SiteGeneration != 6 {
		t.Fatalf("site_generation = %d, want 6", op.SiteGeneration)
	}
}

// 从未成功发布过内容的站点没有制品可恢复，直接恢复可用状态即可，
// 不应登记一个注定失败的 resume 操作。
func TestOnPassRenewedActivatesNeverDeployedSiteDirectly(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedSite(t, "ws-empty", "user-1", website.SiteStatusSuspended, 1)

	l := NewLogic().(*logic)
	if err := l.OnPassRenewed("user-1"); err != nil {
		t.Fatalf("OnPassRenewed: %v", err)
	}

	if got := siteStatus(t, "ws-empty"); got != website.SiteStatusActive {
		t.Fatalf("site status = %q, want %q", got, website.SiteStatusActive)
	}
	var count int64
	if err := resource.GormDB.Table(website.OperationsTable).
		Where("site_id = ?", "ws-empty").Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("expected no operation for a never-deployed site, got %d", count)
	}
}

// 已删除或正在删除的站点不参与套餐联动，避免把它们复活。
func TestPassLifecycleSkipsSitesInOtherStates(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedSite(t, "ws-deleting", "user-1", website.SiteStatusDeleting, 1)

	l := NewLogic().(*logic)
	if err := l.OnPassIsolated("user-1"); err != nil {
		t.Fatalf("OnPassIsolated: %v", err)
	}
	if got := siteStatus(t, "ws-deleting"); got != website.SiteStatusDeleting {
		t.Fatalf("site status = %q, want it untouched (%q)", got, website.SiteStatusDeleting)
	}
}

func seedSite(t *testing.T, siteID, userID, status string, generation int64) {
	t.Helper()
	site := &website.SiteEntity{
		SiteID:              siteID,
		Status:              status,
		BundleID:            "bundle-1",
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

func siteStatus(t *testing.T, siteID string) string {
	t.Helper()
	var site website.SiteEntity
	if err := resource.GormDB.Table(website.SitesTable).
		Where("site_id = ?", siteID).First(&site).Error; err != nil {
		t.Fatal(err)
	}
	return site.Status
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
