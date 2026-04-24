// Package task ...
package task

import (
	"ctl/pkg/model"
	"ctl/pkg/resource"

	"gorm.io/gorm"
)

// Dao ...
type Dao interface {
	model.Dao

	DeleteByParentTaskIds(taskIds ...string) error
}

type dao struct {
	*model.BaseDao
}

// NewDao ...
func NewDao() Dao {
	return &dao{
		BaseDao: model.NewBaseDao(TableName).SetKeyColumn(ColumnTaskId),
	}
}

// DeleteByParentTaskIds deletes tasks by parent_task_id.
func (d *dao) DeleteByParentTaskIds(taskIds ...string) error {
	return resource.GormDB.Table(d.TableName).
		Where("parent_task_id IN ?", taskIds).
		Delete(&gorm.DB{}).Error
}
