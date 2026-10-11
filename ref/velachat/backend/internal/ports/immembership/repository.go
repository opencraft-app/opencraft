// Package immembership 定义腾讯云 IM 成员同步任务边界。
package immembership

import (
	"context"
	"errors"
	"time"
)

var ErrLeaseLost = errors.New("IM membership 操作租约已失效")

type Claim struct {
	LeaseOwner     string
	Now            time.Time
	LeaseExpiresAt time.Time
}

type Work struct {
	OperationID     string
	LeaseOwner      string
	Kind            string
	ResourceType    string
	ServerID        string
	MemberID        string
	GroupID         string
	TopicID         string
	IMUserID        string
	IMState         string
	MemberRevision  int64
	DesiredRevision int64
	Attempts        int64
}

type CompletionStatus string

const (
	CompletionSucceeded  CompletionStatus = "succeeded"
	CompletionRetry      CompletionStatus = "retry_wait"
	CompletionFailed     CompletionStatus = "failed"
	CompletionSuperseded CompletionStatus = "superseded"
)

type Completion struct {
	OperationID   string
	LeaseOwner    string
	Status        CompletionStatus
	ErrorCode     string
	NextAttemptAt time.Time
	CompletedAt   time.Time
}

type Repository interface {
	Claim(context.Context, Claim) (Work, bool, error)
	Complete(context.Context, Completion) error
}
