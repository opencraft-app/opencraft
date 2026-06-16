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

	// ListByParentTaskID 按 parent_task_id 反查所有子 task（trade-pass-isolate Q22-I-E）
	//
	// 用途：父 task IsolatePass 重入时，通过反查 parent_task_id = <父 taskID> 的子 task 集合，
	// 判断每个 instance 是否已派发过 IsolateInstance 子 task（child_registry 防重复）；同时也用于
	// 等所有子 task 终态后推进父 task 走 isolating → isolated。
	//
	// 不带 user_id 维度：task 表全局唯一（parent_task_id 含 task 框架自生成的 19 字符 ID），
	// 不存在跨用户串联问题。
	ListByParentTaskID(parentTaskID string) ([]*Entity, error)
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

// ListByParentTaskID 详见 Dao 接口注释
func (d *dao) ListByParentTaskID(parentTaskID string) ([]*Entity, error) {
	var entities []*Entity
	if err := d.DB().
		Where(ColumnParentTaskId+" = ?", parentTaskID).
		Order(ColumnTaskId + " ASC").
		Find(&entities).Error; err != nil {
		return nil, err
	}
	return entities, nil
}
