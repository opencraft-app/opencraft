// Package common ...
package common

import (
	"encoding/json"
	"fmt"

	"ctl/pkg/context"
	"ctl/pkg/model/task"
)

// TaskMessage ...
type TaskMessage struct {
	TaskName string
	TaskId   string
	TraceId  string
	Account  struct {
		UserID string
	}
	Data []byte
}

// GenerateMessageData ...
func GenerateMessageData(ctx context.Context, taskName, taskId string, taskIn interface{}) ([]byte, error) {
	inData, err := json.Marshal(taskIn)
	if err != nil {
		return nil, fmt.Errorf("json.Marshal inData error: %w", err)
	}

	msg := &TaskMessage{
		TaskName: taskName,
		TaskId:   taskId,
		TraceId:  ctx.GetRequestId(),
		Data:     inData,
	}
	msg.Account.UserID = ctx.GetUserID()

	content, _ := json.Marshal(msg)
	return content, nil
}

// GenerateMessageDataByTaskEntity ...
func GenerateMessageDataByTaskEntity(entity *task.Entity) []byte {
	msg := &TaskMessage{
		TaskName: entity.TaskName,
		TaskId:   entity.TaskId,
		TraceId:  entity.TraceId,
		Data:     []byte(entity.TaskParams),
	}
	msg.Account.UserID = entity.UserID

	content, _ := json.Marshal(msg)
	return content
}
