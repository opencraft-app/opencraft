package subscriptiongateway

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"ctl/pkg/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type Dao interface {
	model.Dao

	GetByUserID(userID string) (*Entity, error)
	Upsert(entity *Entity) error
	CountByGateway(gateway string) (int64, error)
}

type dao struct {
	*model.BaseDao
}

func NewDao() Dao {
	return &dao{
		BaseDao: model.NewBaseDao(TableName).SetKeyColumn(ColumnUserID),
	}
}

func (d *dao) GetByUserID(userID string) (*Entity, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return nil, fmt.Errorf("user_id is required")
	}
	var entity Entity
	if err := d.DB().Where(ColumnUserID+" = ?", userID).First(&entity).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, fmt.Errorf("get user subscription gateway: %w", err)
	}
	return &entity, nil
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

func (d *dao) CountByGateway(gateway string) (int64, error) {
	gateway = strings.TrimSpace(gateway)
	if gateway == "" {
		return 0, fmt.Errorf("gateway is required")
	}
	var count int64
	if err := d.DB().Where(ColumnGateway+" = ?", gateway).Count(&count).Error; err != nil {
		return 0, fmt.Errorf("count user subscription gateway by gateway: %w", err)
	}
	return count, nil
}
