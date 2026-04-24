package instancebirthprofile

import (
	"errors"
	"fmt"
	"time"

	pctx "ctl/pkg/context"
	"ctl/pkg/model"
	modelinstance "ctl/pkg/model/instance"
	"ctl/pkg/resource"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type Dao interface {
	model.Dao

	GetByInstanceID(ctx pctx.Context, instanceID string) (*Entity, error)
	ListByInstanceIDs(ctx pctx.Context, instanceIDs []string) ([]Entity, error)
	Upsert(ctx pctx.Context, entity *Entity) error
	RebuildForChinaDate(ctx pctx.Context, bornDate string) error
}

type dao struct {
	*model.BaseDao
}

func NewDao() Dao {
	return &dao{
		BaseDao: model.NewBaseDao(TableName).SetKeyColumn(ColumnInstanceID),
	}
}

func (d *dao) GetByInstanceID(ctx pctx.Context, instanceID string) (*Entity, error) {
	var entity Entity
	if err := d.dbWithContext(ctx).Where(ColumnInstanceID+" = ?", instanceID).First(&entity).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, err
		}
		return nil, fmt.Errorf("query birth profile: %w", err)
	}
	return &entity, nil
}

func (d *dao) ListByInstanceIDs(ctx pctx.Context, instanceIDs []string) ([]Entity, error) {
	if len(instanceIDs) == 0 {
		return nil, nil
	}
	var entities []Entity
	if err := d.dbWithContext(ctx).
		Where(ColumnInstanceID+" IN ?", instanceIDs).
		Find(&entities).Error; err != nil {
		return nil, fmt.Errorf("list birth profiles: %w", err)
	}
	return entities, nil
}

func (d *dao) Upsert(ctx pctx.Context, entity *Entity) error {
	if entity == nil {
		return errors.New("entity is nil")
	}
	return d.dbWithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: ColumnInstanceID}},
		DoUpdates: clause.AssignmentColumns([]string{ColumnUserID, ColumnSandboxID, ColumnCreatedAtUTC, ColumnBornDateForChina, ColumnBornNumberForChina, ColumnUpdatedAt}),
	}).Create(entity).Error
}

func (d *dao) RebuildForChinaDate(ctx pctx.Context, bornDate string) error {
	if bornDate == "" {
		return errors.New("bornDate is required")
	}

	type row struct {
		ID         int64
		InstanceID string
		UserID     string
		SandboxID  string
		CreatedAt  time.Time
	}
	var rows []row
	err := d.dbWithContext(ctx).
		Table(modelinstance.TableName).
		Select(modelinstance.ColumnID+", "+modelinstance.ColumnInstanceID+", "+modelinstance.ColumnUserID+", "+modelinstance.ColumnSandboxID+", "+modelinstance.ColumnCreatedAt).
		Where("DATE(CONVERT_TZ("+modelinstance.ColumnCreatedAt+", '+00:00', '+08:00')) = ?", bornDate).
		Order(modelinstance.ColumnCreatedAt + " ASC").
		Order(modelinstance.ColumnID + " ASC").
		Find(&rows).Error
	if err != nil {
		return fmt.Errorf("list instances for birth date %s: %w", bornDate, err)
	}

	return resource.GormDB.Transaction(func(tx *gorm.DB) error {
		for idx, row := range rows {
			entity := &Entity{
				InstanceID:         row.InstanceID,
				UserID:             row.UserID,
				SandboxID:          row.SandboxID,
				CreatedAtUTC:       row.CreatedAt.UTC(),
				BornDateForChina:   bornDate,
				BornNumberForChina: idx + 1,
				UpdatedAt:          time.Now().UTC(),
			}
			if err := tx.Table(TableName).Clauses(clause.OnConflict{
				Columns:   []clause.Column{{Name: ColumnInstanceID}},
				DoUpdates: clause.AssignmentColumns([]string{ColumnUserID, ColumnSandboxID, ColumnCreatedAtUTC, ColumnBornDateForChina, ColumnBornNumberForChina, ColumnUpdatedAt}),
			}).Create(entity).Error; err != nil {
				return fmt.Errorf("upsert birth profile for %s: %w", row.InstanceID, err)
			}
		}
		return nil
	})
}

func (d *dao) dbWithContext(ctx pctx.Context) *gorm.DB {
	if ctx == nil {
		return resource.GormDB.Table(TableName)
	}
	return resource.GormDB.WithContext(ctx).Table(TableName)
}
