package model

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/datatypes"
	"gorm.io/gorm"
)

// ModelProviderMapping 定义模型名到提供商的映射规则，支持通配符匹配。
type ModelProviderMapping struct {
	ID           uuid.UUID `gorm:"type:uuid;primaryKey" json:"id"`
	ModelPattern string    `gorm:"type:varchar(128);not null" json:"model_pattern"` // 支持通配符: "gpt-4*", "claude-*"
	ProviderID   uuid.UUID `gorm:"type:uuid;not null" json:"provider_id"`
	Priority     int       `gorm:"default:0;not null" json:"priority"`
	Weight       int       `gorm:"default:100;not null" json:"weight"`
	IsActive     bool      `gorm:"default:true;not null" json:"is_active"`
	CreatedAt    time.Time `gorm:"autoCreateTime" json:"created_at"`

	// 路由策略覆盖（per-mapping 级别，NULL 表示继承全局）
	StrategyMode   *string        `gorm:"type:varchar(20)" json:"strategy_mode,omitempty"` // "loadbalance" / "fallback"
	RetryAttempts  *int           `gorm:"type:int" json:"retry_attempts,omitempty"`        // 0-5
	OnStatusCodes  datatypes.JSON `gorm:"type:json" json:"on_status_codes,omitempty"`      // 策略触发状态码
	OverrideParams datatypes.JSON `gorm:"type:json" json:"override_params,omitempty"`      // Portkey target 参数覆盖

	// 关联
	Provider Provider `gorm:"foreignKey:ProviderID" json:"provider,omitempty"`
}

func (m *ModelProviderMapping) BeforeCreate(tx *gorm.DB) error {
	if m.ID == uuid.Nil {
		m.ID = uuid.New()
	}
	return nil
}

func (ModelProviderMapping) TableName() string {
	return "model_mappings"
}
