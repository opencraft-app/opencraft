package passbillingmigration

import "ctl/pkg/model"

const (
	TableName = "pass_billing_migration"

	ColumnPassID         = "pass_id"
	ColumnUserID         = "user_id"
	ColumnSourceBundleID = "source_bundle_id"
	ColumnTargetBundleID = "target_bundle_id"
	ColumnUin            = "uin"
	ColumnAppID          = "app_id"
	ColumnStatus         = "status"
	ColumnDealName       = "deal_name"
	ColumnBigOrderID     = "big_order_id"
	ColumnLastError      = "last_error"
)

const (
	StatusPendingOrder    = "pending_order"
	StatusPendingTransfer = "pending_transfer"
	StatusPassMigrated    = "pass_migrated"
	StatusFailed          = "failed"
	StatusCompleted       = "completed"
	StatusSkipped         = "skipped"
)

type Entity struct {
	model.BaseEntity

	PassID         string  `gorm:"column:pass_id;uniqueIndex:uk_pass_target"`
	UserID         string  `gorm:"column:user_id;index:idx_user_status"`
	SourceBundleID string  `gorm:"column:source_bundle_id"`
	TargetBundleID string  `gorm:"column:target_bundle_id;uniqueIndex:uk_pass_target"`
	Uin            int64   `gorm:"column:uin"`
	AppID          int64   `gorm:"column:app_id"`
	Status         string  `gorm:"column:status;index:idx_user_status;index:idx_status_updated"`
	DealName       *string `gorm:"column:deal_name"`
	BigOrderID     *string `gorm:"column:big_order_id"`
	LastError      *string `gorm:"column:last_error"`
}

func (Entity) TableName() string {
	return TableName
}

func StringPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func New(passID, userID, sourceBundleID, targetBundleID string, uin, appID int64, status string) *Entity {
	return &Entity{
		PassID:         passID,
		UserID:         userID,
		SourceBundleID: sourceBundleID,
		TargetBundleID: targetBundleID,
		Uin:            uin,
		AppID:          appID,
		Status:         status,
	}
}
