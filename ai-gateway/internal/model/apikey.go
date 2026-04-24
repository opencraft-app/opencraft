package model

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

type ApiKey struct {
	ID         uuid.UUID  `gorm:"type:uuid;primaryKey" json:"id"`
	UserID     uuid.UUID  `gorm:"type:uuid;not null;index" json:"user_id"`
	KeyHash    string     `gorm:"type:varchar(64);uniqueIndex;not null" json:"-"`
	KeyPrefix  string     `gorm:"type:varchar(12);not null" json:"key_prefix"`
	Name       string     `gorm:"type:varchar(64)" json:"name"`
	IsActive   bool       `gorm:"default:true;not null" json:"is_active"`
	LastUsedAt *time.Time `json:"last_used_at"`
	CreatedAt  time.Time  `gorm:"autoCreateTime" json:"created_at"`

	User *User `gorm:"foreignKey:UserID" json:"user,omitempty"`
}

func (a *ApiKey) BeforeCreate(tx *gorm.DB) error {
	if a.ID == uuid.Nil {
		a.ID = uuid.New()
	}
	return nil
}
