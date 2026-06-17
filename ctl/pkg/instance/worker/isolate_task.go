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

// === trade-pass-isolate 子 task 实现（设计稿 §10 Q22-I-D / Q26-D 修订版 / Q29 / Q32）===
//
// 行为契约：
//   - 每个 IsolateInstance 子 task 对应一台 instance；多个 instance 时父 task 派发多个子 task
//   - execute：调 sandbox.PauseSandbox 走关机语义 + CAS Running → Paused
//   - finalizeFailure：execute 一直失败到 max_execute_count 后，CAS Pausing→Running 不需要
//     （instance entity 没有 Pausing 中间态，整个流程对 instance.status 是 "Running → Paused" 直接迁移，
//      execute 失败时 instance 仍是 Running 不需回滚）
//
// 重试窗口（Q22-I-D）：interval=60s × max=60 = 1h，覆盖 sandbox 短暂抖动场景

const (
	// IsolateInstance 子 task 复用与 create/destroy 相同的 lock 时长（10min），单次 PauseSandbox 不需要更长
	isolateInstanceTaskLockSeconds = instanceTaskLockSeconds
)

type isolateInstanceTask struct {
	*taskruntime.BaseTask
	in             *taskcommon.IsolateInstanceTaskPayload
	lastExecuteErr error
}

func newIsolateInstanceTask() *isolateInstanceTask {
	task := &isolateInstanceTask{
		BaseTask: taskruntime.NewBaseTask(),
	}
	task.TaskLockSeconds = isolateInstanceTaskLockSeconds
	task.ExceedMaxExecuteCountFunc = task.exceedMaxExecuteCount
	return task
}

// PrepareIsolateInstanceTask 由 processor.factory 注册到 pfMap，task 框架解码 MQ payload 后回调
func PrepareIsolateInstanceTask(_ pctx.Context, data []byte) (task taskruntime.ServiceTask, in, out interface{}, err error) {
	task = newIsolateInstanceTask()
	in = new(taskcommon.IsolateInstanceTaskPayload)
	err = parseMessageData(data, in)
	return
}

func (t *isolateInstanceTask) Init(in, _ interface{}) error {
	payload, ok := in.(*taskcommon.IsolateInstanceTaskPayload)
	if !ok {
		return fmt.Errorf("unexpected isolate instance task payload: %T", in)
	}
	t.in = payload
	return nil
}

func (t *isolateInstanceTask) Name() string         { return taskcommon.TaskNameIsolateInstance }
func (t *isolateInstanceTask) FirstStepKey() string { return taskruntime.StepKeyLockTask }

func (t *isolateInstanceTask) StepConfigMap() map[string]*taskflow.StepConfig[pctx.Context] {
	stepMap := instanceTaskStepConfigMap(t.BaseTask, t.execute, t.onExecuteFailed, t.idempotentCheck)
	stepMap[stepKeyFinalizeFailure].StepFunc = t.finalizeFailure
	return stepMap
}

func (t *isolateInstanceTask) execute(ctx pctx.Context) (string, error) {
	if err := instancelogic.ExecuteIsolateInstanceTask(ctx, t.in); err != nil {
		return "", err
	}
	return t.markSuccess(ctx)
}

// idempotentCheck 在 LockTask 失败（重入场景）时检查实例是否已到终态。
// 若实例已 Paused，说明前一次执行已成功，直接收口 task 为 SUCCESS。
// 若实例已 Deleted/Failed，也视为 SUCCESS（已无 sandbox 可关机，目标已达成）。
func (t *isolateInstanceTask) idempotentCheck(ctx pctx.Context) (string, error) {
	if t.in == nil || t.in.InstanceID == "" {
		return "", fmt.Errorf("idempotent check: missing instance id")
	}
	instanceDao := daoFactory.DefaultDaoFactory.InstanceDao(ctx)
	entity, err := instanceDao.GetByInstanceID(ctx, t.in.InstanceID)
	if err != nil {
		if errors.Is(err, errcode.ErrInstanceNotFound) {
			ctx.Logger().Info("idempotent check: instance not found, treat as already isolated",
				zap.String("instance_id", t.in.InstanceID),
			)
			return t.markSuccess(ctx)
		}
		ctx.Logger().Warn("idempotent check: query instance failed, treat as lock contention",
			zap.Error(err),
			zap.String("instance_id", t.in.InstanceID),
		)
		return "", fmt.Errorf("LockTask failed and idempotent check unavailable: %w", err)
	}

	switch entity.Status {
	case modelinstance.InstanceStatusPaused, modelinstance.InstanceStatusDeleted, modelinstance.InstanceStatusFailed:
		ctx.Logger().Info("idempotent check: instance already in terminal pause/end state",
			zap.String("instance_id", t.in.InstanceID),
			zap.String("status", entity.Status),
		)
		return t.markSuccess(ctx)
	}

	ctx.Logger().Warn("idempotent check: instance not yet paused, exiting as lock contention",
		zap.String("instance_id", t.in.InstanceID),
		zap.String("status", entity.Status),
	)
	return "", fmt.Errorf("LockTask failed, instance status=%s (not yet paused)", entity.Status)
}

func (t *isolateInstanceTask) onExecuteFailed(_ string, err error) {
	t.lastExecuteErr = err
	t.recordFailureMessage(err)
}

func (t *isolateInstanceTask) finalizeFailure(ctx pctx.Context) (string, error) {
	err := t.lastExecuteErr
	if err == nil {
		err = errors.New("isolate instance task execute failed")
	}
	// I-MR-1 修复：与 R-MR-6 同范式，单次 execute 失败不进 FAILED 终态，
	// 而是回写 task_state=CREATED 让 checkTasks bypass（每分钟扫描）重投，
	// 借助 max_execute_count=60（≈ 60min 重试窗口）兜底。真正终态失败由
	// exceedMaxExecuteCount 入口（execute_count >= max_execute_count）触发。
	//
	// 历史 Bug：原实现 1 次 execute 失败立即 markFailed → checkTasks bypass
	// 不再扫（只扫 UnCompletedTaskStates={CREATED,RUNNING}），父 IsolatePass
	// 在新的 step 4 SUCCESS/FAILED 二分逻辑下会重派子 task，本变更让子 task
	// 自身也具备暂态自愈能力（典型场景：sandbox 重启窗口期短暂 503）。
	ctx.Logger().Warn("isolate instance task transient failure, will be retried by checkTasks bypass",
		zap.Error(err),
		zap.String("instance_id", t.in.InstanceID),
		zap.Int("execute_count", t.TaskEntity.ExecuteCount),
		zap.Int("max_execute_count", t.TaskEntity.MaxExecuteCount),
	)
	return t.markRetryable(ctx, taskmodel.TruncateMessage(err))
}

// markRetryable 把 task_state 回写为 CREATED（非终态）+ 写入诊断 task_message。
//
// 与 completeTaskFailure 的区别（与 pass/worker isolate_task / renew_task / rollback_renew_task
// 的 markRetryable 同范式）：
//   - completeTaskFailure：task_state=FAILED（终态）→ checkTasks bypass 不再扫 → 链路死亡
//   - markRetryable：task_state=CREATED（非终态）→ checkTasks bypass 1 分钟内扫到 →
//     重投 MQ → 框架按 ExecuteInterval(60s) 重投，max_execute_count(60) 兜底
func (t *isolateInstanceTask) markRetryable(ctx pctx.Context, message string) (string, error) {
	if err := daoFactory.DefaultDaoFactory.TaskDao(ctx).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:   taskmodel.StateCreated,
		taskmodel.ColumnTaskMessage: message,
	}, t.TaskId); err != nil {
		return "", fmt.Errorf("update isolate instance task retryable state: %w", err)
	}
	t.TaskEntity.TaskState = taskmodel.StateCreated
	t.TaskEntity.TaskMessage = message
	return taskflow.StepCodeSuccess, nil
}

func (t *isolateInstanceTask) exceedMaxExecuteCount(ctx pctx.Context) (string, error) {
	instancelogic.FinalizeIsolateInstanceTaskFailure(ctx, t.in, fmt.Errorf("max execute count exceeded"))
	return t.failTask(ctx, "ExecuteCount greater than or equal to MaxExecuteCount")
}

func (t *isolateInstanceTask) failTask(ctx pctx.Context, message string) (string, error) {
	if _, err := t.completeTaskFailure(ctx, message); err != nil {
		return "", err
	}
	return "", errors.New(message)
}

func (t *isolateInstanceTask) markSuccess(ctx pctx.Context) (string, error) {
	if err := daoFactory.DefaultDaoFactory.TaskDao(ctx).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:   taskmodel.StateSuccess,
		taskmodel.ColumnTaskMessage: "",
	}, t.TaskId); err != nil {
		return "", fmt.Errorf("update isolate instance task success state: %w", err)
	}
	t.TaskEntity.TaskState = taskmodel.StateSuccess
	t.TaskEntity.TaskMessage = ""
	return taskflow.StepCodeSuccess, nil
}

func (t *isolateInstanceTask) completeTaskFailure(ctx pctx.Context, message string) (string, error) {
	if err := daoFactory.DefaultDaoFactory.TaskDao(ctx).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:       taskmodel.StateFailed,
		taskmodel.ColumnTaskMessage:     message,
		taskmodel.ColumnLastExecuteTime: time.Now().UTC(),
	}, t.TaskId); err != nil {
		return "", fmt.Errorf("update isolate instance task failed state: %w", err)
	}
	t.TaskEntity.TaskState = taskmodel.StateFailed
	t.TaskEntity.TaskMessage = message
	return taskflow.StepCodeSuccess, nil
}

func (t *isolateInstanceTask) recordFailureMessage(err error) {
	_ = daoFactory.DefaultDaoFactory.TaskDao(nil).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskMessage: taskmodel.TruncateMessage(err),
	}, t.TaskId)
}
