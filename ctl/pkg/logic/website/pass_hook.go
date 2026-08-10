// Package website — Pass 生命周期联动入口
// 供 ctl/pkg/pass/worker 直接调用，不依赖 Logic 实例化
//
// 三个钩子都是纯 DB 状态迁移：不登记异步操作、不触碰 COS、不依赖 worker。
// 这是产品「到期与销毁都不真实删除用户数据，文件永久保留，只是不对外服务」
// 这一决定带来的直接结果——站点是否对外服务由自研反代（site-gateway）按状态判定，
// suspended/blocked 直接 403 且不回源，所以下线不需要动任何文件。

package website

import (
	"go.uber.org/zap"
)

// IsolateSitesOnPassExpired Pass 到期隔离时把用户所有 active 站点转为 suspended。
//
// 文件全部保留，公网立刻 403；续费后原地恢复，地址和内容都不变。
//
// 调用方可以把它当成阻塞步骤：整个动作是一次本地 DB 事务，没有跨系统依赖，
// 失败基本只可能是 DB 不可用——那种情况下 pass 隔离本身也推进不了。
func IsolateSitesOnPassExpired(logger *zap.Logger, userID string) error {
	if logger != nil {
		logger.Info("website: isolating sites on pass expired", zap.String("user_id", userID))
	}
	return NewLogic().OnPassIsolated(userID)
}

// ReactivateSitesOnPassRenewed Pass 续费时把用户所有 suspended 站点转回 active。
//
// 不从制品恢复：隔离时一个文件都没删，转 active 后网关立刻回源到原来的 cloud_path。
func ReactivateSitesOnPassRenewed(logger *zap.Logger, userID string) error {
	if logger != nil {
		logger.Info("website: reactivating sites on pass renewed", zap.String("user_id", userID))
	}
	return NewLogic().OnPassRenewed(userID)
}

// SuspendAllSitesOnPassDestroyed Pass 销毁时把用户所有仍在服务的站点转为 suspended。
//
// 销毁不再登记 delete 操作、不再删 COS：文件永久保留，只是不对外服务。
// 站点行也保持存在（不软删），它是桶里那些对象的归属依据。
//
// 用户的 WEBSITE_STATIC_SITE 配额行同样不删：下次购买套餐时由 ensureQuotaInitialized
// 复用并重算额度。注意站点仍然占着席位（CountActiveByUserID 计入 suspended），
// 这与「站点还在、数据还在」是一致的——用户要腾出名额就自己删站，那才是真删。
func SuspendAllSitesOnPassDestroyed(logger *zap.Logger, userID string) error {
	if logger != nil {
		logger.Info("website: suspending all sites on pass destroyed", zap.String("user_id", userID))
	}
	return NewLogic().OnPassDestroyed(userID)
}
