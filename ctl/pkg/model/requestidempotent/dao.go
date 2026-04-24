// Package requestidempotent ...
package requestidempotent

import (
	"ctl/pkg/model"
)

// Dao ...
type Dao interface {
	model.Dao
}

type dao struct {
	*model.BaseDao
}

// NewDao ...
func NewDao() Dao {
	return &dao{
		BaseDao: model.NewBaseDao("request_idempotent"),
	}
}
