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
}

func (Entity) TableName() string {
	return TableName
}
