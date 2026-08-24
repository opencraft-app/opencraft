package taskruntime

import (
	"testing"

	modeltask "ctl/pkg/model/task"
	"ctl/pkg/resource"
	"ctl/test"
	"ctl/test/testutil"
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

func TestUpdateTaskExecuteDoesNotReopenTerminalTask(t *testing.T) {
	originalDB := resource.GormDB
	t.Cleanup(func() { resource.GormDB = originalDB })
	db := testutil.NewSQLiteDB(t, &modeltask.Entity{})

	entity := &modeltask.Entity{
		TaskId:          "task-terminal-success",
		TaskName:        "test-terminal-cas",
		TaskState:       modeltask.StateSuccess,
		ExecuteCount:    3,
		MaxExecuteCount: 10,
	}
	if err := db.Create(entity).Error; err != nil {
		t.Fatalf("seed terminal task: %v", err)
	}

	base := NewBaseTask()
	base.TaskId = entity.TaskId
	base.TaskEntity = entity
	if _, err := base.UpdateTaskExecute(testutil.NewContext(t, "user-terminal")); err == nil {
		t.Fatal("expected terminal task update to be rejected")
	}

	var got modeltask.Entity
	if err := db.Where("task_id = ?", entity.TaskId).First(&got).Error; err != nil {
		t.Fatalf("reload terminal task: %v", err)
	}
	if got.TaskState != modeltask.StateSuccess {
		t.Fatalf("task state = %q, want %q", got.TaskState, modeltask.StateSuccess)
	}
	if got.ExecuteCount != 3 {
		t.Fatalf("execute count = %d, want 3", got.ExecuteCount)
	}
}
