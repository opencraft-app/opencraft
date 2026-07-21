// Package instance 测试文件：RenewInstance 子 task 的 sandbox 错误容错单测。
//
// 设计稿：.tmp/trade-pass-renew-design.md §3.4 / §5 / R-D-4
//
// 与 IsolateInstance / DestroyInstance 子 task 对偶 — 三者都需要对 sandbox 异常做幂等容错，
// 否则一次性的 sandbox 状态偏差会持续阻塞 trade 续费 / 隔离 / 销毁的父 task 收尾。
//
// 关键不变量：
//   - sandbox not_found    → 视为成功，继续走 CAS Paused→Running（与 DeleteSandbox 容错对偶）
//   - sandbox already running → 视为成功，继续走 CAS（已有逻辑，本测试做回归保护）
//   - 其它 sandbox 错误     → 冒泡，触发父 task 重试（不能误吞）
package instance

import (
	"context"
	"errors"
	"strings"
	"testing"

	pllmgateway "ctl/pkg/adapter/llmgateway"
	psandbox "ctl/pkg/adapter/sandbox"
	"ctl/pkg/config"
	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	modelinstance "ctl/pkg/model/instance"
	"ctl/pkg/taskruntime/common"

	"go.uber.org/zap"
)

// renewInstanceDaoStub 仅实现 RunRenewInstanceTask 走过的两个 DAO 方法。
//
// 嵌入 modelinstance.Dao 让其它未实现的方法签名继承自接口零值（被调用时会 panic，
// 但 RunRenewInstanceTask 仅会调到 GetByInstanceID + TransitionStatus 这两个）。
type renewInstanceDaoStub struct {
	modelinstance.Dao
	entity           *modelinstance.Entity
	transitionErr    error
	transitionCalls  int
	lastFromStatuses []string
	lastTargetStatus string
}

func TestRunRenewInstanceTaskMigratesRunningAgentToLLMGateway(t *testing.T) {
	installCreateTaskAiGatewayConfig(t)

	dao := &createTaskInstanceDaoStub{entity: &modelinstance.Entity{
		Id:             201,
		InstanceId:     "ins-renew-migrate",
		UserId:         "user-renew-migrate",
		Status:         modelinstance.InstanceStatusRunning,
		SandboxId:      "sbx-renew-migrate",
		AiGatewayKeyID: "legacy-key",
	}}
	sandbox := &createTaskSandboxAdapterStub{}
	llm := &createTaskLLMGatewayAdapterStub{createResp: &pllmgateway.CreateApiKeyResponse{
		KeyID:     "llm-key-new",
		KeyPrefix: "sk-lgw-new",
		APIKey:    "sk-lgw-new-secret",
	}}
	l := &logic{
		instanceDao:                  dao,
		sandboxAdapter:               sandbox,
		llmGatewayAdapter:            llm,
		logger:                       zap.NewNop(),
		legacyPassEntitlementEnsurer: legacyPassEntitlementAlreadyReady,
	}

	err := l.RunRenewInstanceTask(
		pctx.NewContext(nil).WithUserID("user-renew-migrate"),
		&common.RenewInstanceTaskPayload{
			InstanceID:    "ins-renew-migrate",
			PassID:        "pass-renew-migrate",
			TargetGateway: "llm_gateway",
		},
	)
	if err != nil {
		t.Fatalf("migrate running agent during renewal: %v", err)
	}
	if len(llm.ensureCalls) != 1 || llm.createCalls != 1 {
		t.Fatalf("expected llmgateway user/key preparation, ensure=%+v create=%d", llm.ensureCalls, llm.createCalls)
	}
	if dao.entity.AiGatewayKeyID != "llm-key-new" {
		t.Fatalf("persisted key id = %q, want llm-key-new", dao.entity.AiGatewayKeyID)
	}
	if len(sandbox.processCalls) != 2 {
		t.Fatalf("expected cli bootstrap plus atomic model-save/restart command, got %d calls", len(sandbox.processCalls))
	}
	command := sandbox.processCalls[1].Args[2]
	for _, fragment := range []string{
		"acli provider save",
		"https://model.internal/v1",
		"sk-lgw-new-secret",
		"acli model switch --model",
		"acli gateway restart",
	} {
		if !strings.Contains(command, fragment) {
			t.Fatalf("migration command missing %q: %s", fragment, command)
		}
	}
	if got := llm.revoked; len(got) != 0 {
		t.Fatalf("renewal migration must retain old key for natural expiry, revoked=%+v", got)
	}
	if config.ServerConf.AdapterConfig.LLMGateway.DefaultBaseURL != "https://model.internal/v1" {
		t.Fatal("test setup lost llmgateway runtime configuration")
	}
}

func (s *renewInstanceDaoStub) GetByInstanceID(_ pctx.Context, _ string) (*modelinstance.Entity, error) {
	if s.entity == nil {
		return nil, errcode.ErrInstanceNotFound
	}
	return s.entity, nil
}

func (s *renewInstanceDaoStub) TransitionStatus(_ pctx.Context, _ int64, fromStatuses []string, newStatus string) error {
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

// renewSandboxStub 仅实现 RunRenewInstanceTask 走过的 ResumeSandbox。
//
// 嵌入 psandbox.Adapter 让其它未实现方法继承自接口零值；本子 task 只会调到 ResumeSandbox。
type renewSandboxStub struct {
	psandbox.Adapter
	resumeErr   error
	resumeCalls int
}

func (s *renewSandboxStub) ResumeSandbox(_ context.Context, _ string, _ *psandbox.ResumeSandboxRequest) (*psandbox.Sandbox, error) {
	s.resumeCalls++
	if s.resumeErr != nil {
		return nil, s.resumeErr
	}
	return &psandbox.Sandbox{}, nil
}

func newRenewLogicWith(daoStub *renewInstanceDaoStub, sbStub *renewSandboxStub) *logic {
	return &logic{
		instanceDao:    daoStub,
		sandboxAdapter: sbStub,
		logger:         zap.NewNop(),
	}
}

// TestRunRenewInstanceTaskTreatsSandboxNotFoundAsSuccess BUG-32 修复回归：
// 当 ResumeSandbox 返 ErrSandboxNotFound 时，子 task 应继续走 CAS Paused→Running 并视为成功。
// 行为对齐 IsolateInstance / DestroyInstance 子 task 对 sandbox 缺失的幂等容错。
func TestRunRenewInstanceTaskTreatsSandboxNotFoundAsSuccess(t *testing.T) {
	dao := &renewInstanceDaoStub{
		entity: &modelinstance.Entity{
			Id:         101,
			InstanceId: "ins-renew-sb-404",
			Status:     modelinstance.InstanceStatusPaused,
			SandboxId:  "sbx-renew-404",
		},
	}
	sb := &renewSandboxStub{resumeErr: errcode.ErrSandboxNotFound}
	l := newRenewLogicWith(dao, sb)
	ctx := pctx.NewContext(nil).WithUserID("user-renew-404")

	err := l.RunRenewInstanceTask(ctx, &common.RenewInstanceTaskPayload{
		InstanceID: "ins-renew-sb-404",
		PassID:     "pass-renew-404",
	})
	if err != nil {
		t.Fatalf("expected sandbox not_found to be treated as success, got err=%v", err)
	}
	if sb.resumeCalls != 1 {
		t.Fatalf("expected ResumeSandbox to be called exactly once, got %d", sb.resumeCalls)
	}
	if dao.transitionCalls != 1 {
		t.Fatalf("expected TransitionStatus to be called exactly once, got %d", dao.transitionCalls)
	}
	if dao.lastTargetStatus != modelinstance.InstanceStatusRunning {
		t.Fatalf("expected target status Running, got %s", dao.lastTargetStatus)
	}
	if dao.entity.Status != modelinstance.InstanceStatusRunning {
		t.Fatalf("expected instance to flip to Running, got %s", dao.entity.Status)
	}
}

// TestRunRenewInstanceTaskTreatsSandboxAlreadyRunningAsSuccess 已有逻辑回归保护：
// 当 ResumeSandbox 返 "already running" 类冲突时，子 task 应视为成功并继续 CAS。
func TestRunRenewInstanceTaskTreatsSandboxAlreadyRunningAsSuccess(t *testing.T) {
	dao := &renewInstanceDaoStub{
		entity: &modelinstance.Entity{
			Id:         102,
			InstanceId: "ins-renew-sb-running",
			Status:     modelinstance.InstanceStatusPaused,
			SandboxId:  "sbx-renew-running",
		},
	}
	sb := &renewSandboxStub{
		resumeErr: errcode.Wrap(errcode.ErrSandboxStatusConflict, "sandbox already running"),
	}
	l := newRenewLogicWith(dao, sb)
	ctx := pctx.NewContext(nil).WithUserID("user-renew-running")

	err := l.RunRenewInstanceTask(ctx, &common.RenewInstanceTaskPayload{
		InstanceID: "ins-renew-sb-running",
		PassID:     "pass-renew-running",
	})
	if err != nil {
		t.Fatalf("expected sandbox already-running to be treated as success, got err=%v", err)
	}
	if dao.entity.Status != modelinstance.InstanceStatusRunning {
		t.Fatalf("expected instance to flip to Running, got %s", dao.entity.Status)
	}
}

// TestRunRenewInstanceTaskPropagatesUnexpectedSandboxError 边界保护：
// 当 ResumeSandbox 返非 not_found / 非 conflict 的真实错误时，子 task 必须冒泡错误，
// 让父 task 框架按 60s interval 重试，不能误吞。
func TestRunRenewInstanceTaskPropagatesUnexpectedSandboxError(t *testing.T) {
	dao := &renewInstanceDaoStub{
		entity: &modelinstance.Entity{
			Id:         103,
			InstanceId: "ins-renew-sb-svc-err",
			Status:     modelinstance.InstanceStatusPaused,
			SandboxId:  "sbx-renew-svc-err",
		},
	}
	unexpected := errors.New("sandbox service unavailable")
	sb := &renewSandboxStub{resumeErr: unexpected}
	l := newRenewLogicWith(dao, sb)
	ctx := pctx.NewContext(nil).WithUserID("user-renew-svc-err")

	err := l.RunRenewInstanceTask(ctx, &common.RenewInstanceTaskPayload{
		InstanceID: "ins-renew-sb-svc-err",
		PassID:     "pass-renew-svc-err",
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
	if dao.entity.Status != modelinstance.InstanceStatusPaused {
		t.Fatalf("expected instance to remain Paused on sandbox failure, got %s", dao.entity.Status)
	}
}
