package instance

import (
	"testing"
	"time"

	"ctl/pkg/taskflow"
	"ctl/pkg/taskruntime"
	taskcommon "ctl/pkg/taskruntime/common"
)

// TestCreateTaskStepConfigMap_LockFailureRoutesToIdempotentCheck 验证
// LockTask 失败时路由到 IdempotentCheck 而非直接 UnlockTask
func TestCreateTaskStepConfigMap_LockFailureRoutesToIdempotentCheck(t *testing.T) {
	task := newCreateInstanceTask()
	task.in = &taskcommon.CreateInstanceTaskPayload{InstanceID: "test-inst"}
	stepMap := task.StepConfigMap()

	// LockTask 失败应路由到 IdempotentCheck
	lockStep, ok := stepMap[taskruntime.StepKeyLockTask]
	if !ok {
		t.Fatal("LockTask step not found")
	}
	failRoute := lockStep.RouteMap[taskflow.StepCodeFailure]
	if failRoute != stepKeyIdempotentCheck {
		t.Errorf("LockTask failure route = %q, want %q", failRoute, stepKeyIdempotentCheck)
	}

	// IdempotentCheck 步骤应存在，且 SUCCESS/FAILURE 都终止流程
	idempotentStep, ok := stepMap[stepKeyIdempotentCheck]
	if !ok {
		t.Fatal("IdempotentCheck step not found")
	}
	if idempotentStep.StepFunc == nil {
		t.Error("IdempotentCheck step has nil StepFunc")
	}
	if idempotentStep.RouteMap[taskflow.StepCodeSuccess] != "" {
		t.Errorf("IdempotentCheck success route should terminate, got %q", idempotentStep.RouteMap[taskflow.StepCodeSuccess])
	}
	if idempotentStep.RouteMap[taskflow.StepCodeFailure] != "" {
		t.Errorf("IdempotentCheck failure route should terminate, got %q", idempotentStep.RouteMap[taskflow.StepCodeFailure])
	}
}

// TestDestroyTaskStepConfigMap_LockFailureRoutesToIdempotentCheck 验证
// DestroyInstance 同样有幂等检查路由
func TestDestroyTaskStepConfigMap_LockFailureRoutesToIdempotentCheck(t *testing.T) {
	task := newDestroyInstanceTask()
	task.in = &taskcommon.DestroyInstanceTaskPayload{InstanceID: "test-inst"}
	stepMap := task.StepConfigMap()

	lockStep, ok := stepMap[taskruntime.StepKeyLockTask]
	if !ok {
		t.Fatal("LockTask step not found")
	}
	failRoute := lockStep.RouteMap[taskflow.StepCodeFailure]
	if failRoute != stepKeyIdempotentCheck {
		t.Errorf("LockTask failure route = %q, want %q", failRoute, stepKeyIdempotentCheck)
	}

	idempotentStep, ok := stepMap[stepKeyIdempotentCheck]
	if !ok {
		t.Fatal("IdempotentCheck step not found")
	}
	if idempotentStep.StepFunc == nil {
		t.Error("IdempotentCheck step has nil StepFunc")
	}
}

// TestStepConfigMap_NormalPathUnchanged 验证正常路径（LockTask成功）的路由没有被破坏
func TestStepConfigMap_NormalPathUnchanged(t *testing.T) {
	task := newCreateInstanceTask()
	task.in = &taskcommon.CreateInstanceTaskPayload{InstanceID: "test-inst"}
	stepMap := task.StepConfigMap()

	// LockTask 成功 → CheckTask
	lockStep := stepMap[taskruntime.StepKeyLockTask]
	if lockStep.RouteMap[taskflow.StepCodeSuccess] != taskruntime.StepKeyCheckTask {
		t.Errorf("LockTask success route = %q, want %q", lockStep.RouteMap[taskflow.StepCodeSuccess], taskruntime.StepKeyCheckTask)
	}

	// CheckTask 成功 → UpdateTaskExecute
	checkStep := stepMap[taskruntime.StepKeyCheckTask]
	if checkStep.RouteMap[taskflow.StepCodeSuccess] != taskruntime.StepKeyUpdateTaskExecute {
		t.Errorf("CheckTask success route = %q, want %q", checkStep.RouteMap[taskflow.StepCodeSuccess], taskruntime.StepKeyUpdateTaskExecute)
	}

	// UpdateTaskExecute 成功 → Execute
	updateStep := stepMap[taskruntime.StepKeyUpdateTaskExecute]
	if updateStep.RouteMap[taskflow.StepCodeSuccess] != "Execute" {
		t.Errorf("UpdateTaskExecute success route = %q, want %q", updateStep.RouteMap[taskflow.StepCodeSuccess], "Execute")
	}

	// Execute 成功 → UnlockTask；失败 → FinalizeFailure → UnlockTask
	executeStep := stepMap["Execute"]
	if executeStep.RouteMap[taskflow.StepCodeSuccess] != taskruntime.StepKeyUnlockTask {
		t.Errorf("Execute success route = %q, want %q", executeStep.RouteMap[taskflow.StepCodeSuccess], taskruntime.StepKeyUnlockTask)
	}
	if executeStep.RouteMap[taskflow.StepCodeFailure] != stepKeyFinalizeFailure {
		t.Errorf("Execute failure route = %q, want %q", executeStep.RouteMap[taskflow.StepCodeFailure], stepKeyFinalizeFailure)
	}

	finalizeStep, ok := stepMap[stepKeyFinalizeFailure]
	if !ok {
		t.Fatal("FinalizeFailure step not found")
	}
	if finalizeStep.StepFunc == nil {
		t.Error("FinalizeFailure step has nil StepFunc")
	}
	if finalizeStep.RouteMap[taskflow.StepCodeSuccess] != taskruntime.StepKeyUnlockTask {
		t.Errorf("FinalizeFailure success route = %q, want %q", finalizeStep.RouteMap[taskflow.StepCodeSuccess], taskruntime.StepKeyUnlockTask)
	}
	if finalizeStep.RouteMap[taskflow.StepCodeFailure] != taskruntime.StepKeyUnlockTask {
		t.Errorf("FinalizeFailure failure route = %q, want %q", finalizeStep.RouteMap[taskflow.StepCodeFailure], taskruntime.StepKeyUnlockTask)
	}
}

// TestLockTaskStepConfig_RetrySettings 验证 LockTask 步骤配置了正确的重试参数
func TestLockTaskStepConfig_RetrySettings(t *testing.T) {
	task := newCreateInstanceTask()
	task.in = &taskcommon.CreateInstanceTaskPayload{InstanceID: "test-inst"}
	stepMap := task.StepConfigMap()

	lockStep, ok := stepMap[taskruntime.StepKeyLockTask]
	if !ok {
		t.Fatal("LockTask step not found")
	}
	if lockStep.RetryCnt != 5 {
		t.Errorf("LockTask RetryCnt = %d, want 5", lockStep.RetryCnt)
	}
	if lockStep.RetryDelay != 3*time.Second {
		t.Errorf("LockTask RetryDelay = %v, want 3s", lockStep.RetryDelay)
	}
}

// TestInstanceTaskLockSeconds 验证锁 TTL 为 600 秒
func TestInstanceTaskLockSeconds(t *testing.T) {
	if instanceTaskLockSeconds != 600 {
		t.Errorf("instanceTaskLockSeconds = %d, want 600", instanceTaskLockSeconds)
	}
}
