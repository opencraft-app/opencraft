// Package website 静态建站模型
package website

import (
	"time"

	"ctl/pkg/model"
)

// ---- 表名常量 ----

const (
	SitesTable      = "website_sites"
	ReleasesTable   = "website_releases"
	OperationsTable = "website_operations"
	UsageDailyTable = "website_usage_daily"
)

// ---- Site 状态 ----

const (
	SiteStatusCreating  = "creating"
	SiteStatusActive    = "active"
	SiteStatusSuspended = "suspended"
	SiteStatusDeleted   = "deleted"
)

// ---- Release 状态 ----

const (
	ReleaseStatusPending    = "pending"
	ReleaseStatusUploading  = "uploading"
	ReleaseStatusDeploying  = "deploying"
	ReleaseStatusActive     = "active"
	ReleaseStatusFailed     = "failed"
	ReleaseStatusRolledBack = "rolled_back"
)

// ---- Operation 状态 ----

const (
	OpStatusCreated = "created"
	OpStatusRunning = "running"
	OpStatusSuccess = "success"
	OpStatusFailed  = "failed"
)

// ---- Operation 类型 ----

const (
	OpTypeCreate = "create"
	OpTypeDeploy = "deploy"
	OpTypeDelete = "delete"
)

// ---- 列名 ----

const (
	// common
	ColumnId          = model.ColumnId
	ColumnCreatedTime = model.ColumnCreatedTime
	ColumnUpdatedTime = model.ColumnUpdatedTime
	ColumnUserID      = model.ColumnUserID
)

// ---- Site Entity ----

type SiteEntity struct {
	model.BaseEntity
	model.BaseUserEntity

	SiteID    string `gorm:"column:site_id;uniqueIndex:uk_site_id"`
	PassID    string `gorm:"column:pass_id"`
	BundleID  string `gorm:"column:bundle_id"`
	Name      string `gorm:"column:name"`
	Status    string `gorm:"column:status;index:idx_status"`
	CloudPath string `gorm:"column:cloud_path"`
	TCBEnvID  string `gorm:"column:tcb_env_id"`
	PublicURL string `gorm:"column:public_url"`
	// OperationGeneration fences late workers so an older deploy cannot restore a deleted site.
	OperationGeneration int64      `gorm:"column:operation_generation"`
	DeletedTime         *time.Time `gorm:"column:deleted_time"`
}

func (SiteEntity) TableName() string {
	return SitesTable
}

// ---- Release Entity ----

type ReleaseEntity struct {
	model.BaseEntity
	model.BaseUserEntity

	ReleaseID    string `gorm:"column:release_id;uniqueIndex:uk_release_id"`
	SiteID       string `gorm:"column:site_id;index:idx_site_id"`
	Version      int    `gorm:"column:version"`
	Status       string `gorm:"column:status;index:idx_status"`
	ArtifactHash string `gorm:"column:artifact_hash"`
	ArtifactSize int64  `gorm:"column:artifact_size"`
	FileCount    int    `gorm:"column:file_count"`
	ErrorMessage string `gorm:"column:error_message"`
}

func (ReleaseEntity) TableName() string {
	return ReleasesTable
}

// ---- Operation Entity ----

type OperationEntity struct {
	model.BaseEntity
	model.BaseUserEntity

	OperationID    string     `gorm:"column:operation_id;uniqueIndex:uk_operation_id"`
	SiteID         string     `gorm:"column:site_id;index:idx_site_id"`
	ReleaseID      string     `gorm:"column:release_id"`
	OperationType  string     `gorm:"column:operation_type"`
	Status         string     `gorm:"column:status;index:idx_status"`
	ErrorMessage   string     `gorm:"column:error_message"`
	LeaseToken     string     `gorm:"column:lease_token"`
	LeaseExpiresAt *time.Time `gorm:"column:lease_expires_at"`
	Attempt        int        `gorm:"column:attempt"`
	SiteGeneration int64      `gorm:"column:site_generation"`
	TCBEnvID       string     `gorm:"-"`
}

func (OperationEntity) TableName() string {
	return OperationsTable
}

// ---- Usage Daily Entity ----

type UsageDailyEntity struct {
	Id           int64     `gorm:"column:id;primaryKey;autoIncrement"`
	SiteID       string    `gorm:"column:site_id;uniqueIndex:uk_site_date,priority:1"`
	UserID       string    `gorm:"column:user_id;index:idx_user_date"`
	UsageDate    time.Time `gorm:"column:usage_date;uniqueIndex:uk_site_date,priority:2"`
	TrafficBytes int64     `gorm:"column:traffic_bytes"`
	RequestCount int64     `gorm:"column:request_count"`
	CreatedTime  time.Time `gorm:"column:created_time;autoCreateTime"`
	UpdatedTime  time.Time `gorm:"column:updated_time;autoUpdateTime"`
}

func (UsageDailyEntity) TableName() string {
	return UsageDailyTable
}

// ---- 配额 resource_name 常量 ----

const (
	ResourceNameWebsiteSite    = "WEBSITE_STATIC_SITE"
	ResourceNameWebsiteTraffic = "WEBSITE_TRAFFIC"
	ResourceNameWebsiteStorage = "WEBSITE_STORAGE"
)

// ---- 套餐配额 JSON 结构 ----

type BundleStaticSiteQuota struct {
	MaxSites            int   `json:"max_sites"`
	MonthlyTrafficBytes int64 `json:"monthly_traffic_bytes"`
	StorageBytes        int64 `json:"storage_bytes"`
	MaxArtifactSize     int64 `json:"max_artifact_size"`
	MaxFiles            int   `json:"max_files"`
}
