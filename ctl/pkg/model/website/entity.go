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
)

// ---- Site 状态 ----

const (
	SiteStatusCreating  = "creating"
	SiteStatusActive    = "active"
	SiteStatusSuspended = "suspended"
	SiteStatusDeleting  = "deleting"
	SiteStatusDeleted   = "deleted"
	// SiteStatusBlocked 是违规内容的人工封禁终态。
	//
	// 与 suspended 的区别：suspended 是套餐到期，续费即恢复；blocked 是我们主动
	// 停用，不随套餐状态变化。独立成一个状态是为了让网关能秒级拦截违规站点，
	// 而不必等待删除产物——先于云厂商动手是避免处罚升级到桶级/账号级的关键。
	SiteStatusBlocked = "blocked"
)

// ---- Release 状态 ----

const (
	ReleaseStatusPending   = "pending"
	ReleaseStatusUploading = "uploading"
	ReleaseStatusDeploying = "deploying"
	ReleaseStatusActive    = "active"
	ReleaseStatusFailed    = "failed"
	// ReleaseStatusSuperseded 表示该版本曾成功上线，但已被更新的版本取代。
	// 每个站点在任一时刻只应有一个 active 版本，否则「当前版本」失去唯一性，
	// 续费恢复和发布历史展示都会取到错误的版本。
	ReleaseStatusSuperseded = "superseded"
	ReleaseStatusRolledBack = "rolled_back"
)

// ---- Operation 状态 ----

const (
	OpStatusCreated = "created"
	OpStatusRunning = "running"
	OpStatusSuccess = "success"
	OpStatusFailed  = "failed"
	// OpStatusDead 是可重试操作耗尽重试次数后的终态死信。
	// 与 failed 的区别：failed 仍可能被重新调度，dead 表示已停止重试、需人工介入。
	OpStatusDead = "dead"
)

// ---- Operation 类型 ----

const (
	OpTypeCreate = "create"
	OpTypeDeploy = "deploy"
	OpTypeDelete = "delete"
	// OpTypeSuspend 套餐到期下线：删除线上发布文件，保留制品以便续费恢复。
	OpTypeSuspend = "suspend"
	// OpTypeResume 套餐续费恢复：从保留的制品重新发布。
	OpTypeResume = "resume"
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

	SiteID   string `gorm:"column:site_id;uniqueIndex:uk_site_id"`
	PassID   string `gorm:"column:pass_id"`
	BundleID string `gorm:"column:bundle_id"`
	Name     string `gorm:"column:name"`
	// IdempotencyKey 是创建接口的真实幂等键，(user_id, idempotency_key) 唯一。
	// 指针类型：不传幂等键时写入 NULL，不参与 DB 层去重。
	IdempotencyKey *string `gorm:"column:idempotency_key"`
	Status         string  `gorm:"column:status;index:idx_status"`
	CloudPath      string  `gorm:"column:cloud_path"`
	PublicURL      string  `gorm:"column:public_url"`
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
	NextRetryAt    *time.Time `gorm:"column:next_retry_at"`
	Attempt        int        `gorm:"column:attempt"`
	SiteGeneration int64      `gorm:"column:site_generation"`
}

func (OperationEntity) TableName() string {
	return OperationsTable
}

// ---- 配额 resource_name 常量 ----

const (
	ResourceNameWebsiteSite = "WEBSITE_STATIC_SITE"
)

// ---- 套餐配额 JSON 结构 ----

type BundleStaticSiteQuota struct {
	MaxSites            int   `json:"max_sites"`
	MonthlyTrafficBytes int64 `json:"monthly_traffic_bytes"`
	StorageBytes        int64 `json:"storage_bytes"`
	MaxArtifactSize     int64 `json:"max_artifact_size"`
	MaxFiles            int   `json:"max_files"`
}
