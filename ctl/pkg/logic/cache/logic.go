// Package cache ...
package cache

import (
	"ctl/pkg/context"
)

// Logic ...
type Logic interface {
	GetStruct(ctx context.Context, key string, dest interface{}) (bool, error)
	SetStruct(ctx context.Context, key string, value interface{}, expireSeconds int64) error
	Del(ctx context.Context, key string) error
}

// NewLogic ...
func NewLogic() Logic {
	return &logic{}
}

type logic struct{}

func (l *logic) GetStruct(ctx context.Context, key string, dest interface{}) (bool, error) {
	return false, nil
}

func (l *logic) SetStruct(ctx context.Context, key string, value interface{}, expireSeconds int64) error {
	return nil
}

func (l *logic) Del(ctx context.Context, key string) error {
	return nil
}
