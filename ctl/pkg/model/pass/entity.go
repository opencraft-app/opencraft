package pass

import (
	"time"

	"ctl/pkg/model"
)

const (
	TableName = "pass"

	ColumnPassID       = "pass_id"
	ColumnUserID       = "user_id"
	ColumnBundleID     = "bundle_id"
	ColumnUin          = "uin"
	ColumnAppID        = "app_id"
	ColumnExpiredTime  = "expired_time"
	ColumnIsolatedTime = "isolated_time" // 隔离完成时刻（trade-pass-isolate §11-Q22：status='isolated' 同事务写入）
	ColumnDeletedTime  = "deleted_time"  // 预留：销毁设计走物理 DELETE + history_pass，本字段未使用
	ColumnRenewFlag    = "renew_flag"    // v4 收敛：billing-integration B2 新增
	ColumnStatus       = "status"        // trade-pass-isolate Q8/Q23：隔离生命周期状态列

	// 同 SP 变配（升配）中间态字段。与 isolate/renew 只用 status 占位不同，变配必须持久化
	// 在飞的 flow：计费重投会带着同一个 trade_flow_id 再来，而"另一个 flow 想插队"必须被拒绝，
	// 这个区分只能靠比对 pass 上记着的 flow id。
	ColumnModifyFlowID         = "modify_flow_id"
	ColumnModifyTargetBundleID = "modify_target_bundle_id"
)

// RenewFlag 取值枚举（v4 收敛：billing-integration 子需求 B2）
//   - MANUAL_RENEW：手动续费（默认）。试用、国内站及异常续费标记均使用该值
//   - AUTO_RENEW：自动续费。国际站新购明确选择自动续费时使用
const (
	RenewFlagManual = "MANUAL_RENEW"
	RenewFlagAuto   = "AUTO_RENEW"
)

// Status 取值枚举（trade-pass-isolate 设计稿 Q8 + Q23 = C1 修订版；
// trade-pass-renew §3.1 / §3.4 v3.8 扩展 StatusRenewing；
// trade-pass-destroy §4.1 扩展 StatusDeleting / StatusTerminating）
//   - StatusActive：默认值。pass 处于正常可用状态，CreateInstance 走绿灯
//   - StatusIsolating：IsolatePass 父 task 已 CAS 拿到锁，正在并行下发子 task 关停 instance
//   - StatusIsolated：所有子 task finalize 成功，pass 维度的隔离闭环已完成（终态）
//   - StatusRenewing：到期续费父 task 已 CAS 拿到锁（isolated → renewing），正在并行下发
//     子 task 开机 instance；父 task all-success 后 CAS 切回 active 并清 isolated_time
//   - StatusDeleting：用户已点击销毁、jifei 尚未回调 destroyResource 的中间态（前端可见态占位，
//     幂等防重）；ctl.DeletePass CAS：isolated → deleting；不直接派 task，仅同步调 trade.DeleteResource
//     触发 jifei.ModifyResourceStatus(operateName=PRE_DESTROY)，等待 jifei 异步回调进入主链
//   - StatusTerminating：销毁主链已启动至全部完成前；ctl.DestroyPass CAS：deleting/isolated → terminating
//   - StatusDeleted：销毁主链终态值，**仅出现在 history_pass.status 列**；pass 表实际行已被 5b 删除，
//     这是写 history_pass 时由 fromActivePass 强制改写的终态枚举（区别于销毁瞬间 pass.status='terminating'
//     的中间态镜像，让 history_pass 状态语义统一为"已销毁"）。pass 表 status 列不会出现 deleted。
//
// 状态机：
//
//	active ──[IsolatePass.TryAcquireSlotForIsolate]──▶ isolating
//	isolating ──[父 task finalize 成功]──▶ isolated
//	isolated ──[RenewPass.TryAcquireSlotForRenew]──▶ renewing
//	renewing ──[RenewPass 父 task all-success 收尾]──▶ active（同时清 isolated_time、写新 expired_time）
//	isolated ──[DeletePass.TryAcquireSlotForDelete]──▶ deleting     （入口 A：用户主动销毁）
//	deleting ──[DestroyPass.TryAcquireSlotForTerminate]──▶ terminating（jifei 回调到达后进入主链）
//	isolated ──[DestroyPass.TryAcquireSlotForTerminate]──▶ terminating（入口 B：计费侧销毁回调跳过 deleting）
//	terminating ──[销毁父 task 收尾步 5b]──▶ （删除 pass 行 + 写 history_pass）
//	（不存在 renewing → isolated 的回滚边；task 永不放弃，重投至 all-success）
//	（不存在 isolated → active 的直接边；外部如需"复活"必须经 renewing 中间态）
//	（active → renewing 不存在；提前续费走 active 路径同步直接 UPDATE expired_time，不切 status）
//	（不存在 deleting → isolated 的回滚边；trade.DeleteResource 失败时 pass 留在 deleting，监控兜底）
//	active ──[ModifyPass.TryAcquireSlotForModify]──▶ modifying
//	modifying ──[变配父 task 全链路收敛]──▶ active（同时写新 bundle_id、清 modify_* 中间字段）
//	（不存在 modifying → active 的失败回滚边；系统盘扩容不可逆，只能前滚收敛，见 §8.3）
const (
	StatusActive      = "active"
	StatusIsolating   = "isolating"
	StatusIsolated    = "isolated"
	StatusRenewing    = "renewing"
	StatusDeleting    = "deleting"
	StatusTerminating = "terminating"
	// StatusModifying 同 SP 变配进行中；ModifyPass CAS：active → modifying，父 task 全链路
	// 收敛后 CAS 回 active。期间禁止建实例、隔离、续费、销毁等冲突操作。
	StatusModifying = "modifying"
	// StatusDeleted 销毁主链终态值，仅写入 history_pass.status 列，pass 表的 status 列不会出现该值。
	// 详见上方 Status 注释中关于 StatusDeleted 的说明（history 维度的终态枚举）。
	StatusDeleted = "deleted"
)

// Entity 用户权益实体
type Entity struct {
	model.BaseEntity

	PassID       string     `gorm:"column:pass_id;uniqueIndex:uk_pass_id"`
	UserID       string     `gorm:"column:user_id;index:idx_user_id"`
	BundleID     string     `gorm:"column:bundle_id;index:idx_bundle_id"`
	Uin          int64      `gorm:"column:uin"`
	AppID        int64      `gorm:"column:app_id;index:idx_app_id"`
	ExpiredTime  time.Time  `gorm:"column:expired_time"`
	IsolatedTime *time.Time `gorm:"column:isolated_time"`           // 隔离完成时刻：isolating→isolated 事务内写入（RenewPass 收尾时清 NULL）
	DeletedTime  *time.Time `gorm:"column:deleted_time"`            // 预留：销毁设计走物理 DELETE，本字段未使用
	RenewFlag    string     `gorm:"column:renew_flag"`              // v4 收敛：MANUAL_RENEW / AUTO_RENEW
	Status       string     `gorm:"column:status;index:idx_status"` // trade-pass-isolate：active / isolating / isolated

	// ModifyFlowID / ModifyTargetBundleID 只在 status='modifying' 期间有值，收尾时清零。
	// 变配受理靠它们区分"计费重投同一单"和"另一个单想插队"。
	ModifyFlowID         int64  `gorm:"column:modify_flow_id"`
	ModifyTargetBundleID string `gorm:"column:modify_target_bundle_id"`
}

func (Entity) TableName() string {
	return TableName
}
