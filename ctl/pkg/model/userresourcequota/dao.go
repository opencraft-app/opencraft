// Package userresourcequota ...
package userresourcequota

import (
	"errors"
	"fmt"
	"strings"

	"ctl/pkg/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type ResourceNameKeyPair struct {
	ResourceName string
	ResourceKey  string
}

// Dao ...
type Dao interface {
	model.Dao

	SelectQuota(userID, resourceName, resourceKey string) (*Entity, error)
	AllocQuota(userID, resourceName, resourceKey string, cnt int64) (bool, error)
	FreeQuota(userID, resourceName, resourceKey string, cnt int64) (bool, error)
	DeleteQuota(userID, resourceName, resourceKey string) error
	SelectQuotasByResourceNameKeyPairs(userID string, resourceNameKeyPairs []*ResourceNameKeyPair) ([]*Entity, error)
}

type dao struct {
	*model.BaseDao
}

// NewDao ...
func NewDao() Dao {
	return &dao{
		BaseDao: model.NewBaseDao(TableName),
	}
}

func (d *dao) SelectQuota(userID, resourceName, resourceKey string) (*Entity, error) {
	var entity Entity
	err := d.DB().
		Where(ColumnUserID+" = ? AND "+ColumnResourceName+" = ? AND "+ColumnResourceKey+" = ?", userID, resourceName, resourceKey).
		First(&entity).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, fmt.Errorf("select quota: %w", err)
	}

	return &entity, nil
}

func (d *dao) AllocQuota(userID, resourceName, resourceKey string, cnt int64) (bool, error) {
	if cnt <= 0 {
		return false, errors.New("cnt must be positive")
	}
	result := d.DB().
		Where(ColumnUserID+" = ? AND "+ColumnResourceName+" = ? AND "+ColumnResourceKey+" = ? AND "+ColumnResourceQuotaAvailable+" >= ?",
			userID, resourceName, resourceKey, cnt).
		Updates(map[string]interface{}{
			ColumnResourceQuotaAvailable: gorm.Expr(ColumnResourceQuotaAvailable+" - ?", cnt),
		})
	if result.Error != nil {
		return false, fmt.Errorf("alloc quota: %w", result.Error)
	}

	return result.RowsAffected > 0, nil
}

func (d *dao) FreeQuota(userID, resourceName, resourceKey string, cnt int64) (bool, error) {
	if cnt <= 0 {
		return false, errors.New("cnt must be positive")
	}
	result := d.DB().
		Where(ColumnUserID+" = ? AND "+ColumnResourceName+" = ? AND "+ColumnResourceKey+" = ? AND ("+
			ColumnResourceQuotaAvailable+" + ?) <= "+ColumnResourceQuotaTotal,
			userID, resourceName, resourceKey, cnt).
		Updates(map[string]interface{}{
			ColumnResourceQuotaAvailable: gorm.Expr(ColumnResourceQuotaAvailable+" + ?", cnt),
		})
	if result.Error != nil {
		return false, fmt.Errorf("free quota: %w", result.Error)
	}

	return result.RowsAffected > 0, nil
}

func (d *dao) DeleteQuota(userID, resourceName, resourceKey string) error {
	return d.DB().
		Where(ColumnUserID+" = ? AND "+ColumnResourceName+" = ? AND "+ColumnResourceKey+" = ?", userID, resourceName, resourceKey).
		Delete(&Entity{}).Error
}

func (d *dao) SelectQuotasByResourceNameKeyPairs(userID string, resourceNameKeyPairs []*ResourceNameKeyPair) ([]*Entity, error) {
	if len(resourceNameKeyPairs) == 0 {
		return nil, errors.New("resourceNameKeyPairs is empty")
	}

	args := make([]interface{}, 0, 1+len(resourceNameKeyPairs)*2)
	args = append(args, userID)

	parts := make([]string, 0, len(resourceNameKeyPairs))
	for _, pair := range resourceNameKeyPairs {
		if pair == nil {
			continue
		}
		parts = append(parts, "(?, ?)")
		args = append(args, pair.ResourceName, pair.ResourceKey)
	}
	if len(parts) == 0 {
		return nil, errors.New("resourceNameKeyPairs is empty")
	}

	query := fmt.Sprintf("%s = ? AND (%s, %s) IN (%s)",
		ColumnUserID,
		ColumnResourceName,
		ColumnResourceKey,
		strings.Join(parts, ", "),
	)

	var entities []*Entity
	err := d.DB().
		Clauses(clause.OrderBy{
			Columns: []clause.OrderByColumn{
				{Column: clause.Column{Name: ColumnResourceName}},
				{Column: clause.Column{Name: ColumnResourceKey}},
			},
		}).
		Where(query, args...).
		Find(&entities).Error
	if err != nil {
		return nil, fmt.Errorf("select quotas by pairs: %w", err)
	}

	return entities, nil
}
