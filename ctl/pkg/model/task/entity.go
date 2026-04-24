// Package task ...
package task

import (
	"time"

	"ctl/pkg/model"
)

const (
	TableName = "tasks"

	StateCreated       = "CREATED"
	StateRunning       = "RUNNING"
	StateSuccess       = "SUCCESS"
	StateFailed        = "FAILED"
	StatePartialFailed = "PARTIAL_FAILED"

	ColumnID              = "id"
	ColumnCreatedTime     = "created_time"
	ColumnUpdatedTime     = "updated_time"
	ColumnUserID          = "user_id"
	ColumnTaskId          = "task_id"
	ColumnParentTaskId    = "parent_task_id"
	ColumnTaskName        = "task_name"
	ColumnTaskParams      = "task_params"
	ColumnExecuteCount    = "execute_count"
	ColumnTaskState       = "task_state"
	ColumnTaskMessage     = "task_message"
	ColumnTraceID         = "trace_id"
	ColumnExecuteInterval = "execute_interval"
	ColumnMaxExecuteCount = "max_execute_count"
	ColumnLastExecuteTime = "last_execute_time"
)

// Entity ...
type Entity struct {
	model.BaseEntity
	model.BaseUserEntity

	TaskId          string    `gorm:"column:task_id;uniqueIndex:uk_task_id"`
	ParentTaskId    string    `gorm:"column:parent_task_id;index:idx_parent_task_id"`
	TaskName        string    `gorm:"column:task_name;index:idx_task_name_state_last_execute"`
	TaskParams      string    `gorm:"column:task_params;type:json"`
	TaskState       string    `gorm:"column:task_state;index:idx_task_name_state_last_execute"`
	TaskMessage     string    `gorm:"column:task_message;type:varchar(2048)"`
	TraceId         string    `gorm:"column:trace_id"`
	ExecuteInterval int64     `gorm:"column:execute_interval"`
	ExecuteCount    int       `gorm:"column:execute_count"`
	MaxExecuteCount int       `gorm:"column:max_execute_count"`
	LastExecuteTime time.Time `gorm:"column:last_execute_time;index:idx_task_name_state_last_execute"`
}

func (Entity) TableName() string {
	return TableName
}

func TruncateMessage(err error) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	if len(msg) > 2048 {
		return msg[:2048]
	}
	return msg
}

// TaskCompleted ...
func TaskCompleted(taskState string) bool {
	if taskState == StateSuccess {
		return true
	}
	if taskState == StateFailed {
		return true
	}
	if taskState == StatePartialFailed {
		return true
	}

	return false
}

// UnCompletedTaskStates ...
func UnCompletedTaskStates() []string {
	return []string{StateCreated, StateRunning}
}
