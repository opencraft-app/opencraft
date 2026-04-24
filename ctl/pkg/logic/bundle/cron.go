// Package bundle 套餐包定时任务。
package bundle

import (
	"time"

	modelfactory "ctl/pkg/model/factory"

	"go.uber.org/zap"
)

// StartDailyAvailCountRefresh 启动定时任务：每天指定 hour 点（UTC+8）刷新所有 ONLINE
// 套餐的 available_count = total_count，以恢复每日售卖配额。
// 调用方应在 API 启动时调用此函数，传入 done channel 以便优雅关闭。
func StartDailyAvailCountRefresh(logger *zap.Logger, hour int, done <-chan struct{}) {
	go func() {
		loc := time.FixedZone("CST", 8*3600) // UTC+8

		for {
			now := time.Now().In(loc)
			// 计算下一次执行时间
			next := time.Date(now.Year(), now.Month(), now.Day(), hour, 0, 0, 0, loc)
			if !next.After(now) {
				next = next.AddDate(0, 0, 1)
			}
			wait := next.Sub(now)
			logger.Info("bundle avail count refresh scheduled",
				zap.String("next_run", next.Format(time.RFC3339)),
				zap.Duration("wait", wait),
			)

			select {
			case <-done:
				logger.Info("bundle avail count refresh stopped")
				return
			case <-time.After(wait):
				runRefresh(logger)
			}
		}
	}()
}

func runRefresh(logger *zap.Logger) {
	dao := modelfactory.DefaultDaoFactory.BundleDao(nil)
	affected, err := dao.RefreshAllAvailCount()
	if err != nil {
		logger.Error("bundle avail count refresh failed", zap.Error(err))
		return
	}
	logger.Info("bundle avail count refresh done", zap.Int64("affected", affected))
}
