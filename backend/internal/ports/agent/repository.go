// Package agent 定义 Agent 管理面与持久化之间的边界。
package agent

import (
	"context"
	"errors"
	"time"
)

var (
	ErrServerNotFound      = errors.New("Server 不存在")
	ErrAgentNotFound       = errors.New("Agent 不存在")
	ErrAgentNotReady       = errors.New("Agent IM 尚未就绪")
	ErrComputerNotReady    = errors.New("Computer 尚未就绪")
	ErrPermissionDenied    = errors.New("没有管理 Agent 的权限")
	ErrHandleConflict      = errors.New("Agent handle 冲突")
	ErrRevisionConflict    = errors.New("Agent revision 冲突")
	ErrAgentMustBeStopped  = errors.New("Agent 必须先停止")
	ErrIdempotencyConflict = errors.New("幂等请求冲突")
	ErrCredentialPending   = errors.New("Agent credential 正在安装")
	ErrCredentialMissing   = errors.New("Agent credential 尚未安装")
)

type ServerContext struct {
	Role            string
	IMState         string
	CreatorMemberID string
}

type Runtime struct {
	Kind  string
	Model *string
}

type Agent struct {
	ID                             string
	ServerID                       string
	DisplayName                    string
	Handle                         string
	Description                    *string
	IMUserID                       string
	IMState                        string
	ComputerID                     *string
	Runtime                        Runtime
	ReplyPolicy                    string
	DesiredState                   string
	ObservedState                  string
	Availability                   string
	IMPresence                     string
	IMPresenceUpdatedAt            *time.Time
	IMTransportState               string
	IMTransportUpdatedAt           *time.Time
	HostLastSeenAt                 *time.Time
	CredentialVersion              int64
	LastObservedAt                 *time.Time
	LastErrorCode                  string
	ObservedAssignmentEpoch        *string
	ObservedGeneration             int64
	ObservedAttempt                int64
	ObservedLaunchID               *string
	CurrentLaunchID                *string
	CurrentLaunchAssignmentEpoch   *string
	CurrentLaunchGeneration        int64
	CurrentLaunchCredentialVersion int64
	CurrentLaunchAttempt           int64
	Revision                       int64
}

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

type Draft struct {
	ID              string
	DisplayName     string
	Handle          string
	Description     *string
	IMUserID        string
	ComputerID      *string
	Runtime         Runtime
	ReplyPolicy     string
	CreatorMemberID string
}

type CreateCommand struct {
	AccountID      string
	ServerID       string
	IdempotencyKey string
	RequestHash    [32]byte
	Agent          Draft
	OperationID    string
	CreatedAt      time.Time
}

type CreateResult struct {
	Agent     Agent
	Operation Operation
}

type UpdatePatch struct {
	DisplayName    *string
	DescriptionSet bool
	Description    *string
	ComputerIDSet  bool
	ComputerID     *string
	Runtime        *Runtime
	ReplyPolicy    *string
}

type UpdateCommand struct {
	AccountID      string
	ServerID       string
	AgentID        string
	Revision       int64
	IdempotencyKey string
	RequestHash    [32]byte
	Patch          UpdatePatch
	UpdatedAt      time.Time
}

type LifecycleCommand struct {
	AccountID      string
	ServerID       string
	AgentID        string
	Kind           string
	IdempotencyKey string
	RequestHash    [32]byte
	OperationID    string
	CreatedAt      time.Time
}

type CredentialCommand struct {
	AccountID      string
	ServerID       string
	AgentID        string
	Version        int64
	CredentialID   string
	SecretHash     [32]byte
	IdempotencyKey string
	RequestHash    [32]byte
	OperationID    string
	CreatedAt      time.Time
}

// DeleteCommand 在一个 Server 分片事务中墓碑 Agent，并提交 IM 账号删除操作。
// Computer 运行时通过 Assignment Snapshot 的集合差异收敛；这里不承载 TAT 生命周期。
type DeleteCommand struct {
	AccountID      string
	ServerID       string
	AgentID        string
	IdempotencyKey string
	RequestHash    [32]byte
	OperationID    string
	DeletedAt      time.Time
}

type CredentialResult struct {
	Operation Operation
	Created   bool
}

type Repository interface {
	GetServerContext(context.Context, string, string) (ServerContext, error)
	Create(context.Context, CreateCommand) (CreateResult, error)
	List(context.Context, string, string) ([]Agent, error)
	Get(context.Context, string, string, string) (Agent, error)
	Update(context.Context, UpdateCommand) (Agent, error)
	Delete(context.Context, DeleteCommand) (Operation, error)
	ApplyLifecycle(context.Context, LifecycleCommand) (Operation, error)
	RotateCredential(context.Context, CredentialCommand) (CredentialResult, error)
}
