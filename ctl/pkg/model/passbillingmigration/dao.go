package passbillingmigration

import (
	"fmt"

	"ctl/pkg/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type Dao interface {
	model.Dao
	GetByPassAndTarget(passID, targetBundleID string) (*Entity, error)
	Upsert(entity *Entity) error
	UpdateByPassAndTarget(passID, targetBundleID string, updates map[string]interface{}) error
	DeleteByPassAndTargetAndStatus(passID, targetBundleID, status string) error
}

type dao struct {
	*model.BaseDao
}

func NewDao() Dao {
	return &dao{BaseDao: model.NewBaseDao(TableName)}
}

func (d *dao) GetByPassAndTarget(passID, targetBundleID string) (*Entity, error) {
	var entity Entity
	err := d.DB().
		Where(ColumnPassID+" = ? AND "+ColumnTargetBundleID+" = ?", passID, targetBundleID).
		Take(&entity).Error
	if err != nil {
		return nil, err
	}
	return &entity, nil
}

func (d *dao) Upsert(entity *Entity) error {
	if entity == nil {
		return fmt.Errorf("passbillingmigration.Upsert: nil entity")
	}
	return d.DB().Clauses(clause.OnConflict{
		Columns: []clause.Column{
			{Name: ColumnPassID},
			{Name: ColumnTargetBundleID},
		},
		DoUpdates: clause.AssignmentColumns([]string{
			ColumnUserID,
			ColumnSourceBundleID,
			ColumnUin,
			ColumnAppID,
			ColumnStatus,
			ColumnDealName,
			ColumnBigOrderID,
			ColumnLastError,
		}),
	}).Create(entity).Error
}

func (d *dao) UpdateByPassAndTarget(passID, targetBundleID string, updates map[string]interface{}) error {
	result := d.DB().
		Where(ColumnPassID+" = ? AND "+ColumnTargetBundleID+" = ?", passID, targetBundleID).
		Updates(updates)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

func (d *dao) DeleteByPassAndTargetAndStatus(passID, targetBundleID, status string) error {
	result := d.DB().
		Where(ColumnPassID+" = ? AND "+ColumnTargetBundleID+" = ? AND "+ColumnStatus+" = ?", passID, targetBundleID, status).
		Delete(&Entity{})
	if result.Error != nil {
		return result.Error
	}
	return nil
}
