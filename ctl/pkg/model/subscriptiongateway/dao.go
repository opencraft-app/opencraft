package subscriptiongateway

import (
	"fmt"
	"strings"
	"time"

	"ctl/pkg/model"

	"gorm.io/gorm/clause"
)

type Dao interface {
	model.Dao

	Upsert(entity *Entity) error
}

type dao struct {
	*model.BaseDao
}

func NewDao() Dao {
	return &dao{
		BaseDao: model.NewBaseDao(TableName).SetKeyColumn(ColumnUserID),
	}
}

func (d *dao) Upsert(entity *Entity) error {
	if entity == nil {
		return fmt.Errorf("entity is nil")
	}
	entity.UserID = strings.TrimSpace(entity.UserID)
	entity.Gateway = strings.TrimSpace(entity.Gateway)
	entity.SubscriptionID = strings.TrimSpace(entity.SubscriptionID)
	entity.PlanID = strings.TrimSpace(entity.PlanID)
	entity.Source = strings.TrimSpace(entity.Source)
	if entity.UserID == "" {
		return fmt.Errorf("user_id is required")
	}
	if entity.Gateway == "" {
		return fmt.Errorf("gateway is required")
	}
	if entity.LastObservedAt.IsZero() {
		entity.LastObservedAt = time.Now().UTC()
	}
	return d.DB().Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: ColumnUserID}},
		DoUpdates: clause.AssignmentColumns([]string{
			ColumnGateway,
			ColumnSubscriptionID,
			ColumnPlanID,
			ColumnSource,
			ColumnLastObservedAt,
		}),
	}).Create(entity).Error
}
