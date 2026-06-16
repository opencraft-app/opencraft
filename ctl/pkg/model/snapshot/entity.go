// Package snapshot 实现 ctl 销毁链路的快照模型（Q4-a ✅ 拍板：snapshot 表归属 ctl 顶级业务语义）
//
// 设计稿：.tmp/trade-pass-destroy-design.md §4.4 / §11-A Q4-a / Q9 / Q9-fix / Q21
//
// 表语义：
//   - snapshot 表与 instance 表并列，是 ctl 业务模型的顶级实体之一
//   - 即使将来不使用 cbs（换其他云厂商或自研存储），ctl 的 snapshot 业务模型保持不变
//   - sandbox 仅作为无状态执行层，把 ctl 给来的 snapshot 创建/查询请求转译为底层（当前 cbs）调用
//
// Q9 拍板：单实例单系统盘单快照模型 — 销毁链路只对系统盘创建快照（数据盘场景不存在），
// 表结构无 disk_id / disk_usage 维度。
//
// Q9-fix 拍板（v0.10）：唯一性维度 = 销毁事件维度（flow_id, instance_id 联合 UNIQUE），
// 而非实例维度。sandbox `DELETE /sandboxes/{id}` 实际语义是 Release 把 ALLOCATED→DRY，
// worker Reinstall 后回到 CLEAN 再被分配给下一个用户，因此同 instance_id 会反复 ALLOCATE/Release，
// 每次销毁链路都创快照，原 UNIQUE KEY uk_instance_id 会让第二次销毁同 instance 主键冲突。
//
// Q21 拍板：region 字段数据来源 = ctl 进程配置 config.ServerConf.MiscConfig.Region
// （本期单集群单 region 前提下，instance 维度与配置维度等价）。
package snapshot

import (
	"time"

	"ctl/pkg/model"
)

const (
	TableName = "snapshot"

	ColumnSnapshotID    = "snapshot_id"
	ColumnFlowID        = "flow_id"
	ColumnPassID        = "pass_id"
	ColumnInstanceID    = "instance_id"
	ColumnUserID        = "user_id"
	ColumnUin           = "uin"
	ColumnAppID         = "app_id"
	ColumnRegion        = "region"
	ColumnSnapshotState = "snapshot_state"
	ColumnExpireTime    = "expire_time"
)

// SnapshotState 取值枚举（来自 sandbox `GET /sandboxes/{id}/snapshot-status` 返回，
// 已抽象为业务语义，不暴露 cbs 原生枚举）：
//   - StateInProgress：sandbox 返 "in_progress"（CREATING / CREATING_PERCENT 阶段）
//   - StateNormal：sandbox 返 "ready"（NORMAL，快照已就绪可用）
//   - StateError：sandbox 返 "failed"（ERROR）
//
// 销毁子 task 阶段 1+2 的状态机：CREATING → NORMAL（成功推进）/ ERROR（终态失败）。
// snapshot 表的 snapshot_state 字段在子 task 阶段 2 轮询时实时更新，最终落 NORMAL 或 ERROR。
const (
	StateInProgress = "in_progress"
	StateNormal     = "ready"
	StateError      = "failed"
)

// Entity snapshot 表实体
//
// 表结构：见设计稿 .tmp/trade-pass-destroy-design.md §4.4
//
// 唯一索引：
//   - uk_snapshot_id：物理快照 ID 全局唯一（cbs 侧天然唯一）
//   - uk_flow_instance：(flow_id, instance_id) 销毁事件维度唯一（Q9-fix 修订）
//
// 二级索引：idx_pass_id / idx_instance_id（非唯一，支持反查全部销毁历史） / idx_user_id / idx_expire_time
type Entity struct {
	model.BaseEntity

	SnapshotID    string    `gorm:"column:snapshot_id;uniqueIndex:uk_snapshot_id"`
	FlowID        int64     `gorm:"column:flow_id;uniqueIndex:uk_flow_instance,priority:1"`
	PassID        string    `gorm:"column:pass_id;index:idx_snapshot_pass_id"`
	InstanceID    string    `gorm:"column:instance_id;uniqueIndex:uk_flow_instance,priority:2;index:idx_snapshot_instance_id"`
	UserID        string    `gorm:"column:user_id;index:idx_snapshot_user_id"`
	Uin           int64     `gorm:"column:uin"`
	AppID         int64     `gorm:"column:app_id"`
	Region        string    `gorm:"column:region"` // Q21 ✅ 拍板：来源 ctl config.ServerConf.MiscConfig.Region
	SnapshotState string    `gorm:"column:snapshot_state"`
	ExpireTime    time.Time `gorm:"column:expire_time;index:idx_snapshot_expire_time"`
}

// TableName GORM 物理表名
func (Entity) TableName() string {
	return TableName
}
