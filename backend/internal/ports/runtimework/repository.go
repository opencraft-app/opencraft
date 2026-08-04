// Package runtimework defines the Agent-scoped Task persistence boundary.
package runtimework

import (
	"context"
	"time"

	workport "chatserver/internal/ports/work"
)

type Repository interface {
	ListRuntimeTasks(
		context.Context,
		string,
		string,
		workport.TaskListOptions,
	) (workport.TaskPage, error)
	GetRuntimeTask(context.Context, string, string, string) (workport.Task, error)
	ClaimRuntimeTask(context.Context, string, string, string, time.Time) (workport.Task, error)
	UpdateRuntimeTaskStatus(
		context.Context,
		string,
		string,
		string,
		int64,
		string,
		time.Time,
	) (workport.Task, error)
	EnsureRuntimeThread(
		context.Context,
		string,
		workport.Mutation,
		string,
		workport.ThreadDraft,
	) (workport.MessageThread, error)
	RegisterRuntimeThreadReply(
		context.Context,
		string,
		workport.Mutation,
		string,
		string,
		workport.ThreadReplyDraft,
	) (workport.ThreadReplyReference, error)
	ListRuntimeReminders(context.Context, string, string) ([]workport.Reminder, error)
	GetRuntimeReminder(context.Context, string, string, string) (workport.Reminder, error)
	CreateRuntimeReminder(
		context.Context,
		string,
		workport.Mutation,
		workport.ReminderDraft,
	) (workport.Reminder, error)
	UpdateRuntimeReminder(
		context.Context,
		string,
		workport.Mutation,
		string,
		int64,
		workport.ReminderPatch,
	) (workport.Reminder, error)
	ListRuntimeReminderLog(
		context.Context,
		string,
		string,
		string,
		workport.ReminderLogListOptions,
	) (workport.ReminderLogPage, error)
}
