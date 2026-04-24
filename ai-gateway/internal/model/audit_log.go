package model

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/datatypes"
	"gorm.io/gorm"
)

type AdminAuditLog struct {
	ID               uuid.UUID      `gorm:"type:uuid;primaryKey" json:"id"`
	AdminTokenPrefix string         `gorm:"type:varchar(12);not null" json:"admin_token_prefix"`
	Action           string         `gorm:"type:varchar(64);not null" json:"action"`
	ResourceType     string         `gorm:"type:varchar(32);not null" json:"resource_type"`
	ResourceID       uuid.UUID      `gorm:"type:uuid" json:"resource_id"`
	BeforeValue      datatypes.JSON `gorm:"type:json" json:"before_value"`
	AfterValue       datatypes.JSON `gorm:"type:json" json:"after_value"`
	IPAddress        string         `gorm:"type:varchar(45)" json:"ip_address"`
	CreatedAt        time.Time      `gorm:"autoCreateTime" json:"created_at"`
}

func (a *AdminAuditLog) BeforeCreate(tx *gorm.DB) error {
	if a.ID == uuid.Nil {
		a.ID = uuid.New()
	}
	return nil
}
