package website

import (
	"testing"

	"ctl/pkg/model/website"
)

// 到期隔离必须把 creating 的站点一并停服。
//
// 这是一个真实的正确性缺口：只列 active 的话，到期瞬间还停在 creating 的站点会被
// 跳过，随后那次 create 操作成功回调把它置为 active——套餐已过期，站点却对外服务。
func TestOnPassIsolatedAlsoSuspendsCreatingSite(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedSite(t, "ws-creating", "user-1", website.SiteStatusCreating, 1)
	seedSite(t, "ws-active", "user-1", website.SiteStatusActive, 1)

	l := NewLogic().(*logic)
	if err := l.OnPassIsolated("user-1"); err != nil {
		t.Fatalf("OnPassIsolated: %v", err)
	}

	for _, siteID := range []string{"ws-creating", "ws-active"} {
		if got := siteStatus(t, siteID); got != website.SiteStatusSuspended {
			t.Fatalf("%s 状态 = %q，期望 %q", siteID, got, website.SiteStatusSuspended)
		}
	}
	// generation 必须推进，这是让在途 create 变 superseded 的唯一手段。
	if got := loadSite(t, "ws-creating").OperationGeneration; got != 2 {
		t.Fatalf("ws-creating 的 operation_generation = %d，期望 2", got)
	}
	// 隔离仍然不产生任何异步操作：文件永久保留。
	assertNoOperations(t, "ws-creating")
}

// 套餐销毁同样要覆盖 creating，理由与到期隔离一致。
func TestOnPassDestroyedAlsoSuspendsCreatingSite(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedSite(t, "ws-creating", "user-1", website.SiteStatusCreating, 3)

	l := NewLogic().(*logic)
	if err := l.OnPassDestroyed("user-1"); err != nil {
		t.Fatalf("OnPassDestroyed: %v", err)
	}

	site := loadSite(t, "ws-creating")
	if site.Status != website.SiteStatusSuspended {
		t.Fatalf("状态 = %q，期望 %q", site.Status, website.SiteStatusSuspended)
	}
	if site.OperationGeneration != 4 {
		t.Fatalf("operation_generation = %d，期望 4", site.OperationGeneration)
	}
	if site.DeletedTime != nil {
		t.Fatalf("deleted_time = %v，期望 NULL（站点行必须保留）", site.DeletedTime)
	}
}

// 隔离推进了 generation 之后，在途 create 的成功回调必须被判为 superseded，
// 不能把站点重新拉回 active。这是修复这个缺口的实际机制，光改查询范围不够。
func TestInFlightCreateCannotReviveIsolatedSite(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedSite(t, "ws-creating", "user-1", website.SiteStatusCreating, 1)

	l := NewLogic().(*logic)
	// create 操作是在隔离之前登记并领取的，带着旧的 generation。
	op := &website.OperationEntity{
		OperationID:    "wo-create",
		SiteID:         "ws-creating",
		OperationType:  website.OpTypeCreate,
		Status:         website.OpStatusRunning,
		LeaseToken:     "lease-old",
		SiteGeneration: 1,
	}
	op.UserID = "user-1"
	if err := l.operationDao.CreateOperation(op); err != nil {
		t.Fatal(err)
	}

	if err := l.OnPassIsolated("user-1"); err != nil {
		t.Fatalf("OnPassIsolated: %v", err)
	}

	// worker 现在才回调成功。
	if err := l.CompleteOperation(op.OperationID, op.LeaseToken,
		"sites/ws-creating/current/", "http://ws-creating.sites.example/"); err != nil {
		t.Fatalf("CompleteOperation: %v", err)
	}

	if got := siteStatus(t, "ws-creating"); got != website.SiteStatusSuspended {
		t.Fatalf("站点状态 = %q，期望仍是 %q（在途 create 必须被 generation 围栏挡住）",
			got, website.SiteStatusSuspended)
	}
}

// creating 之外的中间态仍然不参与套餐联动：deleting / deleted 不能被复活成 suspended。
func TestPassIsolationStillSkipsDeletingAndDeleted(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedSite(t, "ws-deleting", "user-1", website.SiteStatusDeleting, 1)
	seedSite(t, "ws-deleted", "user-1", website.SiteStatusDeleted, 1)

	l := NewLogic().(*logic)
	if err := l.OnPassIsolated("user-1"); err != nil {
		t.Fatalf("OnPassIsolated: %v", err)
	}
	if got := siteStatus(t, "ws-deleting"); got != website.SiteStatusDeleting {
		t.Fatalf("ws-deleting 状态 = %q，期望保持不变", got)
	}
	if got := siteStatus(t, "ws-deleted"); got != website.SiteStatusDeleted {
		t.Fatalf("ws-deleted 状态 = %q，期望保持不变", got)
	}
}

// 续费恢复的前置状态仍然只有 suspended：不能把一个正在 creating 的站点
// 当成「待恢复」直接置为 active。
func TestOnPassRenewedDoesNotTouchCreatingSite(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedSite(t, "ws-creating", "user-1", website.SiteStatusCreating, 1)

	l := NewLogic().(*logic)
	if err := l.OnPassRenewed("user-1"); err != nil {
		t.Fatalf("OnPassRenewed: %v", err)
	}
	if got := siteStatus(t, "ws-creating"); got != website.SiteStatusCreating {
		t.Fatalf("状态 = %q，期望保持 %q", got, website.SiteStatusCreating)
	}
}

// ListServingByUserID 的范围就是「套餐失效必须停服」的那批站点。
func TestListServingByUserIDCoversCreatingAndActiveOnly(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedSite(t, "ws-creating", "user-1", website.SiteStatusCreating, 1)
	seedSite(t, "ws-active", "user-1", website.SiteStatusActive, 1)
	seedSite(t, "ws-suspended", "user-1", website.SiteStatusSuspended, 1)
	seedSite(t, "ws-deleting", "user-1", website.SiteStatusDeleting, 1)
	seedSite(t, "ws-other-user", "user-2", website.SiteStatusActive, 1)

	sites, err := website.NewSiteDao().ListServingByUserID("user-1")
	if err != nil {
		t.Fatal(err)
	}
	got := make(map[string]bool, len(sites))
	for _, site := range sites {
		got[site.SiteID] = true
	}
	if len(got) != 2 || !got["ws-creating"] || !got["ws-active"] {
		t.Fatalf("命中站点 = %v，期望仅 ws-creating 与 ws-active", got)
	}
}
