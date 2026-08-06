package website

import (
	"fmt"
	"time"

	"ctl/pkg/errcode"
	"ctl/pkg/model/website"

	"go.uber.org/zap"
)

// usageLocation 是用量统计「天」和「月」的时区口径：UTC+8。
//
// 与 ctl/pkg/logic/bundle/cron.go 的每日配额刷新任务保持一致。这件事必须显式定死：
// 用 UTC 划分的话，国内用户看到的「本月流量」会在每个月初和月末各错开 8 小时，
// 月末最后一晚的访问会被算进下个月，用户投诉时也无从解释。
var usageLocation = time.FixedZone("CST", 8*3600)

// TrafficUsageReport 是站点网关一个上报窗口内某个站点的流量增量。
//
// 字段是增量而不是累计值：网关在内存里聚合，每次上报后清零，没有跨窗口的累计状态。
type TrafficUsageReport struct {
	SiteID       string `json:"site_id"`
	TrafficBytes int64  `json:"traffic_bytes"`
	RequestCount int64  `json:"request_count"`
}

// usageDayString 返回 UTC+8 下的日期，作为 usage_date 的值。
func usageDayString(now time.Time) string {
	return now.In(usageLocation).Format(website.UsageDateLayout)
}

// usageMonthRange 返回 UTC+8 下当月的首尾日期，闭区间。
//
// 用「本月 1 日 → 下月 1 日的前一天」而不是固定 28/30/31：AddDate(0,1,0) 再退一天
// 能自然处理闰年和不同月长，也不需要维护一张月份天数表。
func usageMonthRange(now time.Time) (fromDate string, toDate string) {
	local := now.In(usageLocation)
	first := time.Date(local.Year(), local.Month(), 1, 0, 0, 0, 0, usageLocation)
	last := first.AddDate(0, 1, 0).AddDate(0, 0, -1)
	return first.Format(website.UsageDateLayout), last.Format(website.UsageDateLayout)
}

// RecordTrafficUsage 累加站点网关上报的一批流量增量。
//
// 幂等性：**这个接口不是幂等的**。累加语义决定了同一份上报重放两次就会多算一次。
// 之所以接受这个取舍：
//
//   - 上报是多副本各自进行的，服务端无法靠「站点 + 窗口」去重——除非再引入一张
//     记录「哪个副本的哪个窗口已入账」的表，那等于给一个近似值配一套精确记账。
//   - 网关侧只在**确定失败**（连接错误、非 2xx）时把增量并回内存等下一个窗口，
//     所以正常路径不会重复；真正会重复的只有「服务端已处理但响应丢失」这一种
//     模糊失败，量级极小。
//   - 这个数字的用途是滥用防护的闸门和给用户看的近似用量，不是计费凭据。
//
// 站点不存在的上报直接跳过：那说明站点已被硬删或 site_id 有误，凭空插一行会让
// website_usage_daily 出现无主记录，也会把 user_id 写成空串污染按用户的汇总。
func (l *logic) RecordTrafficUsage(reports []TrafficUsageReport) (int, error) {
	if len(reports) == 0 {
		return 0, nil
	}
	day := usageDayString(time.Now())
	accepted := 0
	var firstErr error
	for _, report := range reports {
		if report.SiteID == "" || (report.TrafficBytes <= 0 && report.RequestCount <= 0) {
			continue
		}
		site, err := l.siteDao.GetBySiteID(report.SiteID)
		if err != nil {
			l.logger.Warn("website usage report: load site failed",
				zap.String("site_id", report.SiteID), zap.Error(err))
			if firstErr == nil {
				firstErr = fmt.Errorf("load site %s: %w", report.SiteID, err)
			}
			continue
		}
		if site == nil {
			l.logger.Warn("website usage report skipped: unknown site",
				zap.String("site_id", report.SiteID))
			continue
		}
		// 已软删的站点仍然入账：站点删除后历史流量记录保留，否则用户可以靠
		// 反复建站/删站把当月已用流量清零，月额度就形同不存在。
		if err := l.usageDao.AddDailyTraffic(
			site.SiteID, site.UserID, day, report.TrafficBytes, report.RequestCount); err != nil {
			l.logger.Warn("website usage report: accumulate failed",
				zap.String("site_id", report.SiteID), zap.Error(err))
			if firstErr == nil {
				firstErr = fmt.Errorf("accumulate usage for %s: %w", report.SiteID, err)
			}
			continue
		}
		accepted++
	}
	return accepted, firstErr
}

// UpdateSiteStorage 回填站点当前占用的存储字节数。
//
// 由 website-deployer 在发布成功和删除完成之后调用。文件永久保留，所以用量只在
// 这两个时刻变化——事件驱动足够准确，不需要定时全桶扫描。
func (l *logic) UpdateSiteStorage(siteID string, storageBytes int64) error {
	if siteID == "" {
		return errcode.ErrWebsiteInvalidParam
	}
	if storageBytes < 0 {
		return errcode.Wrap(errcode.ErrWebsiteInvalidParam, "storage_bytes must not be negative")
	}
	site, err := l.siteDao.GetBySiteID(siteID)
	if err != nil {
		return fmt.Errorf("load site: %w", err)
	}
	if site == nil {
		return errcode.ErrWebsiteNotFound
	}
	if err := l.siteDao.UpdateStorageBytes(siteID, storageBytes); err != nil {
		return fmt.Errorf("update storage bytes: %w", err)
	}
	l.logger.Info("website site storage usage updated",
		zap.String("site_id", siteID), zap.Int64("storage_bytes", storageBytes))
	return nil
}

// usedTrafficBytesThisMonth 返回用户当月已用流量。
//
// 查询失败时返回 0 而不是报错：这个数字只用于展示和超额判定，
// 让它拖垮整个 capability 查询（用户连建站页面都打不开）是更差的取舍。
func (l *logic) usedTrafficBytesThisMonth(userID string) int64 {
	from, to := usageMonthRange(time.Now())
	used, err := l.usageDao.SumTrafficBytesInRange(userID, from, to)
	if err != nil {
		l.logger.Warn("sum monthly website traffic failed",
			zap.String("user_id", userID), zap.Error(err))
		return 0
	}
	return used
}
