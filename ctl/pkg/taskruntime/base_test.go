package taskruntime

import (
	"testing"

	"ctl/test"
)

var (
	taskItem *BaseTask
)

func init() {
	test.InitTestResource()

	taskItem = NewBaseTask()
	taskItem.TaskLockSeconds = 10

	taskItem.SetTaskId("lgtk-abcd1234")
}

func TestLockTask(t *testing.T) {
	code, err := taskItem.LockTask(test.Context())
	t.Log(code, err)
}

func TestUnlockTask(t *testing.T) {
	code, err := taskItem.UnlockTask(test.Context())
	t.Log(code, err)
}

func TestCheckTask(t *testing.T) {
	code, err := taskItem.CheckTask(test.Context())
	t.Log(code, err, taskItem.TaskEntity)
}

func TestUpdateTaskExecute(t *testing.T) {
	code, err := taskItem.UpdateTaskExecute(test.Context())
	t.Log(code, err)
}
