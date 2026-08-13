package website

import (
	"testing"

	quota "ctl/pkg/model/userresourcequota"
	"ctl/pkg/model/website"
	"ctl/pkg/resource"
)

// 用户换过套餐后，配额行的 resource_key 会与站点上记录的 bundle_id 不一致。
// 若按站点的 bundle_id 去匹配配额行，删站时会匹配 0 行，席位被永久吃掉。
func TestReleaseSiteQuotaWorksAfterBundleChange(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedQuota(t, "user-1", "bundle-new-after-change", 0, 1)

	l := NewLogic().(*logic)
	if err := l.releaseSiteQuotaTx(resource.GormDB, "user-1"); err != nil {
		t.Fatalf("releaseSiteQuotaTx: %v", err)
	}

	if got := quotaAvailable(t, "user-1"); got != 1 {
		t.Fatalf("available = %d, want 1 (quota must be returned regardless of bundle change)", got)
	}
}

// 历史数据里同一用户可能存在多行建站配额（旧版每换一次套餐插一行）。
// 归还必须严格只影响一行，否则一次删站归还多个席位，造成超卖。
func TestReleaseSiteQuotaTouchesExactlyOneRow(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedQuota(t, "user-1", "bundle-old", 0, 1)
	seedQuota(t, "user-1", "bundle-new", 0, 1)

	l := NewLogic().(*logic)
	if err := l.releaseSiteQuotaTx(resource.GormDB, "user-1"); err != nil {
		t.Fatalf("releaseSiteQuotaTx: %v", err)
	}

	var total int64
	if err := resource.GormDB.Table(quota.TableName).
		Where("user_id = ? AND resource_name = ?", "user-1", website.ResourceNameWebsiteSite).
		Select("COALESCE(SUM(resource_quota_available),0)").Scan(&total).Error; err != nil {
		t.Fatal(err)
	}
	if total != 1 {
		t.Fatalf("total returned seats = %d, want exactly 1", total)
	}
}

// 配额行不存在时（Pass 已销毁）不能报错，否则 delete 操作会永久失败重试，
// 站点反而删不掉、公开文件一直留在对象存储中。
func TestReleaseSiteQuotaToleratesMissingRow(t *testing.T) {
	newWebsiteOperationTestDB(t)

	l := NewLogic().(*logic)
	if err := l.releaseSiteQuotaTx(resource.GormDB, "user-without-quota"); err != nil {
		t.Fatalf("releaseSiteQuotaTx must tolerate a missing quota row, got %v", err)
	}
}

// 已经满额时重复归还不应把可用额度顶到总量之上。
func TestReleaseSiteQuotaDoesNotExceedTotal(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedQuota(t, "user-1", "bundle-1", 1, 1)

	l := NewLogic().(*logic)
	if err := l.releaseSiteQuotaTx(resource.GormDB, "user-1"); err != nil {
		t.Fatalf("releaseSiteQuotaTx: %v", err)
	}
	if got := quotaAvailable(t, "user-1"); got != 1 {
		t.Fatalf("available = %d, want it capped at total (1)", got)
	}
}

func seedQuota(t *testing.T, userID, resourceKey string, available, total int64) {
	t.Helper()
	err := resource.GormDB.Table(quota.TableName).Create(map[string]interface{}{
		"user_id":                  userID,
		"resource_name":            website.ResourceNameWebsiteSite,
		"resource_key":             resourceKey,
		"resource_quota_available": available,
		"resource_quota_total":     total,
	}).Error
	if err != nil {
		t.Fatal(err)
	}
}

func quotaAvailable(t *testing.T, userID string) int64 {
	t.Helper()
	var available int64
	if err := resource.GormDB.Table(quota.TableName).
		Where("user_id = ? AND resource_name = ?", userID, website.ResourceNameWebsiteSite).
		Order("id ASC").Limit(1).
		Select("resource_quota_available").Scan(&available).Error; err != nil {
		t.Fatal(err)
	}
	return available
}
