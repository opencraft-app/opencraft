package website

import (
	"testing"
	"time"

	"ctl/pkg/model/website"
	"ctl/pkg/resource"
)

// usageRow 只取断言用到的列。
//
// 刻意不扫整个 UsageDailyEntity：usage_date 在生产库是 DATE 列（驱动开了 ParseTime，
// 回来是 time.Time），在单测的 SQLite 里是我们写进去的日期字符串，
// 同一个 Go 字段类型不可能两边都对。而生产代码本身从不回读这一列（只做 SUM），
// 所以这个差异只需要在测试里绕开，不需要为它扭曲实体定义。
type usageRow struct {
	UserID       string `gorm:"column:user_id"`
	TrafficBytes int64  `gorm:"column:traffic_bytes"`
	RequestCount int64  `gorm:"column:request_count"`
}

func loadUsageRow(t *testing.T, siteID, day string) usageRow {
	t.Helper()
	var row usageRow
	if err := resource.GormDB.Table(website.UsageDailyTable).
		Select("user_id", "traffic_bytes", "request_count").
		Where("site_id = ? AND usage_date = ?", siteID, day).
		Take(&row).Error; err != nil {
		t.Fatal(err)
	}
	return row
}

func countUsageRows(t *testing.T, siteID string) int64 {
	t.Helper()
	var count int64
	if err := resource.GormDB.Table(website.UsageDailyTable).
		Where("site_id = ?", siteID).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	return count
}

func seedUsage(t *testing.T, siteID, userID, day string, trafficBytes int64) {
	t.Helper()
	if err := website.NewUsageDao().AddDailyTraffic(siteID, userID, day, trafficBytes, 1); err != nil {
		t.Fatal(err)
	}
}

// 「天」和「月」都按 UTC+8 划分，与 bundle 的每日配额刷新任务同一个口径。
func TestUsageDayAndMonthUseUTC8(t *testing.T) {
	// UTC 时间 2026-07-31 16:30 = UTC+8 的 2026-08-01 00:30，
	// 也就是新一个月的第一天，而不是七月的最后一天。
	boundary := time.Date(2026, 7, 31, 16, 30, 0, 0, time.UTC)
	if got := usageDayString(boundary); got != "2026-08-01" {
		t.Fatalf("usageDayString = %q，期望 2026-08-01（UTC+8 已跨月）", got)
	}
	from, to := usageMonthRange(boundary)
	if from != "2026-08-01" || to != "2026-08-31" {
		t.Fatalf("月区间 = %s..%s，期望 2026-08-01..2026-08-31", from, to)
	}

	// UTC 2026-08-01 00:30 在 UTC+8 仍是 8 月 1 日（08:30），不能提前跨月。
	sameDay := time.Date(2026, 8, 1, 0, 30, 0, 0, time.UTC)
	if got := usageDayString(sameDay); got != "2026-08-01" {
		t.Fatalf("usageDayString = %q，期望 2026-08-01", got)
	}

	// 二月要按闰年给出正确的月末。
	from, to = usageMonthRange(time.Date(2028, 2, 10, 0, 0, 0, 0, usageLocation))
	if from != "2028-02-01" || to != "2028-02-29" {
		t.Fatalf("闰年二月区间 = %s..%s，期望 2028-02-01..2028-02-29", from, to)
	}
	from, to = usageMonthRange(time.Date(2026, 2, 10, 0, 0, 0, 0, usageLocation))
	if from != "2026-02-01" || to != "2026-02-28" {
		t.Fatalf("平年二月区间 = %s..%s，期望 2026-02-01..2026-02-28", from, to)
	}
	// 十二月的月末推算要跨年。
	from, to = usageMonthRange(time.Date(2026, 12, 20, 0, 0, 0, 0, usageLocation))
	if from != "2026-12-01" || to != "2026-12-31" {
		t.Fatalf("十二月区间 = %s..%s，期望 2026-12-01..2026-12-31", from, to)
	}
}

// 多副本各自上报同一个站点同一天，必须累加到同一行而不是插出多行。
func TestMultipleReplicaReportsAccumulateIntoOneRow(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedSite(t, "ws-a", "user-1", website.SiteStatusActive, 1)

	l := NewLogic().(*logic)
	// 副本 1 的窗口
	if _, err := l.RecordTrafficUsage([]TrafficUsageReport{
		{SiteID: "ws-a", TrafficBytes: 1000, RequestCount: 3},
	}); err != nil {
		t.Fatalf("RecordTrafficUsage: %v", err)
	}
	// 副本 2 的同一个窗口
	if _, err := l.RecordTrafficUsage([]TrafficUsageReport{
		{SiteID: "ws-a", TrafficBytes: 500, RequestCount: 2},
	}); err != nil {
		t.Fatalf("RecordTrafficUsage: %v", err)
	}

	if got := countUsageRows(t, "ws-a"); got != 1 {
		t.Fatalf("同一天的记录行数 = %d，期望 1（靠唯一键累加）", got)
	}
	row := loadUsageRow(t, "ws-a", usageDayString(time.Now()))
	if row.TrafficBytes != 1500 {
		t.Fatalf("累加流量 = %d，期望 1500", row.TrafficBytes)
	}
	if row.RequestCount != 5 {
		t.Fatalf("累加请求数 = %d，期望 5", row.RequestCount)
	}
	if row.UserID != "user-1" {
		t.Fatalf("user_id = %q，期望从站点带出 user-1", row.UserID)
	}
}

// 一个请求带上多个站点：这是批量上报的核心形状。
func TestRecordTrafficUsageHandlesBatch(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedSite(t, "ws-a", "user-1", website.SiteStatusActive, 1)
	seedSite(t, "ws-b", "user-2", website.SiteStatusActive, 1)

	l := NewLogic().(*logic)
	accepted, err := l.RecordTrafficUsage([]TrafficUsageReport{
		{SiteID: "ws-a", TrafficBytes: 10, RequestCount: 1},
		{SiteID: "ws-b", TrafficBytes: 20, RequestCount: 2},
	})
	if err != nil {
		t.Fatalf("RecordTrafficUsage: %v", err)
	}
	if accepted != 2 {
		t.Fatalf("入账条数 = %d，期望 2", accepted)
	}
	day := usageDayString(time.Now())
	if got := loadUsageRow(t, "ws-a", day).TrafficBytes; got != 10 {
		t.Fatalf("ws-a = %d", got)
	}
	if got := loadUsageRow(t, "ws-b", day).UserID; got != "user-2" {
		t.Fatalf("ws-b 的 user_id = %q", got)
	}
}

// 站点不存在的上报必须跳过：凭空插一行会让表里出现 user_id 为空的无主记录，
// 污染按用户的月度汇总。
func TestRecordTrafficUsageSkipsUnknownSite(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedSite(t, "ws-a", "user-1", website.SiteStatusActive, 1)

	l := NewLogic().(*logic)
	accepted, err := l.RecordTrafficUsage([]TrafficUsageReport{
		{SiteID: "ws-a", TrafficBytes: 10, RequestCount: 1},
		{SiteID: "ws-ghost", TrafficBytes: 999, RequestCount: 9},
	})
	if err != nil {
		t.Fatalf("未知站点不应让整批失败: %v", err)
	}
	if accepted != 1 {
		t.Fatalf("入账条数 = %d，期望 1", accepted)
	}
	if got := countUsageRows(t, "ws-ghost"); got != 0 {
		t.Fatalf("未知站点写入了 %d 行，期望 0", got)
	}
}

// 已删除的站点仍然入账：否则用户可以靠反复建站/删站把当月已用流量清零。
func TestRecordTrafficUsageStillCountsDeletedSite(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedSite(t, "ws-gone", "user-1", website.SiteStatusDeleted, 1)
	now := time.Now()
	if err := resource.GormDB.Table(website.SitesTable).
		Where("site_id = ?", "ws-gone").Update("deleted_time", now).Error; err != nil {
		t.Fatal(err)
	}

	l := NewLogic().(*logic)
	if _, err := l.RecordTrafficUsage([]TrafficUsageReport{
		{SiteID: "ws-gone", TrafficBytes: 42, RequestCount: 1},
	}); err != nil {
		t.Fatalf("RecordTrafficUsage: %v", err)
	}
	if got := loadUsageRow(t, "ws-gone", usageDayString(now)).TrafficBytes; got != 42 {
		t.Fatalf("已删站点的流量 = %d，期望 42（历史记录保留）", got)
	}
}

// 全零的上报不该产生记录：网关不会发这种数据，但接口不能因此建出一堆空行。
func TestRecordTrafficUsageIgnoresEmptyReports(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedSite(t, "ws-a", "user-1", website.SiteStatusActive, 1)

	l := NewLogic().(*logic)
	accepted, err := l.RecordTrafficUsage([]TrafficUsageReport{
		{SiteID: "ws-a", TrafficBytes: 0, RequestCount: 0},
		{SiteID: "", TrafficBytes: 100, RequestCount: 1},
	})
	if err != nil {
		t.Fatalf("RecordTrafficUsage: %v", err)
	}
	if accepted != 0 {
		t.Fatalf("入账条数 = %d，期望 0", accepted)
	}
	if got := countUsageRows(t, "ws-a"); got != 0 {
		t.Fatalf("写入了 %d 行，期望 0", got)
	}
	if _, err := l.RecordTrafficUsage(nil); err != nil {
		t.Fatalf("空批次不应报错: %v", err)
	}
}

// 当月合计按用户跨站点汇总，且只算当月——上个月的量不能算进来。
func TestUsedTrafficBytesThisMonthIsScopedToUserAndMonth(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedSite(t, "ws-a", "user-1", website.SiteStatusActive, 1)
	seedSite(t, "ws-b", "user-1", website.SiteStatusActive, 1)
	seedSite(t, "ws-other", "user-2", website.SiteStatusActive, 1)

	now := time.Now()
	from, _ := usageMonthRange(now)
	monthStart, err := time.ParseInLocation(website.UsageDateLayout, from, usageLocation)
	if err != nil {
		t.Fatal(err)
	}
	lastMonthDay := monthStart.AddDate(0, 0, -1).Format(website.UsageDateLayout)
	today := usageDayString(now)

	seedUsage(t, "ws-a", "user-1", today, 100)
	seedUsage(t, "ws-b", "user-1", today, 200)
	// 上个月最后一天的流量不能算进本月。
	seedUsage(t, "ws-a", "user-1", lastMonthDay, 999999)
	// 其他用户的流量不能算进来。
	seedUsage(t, "ws-other", "user-2", today, 555)

	l := NewLogic().(*logic)
	if got := l.usedTrafficBytesThisMonth("user-1"); got != 300 {
		t.Fatalf("当月合计 = %d，期望 300（跨本用户全部站点，仅本月）", got)
	}
	if got := l.usedTrafficBytesThisMonth("user-2"); got != 555 {
		t.Fatalf("user-2 当月合计 = %d，期望 555", got)
	}
	if got := l.usedTrafficBytesThisMonth("user-nobody"); got != 0 {
		t.Fatalf("无记录用户 = %d，期望 0", got)
	}
}

// 月初第一天和月末最后一天都必须落在区间内（闭区间，别把边界日漏掉）。
func TestMonthRangeIncludesBothBoundaryDays(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedSite(t, "ws-a", "user-1", website.SiteStatusActive, 1)

	from, to := usageMonthRange(time.Now())
	seedUsage(t, "ws-a", "user-1", from, 7)
	seedUsage(t, "ws-a", "user-1", to, 11)

	l := NewLogic().(*logic)
	want := int64(18)
	if from == to {
		// 只有当月恰好只有一天时才会相等，实际不可能，但别让断言依赖它。
		want = 11
	}
	if got := l.usedTrafficBytesThisMonth("user-1"); got != want {
		t.Fatalf("含边界日的当月合计 = %d，期望 %d", got, want)
	}
}

// ---- 存储用量 ----

func TestUpdateSiteStorageAndUserSum(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedPassAndBundle(t, "user-1", "bundle-1", testQuotaJSON)
	seedPassAndBundle(t, "user-2", "bundle-2", testQuotaJSON)
	seedSite(t, "ws-a", "user-1", website.SiteStatusActive, 1)
	seedSite(t, "ws-b", "user-1", website.SiteStatusActive, 1)
	seedSite(t, "ws-other", "user-2", website.SiteStatusActive, 1)

	l := NewLogic().(*logic)
	if err := l.UpdateSiteStorage("ws-a", 1024); err != nil {
		t.Fatalf("UpdateSiteStorage: %v", err)
	}
	if err := l.UpdateSiteStorage("ws-b", 2048); err != nil {
		t.Fatalf("UpdateSiteStorage: %v", err)
	}
	if err := l.UpdateSiteStorage("ws-other", 4096); err != nil {
		t.Fatalf("UpdateSiteStorage: %v", err)
	}

	if got := loadSite(t, "ws-a").StorageBytes; got != 1024 {
		t.Fatalf("ws-a storage_bytes = %d，期望 1024", got)
	}
	total, err := website.NewSiteDao().SumStorageBytesByUserID("user-1")
	if err != nil {
		t.Fatal(err)
	}
	if total != 3072 {
		t.Fatalf("user-1 存储合计 = %d，期望 3072", total)
	}

	// 覆盖式写入：重复上报同一个绝对值不会翻倍（与流量的增量语义相反）。
	if err := l.UpdateSiteStorage("ws-a", 1024); err != nil {
		t.Fatalf("UpdateSiteStorage: %v", err)
	}
	total, err = website.NewSiteDao().SumStorageBytesByUserID("user-1")
	if err != nil {
		t.Fatal(err)
	}
	if total != 3072 {
		t.Fatalf("重复上报后合计 = %d，期望仍是 3072（幂等）", total)
	}
}

// 存储口径与流量相反：已删除的站点其 COS 对象真的被清掉了，不该继续占额度。
func TestStorageSumExcludesDeletedSites(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedPassAndBundle(t, "user-1", "bundle-1", testQuotaJSON)
	seedSite(t, "ws-live", "user-1", website.SiteStatusActive, 1)
	seedSite(t, "ws-dead", "user-1", website.SiteStatusDeleted, 1)

	l := NewLogic().(*logic)
	if err := l.UpdateSiteStorage("ws-live", 100); err != nil {
		t.Fatal(err)
	}
	if err := l.UpdateSiteStorage("ws-dead", 900); err != nil {
		t.Fatal(err)
	}
	if err := resource.GormDB.Table(website.SitesTable).
		Where("site_id = ?", "ws-dead").Update("deleted_time", time.Now()).Error; err != nil {
		t.Fatal(err)
	}

	total, err := website.NewSiteDao().SumStorageBytesByUserID("user-1")
	if err != nil {
		t.Fatal(err)
	}
	if total != 100 {
		t.Fatalf("存储合计 = %d，期望 100（已删站点不计）", total)
	}
}

// 删除完成后迟到的上报不能把已软删站点的用量改回非零值。
func TestUpdateStorageIgnoresSoftDeletedSite(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedSite(t, "ws-dead", "user-1", website.SiteStatusDeleted, 1)
	if err := resource.GormDB.Table(website.SitesTable).
		Where("site_id = ?", "ws-dead").Update("deleted_time", time.Now()).Error; err != nil {
		t.Fatal(err)
	}

	if err := website.NewSiteDao().UpdateStorageBytes("ws-dead", 12345); err != nil {
		t.Fatal(err)
	}
	if got := loadSite(t, "ws-dead").StorageBytes; got != 0 {
		t.Fatalf("已软删站点的 storage_bytes = %d，期望保持 0", got)
	}
}

func TestUpdateSiteStorageRejectsBadInput(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedSite(t, "ws-a", "user-1", website.SiteStatusActive, 1)

	l := NewLogic().(*logic)
	if err := l.UpdateSiteStorage("", 100); err == nil {
		t.Fatal("空 site_id 应当报错")
	}
	if err := l.UpdateSiteStorage("ws-a", -1); err == nil {
		t.Fatal("负数应当报错")
	}
	if err := l.UpdateSiteStorage("ws-ghost", 100); err == nil {
		t.Fatal("不存在的站点应当报错")
	}
}
