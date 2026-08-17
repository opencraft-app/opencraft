package website

import (
	"errors"
	"testing"

	"ctl/pkg/errcode"
	quota "ctl/pkg/model/userresourcequota"
	"ctl/pkg/model/website"
	"ctl/pkg/resource"
)

// 用户换过套餐后，配额行的 resource_key 可能与当前 bundle_id 不一致
// （ensureQuotaInitialized 的改写失败时只告警不中断流程）。
// 扣减必须与归还一样只按 (user_id, resource_name) 定位，否则会 0 行命中，
// 用户拿到的是「套餐建站数量已满」，把排查方向带偏。
func TestAllocSiteQuotaWorksWhenResourceKeyMismatches(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedQuota(t, "user-1", "bundle_mismatch_probe", 1, 1)

	l := NewLogic().(*logic)
	if err := l.allocSiteQuotaTx(resource.GormDB, "user-1"); err != nil {
		t.Fatalf("allocSiteQuotaTx: %v", err)
	}

	if got := quotaAvailable(t, "user-1"); got != 0 {
		t.Fatalf("available = %d, want 0 (seat must be taken regardless of resource_key)", got)
	}
}

// 配额真的用尽时仍要返回 ErrWebsiteQuotaExceeded：这是给终端用户看的业务错误。
func TestAllocSiteQuotaReturnsQuotaExceededWhenExhausted(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedQuota(t, "user-1", "bundle-1", 0, 1)

	l := NewLogic().(*logic)
	err := l.allocSiteQuotaTx(resource.GormDB, "user-1")
	if !errors.Is(err, errcode.ErrWebsiteQuotaExceeded) {
		t.Fatalf("err = %v, want ErrWebsiteQuotaExceeded", err)
	}
	if got := quotaAvailable(t, "user-1"); got != 0 {
		t.Fatalf("available = %d, want it left at 0", got)
	}
}

// 配额行完全缺失是服务端数据不一致，不是用户配额用尽。
// 必须与 ErrWebsiteQuotaExceeded 区分开，否则排查时会误以为是用户套餐额度问题。
func TestAllocSiteQuotaDistinguishesMissingRowFromExhausted(t *testing.T) {
	newWebsiteOperationTestDB(t)

	l := NewLogic().(*logic)
	err := l.allocSiteQuotaTx(resource.GormDB, "user-without-quota")
	if err == nil {
		t.Fatal("allocSiteQuotaTx must fail when the quota row is missing")
	}
	if errors.Is(err, errcode.ErrWebsiteQuotaExceeded) {
		t.Fatalf("missing quota row must not surface as ErrWebsiteQuotaExceeded, got %v", err)
	}
	if !errors.Is(err, errcode.ErrInternalServer) {
		t.Fatalf("err = %v, want ErrInternalServer", err)
	}
}

// 防回归：即使历史数据残留多行建站配额，扣减也必须严格只影响一行，
// 否则一次建站会吃掉多个席位。
func TestAllocSiteQuotaTouchesExactlyOneRow(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedQuota(t, "user-1", "bundle-old", 1, 1)
	seedQuota(t, "user-1", "bundle-new", 1, 1)

	l := NewLogic().(*logic)
	if err := l.allocSiteQuotaTx(resource.GormDB, "user-1"); err != nil {
		t.Fatalf("allocSiteQuotaTx: %v", err)
	}

	var total int64
	if err := resource.GormDB.Table(quota.TableName).
		Where("user_id = ? AND resource_name = ?", "user-1", website.ResourceNameWebsiteSite).
		Select("COALESCE(SUM(resource_quota_available),0)").Scan(&total).Error; err != nil {
		t.Fatal(err)
	}
	if total != 1 {
		t.Fatalf("remaining seats = %d, want exactly 1 consumed (2 -> 1)", total)
	}
}

// 扣减只影响当前用户，不能误伤同一 resource_name 下其他用户的配额行。
func TestAllocSiteQuotaDoesNotTouchOtherUsers(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedQuota(t, "user-1", "bundle-1", 1, 1)
	seedQuota(t, "user-2", "bundle-1", 1, 1)

	l := NewLogic().(*logic)
	if err := l.allocSiteQuotaTx(resource.GormDB, "user-1"); err != nil {
		t.Fatalf("allocSiteQuotaTx: %v", err)
	}
	if got := quotaAvailable(t, "user-2"); got != 1 {
		t.Fatalf("user-2 available = %d, want 1", got)
	}
}
