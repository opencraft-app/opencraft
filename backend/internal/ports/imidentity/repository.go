// Package imidentity 定义 Human IM 身份后台任务的数据边界。
package imidentity

import (
	"context"
	"errors"
	"time"
)

var (
	// ErrLeaseLost 表示当前 Worker 已不再持有该操作租约。
	ErrLeaseLost = errors.New("IM 身份操作租约已失效")
)

// Claim 描述一次 Worker 领取。
type Claim struct {
	LeaseOwner     string
	Now            time.Time
	LeaseExpiresAt time.Time
}

// Work 是领取操作时回读的最小 Account 事实。
type Work struct {
	OperationID     string
	LeaseOwner      string
	AccountID       string
	DisplayName     string
	IMUserID        string
	IMState         string
	AccountRevision int64
	DesiredRevision int64
	Attempts        int64
}

// CompletionStatus 是 Worker 对一次已领取操作的归一化结论。
type CompletionStatus string

const (
	CompletionSucceeded  CompletionStatus = "succeeded"
	CompletionRetry      CompletionStatus = "retry_wait"
	CompletionFailed     CompletionStatus = "failed"
	CompletionSuperseded CompletionStatus = "superseded"
)

// Completion 通过 operationId+leaseOwner fencing 写回执行结论。
type Completion struct {
	OperationID   string
	LeaseOwner    string
	Status        CompletionStatus
	IMUserID      string
	ErrorCode     string
	NextAttemptAt time.Time
	CompletedAt   time.Time
}

// Repository 提供 IM 身份 Worker 的租约和原子状态收敛。
type Repository interface {
	Claim(context.Context, Claim) (Work, bool, error)
	Complete(context.Context, Completion) error
}

// IdentityDeriver 生成首次持久化后保持不变的 Human IM UserID。
type IdentityDeriver interface {
	HumanUserID(string) (string, error)
}
