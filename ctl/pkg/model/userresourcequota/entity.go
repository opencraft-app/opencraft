package userresourcequota

import "ctl/pkg/model"

const (
	TableName = "user_resource_quota"

	ColumnUserID                 = "user_id"
	ColumnResourceName           = "resource_name"
	ColumnResourceKey            = "resource_key"
	ColumnResourceQuotaAvailable = "resource_quota_available"
	ColumnResourceQuotaTotal     = "resource_quota_total"
)

type Entity struct {
	model.BaseEntity

	UserID                 string `gorm:"column:user_id;uniqueIndex:uk_user_resource_key"`
	ResourceName           string `gorm:"column:resource_name;uniqueIndex:uk_user_resource_key"`
	ResourceKey            string `gorm:"column:resource_key;uniqueIndex:uk_user_resource_key"`
	ResourceQuotaAvailable int64  `gorm:"column:resource_quota_available"`
	ResourceQuotaTotal     int64  `gorm:"column:resource_quota_total"`
}

func (Entity) TableName() string {
	return TableName
}
