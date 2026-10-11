// Package servermember 定义 Server、Owner Member 与查询的应用层边界。
package servermember

import (
	"context"
	"errors"
	"time"
)

var (
	ErrAccountNotFound     = errors.New("账号不存在")
	ErrAccountIMNotReady   = errors.New("账号 IM 身份未就绪")
	ErrServerSlugConflict  = errors.New("Server slug 已被使用")
	ErrIdempotencyConflict = errors.New("幂等键与原请求不一致")
	ErrServerNotFound      = errors.New("Server 不存在")
	ErrRevisionConflict    = errors.New("Server revision 冲突")
	ErrMemberNotFound      = errors.New("成员不存在")
	ErrPermissionDenied    = errors.New("没有读取该 Channel 成员的权限")
)

// ServerDraft 是创建事务中的 Server 初始事实。
type ServerDraft struct {
	ID            string
	Slug          string
	Name          string
	Description   *string
	IMGroupID     string
	OwnerMemberID string
}

// OwnerDraft 是创建者在 Server 内的初始成员事实。
type OwnerDraft struct {
	ID     string
	Handle string
}

// CreateCommand 包含一次 Server 创建事务所需的全部稳定 ID。
type CreateCommand struct {
	AccountID            string
	IdempotencyKey       string
	RequestHash          [32]byte
	CreatedAt            time.Time
	Server               ServerDraft
	Owner                OwnerDraft
	RootChannelID        string
	RootChannelTopicID   string
	OperationID          string
	RootTopicOperationID string
}

// CreateResult 是创建或幂等命中的稳定资源定位。
type CreateResult struct {
	Created     bool
	ServerID    string
	OperationID string
}

// UpdateCommand 保存一次带乐观并发和幂等保护的 Server 元数据修改。
type UpdateCommand struct {
	AccountID      string
	ServerID       string
	Revision       int64
	IdempotencyKey string
	RequestHash    [32]byte
	NameSet        bool
	Name           string
	DescriptionSet bool
	Description    *string
	UpdatedAt      time.Time
}

// Server 是应用层可见的 Server 事实。
type Server struct {
	ID            string
	Slug          string
	Name          string
	Description   *string
	OwnerMemberID string
	IMState       string
	Revision      uint64
}

// Member 是应用层可见的 Server 成员事实。
type Member struct {
	ID          string
	ServerID    string
	AccountID   *string
	Kind        string
	Role        string
	DisplayName string
	Handle      string
	Status      string
	IMUserID    string
	IMState     string
	Revision    uint64
	CreatedAt   time.Time
}

// ListOptions 使用稳定逻辑 ID 作为 v1 SQLite cursor。
type ListOptions struct {
	Limit          int
	Cursor         string
	AfterID        string
	AfterCreatedAt *time.Time
}

// ServerPage 是当前账号的 Server 分页结果。
type ServerPage struct {
	Items      []Server
	NextCursor string
}

// MemberPage 是 Server 成员的稳定分页结果。
type MemberPage struct {
	Items         []Member
	NextCursor    string
	NextCreatedAt *time.Time
	NextID        string
}

// Repository 保存 Server 创建事务并提供授权后的查询。
type Repository interface {
	Create(context.Context, CreateCommand) (CreateResult, error)
	Update(context.Context, UpdateCommand) (Server, error)
	ListServers(context.Context, string, ListOptions) (ServerPage, error)
	GetServer(context.Context, string, string) (Server, error)
	ListMembers(context.Context, string, string, ListOptions) (MemberPage, error)
	ListChannelMembers(
		context.Context,
		string,
		string,
		string,
		ListOptions,
	) ([]Member, error)
	GetMember(context.Context, string, string, string) (Member, error)
}
