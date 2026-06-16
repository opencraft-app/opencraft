package pass

import (
	"time"

	"ctl/pkg/model"
)

// === trade-pass-destroy 设计稿落地（§4.3 history_pass 表）===
// 设计稿：.tmp/trade-pass-destroy-design.md §4.3 / §11-A Q24
//
// history_pass 表用于销毁链路终态后保留 pass 历史记录：
//   - 销毁主链父 task 收尾步 5b 时，把 pass 表对应行迁移到 history_pass，再 DELETE pass 行
//   - pass 表仅保留 active/isolating/isolated/renewing/deleting/terminating 六态的"在用 pass"
//   - history_pass 表保留所有"已销毁 pass"的最终镜像（包含销毁时刻 + 销毁原因）
//
// 字段对偶关系（与 pass.Entity 对齐）：
//   - pass_id / user_id / bundle_id / uin / app_id / expired_time / isolated_time
//     / renew_flag / status：完全镜像 pass 表对应字段（保持类型一致，迁移零转换）
//   - deleted_time：history 独有，必填，记录 MoveToHistory 调用时刻（即销毁完成时刻）
//   - destroy_reason：history 独有，Q24 ✅ 拍板镜像 jifei `para.source` 原值
//     （biz=jifei 控制台 / qn=jifei 定时 / other=其他 / 空串=用户控制台 DeletePass 入口
//     未经 jifei 二次回标的兜底场景）
//
// 注意（设计稿 SQL 与 ctl 仓现状的差异）：
//   - 设计稿 SQL 写 created_at / updated_at；ctl 仓 model.BaseEntity 用 created_time /
//     updated_time（autoCreateTime / autoUpdateTime）。本期沿用 ctl 现存 BaseEntity，
//     即列名为 created_time / updated_time，与 pass 表保持一致。
//   - 设计稿 SQL 写 uin VARCHAR(64)；ctl pass.Entity 实际用 int64（与 pass 表 BIGINT 对齐）。
//     history 表沿用 int64，避免迁移时类型转换，保证字段镜像零失真。
const (
	HistoryTableName = "history_pass"

	HistoryColumnPassID        = "pass_id"
	HistoryColumnUserID        = "user_id"
	HistoryColumnBundleID      = "bundle_id"
	HistoryColumnUin           = "uin"
	HistoryColumnAppID         = "app_id"
	HistoryColumnExpiredTime   = "expired_time"
	HistoryColumnIsolatedTime  = "isolated_time"
	HistoryColumnDeletedTime   = "deleted_time"
	HistoryColumnRenewFlag     = "renew_flag"
	HistoryColumnStatus        = "status"
	HistoryColumnDestroyReason = "destroy_reason"
)

// HistoryEntity 销毁后的历史 pass 实体
//
// 表结构：见设计稿 .tmp/trade-pass-destroy-design.md §4.3
//
// 唯一索引：uk_history_pass_id（pass_id）— 支撑 MoveToHistory 的幂等语义（同 pass 重复迁移碰冲突视为已迁）
// 二级索引：idx_history_user_id / idx_history_uin_appid (uin, app_id) / idx_history_deleted_time
//
// 注意（GORM tag 索引名 vs 设计稿 SQL 索引名）：
//   - 设计稿 SQL 写 `KEY idx_user_id (user_id) / idx_uin_appid (uin, app_id) / idx_deleted_time (deleted_time)`
//   - 生产 MySQL 索引名跨表可重名，所以设计稿写法在 MySQL migration 里没问题
//   - 但 sqlite（单测使用）要求索引名全 DB 唯一，与 pass 表的 idx_user_id 会冲突
//   - 故 GORM tag 里加 `history_` 前缀做隔离；MySQL migration SQL 仍按设计稿原命名落地
type HistoryEntity struct {
	model.BaseEntity

	PassID        string     `gorm:"column:pass_id;uniqueIndex:uk_history_pass_id"`
	UserID        string     `gorm:"column:user_id;index:idx_history_user_id"`
	BundleID      string     `gorm:"column:bundle_id"`
	Uin           int64      `gorm:"column:uin;index:idx_history_uin_appid,priority:1"`
	AppID         int64      `gorm:"column:app_id;index:idx_history_uin_appid,priority:2"`
	ExpiredTime   time.Time  `gorm:"column:expired_time"`
	IsolatedTime  *time.Time `gorm:"column:isolated_time"`
	DeletedTime   time.Time  `gorm:"column:deleted_time;index:idx_history_deleted_time"`
	RenewFlag     string     `gorm:"column:renew_flag"`
	Status        string     `gorm:"column:status"`
	DestroyReason string     `gorm:"column:destroy_reason"` // Q24 ✅ 拍板：镜像 jifei para.source（biz/qn/other/空串）
}

// TableName 指定 GORM 物理表名
func (HistoryEntity) TableName() string {
	return HistoryTableName
}

// fromActivePass 从 pass.Entity（在用 pass）构造 HistoryEntity（销毁后历史 pass）
//
// 用途：MoveToHistory 单事务内 — pass 行查到后，先转 HistoryEntity 再 INSERT history_pass。
// destroyReason 由 caller 传入（最终来源 jifei para.source 镜像，由 ctl 父 task payload 透传）。
//
// 注意：BaseEntity 不复制（id/created_time/updated_time 由 history_pass 表自身重新生成；
// 销毁前 pass 行的 created_time 不需要保留 — 业务上"销毁时刻" deleted_time 才是真正有意义的时间维度）。
// fromActivePass 从 pass.Entity（在用 pass）构造 HistoryEntity（销毁后历史 pass）
//
// === Bug fix（用户 2026-05-25 拍板）===
// 原实现镜像 p.Status（销毁瞬间通常是 'terminating'）→ history_pass.status 落 'terminating'，
// 与 history_pass 的语义不符（history 维度的语义就是"已销毁"）。
// 修复：强制把 history_pass.status 写为 StatusDeleted（'deleted'），不再镜像销毁瞬间的中间态。
// pass 表本身的 status 列不会出现 'deleted'（pass 行已被 5b 删除），仅 history_pass 列承载该值。
func fromActivePass(p *Entity, deletedTime time.Time, destroyReason string) *HistoryEntity {
	return &HistoryEntity{
		PassID:        p.PassID,
		UserID:        p.UserID,
		BundleID:      p.BundleID,
		Uin:           p.Uin,
		AppID:         p.AppID,
		ExpiredTime:   p.ExpiredTime,
		IsolatedTime:  p.IsolatedTime,
		DeletedTime:   deletedTime,
		RenewFlag:     p.RenewFlag,
		Status:        StatusDeleted,
		DestroyReason: destroyReason,
	}
}
