// Package model ...
package model

import (
	"time"
)

const (
	ColumnId          = "id"
	ColumnCreatedTime = "created_time"
	ColumnUpdatedTime = "updated_time"
	ColumnUserID      = "user_id"
)

// BaseEntity contains the common fields for all entities.
type BaseEntity struct {
	Id          *int64     `gorm:"column:id;primaryKey;autoIncrement"`
	CreatedTime *time.Time `gorm:"column:created_time;autoCreateTime"`
	UpdatedTime *time.Time `gorm:"column:updated_time;autoUpdateTime"`
}

// Nil checks if the entity has a valid (positive) ID.
func (e *BaseEntity) Nil() bool {
	if e.Id == nil || *e.Id <= 0 {
		return true
	}
	return false
}

// BaseUserEntity contains multi-tenant user fields.
type BaseUserEntity struct {
	UserID string `gorm:"column:user_id"`
}
