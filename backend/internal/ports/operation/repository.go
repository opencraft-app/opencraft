// Package operation 定义腾讯云异步操作查询边界。
package operation

import (
	"context"
	"errors"
	"time"
)

var (
	ErrServerNotFound    = errors.New("Server 不存在")
	ErrOperationNotFound = errors.New("Operation 不存在")
)

type Operation struct {
	ID            string
	ServerID      string
	Service       string
	Kind          string
	State         string
	CreatedAt     time.Time
	CompletedAt   *time.Time
	LastErrorCode string
}

type Repository interface {
	Get(context.Context, string, string, string) (Operation, error)
}
