// Package work 定义 Task、Reminder、Inbox 与 Activity 的持久化端口。
package work

import (
	"context"
	"errors"
	"time"
)

var (
	ErrForbidden           = errors.New("work forbidden")
	ErrNotFound            = errors.New("work resource not found")
	ErrRevisionConflict    = errors.New("work revision conflict")
	ErrIdempotencyConflict = errors.New("work idempotency conflict")
	ErrInvalidOwner        = errors.New("work owner invalid")
	ErrInvalidAgent        = errors.New("work agent invalid")
)

type MessageRef struct {
	Kind         string  `json:"kind"`
	MessageID    string  `json:"messageId"`
	GroupID      *string `json:"groupId,omitempty"`
	TopicID      *string `json:"topicId,omitempty"`
	SenderUserID *string `json:"senderUserId,omitempty"`
	Sequence     *int64  `json:"sequence,omitempty"`
	Timestamp    *int64  `json:"timestamp,omitempty"`
}

type MessageThread struct {
	ID             string
	ServerID       string
	ChannelID      string
	RootMessageRef MessageRef
	ReplyCount     int64
	UnreadCount    int64
	LastReplyAt    *time.Time
	CreatedAt      time.Time
}

type ThreadReplyReference struct {
	ID         string
	ThreadID   string
	MessageRef MessageRef
	CreatedAt  time.Time
}

type ThreadReplyPage struct {
	Items        []ThreadReplyReference
	NextCursor   *string
	NextSequence *int64
	NextID       string
}

type ThreadReplyListOptions struct {
	Limit         int
	AfterSequence *int64
	AfterID       string
}

type ThreadDraft struct {
	ID             string
	ChannelID      string
	RootMessageRef MessageRef
}

type ThreadReplyDraft struct {
	ID         string
	ThreadID   string
	MessageRef MessageRef
}

type Task struct {
	ID                 string
	ServerID           string
	Number             int64
	Title              string
	Description        *string
	Status             string
	OwnerMemberID      *string
	AssignmentRevision int64
	CreatedByMemberID  string
	UpdatedByMemberID  string
	SourceMessageRef   *MessageRef
	Revision           int64
	CreatedAt          time.Time
	UpdatedAt          time.Time
}

// TaskListOptions carries the stable, filter-bound keyset pagination input.
type TaskListOptions struct {
	Limit          int
	Cursor         string
	OwnerMemberID  *string
	UpdatedAfter   *time.Time
	AfterUpdatedAt *time.Time
	AfterID        string
}

// TaskPage carries one descending (updated_at, id) page. The raw next tuple is
// kept inside the application boundary and encoded by the use-case service.
type TaskPage struct {
	Items         []Task
	NextCursor    string
	NextUpdatedAt *time.Time
	NextID        string
}

type Reminder struct {
	ID                string
	ServerID          string
	AgentID           string
	CreatedByMemberID string
	ScheduleKind      string
	Schedule          string
	Timezone          string
	Text              string
	Status            string
	NextFireAt        *time.Time
	Revision          int64
	CreatedAt         time.Time
	UpdatedAt         time.Time
	Anchor            *ReminderAnchor
}

type ReminderAnchor struct {
	Kind       string
	ChannelID  string
	ThreadID   *string
	MessageRef MessageRef
}

type ReminderLogEntry struct {
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

type ReminderLogListOptions struct {
	Limit                int
	Cursor               string
	AfterScheduledFireAt *time.Time
	AfterID              string
}

type ReminderLogPage struct {
	Items               []ReminderLogEntry
	NextCursor          string
	NextScheduledFireAt *time.Time
	NextID              string
}

type InboxItem struct {
	ID         string
	ServerID   string
	Kind       string
	Title      string
	Status     string
	ResourceID string
	UpdatedAt  time.Time
}

type ActivityItem struct {
	ID           string
	ServerID     string
	Kind         string
	ResourceID   string
	ResourceType string
	Summary      string
	OccurredAt   time.Time
}

type TaskDraft struct {
	ID                      string
	Title                   string
	Description             *string
	OwnerMemberID           *string
	SourceMessageRef        *MessageRef
	NotificationOperationID *string
}

type TaskPatch struct {
	Title                   *string
	Description             **string
	Status                  *string
	OwnerMemberID           **string
	NotificationOperationID *string
}

type ReminderDraft struct {
	ID           string
	AgentID      string
	ScheduleKind string
	Schedule     string
	Timezone     string
	Text         string
	NextFireAt   *time.Time
	Anchor       *ReminderAnchor
}

type ReminderPatch struct {
	Schedule   *string
	Timezone   *string
	Text       *string
	Status     *string
	NextFireAt **time.Time
	Anchor     **ReminderAnchor
}

type Mutation struct {
	AccountID      string
	ServerID       string
	IdempotencyKey string
	RequestHash    [32]byte
	Now            time.Time
}

type Repository interface {
	ListTasks(context.Context, string, string, TaskListOptions) (TaskPage, error)
	GetTask(context.Context, string, string, string) (Task, error)
	CreateTask(context.Context, Mutation, TaskDraft) (Task, error)
	UpdateTask(context.Context, Mutation, string, int64, TaskPatch) (Task, error)

	ListReminders(context.Context, string, string) ([]Reminder, error)
	GetReminder(context.Context, string, string, string) (Reminder, error)
	CreateReminder(context.Context, Mutation, ReminderDraft) (Reminder, error)
	UpdateReminder(
		context.Context,
		Mutation,
		string,
		int64,
		ReminderPatch,
	) (Reminder, error)
	CancelReminder(context.Context, Mutation, string, int64) error

	ListInbox(context.Context, string, string) ([]InboxItem, error)
	ListActivity(context.Context, string, string) ([]ActivityItem, error)

	EnsureThread(
		context.Context,
		Mutation,
		string,
		ThreadDraft,
	) (MessageThread, error)
	GetThread(
		context.Context,
		string,
		string,
		string,
		string,
	) (MessageThread, error)
	ListThreadReplies(
		context.Context,
		string,
		string,
		string,
		string,
		ThreadReplyListOptions,
	) (ThreadReplyPage, error)
	RegisterThreadReply(
		context.Context,
		Mutation,
		string,
		string,
		ThreadReplyDraft,
	) (ThreadReplyReference, error)
	MarkThreadRead(
		context.Context,
		Mutation,
		string,
		string,
		string,
	) error
}
