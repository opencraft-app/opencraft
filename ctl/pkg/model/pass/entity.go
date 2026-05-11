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
	ColumnIsolatedTime = "isolated_time" // 预留
	ColumnDeletedTime  = "deleted_time"  // 预留
	ColumnRenewFlag    = "renew_flag"    // v4 收敛：billing-integration B2 新增
)

// RenewFlag 取值枚举（v4 收敛：billing-integration 子需求 B2）
//   - MANUAL_RENEW：手动续费（默认）。试用走默认值；付费 pass CompletePass logic 内部写死该值
//   - AUTO_RENEW：自动续费。本期不对外暴露，预留供未来扩展
const (
	RenewFlagManual = "MANUAL_RENEW"
	RenewFlagAuto   = "AUTO_RENEW"
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
	IsolatedTime *time.Time `gorm:"column:isolated_time"` // 预留
	DeletedTime  *time.Time `gorm:"column:deleted_time"`  // 预留
	RenewFlag    string     `gorm:"column:renew_flag"`    // v4 收敛：MANUAL_RENEW / AUTO_RENEW
}

func (Entity) TableName() string {
	return TableName
}
