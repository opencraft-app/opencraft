//go:build integration

package task

import (
	"testing"
	"time"

	"ctl/pkg/model"
	"ctl/pkg/model/factory"
	"ctl/pkg/model/task"
	"ctl/test/testutil"
)

func TestCRUD(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "..", "migrations")

	entity := &task.Entity{
		BaseEntity: model.BaseEntity{},
		BaseUserEntity: model.BaseUserEntity{
			UserID: "654321",
		},
		TaskId:          "task-abcd1234",
		ParentTaskId:    "task-pabc1234",
		TaskName:        "test",
		TaskParams:      `{"hello":"world"}`,
		TaskState:       task.StateCreated,
		TaskMessage:     "done",
		TraceId:         "traceid-abcd1234",
		ExecuteInterval: 10,
		ExecuteCount:    20,
		MaxExecuteCount: 30,
		LastExecuteTime: time.Now(),
	}

	dao := factory.DefaultDaoFactory.TaskDao(testutil.NewContext(t, "654321"))
	err := dao.Insert(entity)
	if err != nil {
		t.Fatalf("insert result: %v", err)
	}

	err = dao.SelectByKeyColumn("task-abcd1234", entity)
	if err != nil {
		t.Fatalf("SelectByKeyColumn: %v", err)
	}
	if entity.TaskState != task.StateCreated {
		t.Fatalf("unexpected task state after select: %s", entity.TaskState)
	}

	err = dao.UpdateByKeyColumn(map[string]interface{}{
		task.ColumnTaskState:       task.StateRunning,
		task.ColumnLastExecuteTime: time.Now().Format("2006-01-02 15:04:05"),
	}, "task-abcd1234")
	if err != nil {
		t.Fatalf("update result: %v", err)
	}

	var data []*task.Entity
	err = dao.SimpleQueryAnd(&data,
		model.WhereEqual(task.ColumnTaskId, "task-abcd1234"),
	)
	if err != nil {
		t.Fatalf("SimpleQueryAnd: %v", err)
	}
	if len(data) != 1 || data[0].TaskState != task.StateRunning {
		t.Fatalf("unexpected query result: %+v", data)
	}

	total, err := dao.SimpleTotalAnd(
		model.WhereEqual(task.ColumnTaskId, "task-abcd1234"),
	)
	if err != nil {
		t.Fatalf("SimpleTotalAnd: %v", err)
	}
	if total != 1 {
		t.Fatalf("unexpected total: %d", total)
	}

	err = dao.DeleteByKeyColumn("task-abcd1234")
	if err != nil {
		t.Fatalf("delete result: %v", err)
	}

	err = dao.DeleteByParentTaskIds("ptask-abcd1234")
	if err != nil {
		t.Fatalf("DeleteByParentTaskIds: %v", err)
	}
}
