// Package instance 测试文件：IsolateInstance 子 task 的 sandbox 错误容错单测。
//
// 设计稿：.tmp/trade-pass-isolate-design.md §10 Q22-I-D / Q26-D 修订版
//
// I-MR-1 修复回归（2026-05-25）：
//   - sandbox not_found    → 视为成功，继续走 CAS Running→Paused（与 RenewInstance / DestroyInstance 容错对偶）
//   - sandbox already paused → 视为成功，继续走 CAS（已有逻辑，本测试做回归保护）
//   - 其它 sandbox 错误     → 冒泡，触发父 task 重试（不能误吞）
package instance

import (
	"context"
	"errors"
	"testing"

	psandbox "ctl/pkg/adapter/sandbox"
	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	modelinstance "ctl/pkg/model/instance"
	"ctl/pkg/taskruntime/common"

	"go.uber.org/zap"
)

// isolateInstanceDaoStub 仅实现 RunIsolateInstanceTask 走过的两个 DAO 方法。
type isolateInstanceDaoStub struct {
	modelinstance.Dao
	entity           *modelinstance.Entity
	transitionErr    error
	transitionCalls  int
	lastFromStatuses []string
	lastTargetStatus string
}

func (s *isolateInstanceDaoStub) GetByInstanceID(_ pctx.Context, _ string) (*modelinstance.Entity, error) {
	if s.entity == nil {
		return nil, errcode.ErrInstanceNotFound
	}
	return s.entity, nil
}

func (s *isolateInstanceDaoStub) TransitionStatus(_ pctx.Context, _ int64, fromStatuses []string, newStatus string) error {
	s.transitionCalls++
	s.lastFromStatuses = append([]string(nil), fromStatuses...)
	s.lastTargetStatus = newStatus
	if s.transitionErr != nil {
		return s.transitionErr
	}
	if s.entity != nil {
		s.entity.Status = newStatus
	}
	return nil
}

// isolateSandboxStub 仅实现 RunIsolateInstanceTask 走过的 PauseSandbox。
type isolateSandboxStub struct {
	psandbox.Adapter
	pauseErr   error
	pauseCalls int
}

func (s *isolateSandboxStub) PauseSandbox(_ context.Context, _ string) error {
	s.pauseCalls++
	return s.pauseErr
}

func newIsolateLogicWith(daoStub *isolateInstanceDaoStub, sbStub *isolateSandboxStub) *logic {
	return &logic{
		instanceDao:    daoStub,
		sandboxAdapter: sbStub,
		logger:         zap.NewNop(),
	}
}

// TestRunIsolateInstanceTaskTreatsSandboxNotFoundAsSuccess I-MR-1 修复回归：
// 当 PauseSandbox 返 ErrSandboxNotFound 时，子 task 应继续走 CAS Running→Paused 并视为成功。
// 行为对齐 RenewInstance / DestroyInstance 子 task 对 sandbox 缺失的幂等容错。
func TestRunIsolateInstanceTaskTreatsSandboxNotFoundAsSuccess(t *testing.T) {
	dao := &isolateInstanceDaoStub{
		entity: &modelinstance.Entity{
			Id:         201,
			InstanceId: "ins-isolate-sb-404",
			Status:     modelinstance.InstanceStatusRunning,
			SandboxId:  "sbx-isolate-404",
		},
	}
	sb := &isolateSandboxStub{pauseErr: errcode.ErrSandboxNotFound}
	l := newIsolateLogicWith(dao, sb)
	ctx := pctx.NewContext(nil).WithUserID("user-isolate-404")

	err := l.RunIsolateInstanceTask(ctx, &common.IsolateInstanceTaskPayload{
		InstanceID: "ins-isolate-sb-404",
		PassID:     "pass-isolate-404",
	})
	if err != nil {
		t.Fatalf("expected sandbox not_found to be treated as success, got err=%v", err)
	}
	if sb.pauseCalls != 1 {
		t.Fatalf("expected PauseSandbox to be called exactly once, got %d", sb.pauseCalls)
	}
	if dao.transitionCalls != 1 {
		t.Fatalf("expected TransitionStatus to be called exactly once, got %d", dao.transitionCalls)
	}
	if dao.lastTargetStatus != modelinstance.InstanceStatusPaused {
		t.Fatalf("expected target status Paused, got %s", dao.lastTargetStatus)
	}
	if dao.entity.Status != modelinstance.InstanceStatusPaused {
		t.Fatalf("expected instance to flip to Paused, got %s", dao.entity.Status)
	}
}

// TestRunIsolateInstanceTaskTreatsSandboxAlreadyPausedAsSuccess 已有逻辑回归保护：
// 当 PauseSandbox 返 "already paused" 类冲突时，子 task 应视为成功并继续 CAS。
func TestRunIsolateInstanceTaskTreatsSandboxAlreadyPausedAsSuccess(t *testing.T) {
	dao := &isolateInstanceDaoStub{
		entity: &modelinstance.Entity{
			Id:         202,
			InstanceId: "ins-isolate-sb-paused",
			Status:     modelinstance.InstanceStatusRunning,
			SandboxId:  "sbx-isolate-paused",
		},
	}
	sb := &isolateSandboxStub{
		pauseErr: errcode.Wrap(errcode.ErrSandboxStatusConflict, "sandbox already paused"),
	}
	l := newIsolateLogicWith(dao, sb)
	ctx := pctx.NewContext(nil).WithUserID("user-isolate-paused")

	err := l.RunIsolateInstanceTask(ctx, &common.IsolateInstanceTaskPayload{
		InstanceID: "ins-isolate-sb-paused",
		PassID:     "pass-isolate-paused",
	})
	if err != nil {
		t.Fatalf("expected sandbox already-paused to be treated as success, got err=%v", err)
	}
	if dao.entity.Status != modelinstance.InstanceStatusPaused {
		t.Fatalf("expected instance to flip to Paused, got %s", dao.entity.Status)
	}
}

// TestRunIsolateInstanceTaskPropagatesUnexpectedSandboxError 边界保护：
// 当 PauseSandbox 返非 not_found / 非 conflict 的真实错误时，子 task 必须冒泡错误，
// 让父 task 框架按 60s interval 重试，不能误吞。
func TestRunIsolateInstanceTaskPropagatesUnexpectedSandboxError(t *testing.T) {
	dao := &isolateInstanceDaoStub{
		entity: &modelinstance.Entity{
			Id:         203,
			InstanceId: "ins-isolate-sb-svc-err",
			Status:     modelinstance.InstanceStatusRunning,
			SandboxId:  "sbx-isolate-svc-err",
		},
	}
	unexpected := errors.New("sandbox service unavailable")
	sb := &isolateSandboxStub{pauseErr: unexpected}
	l := newIsolateLogicWith(dao, sb)
	ctx := pctx.NewContext(nil).WithUserID("user-isolate-svc-err")

	err := l.RunIsolateInstanceTask(ctx, &common.IsolateInstanceTaskPayload{
		InstanceID: "ins-isolate-sb-svc-err",
		PassID:     "pass-isolate-svc-err",
	})
	if err == nil {
		t.Fatal("expected unexpected sandbox error to be propagated, got nil")
	}
	if !errors.Is(err, unexpected) {
		t.Fatalf("expected wrapped error to chain unexpected sandbox error, got %v", err)
	}
	if dao.transitionCalls != 0 {
		t.Fatalf("expected TransitionStatus NOT to be called when sandbox call fails, got %d", dao.transitionCalls)
	}
	if dao.entity.Status != modelinstance.InstanceStatusRunning {
		t.Fatalf("expected instance to remain Running on sandbox failure, got %s", dao.entity.Status)
	}
}
