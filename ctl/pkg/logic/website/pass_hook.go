// Package website — Pass 生命周期联动入口
// 供 ctl/pkg/pass/worker 直接调用，不依赖 Logic 实例化

package website

import (
	"fmt"

	"go.uber.org/zap"
)

// IsolateSitesOnPassExpired Pass 到期隔离时下线用户所有 active 站点。
//
// 站点状态在 DB 里立即变为 suspended，CloudBase 上的发布文件由worker 异步删除；
// 制品会被保留，续费后可原地恢复，站点地址不变。
func IsolateSitesOnPassExpired(logger *zap.Logger, userID string) error {
	if logger != nil {
		logger.Info("website: isolating sites on pass expired", zap.String("user_id", userID))
	}
	return NewLogic().OnPassIsolated(userID)
}

// ReactivateSitesOnPassRenewed Pass 续费时从保留的制品恢复用户所有 suspended 站点。
func ReactivateSitesOnPassRenewed(logger *zap.Logger, userID string) error {
	if logger != nil {
		logger.Info("website: reactivating sites on pass renewed", zap.String("user_id", userID))
	}
	return NewLogic().OnPassRenewed(userID)
}

// DeleteAllSitesOnPassDestroyed Pass 销毁时删除用户所有站点。
//
// 每个站点转入 deleting 并登记 delete 操作，由 worker 清理
// sites/{siteID}/ 与 _artifacts/{siteID}/ 两个前缀——也就是说，
// 到期下线时保留的制品最终在这里被清除，不需要额外的定时清理任务。
//
// 席位不在这里归还，而是等 worker 确认 COS 清理成功后由 CompleteOperation 归还，
// 避免「席位已还但公开对象仍在」。delete 操作失败会按退避持久重试，
// 因此单个站点在本函数内失败不阻塞其余站点。
//
// 注意：用户的 WEBSITE_STATIC_SITE 配额行故意不在此删除。
// 保留它可以让用户下次购买套餐时由 ensureQuotaInitialized 直接复用并重算额度，
// 比删掉再重建更少一次写入，也避免残留孤儿数据。
func DeleteAllSitesOnPassDestroyed(logger *zap.Logger, userID string) error {
	if logger != nil {
		logger.Info("website: deleting all sites on pass destroyed", zap.String("user_id", userID))
	}
	l := NewLogic().(*logic)

	// 查出所有未删除的站点
	sites, _, err := l.siteDao.ListByUserID(userID, 1, 1000)
	if err != nil {
		return fmt.Errorf("list sites for destroy: %w", err)
	}

	for _, site := range sites {
		if _, err := l.DeleteSite(userID, site.SiteID); err != nil {
			if logger != nil {
				logger.Warn("website: delete site on pass destroyed failed",
					zap.String("site_id", site.SiteID),
					zap.Error(err),
				)
			}
		}
	}

	return nil
}
