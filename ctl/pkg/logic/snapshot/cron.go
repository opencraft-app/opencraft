// Package snapshot 实现 trade-pass-destroy 销毁链路的快照定时清理任务。
//
// 设计稿：.tmp/trade-pass-destroy-design.md §4.10 / §11-A Q7
//
// 职责（D-8 切片，Phase A 简化版）：
//   1. 每日定时（默认凌晨 03:00 UTC+8）扫 ctl snapshot 表中 expire_time < now 的行
//   2. 每行物理删除 ctl snapshot 表行（释放数据库存储）
//   3. cbs 物理快照保留 — 依赖 cbs 端 SnapshotCreate 入参中的 Deadline 字段（D-4.2b 落地，
//      已设置 RFC3339 retention 期），cbs 到期自动回收，无需 ctl 端主动删
//
// Phase B（未来切片）若发现 cbs Deadline 不可靠，再扩展 sandbox.DeleteSnapshot 端点 + ctl cron
// 主动调 sandbox 删物理快照，然后再删 ctl snapshot 表行。本期实现保持简单，避免引入双重保障。
//
// 与 bundle/cron.go 的设计模式一致：
//   - StartDailyExpiredSnapshotCleanup 由 ctl API server 启动时注册
//   - 内置 done channel 优雅关闭
//   - 默认时间窗口可调（凌晨低峰期减少对生产业务的影响）
package snapshot

import (
	"context"
	"time"

	"ctl/pkg/metric"
	modelsnapshot "ctl/pkg/model/snapshot"

	"go.uber.org/zap"
)

// 默认配置
const (
	// snapshotCleanupBatchLimit 单次扫描批量上限 — 防止一次拉太多行 OOM；
	// 多于此数量时下一轮 cron 继续扫（非业务关键 / 非紧急）。
	snapshotCleanupBatchLimit = 500

	// snapshotCleanupGracePeriod expire_time < now - grace 的快照才视为"过期"（防止 expire_time 边界抖动）。
	// 30 分钟足够防御 cron worker 时钟偏差 / DB 主从延迟。
	snapshotCleanupGracePeriod = 30 * time.Minute
)

// StartDailyExpiredSnapshotCleanup 启动定时任务：每天指定 hour 点（UTC+8）扫 expire_time < now-grace 的快照行，
// 物理删除 ctl snapshot 表行（cbs 物理快照由 cbs Deadline 字段自动回收）。
//
// 调用方应在 API 启动时调用此函数，传入 done channel 以便优雅关闭。
func StartDailyExpiredSnapshotCleanup(logger *zap.Logger, hour int, done <-chan struct{}) {
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
			logger.Info("snapshot expired cleanup scheduled",
				zap.String("next_run", next.Format(time.RFC3339)),
				zap.Duration("wait", wait),
			)

			select {
			case <-done:
				logger.Info("snapshot expired cleanup stopped")
				return
			case <-time.After(wait):
				RunExpiredCleanup(logger)
			}
		}
	}()
}

// RunExpiredCleanup 单次扫表 + 删除一批过期快照（导出便于运维手动触发 / 单测）
//
// 流程：
//   1. ListExpired(now - grace, batchLimit) 反查到期快照
//   2. 依次 DeleteByID 物理删除 ctl snapshot 表行（cbs 物理快照不删，依赖 cbs Deadline）
//   3. 记录每行的 instance_id / pass_id / snapshot_id 便于审计
//
// 不返回错误（cron 入口）：失败仅记 Warn，不阻塞下一轮 cron。
func RunExpiredCleanup(logger *zap.Logger) {
	dao := modelsnapshot.NewDao()
	cutoff := time.Now().UTC().Add(-snapshotCleanupGracePeriod)
	expired, err := dao.ListExpired(context.Background(), cutoff, snapshotCleanupBatchLimit)
	if err != nil {
		logger.Error("snapshot expired cleanup: list failed", zap.Error(err))
		return
	}
	if len(expired) == 0 {
		logger.Info("snapshot expired cleanup: no rows to clean",
			zap.Time("cutoff", cutoff))
		return
	}

	cleaned := 0
	failed := 0
	for _, row := range expired {
		if row.Id == nil {
			logger.Warn("snapshot expired cleanup: row id is nil, skip",
				zap.String("snapshot_id", row.SnapshotID))
			metric.SnapshotCleanupTotal.WithLabelValues("skipped").Inc()
			failed++
			continue
		}
		rowID := *row.Id
		if err := dao.DeleteByID(context.Background(), rowID); err != nil {
			logger.Warn("snapshot expired cleanup: delete row failed (will retry next round)",
				zap.Error(err),
				zap.Int64("id", rowID),
				zap.String("snapshot_id", row.SnapshotID),
				zap.String("pass_id", row.PassID),
				zap.String("instance_id", row.InstanceID),
				zap.Time("expire_time", row.ExpireTime),
			)
			metric.SnapshotCleanupTotal.WithLabelValues("failed").Inc()
			failed++
			continue
		}
		logger.Info("snapshot expired cleanup: row deleted (cbs physical snapshot retained until cbs Deadline)",
			zap.Int64("id", rowID),
			zap.String("snapshot_id", row.SnapshotID),
			zap.String("pass_id", row.PassID),
			zap.String("instance_id", row.InstanceID),
			zap.Time("expire_time", row.ExpireTime),
		)
		metric.SnapshotCleanupTotal.WithLabelValues("cleaned").Inc()
		cleaned++
	}
	logger.Info("snapshot expired cleanup: round done",
		zap.Int("total", len(expired)),
		zap.Int("cleaned", cleaned),
		zap.Int("failed", failed),
		zap.Time("cutoff", cutoff),
	)
}
