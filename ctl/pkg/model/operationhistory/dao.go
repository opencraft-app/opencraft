package operationhistory

import (
	"errors"
	"fmt"

	pctx "ctl/pkg/context"
	"ctl/pkg/resource"

	"gorm.io/gorm"
)

// Dao defines the data access interface for operation history.
type Dao interface {
	Create(ctx pctx.Context, entity *Entity) error
	ListByInstanceID(ctx pctx.Context, instanceID, userID string, page, pageSize int) ([]Entity, int64, error)
	UpdateStatus(ctx pctx.Context, operationID, status, errorMessage string) error
}

type dao struct{}

// NewDao creates a new operation history DAO.
func NewDao() Dao {
	return &dao{}
}

func (d *dao) Create(ctx pctx.Context, entity *Entity) error {
	if entity == nil {
		return errors.New("entity is nil")
	}
	return d.dbWithContext(ctx).Create(entity).Error
}

func (d *dao) ListByInstanceID(ctx pctx.Context, instanceID, userID string, page, pageSize int) ([]Entity, int64, error) {
	if instanceID == "" {
		return nil, 0, errors.New("instanceID is required")
	}
	if userID == "" {
		return nil, 0, errors.New("userID is required")
	}
	if page <= 0 {
		page = 1
	}
	if pageSize <= 0 {
		pageSize = 20
	}

	var total int64
	var entities []Entity

	err := d.dbWithContext(ctx).Session(&gorm.Session{}).Transaction(func(tx *gorm.DB) error {
		query := tx.Table(TableName).
			Where(ColumnInstanceID+" = ? AND "+ColumnUserID+" = ?", instanceID, userID)
		if err := query.Count(&total).Error; err != nil {
			return fmt.Errorf("count operation histories: %w", err)
		}
		if err := query.Order(ColumnCreatedAt + " DESC").
			Offset((page - 1) * pageSize).
			Limit(pageSize).
			Find(&entities).Error; err != nil {
			return fmt.Errorf("list operation histories: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, 0, err
	}
	return entities, total, nil
}

func (d *dao) UpdateStatus(ctx pctx.Context, operationID, status, errorMessage string) error {
	if operationID == "" {
		return errors.New("operationID is required")
	}

	updates := map[string]interface{}{
		ColumnStatus: status,
	}
	if errorMessage != "" {
		updates[ColumnErrorMessage] = errorMessage
	}

	result := d.dbWithContext(ctx).
		Model(&Entity{}).
		Where(ColumnOperationID+" = ?", operationID).
		Updates(updates)
	if result.Error != nil {
		return fmt.Errorf("update operation history status: %w", result.Error)
	}
	if result.RowsAffected == 0 {
		return fmt.Errorf("operation history not found: %s", operationID)
	}
	return nil
}

func (d *dao) dbWithContext(ctx pctx.Context) *gorm.DB {
	if ctx == nil {
		return resource.GormDB.Table(TableName)
	}
	return resource.GormDB.WithContext(ctx).Table(TableName)
}
