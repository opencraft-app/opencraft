package instance

import (
	"errors"
	"fmt"
	"time"

	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	instancelogic "ctl/pkg/instance"
	daoFactory "ctl/pkg/model/factory"
	modelinstance "ctl/pkg/model/instance"
	taskmodel "ctl/pkg/model/task"
	"ctl/pkg/taskflow"
	"ctl/pkg/taskruntime"
	taskcommon "ctl/pkg/taskruntime/common"

	"go.uber.org/zap"
)

// === trade-pass-destroy 销毁子 task DestroyInstanceWithSnapshot 实现（设计稿 §4.7 / §11-A Q5 / Q9 / Q10 / Q21 / Q25）===
//
// 行为契约（与 IsolateInstance 子 task 同骨架，差异在 execute 4 阶段流程）：
//   - 每个 DestroyInstanceWithSnapshot 子 task 对应一台 instance；多个 instance 时父 task 派发多个子 task
//   - execute（设计稿 §4.7）：
//     1. 阶段 1（payload.SnapshotID==""）：sandbox.CreateSnapshot 触发系统盘快照创建
//     2. 阶段 2（!SnapshotsDone）：sandbox.GetSnapshotStatus 轮询至 ready / failed / 跳过
//     3. 阶段 3：sandbox.DeleteSandbox 销毁 cvm
//     4. 阶段 4：CAS instance.status (Running/Paused/Deleting/Creating) → Deleted
//   - 重试节奏（与 IsolateInstance 同）：interval=60s × max=60 = 1h 重试窗口
//
// finalizeFailure 行为（与 isolate_task.go 的 I-MR-1 同范式）：
//   - 默认分支：markRetryable → task_state=Created（非终态）→ checkTasks bypass 60s 后重投
//     覆盖 sandbox 5xx / snapshot in-progress / DeleteSandbox 暂态失败 / CAS 冲突等可重试错。
//   - fail-fast 分支：errors.Is(err, instancelogic.ErrSnapshotPermanentFailed) 命中时走 failTask
//     → task_state=Failed（终态）→ 父 task 立刻重派新子 task。覆盖 cbs StateError 不可逆失败 /
//     payload 参数性致命错。
//   - 均不回滚 instance.status；reconcile worker 兑底。
//
// 重投幂等：
//   - payload.SnapshotID 已写回 → 跳过阶段 1；即使未写回，sandbox 端 cbs ClientToken={PassID}-{InstanceID}
//     幂等保护也会复用同一个 snapshot 资源。
//   - SnapshotsDone==true → 跳过阶段 1+2；阶段 3+4 通过反查 instance.status==Deleted 判断幂等。
const (
	// DestroyInstanceWithSnapshot 子 task lock 时长（与 IsolateInstance 同）
	destroyInstanceForPassTaskLockSeconds = instanceTaskLockSeconds
)

type destroyInstanceForPassTask struct {
	*taskruntime.BaseTask
	in             *taskcommon.DestroyInstanceForPassTaskPayload
	lastExecuteErr error
}

func newDestroyInstanceForPassTask() *destroyInstanceForPassTask {
	task := &destroyInstanceForPassTask{
		BaseTask: taskruntime.NewBaseTask(),
	}
	task.TaskLockSeconds = destroyInstanceForPassTaskLockSeconds
	task.ExceedMaxExecuteCountFunc = task.exceedMaxExecuteCount
	return task
}

// PrepareDestroyInstanceForPassTask 由 processor.factory 注册到 pfMap，task 框架解码 MQ payload 后回调
func PrepareDestroyInstanceForPassTask(_ pctx.Context, data []byte) (task taskruntime.ServiceTask, in, out interface{}, err error) {
	task = newDestroyInstanceForPassTask()
	in = new(taskcommon.DestroyInstanceForPassTaskPayload)
	err = parseMessageData(data, in)
	return
}

func (t *destroyInstanceForPassTask) Init(in, _ interface{}) error {
	payload, ok := in.(*taskcommon.DestroyInstanceForPassTaskPayload)
	if !ok {
		return fmt.Errorf("unexpected destroy instance for pass task payload: %T", in)
	}
	t.in = payload
	return nil
}

func (t *destroyInstanceForPassTask) Name() string {
	return taskcommon.TaskNameDestroyInstanceWithSnapshot
}
func (t *destroyInstanceForPassTask) FirstStepKey() string { return taskruntime.StepKeyLockTask }

func (t *destroyInstanceForPassTask) StepConfigMap() map[string]*taskflow.StepConfig[pctx.Context] {
	stepMap := instanceTaskStepConfigMap(t.BaseTask, t.execute, t.onExecuteFailed, t.idempotentCheck)
	stepMap[stepKeyFinalizeFailure].StepFunc = t.finalizeFailure
	return stepMap
}

// execute 调 logic.RunDestroyInstanceForPassTask 走 4 阶段流程
//
// 关键：UpdatePayload 持久化进度位需要拿到本 task 的 task_id，因此把 t.TaskId 透传给 logic 层。
// snapshotPollWaitErr / 业务错都通过 return error 让框架走重投或 finalizeFailure 路径。
func (t *destroyInstanceForPassTask) execute(ctx pctx.Context) (string, error) {
	if err := instancelogic.ExecuteDestroyInstanceForPassTask(ctx, t.TaskId, t.in); err != nil {
		return "", err
	}
	return t.markSuccess(ctx)
}

// idempotentCheck 锁竞争场景：检查 instance 是否已 Deleted；若是 → markSuccess（与 IsolateInstance 同范式）
func (t *destroyInstanceForPassTask) idempotentCheck(ctx pctx.Context) (string, error) {
	if t.in == nil || t.in.InstanceID == "" {
		return "", fmt.Errorf("idempotent check: missing instance id")
	}
	instanceDao := daoFactory.DefaultDaoFactory.InstanceDao(ctx)
	entity, err := instanceDao.GetByInstanceID(ctx, t.in.InstanceID)
	if err != nil {
		if errors.Is(err, errcode.ErrInstanceNotFound) {
			ctx.Logger().Info("destroy idempotent check: instance not found, treat as already destroyed",
				zap.String("instance_id", t.in.InstanceID),
			)
			return t.markSuccess(ctx)
		}
		ctx.Logger().Warn("destroy idempotent check: query instance failed, treat as lock contention",
			zap.Error(err),
			zap.String("instance_id", t.in.InstanceID),
		)
		return "", fmt.Errorf("LockTask failed and idempotent check unavailable: %w", err)
	}

	switch entity.Status {
	case modelinstance.InstanceStatusDeleted, modelinstance.InstanceStatusFailed:
		ctx.Logger().Info("destroy idempotent check: instance already in terminal state",
			zap.String("instance_id", t.in.InstanceID),
			zap.String("status", entity.Status),
		)
		return t.markSuccess(ctx)
	}

	ctx.Logger().Warn("destroy idempotent check: instance not yet terminal, exiting as lock contention",
		zap.String("instance_id", t.in.InstanceID),
		zap.String("status", entity.Status),
	)
	return "", fmt.Errorf("LockTask failed, instance status=%s (not yet terminal)", entity.Status)
}

func (t *destroyInstanceForPassTask) onExecuteFailed(_ string, err error) {
	t.lastExecuteErr = err
	t.recordFailureMessage(err)
}

func (t *destroyInstanceForPassTask) finalizeFailure(ctx pctx.Context) (string, error) {
	err := t.lastExecuteErr
	if err == nil {
		err = errors.New("destroy instance for pass task execute failed")
	}
	instancelogic.FinalizeDestroyInstanceForPassTaskFailure(ctx, t.in, err)

	// fail-fast：哨兵 ErrSnapshotPermanentFailed 命中表示不可重试错误（cbs snapshot StateError /
	// payload 参数性致命错），跳过 60 次 1h 重试窗口直接进终态 Failed，让父 task 立刻重派新子 task。
	if errors.Is(err, instancelogic.ErrSnapshotPermanentFailed) {
		ctx.Logger().Error("destroy instance for pass task permanent failure, fail-fast to terminal Failed",
			zap.Error(err),
			zap.String("instance_id", t.in.InstanceID),
			zap.String("pass_id", t.in.PassID),
		)
		return t.failTask(ctx, taskmodel.TruncateMessage(err))
	}

	// D-MR-1：与 isolate_task.go 的 I-MR-1 / pass/worker renew_task 的 R-MR-6 同范式。
	// 单次 execute 失败不进 FAILED 终态，而是回写 task_state=CREATED 让 checkTasks bypass（每分钟扫描）
	// 重投，借助 max_execute_count=60 × ExecuteInterval=60s ≈ 1h 重试窗口兜底。真正终态失败由
	// exceedMaxExecuteCount 入口（execute_count >= max_execute_count）触发。
	//
	// 历史 Bug（bugA）：原实现为 completeTaskFailure，一次 execute error（含 sandbox 5xx /
	// snapshotPollWaitErr / DeleteSandbox 暂态失败 / CAS 冲突）立刻 markFailed → checkTasks bypass
	// 不再扫（只扫 UnCompletedTaskStates={CREATED,RUNNING}），导致子 task 死透；本变更让子 task
	// 具备暂态自愈能力。幂等保护：sandbox 端 cbs ClientToken={PassID}-{InstanceID} 保证重试只创建 1 个 snapshot。
	ctx.Logger().Warn("destroy instance for pass task transient failure, will be retried by checkTasks bypass",
		zap.Error(err),
		zap.String("instance_id", t.in.InstanceID),
		zap.String("pass_id", t.in.PassID),
		zap.Int("execute_count", t.TaskEntity.ExecuteCount),
		zap.Int("max_execute_count", t.TaskEntity.MaxExecuteCount),
	)
	return t.markRetryable(ctx, taskmodel.TruncateMessage(err))
}

// markRetryable 把 task_state 回写为 CREATED（非终态）+ 写入诊断 task_message。
//
// 与 completeTaskFailure 的区别（与 isolate_task.go markRetryable 同范式）：
//   - completeTaskFailure：task_state=FAILED（终态）→ checkTasks bypass 不再扫 → 链路死亡
//   - markRetryable：task_state=CREATED（非终态）→ checkTasks bypass 1 分钟内扫到 →
//     重投 MQ → 框架按 ExecuteInterval(60s) 重投，max_execute_count(60) 兜底
func (t *destroyInstanceForPassTask) markRetryable(ctx pctx.Context, message string) (string, error) {
	if err := daoFactory.DefaultDaoFactory.TaskDao(ctx).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:   taskmodel.StateCreated,
		taskmodel.ColumnTaskMessage: message,
	}, t.TaskId); err != nil {
		return "", fmt.Errorf("update destroy instance for pass task retryable state: %w", err)
	}
	t.TaskEntity.TaskState = taskmodel.StateCreated
	t.TaskEntity.TaskMessage = message
	return taskflow.StepCodeSuccess, nil
}

func (t *destroyInstanceForPassTask) exceedMaxExecuteCount(ctx pctx.Context) (string, error) {
	instancelogic.FinalizeDestroyInstanceForPassTaskFailure(ctx, t.in, fmt.Errorf("max execute count exceeded"))
	return t.failTask(ctx, "ExecuteCount greater than or equal to MaxExecuteCount")
}

func (t *destroyInstanceForPassTask) failTask(ctx pctx.Context, message string) (string, error) {
	if _, err := t.completeTaskFailure(ctx, message); err != nil {
		return "", err
	}
	return "", errors.New(message)
}

func (t *destroyInstanceForPassTask) markSuccess(ctx pctx.Context) (string, error) {
	if err := daoFactory.DefaultDaoFactory.TaskDao(ctx).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:   taskmodel.StateSuccess,
		taskmodel.ColumnTaskMessage: "",
	}, t.TaskId); err != nil {
		return "", fmt.Errorf("update destroy instance for pass task success state: %w", err)
	}
	t.TaskEntity.TaskState = taskmodel.StateSuccess
	t.TaskEntity.TaskMessage = ""
	return taskflow.StepCodeSuccess, nil
}

func (t *destroyInstanceForPassTask) completeTaskFailure(ctx pctx.Context, message string) (string, error) {
	if err := daoFactory.DefaultDaoFactory.TaskDao(ctx).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:       taskmodel.StateFailed,
		taskmodel.ColumnTaskMessage:     message,
		taskmodel.ColumnLastExecuteTime: time.Now().UTC(),
	}, t.TaskId); err != nil {
		return "", fmt.Errorf("update destroy instance for pass task failed state: %w", err)
	}
	t.TaskEntity.TaskState = taskmodel.StateFailed
	t.TaskEntity.TaskMessage = message
	return taskflow.StepCodeSuccess, nil
}

func (t *destroyInstanceForPassTask) recordFailureMessage(err error) {
	_ = daoFactory.DefaultDaoFactory.TaskDao(nil).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskMessage: taskmodel.TruncateMessage(err),
	}, t.TaskId)
}
