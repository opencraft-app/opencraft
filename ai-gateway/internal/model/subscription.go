package model

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

const (
	SubscriptionStatusActive    = "active"
	SubscriptionStatusExpired   = "expired"
	SubscriptionStatusCancelled = "cancelled"
)

type Subscription struct {
	ID           uuid.UUID `gorm:"type:uuid;primaryKey" json:"id"`
	UserID       uuid.UUID `gorm:"type:uuid;not null;index" json:"user_id"`
	PlanID       uuid.UUID `gorm:"type:uuid;not null" json:"plan_id"`
	Status       string    `gorm:"type:varchar(20);default:'active';not null" json:"status"`
	TokenBalance int64     `gorm:"not null" json:"token_balance"`
	PeriodStart  time.Time `gorm:"not null" json:"period_start"`
	PeriodEnd    time.Time `gorm:"not null" json:"period_end"`
	CreatedAt    time.Time `gorm:"autoCreateTime" json:"created_at"`
	UpdatedAt    time.Time `gorm:"autoUpdateTime" json:"updated_at"`

	User *User `gorm:"foreignKey:UserID" json:"user,omitempty"`
	Plan *Plan `gorm:"foreignKey:PlanID" json:"plan,omitempty"`
}

func (s *Subscription) BeforeCreate(tx *gorm.DB) error {
	if s.ID == uuid.Nil {
		s.ID = uuid.New()
	}
	return nil
}
