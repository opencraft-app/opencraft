// Package instance 销毁子 task 入队接口（EnqueueDestroyInstanceForPassTask）参数校验单测
//
// 设计稿：.tmp/trade-pass-destroy-design.md §4.7 + BUG-30 销毁链路延伸
// （sandbox-bj-7 联调 2026-05-25 实测：原实现漏注入 ctx user，导致
// DestroyInstanceWithSnapshot 子 task reload 时 ctx user 为空 →
// instanceDao.GetByInstanceID 返 `context user is required` →
// 父 task DestroyPass 一直等不到子 task 终态、销毁链路卡死）。
//
// 仅覆盖入参校验失败的纯路径（在 enqueueTaskWithSchedule 之前 short-circuit），
// 无需 mock producer / DB；valid 入参的 happy path 由 worker 端集成测试覆盖。
package instance

import (
	"strings"
	"testing"

	pctx "ctl/pkg/context"
	taskcommon "ctl/pkg/taskruntime/common"
)

func TestEnqueueDestroyInstanceForPassTask_ParamValidation(t *testing.T) {
	validPayload := taskcommon.DestroyInstanceForPassTaskPayload{
		InstanceID: "ins-1",
		PassID:     "pass-1",
		UserID:     "user-1",
	}

	cases := []struct {
		name       string
		payload    taskcommon.DestroyInstanceForPassTaskPayload
		parentID   string
		wantErrSub string
	}{
		{
			name: "empty_instance_id",
			payload: taskcommon.DestroyInstanceForPassTaskPayload{
				PassID: "pass-1",
				UserID: "user-1",
			},
			parentID:   "task-parent-1",
			wantErrSub: "payload.InstanceID is required",
		},
		{
			name: "empty_user_id",
			payload: taskcommon.DestroyInstanceForPassTaskPayload{
				InstanceID: "ins-1",
				PassID:     "pass-1",
			},
			parentID:   "task-parent-1",
			wantErrSub: "payload.UserID is required",
		},
		{
			name:       "empty_parent_task_id",
			payload:    validPayload,
			parentID:   "",
			wantErrSub: "parentTaskID is required",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ctx := pctx.NewContext(nil)
			err := EnqueueDestroyInstanceForPassTask(
				ctx,
				c.payload,
				c.parentID,
				0, 0,
			)
			if err == nil {
				t.Fatalf("expected non-nil err for case %q", c.name)
			}
			if !strings.Contains(err.Error(), c.wantErrSub) {
				t.Errorf("err = %v; want substring %q", err, c.wantErrSub)
			}
		})
	}
}
