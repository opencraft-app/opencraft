// Package imcommunity 定义 Server Community 后台任务边界。
package imcommunity

import (
	"context"
	"errors"
	"time"
)

var ErrLeaseLost = errors.New("Community 操作租约已失效")

type Claim struct {
	LeaseOwner     string
	Now            time.Time
	LeaseExpiresAt time.Time
}

type Work struct {
	OperationID     string
	LeaseOwner      string
	ServerID        string
	ServerName      string
	Description     string
	GroupID         string
	OwnerMemberID   string
	OwnerIMUserID   string
	RootChannelID   string
	IMState         string
	ServerRevision  int64
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
