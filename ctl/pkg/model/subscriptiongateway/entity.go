package subscriptiongateway

import (
	"time"

	"ctl/pkg/model"
)

const (
	TableName = "user_subscription_gateway"

	ColumnUserID         = "user_id"
	ColumnGateway        = "gateway"
	ColumnSubscriptionID = "subscription_id"
	ColumnPlanID         = "plan_id"
	ColumnSource         = "source"
	ColumnLastObservedAt = "last_observed_at"

	GatewayAIGateway = "ai_gateway"

	SourceApplySubscription = "apply_subscription"
)

type Entity struct {
	model.BaseEntity

	UserID         string    `gorm:"column:user_id;uniqueIndex:uk_user_subscription_gateway_user_id"`
	Gateway        string    `gorm:"column:gateway;index:idx_user_subscription_gateway_gateway"`
	SubscriptionID string    `gorm:"column:subscription_id"`
	PlanID         string    `gorm:"column:plan_id"`
	Source         string    `gorm:"column:source"`
	LastObservedAt time.Time `gorm:"column:last_observed_at"`
}

func (Entity) TableName() string {
	return TableName
}
