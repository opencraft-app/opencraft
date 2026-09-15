// Package imdirectconversation 定义 Server 内私信腾讯群后台任务边界。
package imdirectconversation

import (
	"context"
	"errors"
	"time"
)

var ErrLeaseLost = errors.New("Server 内私信操作租约已失效")

type Claim struct {
	LeaseOwner     string
	Now            time.Time
	LeaseExpiresAt time.Time
}

type Work struct {
	OperationID          string
	LeaseOwner           string
	ServerID             string
	DirectConversationID string
	GroupID              string
	GroupName            string
	MemberAIMUserID      string
	MemberBIMUserID      string
	IMState              string
	ConversationRevision int64
	DesiredRevision      int64
	Attempts             int64
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
