// Package channel 定义 Channel 管理面与持久化之间的最小边界。
package channel

import (
	"context"
	"errors"
	"time"
)

var (
	ErrServerNotFound      = errors.New("Server 不存在")
	ErrServerNotReady      = errors.New("Server IM 尚未就绪")
	ErrPermissionDenied    = errors.New("没有管理 Channel 的权限")
	ErrChannelNotFound     = errors.New("Channel 不存在")
	ErrChannelNameConflict = errors.New("Channel 名称冲突")
	ErrRevisionConflict    = errors.New("Channel revision 冲突")
	ErrIdempotencyConflict = errors.New("幂等请求冲突")
)

// ServerContext 是创建 Topic 前必须冻结的 Server 路由和权限事实。
type ServerContext struct {
	IMGroupID string
	IMState   string
	Role      string
}

// Channel 是平台保存的腾讯 Community Topic 映射。
type Channel struct {
	ID          string
	ServerID    string
	Name        string
	Description *string
	Visibility  string
	Joined      bool
	SystemKey   *string
	IMGroupID   string
	IMTopicID   *string
	IMState     string
	Revision    int64
}

// Operation 是创建 Topic 的脱敏异步操作。
type Operation struct {
	ID        string
	ServerID  string
	Service   string
	Kind      string
	State     string
	CreatedAt time.Time
}

// Draft 是创建事务中的普通 Channel。
type Draft struct {
	ID          string
	Name        string
	Description *string
	Visibility  string
	IMGroupID   string
	IMTopicID   string
	IMTopicName string
}

// CreateCommand 携带幂等创建和 Topic 收敛所需的稳定事实。
type CreateCommand struct {
	AccountID                    string
	ServerID                     string
	IdempotencyKey               string
	RequestHash                  [32]byte
	Channel                      Draft
	OperationID                  string
	InitialChannelMemberID       string
	InitialMembershipOperationID string
	CreatedAt                    time.Time
}

// CreateResult 返回固定 Channel 和 operation locator。
type CreateResult struct {
	Channel    Channel
	Operations []Operation
}

// UpdateCommand 保存一次带乐观并发和幂等保护的 Channel 元数据修改。
type UpdateCommand struct {
	AccountID      string
	ServerID       string
	ChannelID      string
	Revision       int64
	IdempotencyKey string
	RequestHash    [32]byte
	NameSet        bool
	Name           string
	DescriptionSet bool
	Description    *string
	UpdatedAt      time.Time
}

// Repository 在 active Human membership 授权后读写 Channel。
type Repository interface {
	GetServerContext(context.Context, string, string) (ServerContext, error)
	Create(context.Context, CreateCommand) (CreateResult, error)
	Update(context.Context, UpdateCommand) (Channel, error)
	List(context.Context, string, string) ([]Channel, error)
	Get(context.Context, string, string, string) (Channel, error)
}
