package instance

import (
	"errors"
	"fmt"
	"time"

	"ctl/pkg/config"
	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	"ctl/pkg/model"
	"ctl/pkg/resource"

	"gorm.io/gorm"
)

type Dao interface {
	model.Dao

	Create(ctx pctx.Context, entity *Entity) error
	GetByInstanceID(ctx pctx.Context, instanceID string) (*Entity, error)
	GetByID(ctx pctx.Context, id int64) (*Entity, error)
	ExistsBySandboxID(ctx pctx.Context, sandboxID string) (bool, error)
	ListByUserID(ctx pctx.Context, userID string, page, pageSize int) ([]Entity, int64, error)
	UpdateDisplayName(ctx pctx.Context, id int64, displayName string) error
	UpdateStatus(ctx pctx.Context, id int64, newStatus string) error
	TransitionStatus(ctx pctx.Context, id int64, fromStatuses []string, newStatus string) error
	UpdateWithStatusPrecondition(ctx pctx.Context, id int64, fromStatuses []string, updates map[string]interface{}) error
	UpdateSandboxAndStatus(ctx pctx.Context, id int64, sandboxID, newStatus string) error
	UpdateTimeoutAt(ctx pctx.Context, id int64, timeoutAt time.Time) error
	DeleteByID(ctx pctx.Context, id int64) error
}

type dao struct {
	*model.BaseDao
}

func NewDao() Dao {
	return &dao{
		BaseDao: model.NewBaseDao(TableName).SetKeyColumn(ColumnInstanceID),
	}
}

func (d *dao) Create(ctx pctx.Context, entity *Entity) error {
	if entity == nil {
		return errors.New("entity is nil")
	}
	if entity.InstanceId == "" {
		return errors.New("instanceID is required")
	}

	userID, err := userIDFromContext(ctx)
	if err != nil {
		return err
	}
	entity.UserId = userID

	return d.dbWithContext(ctx).Create(entity).Error
}

func (d *dao) GetByInstanceID(ctx pctx.Context, instanceID string) (*Entity, error) {
	return d.firstByUser(ctx, func(db *gorm.DB) *gorm.DB {
		return db.Where(ColumnInstanceID+" = ?", instanceID)
	})
}

func (d *dao) GetByID(ctx pctx.Context, id int64) (*Entity, error) {
	return d.firstByUser(ctx, func(db *gorm.DB) *gorm.DB {
		return db.Where(ColumnID+" = ?", id)
	})
}

func (d *dao) ExistsBySandboxID(ctx pctx.Context, sandboxID string) (bool, error) {
	if sandboxID == "" {
		return false, errors.New("sandboxID is required")
	}

	var count int64
	query := d.dbWithContext(ctx).Model(&Entity{}).Where(ColumnSandboxID+" = ?", sandboxID)
	if ctx != nil {
		userID, err := userIDFromContext(ctx)
		if err != nil {
			return false, err
		}
		query = query.Where(ColumnUserID+" = ?", userID)
	}
	if err := query.Count(&count).Error; err != nil {
		return false, fmt.Errorf("query instance by sandbox id: %w", err)
	}
	return count > 0, nil
}

func (d *dao) ListByUserID(ctx pctx.Context, userID string, page, pageSize int) ([]Entity, int64, error) {
	if userID == "" {
		return nil, 0, errors.New("userID is required")
	}
	if page <= 0 {
		page = 1
	}
	if pageSize <= 0 {
		pageSize = int(config.DefaultPageLimit)
	}
	if pageSize > int(config.MaxPageLimit) {
		pageSize = int(config.MaxPageLimit)
	}

	var total int64
	var entities []Entity
	err := d.dbWithContext(ctx).Session(&gorm.Session{}).Transaction(func(tx *gorm.DB) error {
		snapshotQuery := tx.Model(&Entity{}).Where(ColumnUserID+" = ?", userID)
		if err := snapshotQuery.Count(&total).Error; err != nil {
			return fmt.Errorf("count instances: %w", err)
		}
		if err := snapshotQuery.
			Order(ColumnCreatedAt + " DESC").
			Order(ColumnID + " DESC").
			Offset((page - 1) * pageSize).
			Limit(pageSize).
			Find(&entities).Error; err != nil {
			return fmt.Errorf("list instances: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, 0, err
	}

	return entities, total, nil
}

func (d *dao) UpdateStatus(ctx pctx.Context, id int64, newStatus string) error {
	return d.updateByUser(ctx, id, map[string]interface{}{
		ColumnStatus: newStatus,
	})
}

func (d *dao) UpdateDisplayName(ctx pctx.Context, id int64, displayName string) error {
	return d.updateByUser(ctx, id, map[string]interface{}{
		ColumnDisplayName: displayName,
	})
}

func (d *dao) TransitionStatus(ctx pctx.Context, id int64, fromStatuses []string, newStatus string) error {
	return d.UpdateWithStatusPrecondition(ctx, id, fromStatuses, map[string]interface{}{
		ColumnStatus: newStatus,
	})
}

func (d *dao) UpdateWithStatusPrecondition(ctx pctx.Context, id int64, fromStatuses []string, updates map[string]interface{}) error {
	userID, err := userIDFromContext(ctx)
	if err != nil {
		return err
	}
	if len(fromStatuses) == 0 {
		return errors.New("fromStatuses is required")
	}
	if len(updates) == 0 {
		return errors.New("updates is required")
	}

	result := d.dbWithContext(ctx).
		Model(&Entity{}).
		Where(ColumnID+" = ? AND "+ColumnUserID+" = ? AND "+ColumnStatus+" IN ?", id, userID, fromStatuses).
		Updates(updates)
	if result.Error != nil {
		return fmt.Errorf("update instance with status precondition: %w", result.Error)
	}
	if result.RowsAffected > 0 {
		return nil
	}

	var count int64
	if err := d.dbWithContext(ctx).
		Model(&Entity{}).
		Where(ColumnID+" = ? AND "+ColumnUserID+" = ?", id, userID).
		Count(&count).Error; err != nil {
		return fmt.Errorf("query instance during conditional update: %w", err)
	}
	if count == 0 {
		return errcode.ErrInstanceNotFound
	}
	return errcode.ErrInstanceStatusInvalid
}

func (d *dao) UpdateSandboxAndStatus(ctx pctx.Context, id int64, sandboxID, newStatus string) error {
	return d.updateByUser(ctx, id, map[string]interface{}{
		ColumnSandboxID: sandboxID,
		ColumnStatus:    newStatus,
	})
}

func (d *dao) UpdateTimeoutAt(ctx pctx.Context, id int64, timeoutAt time.Time) error {
	return d.updateByUser(ctx, id, map[string]interface{}{
		ColumnTimeoutAt: timeoutAt,
	})
}

func (d *dao) DeleteByID(ctx pctx.Context, id int64) error {
	userID, err := userIDFromContext(ctx)
	if err != nil {
		return err
	}

	result := d.dbWithContext(ctx).
		Where(ColumnID+" = ? AND "+ColumnUserID+" = ?", id, userID).
		Delete(&Entity{})
	if result.Error != nil {
		return fmt.Errorf("delete instance: %w", result.Error)
	}
	if result.RowsAffected == 0 {
		return errcode.ErrInstanceNotFound
	}

	return nil
}

func (d *dao) firstByUser(ctx pctx.Context, scope func(*gorm.DB) *gorm.DB) (*Entity, error) {
	userID, err := userIDFromContext(ctx)
	if err != nil {
		return nil, err
	}

	var entity Entity
	db := scope(d.dbWithContext(ctx).Where(ColumnUserID+" = ?", userID))
	if err := db.First(&entity).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, errcode.ErrInstanceNotFound
		}
		return nil, fmt.Errorf("query instance: %w", err)
	}

	return &entity, nil
}

func (d *dao) updateByUser(ctx pctx.Context, id int64, updates map[string]interface{}) error {
	userID, err := userIDFromContext(ctx)
	if err != nil {
		return err
	}

	result := d.dbWithContext(ctx).
		Model(&Entity{}).
		Where(ColumnID+" = ? AND "+ColumnUserID+" = ?", id, userID).
		Updates(updates)
	if result.Error != nil {
		return fmt.Errorf("update instance: %w", result.Error)
	}
	if result.RowsAffected == 0 {
		return errcode.ErrInstanceNotFound
	}

	return nil
}

func (d *dao) dbWithContext(ctx pctx.Context) *gorm.DB {
	if ctx == nil {
		return resource.GormDB.Table(TableName)
	}
	return resource.GormDB.WithContext(ctx).Table(TableName)
}

func userIDFromContext(ctx pctx.Context) (string, error) {
	if ctx == nil {
		return "", errors.New("context is required")
	}
	if ctx.GetUserID() == "" {
		return "", errors.New("context user is required")
	}
	return ctx.GetUserID(), nil
}
