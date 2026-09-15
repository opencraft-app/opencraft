// Package membermutation 定义 Server Member 变更事务边界。
package membermutation

import (
	"context"
	"errors"
	"time"
)

var (
	ErrMemberNotFound      = errors.New("成员不存在")
	ErrPermissionDenied    = errors.New("没有管理成员的权限")
	ErrOwnerImmutable      = errors.New("Owner 不能通过成员接口变更")
	ErrRevisionConflict    = errors.New("成员版本冲突")
	ErrIdempotencyConflict = errors.New("幂等请求冲突")
)

type UpdateCommand struct {
	AccountID        string
	ServerID         string
	MemberID         string
	ExpectedRevision int64
	IdempotencyKey   string
	RequestHash      [32]byte
	DisplayName      *string
	Role             *string
	UpdatedAt        time.Time
}

type UpdateResult struct {
	MemberID string
}

type RemoveCommand struct {
	AccountID      string
	ServerID       string
	MemberID       string
	OperationID    string
	IdempotencyKey string
	RequestHash    [32]byte
	RemovedAt      time.Time
}

type RemoveResult struct {
	MemberID    string
	OperationID string
	CreatedAt   time.Time
}

type Repository interface {
	Update(context.Context, UpdateCommand) (UpdateResult, error)
	Remove(context.Context, RemoveCommand) (RemoveResult, error)
}
