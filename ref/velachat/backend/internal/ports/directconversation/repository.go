// Package directconversation 定义 Server 内私信管理面与持久化之间的边界。
package directconversation

import (
	"context"
	"errors"
	"time"
)

var (
	ErrServerNotFound       = errors.New("Server 不存在")
	ErrMemberNotFound       = errors.New("Member 不存在")
	ErrMemberRemoved        = errors.New("Member 已移除")
	ErrIMIdentityNotReady   = errors.New("Member IM 身份未就绪")
	ErrConversationNotFound = errors.New("私信不存在")
	ErrConversationClosing  = errors.New("私信正在关闭")
	ErrRetryNotAllowed      = errors.New("当前私信状态不允许恢复")
	ErrIdempotencyConflict  = errors.New("幂等请求冲突")
)

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
	Revision    int64
}

type Participants struct {
	Self Member
	Peer Member
}

type Conversation struct {
	ID        string
	ServerID  string
	MemberA   Member
	MemberB   Member
	Status    string
	IMGroupID string
	IMState   string
	Revision  int64
	CreatedAt time.Time
	UpdatedAt time.Time
}

type Operation struct {
	ID            string
	ServerID      string
	Service       string
	Kind          string
	State         string
	CreatedAt     time.Time
	CompletedAt   *time.Time
	LastErrorCode *string
}

type CreateCommand struct {
	AccountID            string
	ServerID             string
	PeerMemberID         string
	MemberAID            string
	MemberBID            string
	DirectConversationID string
	IMGroupID            string
	OperationID          string
	IdempotencyKey       string
	RequestHash          [32]byte
	CreatedAt            time.Time
}

type CreateResult struct {
	Conversation Conversation
	Operations   []Operation
	Accepted     bool
}

type RetryCommand struct {
	AccountID            string
	ServerID             string
	DirectConversationID string
	OperationID          string
	IdempotencyKey       string
	RequestHash          [32]byte
	RequestedAt          time.Time
}

type PageRequest struct {
	AccountID      string
	ServerID       string
	Cursor         string
	Limit          int
	AfterUpdatedAt *time.Time
	AfterID        string
}

type Page struct {
	Items         []Conversation
	NextCursor    *string
	NextUpdatedAt *time.Time
	NextID        string
}

type Repository interface {
	ResolveParticipants(context.Context, string, string, string) (Participants, error)
	Create(context.Context, CreateCommand) (CreateResult, error)
	Retry(context.Context, RetryCommand) (CreateResult, error)
	List(context.Context, PageRequest) (Page, error)
	Get(context.Context, string, string, string) (Conversation, error)
}
