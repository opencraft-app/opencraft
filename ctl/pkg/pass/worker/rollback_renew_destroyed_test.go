package pass

import (
	"testing"
	"time"

	modelpass "ctl/pkg/model/pass"
	modeltask "ctl/pkg/model/task"
	"ctl/pkg/resource"
	taskcommon "ctl/pkg/taskruntime/common"
	"ctl/test/testutil"
)

func TestRollbackRenewPassSucceedsWhenPassAlreadyDestroyed(t *testing.T) {
	originalDB := resource.GormDB
	t.Cleanup(func() { resource.GormDB = originalDB })
	db := testutil.NewSQLiteDB(t, &modelpass.Entity{}, &modelpass.HistoryEntity{}, &modeltask.Entity{})

	const taskID = "task-rollback-destroyed-pass"
	const passID = "pass-already-destroyed"
	if err := db.Create(&modelpass.HistoryEntity{
		PassID:      passID,
		UserID:      "user-destroyed",
		Status:      modelpass.StatusDeleted,
		DeletedTime: time.Now().UTC(),
	}).Error; err != nil {
		t.Fatalf("seed history pass: %v", err)
	}
	if err := db.Create(&modeltask.Entity{
		TaskId:          taskID,
		TaskName:        taskcommon.TaskNameRollbackRenewPass,
		TaskState:       modeltask.StateRunning,
		MaxExecuteCount: 1 << 30,
	}).Error; err != nil {
		t.Fatalf("seed rollback task: %v", err)
	}

	task := newRollbackRenewPassTask()
	task.TaskId = taskID
	task.in = &taskcommon.RollbackRenewPassTaskPayload{
		PassID:               passID,
		UserID:               "user-destroyed",
		OriginalExpiredTime:  time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC),
		OriginalParentTaskID: "task-renew-destroyed-parent",
	}

	if _, err := task.execute(testutil.NewContext(t, "user-destroyed")); err != nil {
		t.Fatalf("execute rollback for destroyed pass: %v", err)
	}

	var got modeltask.Entity
	if err := db.Where("task_id = ?", taskID).First(&got).Error; err != nil {
		t.Fatalf("reload rollback task: %v", err)
	}
	if got.TaskState != modeltask.StateSuccess {
		t.Fatalf("task state = %q, want %q", got.TaskState, modeltask.StateSuccess)
	}
}
