// Package website — Pass 生命周期联动入口
// 供 ctl/pkg/pass/worker 直接调用，不依赖 Logic 实例化

package website

import (
	"fmt"

	"go.uber.org/zap"
)

// IsolateSitesOnPassExpired Pass隔离时挂起用户所有active站点
func IsolateSitesOnPassExpired(logger *zap.Logger, userID string) error {
	if logger != nil {
		logger.Info("website: isolating sites on pass expired", zap.String("user_id", userID))
	}
	return NewLogic().OnPassIsolated(userID)
}

// ReactivateSitesOnPassRenewed Pass续费时恢复用户所有suspended站点
func ReactivateSitesOnPassRenewed(logger *zap.Logger, userID string) error {
	if logger != nil {
		logger.Info("website: reactivating sites on pass renewed", zap.String("user_id", userID))
	}
	return NewLogic().OnPassRenewed(userID)
}

// DeleteAllSitesOnPassDestroyed Pass销毁时删除用户所有站点并释放配额
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
		// 逐个删除（每个都会释放配额+软删+创建delete operation）
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
