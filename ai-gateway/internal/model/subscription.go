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
	// LastRefreshedAt 记录订阅 token_balance 上一次被月度刷新覆盖到 plan.MonthlyTokens
	// 的时刻；scheduler 用此字段按 b3 同号日规则计算下次刷新时刻。
	// NULL 表示尚未被刷新过（新创建的订阅在 Subscribe 中写入 PeriodStart）。
	// 详见 .tmp/aigateway-monthly-token-refresh-design.md §3.1 / §3.2。
	LastRefreshedAt *time.Time `gorm:"index" json:"last_refreshed_at,omitempty"`
	CreatedAt       time.Time  `gorm:"autoCreateTime" json:"created_at"`
	UpdatedAt       time.Time  `gorm:"autoUpdateTime" json:"updated_at"`

	User *User `gorm:"foreignKey:UserID" json:"user,omitempty"`
	Plan *Plan `gorm:"foreignKey:PlanID" json:"plan,omitempty"`
}

func (s *Subscription) BeforeCreate(tx *gorm.DB) error {
	if s.ID == uuid.Nil {
		s.ID = uuid.New()
	}
	return nil
}
