// Package agentidentity 定义 Agent IM 身份 Worker 的持久化边界。
package agentidentity

import (
	"context"
	"errors"
	"time"
)

var ErrLeaseLost = errors.New("Agent IM 身份操作租约已失效")

type Claim struct {
	LeaseOwner     string
	Now            time.Time
	LeaseExpiresAt time.Time
}

type Work struct {
	Kind            string
	OperationID     string
	LeaseOwner      string
	AgentID         string
	DisplayName     string
	IMUserID        string
	IMState         string
	AgentRevision   int64
	DesiredRevision int64
	Attempts        int64
	Deleted         bool
}

// RouteRevocation 是跨 `im_user_id` 分片执行的幂等路由撤销。
type RouteRevocation struct {
	OperationID string
	LeaseOwner  string
	AgentID     string
	IMUserID    string
	RevokedAt   time.Time
}

type CompletionStatus string

const (
	CompletionSucceeded  CompletionStatus = "succeeded"
	CompletionRetry      CompletionStatus = "retry_wait"
	CompletionFailed     CompletionStatus = "failed"
	CompletionSuperseded CompletionStatus = "superseded"
)

type Completion struct {
	OperationID           string
	MembershipOperationID string
	LeaseOwner            string
	Status                CompletionStatus
	ErrorCode             string
	NextAttemptAt         time.Time
	CompletedAt           time.Time
}

// LegacyMembership 是升级前被错误标记 ready、但从未提交入群操作的 Agent Member。
type LegacyMembership struct {
	ServerID string
	MemberID string
	Revision int64
}

// LegacyMembershipSchedule 按旧 Member 当前 revision 幂等提交一次 Community ensure。
type LegacyMembershipSchedule struct {
	LegacyMembership
	OperationID string
	ScheduledAt time.Time
}

type Repository interface {
	Claim(context.Context, Claim) (Work, bool, error)
	RevokeRoute(context.Context, RouteRevocation) error
	Complete(context.Context, Completion) error
	FindLegacyMembership(context.Context) (LegacyMembership, bool, error)
	ScheduleLegacyMembership(context.Context, LegacyMembershipSchedule) (bool, error)
	LegacyMembershipRepairCompleted(context.Context) (bool, error)
	CompleteLegacyMembershipRepair(context.Context, string, time.Time) error
}
