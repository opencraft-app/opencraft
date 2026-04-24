// Package idgen ...
package idgen

import (
	"errors"
	"fmt"
	"strings"

	"ctl/pkg/model"
	"ctl/pkg/resource"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Dao ...
type Dao interface {
	model.Dao

	GenId(name string) (int64, error)
}

type dao struct {
	*model.BaseDao
}

// NewDao ...
func NewDao() Dao {
	return &dao{
		BaseDao: model.NewBaseDao("id_gen"),
	}
}

// GenId generates a new auto-increment ID by updating the max_id column.
func (d *dao) GenId(name string) (int64, error) {
	type idGenRow struct {
		Name  string `gorm:"column:name;primaryKey"`
		MaxID int64  `gorm:"column:max_id"`
	}

	for range 2 {
		var nextID int64
		err := resource.GormDB.Transaction(func(tx *gorm.DB) error {
			var row idGenRow
			err := tx.Table(d.TableName).
				Clauses(clause.Locking{Strength: "UPDATE"}).
				Where("name = ?", name).
				First(&row).Error
			if err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					row = idGenRow{Name: name, MaxID: 1}
					if createErr := tx.Table(d.TableName).Create(&row).Error; createErr != nil {
						if isRetryableCreateConflict(createErr) {
							return errRetryGenID
						}
						return fmt.Errorf("create id_gen row: %w", createErr)
					}
					nextID = row.MaxID
					return nil
				}
				return fmt.Errorf("select id_gen row: %w", err)
			}

			nextID = row.MaxID + 1
			if err := tx.Table(d.TableName).Where("name = ?", name).Update("max_id", nextID).Error; err != nil {
				return fmt.Errorf("update id_gen row: %w", err)
			}
			return nil
		})
		if err == nil {
			return nextID, nil
		}
		if errors.Is(err, errRetryGenID) {
			continue
		}
		return 0, err
	}

	return 0, fmt.Errorf("gen id retry exhausted for %s", name)
}

var errRetryGenID = errors.New("retry gen id")

func isRetryableCreateConflict(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "duplicate") ||
		strings.Contains(msg, "unique constraint") ||
		strings.Contains(msg, "unique failed") ||
		strings.Contains(msg, "deadlock") ||
		strings.Contains(msg, "error 1213")
}
