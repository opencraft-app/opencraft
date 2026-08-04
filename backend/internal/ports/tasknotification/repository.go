// Package tasknotification defines durable Agent Task assignment delivery.
package tasknotification

import (
	"context"
	"errors"
	"time"
)

var ErrLeaseLost = errors.New("Task notification lease lost")

type Claim struct {
	LeaseOwner     string
	Now            time.Time
	LeaseExpiresAt time.Time
}

type Work struct {
	OperationID        string
	LeaseOwner         string
	ServerID           string
	TaskID             string
	AgentID            string
	RecipientUserID    string
	AssignmentRevision int64
	Attempts           int64
	Current            bool
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
	Current(context.Context, Work, time.Time) (bool, error)
	Complete(context.Context, Completion) error
}
