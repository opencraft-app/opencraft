// Package tencentoperation 定义 TAT 可靠副作用任务的持久化边界。
package tencentoperation

import (
	"context"
	"errors"
	"time"

	tencenttatport "chatserver/internal/ports/tencenttat"
)

var ErrLeaseLost = errors.New("腾讯云操作租约已失效")

// Claim 描述一次有 fencing 的短租约领取。
type Claim struct {
	LeaseOwner     string
	Now            time.Time
	LeaseExpiresAt time.Time
}

// Work 是执行前读取的 Computer 当前事实。
type Work struct {
	OperationID           string
	LeaseOwner            string
	ServerID              string
	ResourceID            string
	ResourceType          string
	Kind                  string
	DesiredRevision       int64
	ResourceRevision      int64
	Target                tencenttatport.Target
	ComputerActive        bool
	TATOnline             bool
	RegistrationExpiresAt *time.Time
	Attempts              int64
}

// CompletionStatus 是可靠操作的归一化收敛状态。
type CompletionStatus string

const (
	CompletionSucceeded  CompletionStatus = "succeeded"
	CompletionRetry      CompletionStatus = "retry_wait"
	CompletionFailed     CompletionStatus = "failed"
	CompletionUncertain  CompletionStatus = "uncertain"
	CompletionSuperseded CompletionStatus = "superseded"
)

// Completion 用 operationId+leaseOwner 写回，不携带脚本或敏感参数。
type Completion struct {
	OperationID        string
	LeaseOwner         string
	Status             CompletionStatus
	ErrorCode          string
	NextAttemptAt      time.Time
	CompletedAt        time.Time
	ComputerInstanceID string
	ComputerOS         tencenttatport.OS
	ComputerTATOnline  *bool
}

// Repository 负责租约、同资源串行化和业务状态原子收敛。
type Repository interface {
	Claim(context.Context, Claim) (Work, bool, error)
	Complete(context.Context, Completion) error
}
