// Package serverinvite 定义 Server 邀请的应用端口。
package serverinvite

import (
	"context"
	"errors"
	"time"
)

var (
	ErrPermissionDenied = errors.New("没有管理邀请的权限")
	ErrInviteNotFound   = errors.New("邀请不存在")
	ErrInviteInvalid    = errors.New("邀请无效或已失效")
	ErrAlreadyMember    = errors.New("已经是 Server 成员")
	ErrAccountNotReady  = errors.New("账号 IM 身份尚未就绪")
	ErrIdempotency      = errors.New("幂等请求冲突")
	ErrLandingNotFound  = errors.New("邀请落地 Channel 不存在")
)

// Invite 是不包含原始 token 的邀请事实。
type Invite struct {
	ID               string
	ServerID         string
	Role             string
	MaxUses          int64
	UsedCount        int64
	LandingChannelID *string
	ExpiresAt        time.Time
	Revision         uint64
}

// CreateCommand 只向持久层传递 token hash。
type CreateCommand struct {
	AccountID        string
	ServerID         string
	InviteID         string
	TokenHash        [32]byte
	Role             string
	MaxUses          int64
	LandingChannelID *string
	ExpiresAt        time.Time
	CreatedAt        time.Time
}

// RevokeCommand 撤销仍有效的邀请。
type RevokeCommand struct {
	AccountID string
	ServerID  string
	InviteID  string
	RevokedAt time.Time
}

// AcceptCommand 原子消费邀请并建立 Human membership。
type AcceptCommand struct {
	AccountID           string
	ServerID            string
	MemberID            string
	OperationID         string
	IdempotencyKey      string
	RequestHash         [32]byte
	TokenHash           [32]byte
	Handle              string
	AllowExistingMember bool
	AcceptedAt          time.Time
}

// AcceptResult 是接受邀请或幂等重放后的稳定资源定位。
type AcceptResult struct {
	MemberID         string
	ServerID         string
	ServerSlug       string
	LandingChannelID string
	OperationID      string
	CreatedAt        time.Time
}

// Repository 保存邀请事实并执行服务端权限检查。
type Repository interface {
	Create(context.Context, CreateCommand) (Invite, error)
	List(context.Context, string, string) ([]Invite, error)
	Revoke(context.Context, RevokeCommand) error
	Accept(context.Context, AcceptCommand) (AcceptResult, error)
}
