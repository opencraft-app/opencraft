package channelloginsession

import (
	"errors"
	"fmt"
	"strings"

	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	"ctl/pkg/model"
	"ctl/pkg/resource"

	"gorm.io/gorm"
)

type Dao interface {
	model.Dao

	Create(ctx pctx.Context, entity *Entity) error
	GetBySessionID(ctx pctx.Context, instanceID, sessionID string) (*Entity, error)
	GetActiveByInstance(ctx pctx.Context, instanceID, channel string) (*Entity, error)
	UpdateFields(ctx pctx.Context, instanceID, sessionID string, updates map[string]interface{}) error
}

type dao struct {
	*model.BaseDao
}

func NewDao() Dao {
	return &dao{
		BaseDao: model.NewBaseDao(TableName).SetKeyColumn(ColumnSessionID),
	}
}

func (d *dao) Create(ctx pctx.Context, entity *Entity) error {
	if entity == nil {
		return errors.New("entity is nil")
	}
	if entity.SessionID == "" || entity.InstanceID == "" {
		return errors.New("sessionID and instanceID are required")
	}
	userID, err := userIDFromContext(ctx)
	if err != nil {
		return err
	}
	entity.UserID = userID
	if err := d.dbWithContext(ctx).Create(entity).Error; err != nil {
		if isDuplicateKeyError(err) {
			return errcode.Wrap(errcode.ErrChannelLoginConflict, "active session already exists")
		}
		return err
	}
	return nil
}

func (d *dao) GetBySessionID(ctx pctx.Context, instanceID, sessionID string) (*Entity, error) {
	userID, err := userIDFromContext(ctx)
	if err != nil {
		return nil, err
	}
	var entity Entity
	err = d.dbWithContext(ctx).
		Where(ColumnUserID+" = ? AND "+ColumnInstanceID+" = ? AND "+ColumnSessionID+" = ?", userID, instanceID, sessionID).
		First(&entity).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, errcode.ErrInstanceNotFound
		}
		return nil, fmt.Errorf("query channel login session: %w", err)
	}
	return &entity, nil
}

func (d *dao) GetActiveByInstance(ctx pctx.Context, instanceID, channel string) (*Entity, error) {
	userID, err := userIDFromContext(ctx)
	if err != nil {
		return nil, err
	}
	var entity Entity
	err = d.dbWithContext(ctx).
		Where(ColumnUserID+" = ? AND "+ColumnInstanceID+" = ? AND "+ColumnChannel+" = ? AND "+ColumnStatus+" IN ?", userID, instanceID, channel, ActiveStatuses).
		Order(ColumnCreatedAt + " DESC").
		First(&entity).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, fmt.Errorf("query active channel login session: %w", err)
	}
	return &entity, nil
}

func (d *dao) UpdateFields(ctx pctx.Context, instanceID, sessionID string, updates map[string]interface{}) error {
	if len(updates) == 0 {
		return nil
	}
	userID, err := userIDFromContext(ctx)
	if err != nil {
		return err
	}
	result := d.dbWithContext(ctx).
		Model(&Entity{}).
		Where(ColumnUserID+" = ? AND "+ColumnInstanceID+" = ? AND "+ColumnSessionID+" = ?", userID, instanceID, sessionID).
		Updates(updates)
	if result.Error != nil {
		return fmt.Errorf("update channel login session: %w", result.Error)
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
	if ctx == nil || ctx.GetUserID() == "" {
		return "", errcode.ErrInstanceMissingUserID
	}
	return ctx.GetUserID(), nil
}

func isDuplicateKeyError(err error) bool {
	if err == nil {
		return false
	}
	message := err.Error()
	return strings.Contains(message, "Duplicate entry") || strings.Contains(message, "1062")
}
