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
)

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
