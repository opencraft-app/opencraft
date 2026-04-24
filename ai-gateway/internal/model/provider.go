package model

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/datatypes"
	"gorm.io/gorm"
)

const (
	ProviderStatusActive    = "active"
	ProviderStatusExhausted = "exhausted"
	ProviderStatusDisabled  = "disabled"
	ProviderStatusUnhealthy = "unhealthy"

	ProviderTypeOpenAI    = "openai"
	ProviderTypeDeepSeek  = "deepseek"
	ProviderTypeQwen      = "qwen"
	ProviderTypeAnthropic = "anthropic"

	ModelDiscoveryProtocolOpenAICompatible = "openai_compatible"
	ModelDiscoveryProtocolAnthropic        = "anthropic"
	ModelDiscoveryProtocolGemini           = "gemini"

	RegistrationSourceManual   = "manual"
	RegistrationSourceRegistry = "registry"
)

type Provider struct {
	ID                     uuid.UUID      `gorm:"type:uuid;primaryKey" json:"id"`
	Name                   string         `gorm:"type:varchar(64);not null" json:"name"`
	ProviderType           string         `gorm:"type:varchar(32);not null" json:"provider_type"`
	APIKey                 string         `gorm:"type:text;not null" json:"api_key"` // encrypted at rest
	BaseURL                string         `gorm:"type:varchar(256);not null" json:"base_url"`
	TotalQuota             int64          `gorm:"not null" json:"total_quota"`
	UsedQuota              int64          `gorm:"default:0;not null" json:"used_quota"`
	Status                 string         `gorm:"type:varchar(20);default:'active';not null" json:"status"`
	Priority               int            `gorm:"default:0;not null" json:"priority"`
	Weight                 int            `gorm:"default:100;not null" json:"weight"`
	HealthCheckURL         string         `gorm:"type:varchar(256);default:''" json:"health_check_url"`
	ModelDiscoveryProtocol string         `gorm:"type:varchar(32);default:'openai_compatible'" json:"model_discovery_protocol"`
	LastHeartbeat          *time.Time     `json:"last_heartbeat"`
	RegistrationSource     string         `gorm:"type:varchar(20);default:'manual';not null" json:"registration_source"`
	SupportedModels        datatypes.JSON `gorm:"type:json;default:'[]'" json:"supported_models"`
	CreatedAt              time.Time      `gorm:"autoCreateTime" json:"created_at"`
	UpdatedAt              time.Time      `gorm:"autoUpdateTime" json:"updated_at"`
}

func (p *Provider) BeforeCreate(tx *gorm.DB) error {
	if p.ID == uuid.Nil {
		p.ID = uuid.New()
	}
	return nil
}
