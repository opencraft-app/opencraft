// Package agent 定义 Agent 管理面与持久化之间的边界。
package agent

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strconv"
	"strings"
	"time"
)

func ProfileCapabilityAuthorityContextKey(
	serverID string,
	agentID string,
	computerID string,
	runtimeKind string,
	revision int64,
) string {
	var canonical strings.Builder
	canonical.WriteString("agent-profile-capability-context/v1\x00")
	for _, value := range []string{
		strings.ToLower(serverID), strings.ToLower(agentID),
		strings.ToLower(computerID), strings.TrimSpace(runtimeKind),
		strconv.FormatInt(revision, 10),
	} {
		canonical.WriteString(strconv.Itoa(len(value)))
		canonical.WriteByte(':')
		canonical.WriteString(value)
	}
	digest := sha256.Sum256([]byte(canonical.String()))
	return base64.RawURLEncoding.EncodeToString(digest[:])
}

var (
	ErrServerNotFound                 = errors.New("Server 不存在")
	ErrAgentNotFound                  = errors.New("Agent 不存在")
	ErrAgentNotReady                  = errors.New("Agent IM 尚未就绪")
	ErrComputerNotReady               = errors.New("Computer 尚未就绪")
	ErrPermissionDenied               = errors.New("没有管理 Agent 的权限")
	ErrHandleConflict                 = errors.New("Agent handle 冲突")
	ErrRevisionConflict               = errors.New("Agent revision 冲突")
	ErrAgentMustBeStopped             = errors.New("Agent 必须先停止")
	ErrIdempotencyConflict            = errors.New("幂等请求冲突")
	ErrCredentialPending              = errors.New("Agent credential 正在安装")
	ErrCredentialMissing              = errors.New("Agent credential 尚未安装")
	ErrProfileCapabilitiesUnsupported = errors.New("Computer 不支持 Profile capability")
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

// RequiresActiveCredential 定义会把 Agent 写入可安装或可运行 Assignment 的生命周期动作。
// Service 用它决定是否自动签发首次凭据，Repository 用它守住持久化不变量。
func RequiresActiveCredential(kind string) bool {
	switch kind {
	case "agent.deploy", "agent.start", "agent.restart":
		return true
	default:
		return false
	}
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

type ProfileCapabilityRefreshCommand struct {
	AccountID             string
	ServerID              string
	AgentID               string
	ComputerID            string
	RuntimeKind           string
	ContextGeneration     int64
	AuthorityContextKey   string
	InvalidationWatermark int64
	ForceReload           bool
	Trigger               string
	IdempotencyKey        string
	RequestHash           [32]byte
	OperationID           string
	CreatedAt             time.Time
	DeadlineAt            time.Time
}

type ProfileCapabilities struct {
	AgentID           string
	ComputerID        *string
	ContextGeneration int64
	Runtime           Runtime
	SnapshotJSON      *string
	RefreshOperation  *Operation
}

type ProfileCapabilityResultCommand struct {
	ServerID            string
	ComputerID          string
	AgentID             string
	OperationID         string
	ContextGeneration   int64
	AuthorityContextKey string
	Succeeded           bool
	ErrorCode           string
	ResultJSON          []byte
	ResultHash          [32]byte
	CompletedAt         time.Time
}

type ProfileCapabilitySubmissionResult struct {
	Accepted bool
	Reason   string
}

type ProfileCapabilityInvalidationCommand struct {
	ServerID                 string
	ComputerID               string
	AgentID                  string
	EventID                  string
	ContextGeneration        int64
	AuthorityContextKey      string
	RuntimeContextGeneration int64
	EventSequence            int64
	Reason                   string
	ObservedAt               time.Time
}

type SystemProfileCapabilityEnsureCommand struct {
	ServerID          string
	ComputerID        string
	AgentID           string
	ContextGeneration int64
	OperationID       string
	CreatedAt         time.Time
	DeadlineAt        time.Time
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

type ProfileCapabilityRepository interface {
	SupportsProfileCapabilities(
		context.Context,
		string,
		string,
	) (bool, error)
	GetProfileCapabilities(
		context.Context,
		string,
		string,
		string,
	) (ProfileCapabilities, error)
	BeginProfileCapabilityRefresh(
		context.Context,
		ProfileCapabilityRefreshCommand,
	) (Operation, error)
}

type ProfileCapabilityResultRepository interface {
	CompleteProfileCapabilityRefresh(
		context.Context,
		ProfileCapabilityResultCommand,
	) (ProfileCapabilitySubmissionResult, error)
	PutProfileCapabilityInvalidation(
		context.Context,
		ProfileCapabilityInvalidationCommand,
	) (ProfileCapabilitySubmissionResult, error)
}

type SystemProfileCapabilityRepository interface {
	EnsureSystemProfileCapabilityRefresh(
		context.Context,
		SystemProfileCapabilityEnsureCommand,
	) (Operation, error)
}

type ProfileCapabilityDeadlineRepository interface {
	ExpireProfileCapabilityRefresh(context.Context, time.Time) (bool, error)
}
