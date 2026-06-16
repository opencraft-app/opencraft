package instance

import (
	"testing"

	"ctl/pkg/taskflow"
	"ctl/pkg/taskruntime"
	taskcommon "ctl/pkg/taskruntime/common"
)

// TestIsolateInstanceTaskStepConfigMap_FinalizeFailureWired I-MR-1 修复回归：
// IsolateInstance 子 task 的 FinalizeFailure step 必须挂上 markRetryable 路径（非 completeTaskFailure）。
// 仅做结构性断言：step 存在 + StepFunc 不为 nil + 路由出口指向 UnlockTask（与 instance/worker 同骨架）。
//
// 行为正确性（execute err → markRetryable → state=CREATED）由 sandbox-bj-7 实测覆盖
// （与 R-MR-6 RenewPass / RollbackRenewPass 同范式，复用同一条 checkTasks bypass 重投回路）。
func TestIsolateInstanceTaskStepConfigMap_FinalizeFailureWired(t *testing.T) {
	task := newIsolateInstanceTask()
	task.in = &taskcommon.IsolateInstanceTaskPayload{InstanceID: "test-inst"}
	stepMap := task.StepConfigMap()

	finalizeStep, ok := stepMap[stepKeyFinalizeFailure]
	if !ok {
		t.Fatal("FinalizeFailure step not found in IsolateInstance task")
	}
	if finalizeStep.StepFunc == nil {
		t.Error("FinalizeFailure step has nil StepFunc; markRetryable wiring missing")
	}
	if finalizeStep.RouteMap[taskflow.StepCodeSuccess] != taskruntime.StepKeyUnlockTask {
		t.Errorf("FinalizeFailure success route = %q, want UnlockTask",
			finalizeStep.RouteMap[taskflow.StepCodeSuccess])
	}
	if finalizeStep.RouteMap[taskflow.StepCodeFailure] != taskruntime.StepKeyUnlockTask {
		t.Errorf("FinalizeFailure failure route = %q, want UnlockTask",
			finalizeStep.RouteMap[taskflow.StepCodeFailure])
	}
}

// TestIsolateInstanceTaskExceedMaxExecuteCountWired I-MR-1 修复回归：
// 真终态收口由 ExceedMaxExecuteCountFunc 在 max_execute_count 用尽时触发（调
// FinalizeIsolateInstanceTaskFailure → completeOperation 把 operation 推到 failed 终态）。
// 这里仅做结构性断言：钩子已挂上，避免回归 markRetryable 改动同时漏掉真终态出口。
func TestIsolateInstanceTaskExceedMaxExecuteCountWired(t *testing.T) {
	task := newIsolateInstanceTask()
	task.in = &taskcommon.IsolateInstanceTaskPayload{InstanceID: "test-inst"}
	if task.ExceedMaxExecuteCountFunc == nil {
		t.Fatal("ExceedMaxExecuteCountFunc not wired; max_execute_count exhaustion path missing")
	}
}
