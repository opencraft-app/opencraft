package bundle

import (
	"fmt"

	"ctl/pkg/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Dao Bundle 数据访问接口
type Dao interface {
	model.Dao

	GetByBundleID(bundleID string) (*Entity, error)
	ListAll() ([]*Entity, error)
	ListByState(state string) ([]*Entity, error)
	// Upsert 不存在则创建，存在则覆盖性更新全部字段
	Upsert(entity *Entity) error
	// UpdateByBundleIDs 批量部分更新，返回实际影响行数
	UpdateByBundleIDs(bundleIDs []string, updates map[string]interface{}) (int64, error)

	// DecrementAvailCount 原子扣减可售卖余量（WHERE available_count >= cnt），返回是否扣减成功
	DecrementAvailCount(bundleID string, cnt int) (bool, error)
	// IncrementAvailCount 原子回滚可售卖余量（回滚用）
	IncrementAvailCount(bundleID string, cnt int) error
	// RefreshAllAvailCount 将所有 ONLINE 套餐的 available_count 刷新为 total_count
	RefreshAllAvailCount() (int64, error)
}

type dao struct {
	*model.BaseDao
}

// NewDao 创建 Bundle DAO
func NewDao() Dao {
	return &dao{
		BaseDao: model.NewBaseDao(TableName).SetKeyColumn(ColumnBundleID),
	}
}

func (d *dao) GetByBundleID(bundleID string) (*Entity, error) {
	var entity Entity
	if err := d.SelectByKeyColumn(bundleID, &entity); err != nil {
		return nil, err
	}
	return &entity, nil
}

func (d *dao) ListAll() ([]*Entity, error) {
	var entities []*Entity
	if err := d.DB().Find(&entities).Error; err != nil {
		return nil, fmt.Errorf("list all bundles: %w", err)
	}
	return entities, nil
}

func (d *dao) ListByState(state string) ([]*Entity, error) {
	var entities []*Entity
	if err := d.SimpleQueryAnd(&entities, model.WhereEqual(ColumnBundleState, state)); err != nil {
		return nil, err
	}
	return entities, nil
}

func (d *dao) Upsert(entity *Entity) error {
	return d.DB().Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: ColumnBundleID}},
		DoUpdates: clause.AssignmentColumns([]string{
			ColumnBundleName,
			ColumnDescription,
			ColumnAgentQuota,
			ColumnCredit,
			ColumnTimeSpan,
			ColumnTimeUnit,
			ColumnAiGatewayPlanID,
			ColumnStaticSoldOut,
			ColumnBundleSalesAvailCount,
			ColumnBundleSalesTotalCount,
		}),
	}).Create(entity).Error
}

func (d *dao) UpdateByBundleIDs(bundleIDs []string, updates map[string]interface{}) (int64, error) {
	result := d.DB().
		Model(&Entity{}).
		Where(ColumnBundleID+" IN ?", bundleIDs).
		Updates(updates)
	if result.Error != nil {
		return 0, fmt.Errorf("update bundles: %w", result.Error)
	}
	return result.RowsAffected, nil
}

// DecrementAvailCount 原子扣减可售卖余量，返回是否扣减成功
func (d *dao) DecrementAvailCount(bundleID string, cnt int) (bool, error) {
	result := d.DB().
		Model(&Entity{}).
		Where(ColumnBundleID+" = ? AND "+ColumnBundleSalesAvailCount+" >= ?", bundleID, cnt).
		Updates(map[string]interface{}{
			ColumnBundleSalesAvailCount: gorm.Expr(ColumnBundleSalesAvailCount+" - ?", cnt),
		})
	if result.Error != nil {
		return false, fmt.Errorf("decrement avail count: %w", result.Error)
	}
	return result.RowsAffected > 0, nil
}

// IncrementAvailCount 原子回滚可售卖余量
func (d *dao) IncrementAvailCount(bundleID string, cnt int) error {
	result := d.DB().
		Model(&Entity{}).
		Where(ColumnBundleID+" = ?", bundleID).
		Updates(map[string]interface{}{
			ColumnBundleSalesAvailCount: gorm.Expr(ColumnBundleSalesAvailCount+" + ?", cnt),
		})
	if result.Error != nil {
		return fmt.Errorf("increment avail count: %w", result.Error)
	}
	return nil
}

// RefreshAllAvailCount 将所有 ONLINE 套餐的 available_count 刷新为 total_count
func (d *dao) RefreshAllAvailCount() (int64, error) {
	result := d.DB().
		Model(&Entity{}).
		Where(ColumnBundleState+" = ?", StateOnline).
		Updates(map[string]interface{}{
			ColumnBundleSalesAvailCount: gorm.Expr(ColumnBundleSalesTotalCount),
		})
	if result.Error != nil {
		return 0, fmt.Errorf("refresh avail count: %w", result.Error)
	}
	return result.RowsAffected, nil
}
