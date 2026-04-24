package model

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

type UsageLog struct {
	ID               uuid.UUID `gorm:"type:uuid;primaryKey" json:"id"`
	UserID           uuid.UUID `gorm:"type:uuid;not null" json:"user_id"`
	SubscriptionID   uuid.UUID `gorm:"type:uuid;not null" json:"subscription_id"`
	ProviderID       uuid.UUID `gorm:"type:uuid;not null" json:"provider_id"`
	Model            string    `gorm:"type:varchar(64);not null" json:"model"`
	PromptTokens     int       `gorm:"not null" json:"prompt_tokens"`
	CompletionTokens int       `gorm:"not null" json:"completion_tokens"`
	TotalTokens      int       `gorm:"not null" json:"total_tokens"`
	LatencyMs        int       `gorm:"not null" json:"latency_ms"`
	StatusCode       int       `gorm:"not null" json:"status_code"`
	RequestID        string    `gorm:"type:varchar(64)" json:"request_id"`
	Source           string    `gorm:"type:varchar(16);default:'api'" json:"source"` // "api" | "cache"
	CreatedAt        time.Time `gorm:"autoCreateTime" json:"created_at"`
}

func (u *UsageLog) BeforeCreate(tx *gorm.DB) error {
	if u.ID == uuid.Nil {
		u.ID = uuid.New()
	}
	return nil
}
