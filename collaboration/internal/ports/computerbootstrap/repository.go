// Package computerbootstrap 定义已 claim Computer 与 provider 注册编排之间的边界。
package computerbootstrap

import (
	"context"
	"errors"
	"time"
)

var (
	ErrNotEligible = errors.New("Computer 当前不能 bootstrap")
	ErrLeaseLost   = errors.New("Computer bootstrap lease 已失效")
)

type StartCommand struct {
	ServerID          string
	ComputerID        string
	CredentialVersion uint64
	OperationID       string
	IdempotencyKey    string
	CreatedAt         time.Time
	DeadlineAt        time.Time
}

type Operation struct {
	ID                string
	ServerID          string
	ComputerID        string
	CredentialVersion uint64
	State             string
	Attempts          int64
	LeaseOwner        string
	NextAttemptAt     *time.Time
	EncryptedResult   string
	ResultExpiresAt   time.Time
}

type ClaimCommand struct {
	LeaseOwner     string
	Now            time.Time
	LeaseExpiresAt time.Time
	MaxAttempts    int64
}

type LeaseCommand struct {
	OperationID    string
	LeaseOwner     string
	Now            time.Time
	LeaseExpiresAt time.Time
	MaxAttempts    int64
}

type CompleteCommand struct {
	OperationID     string
	LeaseOwner      string
	EncryptedResult string
	ResultExpiresAt time.Time
	CompletedAt     time.Time
}

type RetryCommand struct {
	OperationID   string
	LeaseOwner    string
	ErrorCode     string
	NextAttemptAt time.Time
	FailedAt      time.Time
	Terminal      bool
}

type RenewExpiredCommand struct {
	OperationID             string
	ServerID                string
	ComputerID              string
	CredentialVersion       uint64
	ExpectedEncryptedResult string
	RenewedAt               time.Time
	DeadlineAt              time.Time
}

// EnsureReconcileCommand 把一份已经签发的 provider 注册材料，幂等投影为通用 TAT
// Worker 可消费的注册对账 Operation。MaterialFingerprint 只标识密文版本，不包含明文注册码。
type EnsureReconcileCommand struct {
	BootstrapOperationID string
	ReconcileOperationID string
	ServerID             string
	ComputerID           string
	CredentialVersion    uint64
	MaterialFingerprint  [32]byte
	MaterialExpiresAt    time.Time
	CreatedAt            time.Time
}

type Repository interface {
	GetOrCreate(context.Context, StartCommand) (Operation, error)
	ClaimNext(context.Context, ClaimCommand) (Operation, bool, error)
	TryLease(context.Context, LeaseCommand) (bool, error)
	Complete(context.Context, CompleteCommand) error
	Retry(context.Context, RetryCommand) error
	RenewExpired(context.Context, RenewExpiredCommand) (Operation, bool, error)
	EnsureReconcile(context.Context, EnsureReconcileCommand) error
}
