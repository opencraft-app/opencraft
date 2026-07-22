package instance

import (
	"time"

	"gorm.io/gorm"
)

const (
	TableName = "instances"

	ColumnID               = "id"
	ColumnInstanceID       = "instance_id"
	ColumnUserID           = "user_id"
	ColumnDisplayName      = "display_name"
	ColumnSandboxID        = "sandbox_id"
	ColumnAiGatewayKeyID   = "ai_gateway_key_id"
	ColumnGatewayAuthToken = "gateway_auth_token"
	ColumnStatus           = "status"
	ColumnTimeoutAt        = "timeout_at"
	ColumnCreatedAt        = "created_at"
	ColumnUpdatedAt        = "updated_at"
	ColumnDeletedAt        = "deleted_at"

	InstanceStatusCreating = "Creating"
	InstanceStatusRunning  = "Running"
	InstanceStatusPaused   = "Paused"
	InstanceStatusResuming = "Resuming"
	InstanceStatusFailed   = "Failed"
	InstanceStatusDeleting = "Deleting"
	InstanceStatusDeleted  = "Deleted"
)

type Entity struct {
	Id               int64          `gorm:"column:id;primaryKey;autoIncrement"`
	InstanceId       string         `gorm:"column:instance_id;uniqueIndex:uk_instance_id"`
	UserId           string         `gorm:"column:user_id;index:idx_user_id"`
	DisplayName      string         `gorm:"column:display_name"`
	SandboxId        string         `gorm:"column:sandbox_id"`
	AiGatewayKeyID   string         `gorm:"column:ai_gateway_key_id"`
	GatewayAuthToken string         `gorm:"column:gateway_auth_token"`
	SandboxIdKey     *string        `gorm:"column:sandbox_id_key;->;-:migration"`
	Status           string         `gorm:"column:status"`
	TimeoutAt        time.Time      `gorm:"column:timeout_at"`
	CreatedAt        time.Time      `gorm:"column:created_at;autoCreateTime"`
	UpdatedAt        time.Time      `gorm:"column:updated_at;autoUpdateTime"`
	DeletedAt        gorm.DeletedAt `gorm:"column:deleted_at;index:idx_deleted_at"`
}

func (Entity) TableName() string {
	return TableName
}
