// Package reminderoccurrence 定义 Reminder 到期事实的持久化端口。
package reminderoccurrence

import (
	"context"
	"errors"
	"time"
)

var (
	ErrNotFound              = errors.New("reminder occurrence not found")
	ErrNotificationLeaseLost = errors.New("reminder notification lease lost")
)

type Occurrence struct {
	ID              string
	ServerID        string
	ReminderID      string
	AgentID         string
	ScheduledFireAt time.Time
	State           string
	AcknowledgedAt  *time.Time
	ResultCode      *string
	Text            string
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

type ListOptions struct {
	Limit                int
	Cursor               string
	AfterScheduledFireAt *time.Time
	AfterID              string
}

type Page struct {
	Items               []Occurrence
	NextCursor          string
	NextScheduledFireAt *time.Time
	NextID              string
}

type NotificationClaim struct {
	LeaseOwner     string
	Now            time.Time
	LeaseExpiresAt time.Time
}

type NotificationWork struct {
	EventID         string
	LeaseOwner      string
	ServerID        string
	AgentID         string
	ResourceID      string
	RecipientUserID string
	Revision        int64
	Attempts        int64
}

type Repository interface {
	ProcessOne(context.Context, time.Time) (bool, error)
	ListDue(
		context.Context,
		string,
		string,
		ListOptions,
	) (Page, error)
	Acknowledge(
		context.Context,
		string,
		string,
		string,
		*string,
		time.Time,
	) (Occurrence, error)
	ClaimNotification(
		context.Context,
		NotificationClaim,
	) (NotificationWork, bool, error)
	NotificationCurrent(context.Context, NotificationWork, time.Time) (bool, error)
	CompleteNotification(context.Context, string, string, time.Time) error
	RetryNotification(
		context.Context,
		string,
		string,
		time.Time,
		string,
		bool,
	) error
}
