// Package instance R-MR-5 续费失败回滚 task 入队接口（EnqueueRollbackRenewPassTask）参数校验单测
//
// 设计稿：.tmp/trade-pass-renew-design.md §3.4 失败回滚链路升级（2026-05-24 用户拍板）
//
// 仅覆盖入参校验失败的纯路径（在 enqueueTaskWithSchedule 之前 short-circuit），
// 无需 mock producer / DB；valid 入参的 happy path 由 worker 端集成测试覆盖。
package instance

import (
	"errors"
	"strings"
	"testing"
	"time"

	pctx "ctl/pkg/context"
	modelfactory "ctl/pkg/model/factory"
	modeltask "ctl/pkg/model/task"
	"ctl/pkg/mq"
	"ctl/pkg/resource"
	taskcommon "ctl/pkg/taskruntime/common"
	"ctl/test/testutil"
)

type rollbackRecordingProducer struct {
	sendCount int
	err       error
}

func (p *rollbackRecordingProducer) Send(_ *mq.Message) error {
	p.sendCount++
	return p.err
}

func TestEnqueueRollbackRenewPassTaskIsIdempotentByParent(t *testing.T) {
	originalDB := resource.GormDB
	t.Cleanup(func() { resource.GormDB = originalDB })
	db := testutil.NewSQLiteDB(t, &modeltask.Entity{})
	producer := &rollbackRecordingProducer{}
	logic := &logic{
		taskDao:  modelfactory.DefaultDaoFactory.TaskDao(nil),
		producer: producer,
	}
	ctx := testutil.NewContext(t, "user-renew-idempotent")
	parentTaskID := "task-renew-parent-idempotent"
	taskID := rollbackRenewPassTaskID(parentTaskID)
	payload := &taskcommon.RollbackRenewPassTaskPayload{
		PassID:               "pass-renew-idempotent",
		UserID:               "user-renew-idempotent",
		OriginalExpiredTime:  time.Date(2026, 8, 18, 0, 0, 0, 0, time.UTC),
		OriginalParentTaskID: parentTaskID,
	}

	firstID, err := logic.enqueueTaskWithScheduleAndID(ctx, taskID, taskcommon.TaskNameRollbackRenewPass, payload, parentTaskID, 30, 1<<30)
	if err != nil {
		t.Fatalf("first enqueue: %v", err)
	}
	secondID, err := logic.enqueueTaskWithScheduleAndID(ctx, taskID, taskcommon.TaskNameRollbackRenewPass, payload, parentTaskID, 30, 1<<30)
	if err != nil {
		t.Fatalf("second enqueue: %v", err)
	}
	if firstID != secondID || firstID != taskID {
		t.Fatalf("task ids = (%q, %q), want deterministic %q", firstID, secondID, taskID)
	}

	var count int64
	if err := db.Model(&modeltask.Entity{}).Where("task_id = ?", taskID).Count(&count).Error; err != nil {
		t.Fatalf("count rollback tasks: %v", err)
	}
	if count != 1 {
		t.Fatalf("rollback task count = %d, want 1", count)
	}
}

func TestStableRollbackTaskRemainsRetryableWhenMQSendFails(t *testing.T) {
	originalDB := resource.GormDB
	t.Cleanup(func() { resource.GormDB = originalDB })
	db := testutil.NewSQLiteDB(t, &modeltask.Entity{})
	producer := &rollbackRecordingProducer{err: errors.New("mq unavailable")}
	logic := &logic{
		taskDao:  modelfactory.DefaultDaoFactory.TaskDao(nil),
		producer: producer,
	}
	ctx := testutil.NewContext(t, "user-renew-mq-failure")
	parentTaskID := "task-renew-parent-mq-failure"
	taskID := rollbackRenewPassTaskID(parentTaskID)
	payload := &taskcommon.RollbackRenewPassTaskPayload{
		PassID:               "pass-renew-mq-failure",
		UserID:               "user-renew-mq-failure",
		OriginalExpiredTime:  time.Date(2026, 8, 18, 0, 0, 0, 0, time.UTC),
		OriginalParentTaskID: parentTaskID,
	}

	if _, err := logic.enqueueTaskWithScheduleAndID(ctx, taskID, taskcommon.TaskNameRollbackRenewPass, payload, parentTaskID, 30, 1<<30); err == nil {
		t.Fatal("expected MQ send failure")
	}

	var got modeltask.Entity
	if err := db.Where("task_id = ?", taskID).First(&got).Error; err != nil {
		t.Fatalf("reload rollback task: %v", err)
	}
	if got.TaskState != modeltask.StateCreated {
		t.Fatalf("task state = %q, want %q for checkTasks recovery", got.TaskState, modeltask.StateCreated)
	}
	if !strings.Contains(got.TaskMessage, "mq unavailable") {
		t.Fatalf("task message = %q, want MQ error", got.TaskMessage)
	}
}

func TestEnqueueRollbackRenewPassTask_ParamValidation(t *testing.T) {
	validExpired := time.Date(2026, 7, 22, 7, 22, 50, 0, time.UTC)
	validParentTaskID := "task-renew-pass-original-1"

	cases := []struct {
		name        string
		passID      string
		userID      string
		opID        string
		flowID      int64
		origExpired time.Time
		origIsoPtr  *time.Time
		failReason  string
		origParent  string
		wantErrSub  string // err.Error() 中必须包含该子串
	}{
		{
			name:        "empty_pass_id",
			passID:      "",
			userID:      "user-1",
			origExpired: validExpired,
			origParent:  validParentTaskID,
			wantErrSub:  "passID is required",
		},
		{
			name:        "empty_user_id",
			passID:      "pass-1",
			userID:      "",
			origExpired: validExpired,
			origParent:  validParentTaskID,
			wantErrSub:  "userID is required",
		},
		{
			name:        "zero_original_expired_time",
			passID:      "pass-1",
			userID:      "user-1",
			origExpired: time.Time{}, // 零值
			origParent:  validParentTaskID,
			wantErrSub:  "originalExpiredTime is required",
		},
		{
			name:        "empty_original_parent_task_id",
			passID:      "pass-1",
			userID:      "user-1",
			origExpired: validExpired,
			origParent:  "",
			wantErrSub:  "originalParentTaskID is required",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ctx := pctx.NewContext(nil)
			_, err := EnqueueRollbackRenewPassTask(
				ctx,
				c.passID, c.userID, c.opID,
				c.flowID, c.origExpired, c.origIsoPtr,
				c.failReason, c.origParent,
				0, 0,
			)
			if err == nil {
				t.Fatalf("expected non-nil err for case %q", c.name)
			}
			if !strings.Contains(err.Error(), c.wantErrSub) {
				t.Errorf("err = %v; want substring %q", err, c.wantErrSub)
			}
			// 防御：不应是 nil pointer / panic 等异常类型
			if errors.Is(err, errors.New("dummy")) {
				t.Errorf("unexpected wrapping behavior")
			}
		})
	}
}

// TestEnqueueRenewPassTask_ParamValidation_Baseline 验证 R-MR-5 升级后 RenewPass
// 入队接口新增的 originalExpiredTime 必填校验。
func TestEnqueueRenewPassTask_ParamValidation_Baseline(t *testing.T) {
	ctx := pctx.NewContext(nil)
	// 缺 originalExpiredTime（零值）→ 必须返错。
	_, err := EnqueueRenewPassTask(
		ctx,
		"pass-1", "user-1", "op-1",
		0, // tradeFlowID
		1, "m",
		time.Time{}, // originalExpiredTime 零值
		nil,         // originalIsolatedTime
		30, 5,
	)
	if err == nil {
		t.Fatalf("expected non-nil err when originalExpiredTime is zero")
	}
	if !strings.Contains(err.Error(), "originalExpiredTime is required") {
		t.Errorf("err = %v; want substring 'originalExpiredTime is required'", err)
	}
}
