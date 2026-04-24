package pass

import (
	"fmt"

	"ctl/pkg/model"

	quota "ctl/pkg/model/userresourcequota"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Dao Pass 数据访问接口
type Dao interface {
	model.Dao

	GetByPassID(passID string) (*Entity, error)
	ListByUserID(userID string) ([]*Entity, error)
	ListByBundleID(bundleID string) ([]*Entity, error)
	ListByAppID(appID int64) ([]*Entity, error)
	ListByFilters(userID *string, bundleID *string) ([]*Entity, error)
	Create(entity *Entity) error
	UpdateByPassID(passID string, updates map[string]interface{}) error

	// CreatePassWithQuota 在同一事务中插入 pass 记录并替换更新配额
	// agentQuota 为 Bundle 的 agent_quota 值（最大配额上限，替换语义）
	CreatePassWithQuota(entity *Entity, userID string, agentQuota int64) error
}

type dao struct {
	*model.BaseDao
}

// NewDao 创建 Pass DAO
func NewDao() Dao {
	return &dao{
		BaseDao: model.NewBaseDao(TableName).SetKeyColumn(ColumnPassID),
	}
}

func (d *dao) GetByPassID(passID string) (*Entity, error) {
	var entity Entity
	if err := d.SelectByKeyColumn(passID, &entity); err != nil {
		return nil, err
	}
	return &entity, nil
}

func (d *dao) ListByUserID(userID string) ([]*Entity, error) {
	var entities []*Entity
	if err := d.SimpleQueryAnd(&entities, model.WhereEqual(ColumnUserID, userID)); err != nil {
		return nil, err
	}
	return entities, nil
}

func (d *dao) ListByBundleID(bundleID string) ([]*Entity, error) {
	var entities []*Entity
	if err := d.SimpleQueryAnd(&entities, model.WhereEqual(ColumnBundleID, bundleID)); err != nil {
		return nil, err
	}
	return entities, nil
}

func (d *dao) ListByAppID(appID int64) ([]*Entity, error) {
	var entities []*Entity
	if err := d.SimpleQueryAnd(&entities, model.WhereEqual(ColumnAppID, appID)); err != nil {
		return nil, err
	}
	return entities, nil
}

func (d *dao) ListByFilters(userID *string, bundleID *string) ([]*Entity, error) {
	var entities []*Entity
	var scopes []func(*gorm.DB) *gorm.DB
	if userID != nil {
		scopes = append(scopes, model.WhereEqual(ColumnUserID, *userID))
	}
	if bundleID != nil {
		scopes = append(scopes, model.WhereEqual(ColumnBundleID, *bundleID))
	}
	if err := d.SimpleQueryAnd(&entities, scopes...); err != nil {
		return nil, err
	}
	return entities, nil
}

func (d *dao) Create(entity *Entity) error {
	return d.Insert(entity)
}

func (d *dao) UpdateByPassID(passID string, updates map[string]interface{}) error {
	return d.UpdateByKeyColumn(updates, passID)
}

// CreatePassWithQuota 在同一事务中：
// 1. 插入 pass 记录
// 2. 更新 user_resource_quota（替换语义 + 并发安全）：
//   - 先 INSERT IGNORE 确保配额记录存在（首次购买时创建）
//   - 再 UPDATE 带 WHERE available + (agentQuota - total) >= 0 条件
//     total = agentQuota, available = available + (agentQuota - total)
//   - WHERE 条件保证并发场景下 available 不会变为负数
func (d *dao) CreatePassWithQuota(entity *Entity, userID string, agentQuota int64) error {
	return d.Transaction(func(tx *gorm.DB) error {
		// 1. 插入 pass
		if err := tx.Create(entity).Error; err != nil {
			return fmt.Errorf("insert pass: %w", err)
		}

		// 2a. 确保配额记录存在（INSERT IGNORE）
		if err := tx.Clauses(clause.OnConflict{
			Columns: []clause.Column{
				{Name: quota.ColumnUserID},
				{Name: quota.ColumnResourceName},
				{Name: quota.ColumnResourceKey},
			},
			DoNothing: true,
		}).Create(&quota.Entity{
			UserID:                 userID,
			ResourceName:           "OPENCLAW_INSTANCE",
			ResourceKey:            "",
			ResourceQuotaAvailable: 0,
			ResourceQuotaTotal:     0,
		}).Error; err != nil {
			return fmt.Errorf("ensure quota record: %w", err)
		}

		// 2b. 原子更新配额（带 WHERE 条件保证 available >= 0）
		result := tx.Model(&quota.Entity{}).
			Where(
				quota.ColumnUserID+" = ? AND "+quota.ColumnResourceName+" = ? AND "+quota.ColumnResourceKey+" = ? AND "+
					quota.ColumnResourceQuotaAvailable+" + (? - "+quota.ColumnResourceQuotaTotal+") >= 0",
				userID, "OPENCLAW_INSTANCE", "", agentQuota,
			).
			Updates(map[string]interface{}{
				quota.ColumnResourceQuotaAvailable: gorm.Expr(
					quota.ColumnResourceQuotaAvailable+" + (? - "+quota.ColumnResourceQuotaTotal+")",
					agentQuota,
				),
				quota.ColumnResourceQuotaTotal: agentQuota,
			})
		if result.Error != nil {
			return fmt.Errorf("update quota: %w", result.Error)
		}
		if result.RowsAffected == 0 {
			return fmt.Errorf("quota update rejected: consumed exceeds new agent_quota")
		}

		return nil
	})
}
