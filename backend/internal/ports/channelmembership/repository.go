// Package channelmembership 定义普通 Channel 的显式成员变更边界。
package channelmembership

import (
	"context"
	"errors"
	"time"
)

var (
	ErrServerNotFound      = errors.New("Server 不存在")
	ErrChannelNotFound     = errors.New("Channel 不存在")
	ErrMemberNotFound      = errors.New("成员不存在")
	ErrPermissionDenied    = errors.New("没有管理 Channel 成员的权限")
	ErrImplicitMembership  = errors.New("系统 #全员使用隐式成员关系")
	ErrMembershipNotFound  = errors.New("Channel membership 不存在")
	ErrIdempotencyConflict = errors.New("幂等请求冲突")
)

type Command struct {
	AccountID       string
	ServerID        string
	ChannelID       string
	MemberID        string
	ChannelMemberID string
	OperationID     string
	IdempotencyKey  string
	RequestHash     [32]byte
	Action          string
	ChangedAt       time.Time
}

type Result struct {
	ChannelMemberID string
	OperationID     string
	CreatedAt       time.Time
}

type Repository interface {
	Change(context.Context, Command) (Result, error)
}
