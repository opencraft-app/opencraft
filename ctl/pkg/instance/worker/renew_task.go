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

// === trade-pass-renew 子 task 实现（设计稿 §3.4 / §5 / R-D-4）===
//
// 行为契约（与 IsolateInstanceTask 对偶反向）：
//   - 每个 RenewInstance 子 task 对应一台 instance；多个 instance 时父 task 派发多个子 task
//   - execute：调 sandbox.ResumeSandbox 走开机语义 + CAS Paused → Running
//   - finalizeFailure：execute 一直失败到 max_execute_count 后，不做状态回滚
//     （instance entity 没有 Resuming 中间态，整个流程对 instance.status 是 "Paused → Running" 直接迁移，
//      execute 失败时 instance 仍是 Paused，等下一轮父 task 重投或 reconcile 兜底）
//
// 重试窗口：interval=60s × max=60 = 1h，与 IsolateInstance 子 task 同节奏
//
// ⚠️ R-F 阻塞：sandbox 服务侧 ResumeSandbox handler 当前是 noop，本子 task 调通后 instance 状态
// 翻牌但 CVM 实际不开机；R-F 落地（sandbox handler 接 cp.StartInstance）后真闭环。

const (
	// RenewInstance 子 task 复用与 isolate 相同的 lock 时长（10min），单次 ResumeSandbox 不需要更长
	renewInstanceTaskLockSeconds = instanceTaskLockSeconds
)

type renewInstanceTask struct {
	*taskruntime.BaseTask
	in             *taskcommon.RenewInstanceTaskPayload
	lastExecuteErr error
}

func newRenewInstanceTask() *renewInstanceTask {
	task := &renewInstanceTask{
		BaseTask: taskruntime.NewBaseTask(),
	}
	task.TaskLockSeconds = renewInstanceTaskLockSeconds
	task.ExceedMaxExecuteCountFunc = task.exceedMaxExecuteCount
	return task
}

// PrepareRenewInstanceTask 由 processor.factory 注册到 pfMap，task 框架解码 MQ payload 后回调
func PrepareRenewInstanceTask(_ pctx.Context, data []byte) (task taskruntime.ServiceTask, in, out interface{}, err error) {
	task = newRenewInstanceTask()
	in = new(taskcommon.RenewInstanceTaskPayload)
	err = parseMessageData(data, in)
	return
}

func (t *renewInstanceTask) Init(in, _ interface{}) error {
	payload, ok := in.(*taskcommon.RenewInstanceTaskPayload)
	if !ok {
		return fmt.Errorf("unexpected renew instance task payload: %T", in)
	}
	t.in = payload
	return nil
}

func (t *renewInstanceTask) Name() string         { return taskcommon.TaskNameRenewInstance }
func (t *renewInstanceTask) FirstStepKey() string { return taskruntime.StepKeyLockTask }

func (t *renewInstanceTask) StepConfigMap() map[string]*taskflow.StepConfig[pctx.Context] {
	stepMap := instanceTaskStepConfigMap(t.BaseTask, t.execute, t.onExecuteFailed, t.idempotentCheck)
	stepMap[stepKeyFinalizeFailure].StepFunc = t.finalizeFailure
	return stepMap
}

func (t *renewInstanceTask) execute(ctx pctx.Context) (string, error) {
	if err := instancelogic.ExecuteRenewInstanceTask(ctx, t.in); err != nil {
		return "", err
	}
	return t.markSuccess(ctx)
}

// idempotentCheck 在 LockTask 失败（重入场景）时检查实例是否已到终态。
// 若实例已 Running，说明前一次执行已成功，直接收口 task 为 SUCCESS。
// 若实例已 Deleted/Failed，也视为 SUCCESS（已无 sandbox 可开机，目标已达成）。
func (t *renewInstanceTask) idempotentCheck(ctx pctx.Context) (string, error) {
	if t.in == nil || t.in.InstanceID == "" {
		return "", fmt.Errorf("idempotent check: missing instance id")
	}
	instanceDao := daoFactory.DefaultDaoFactory.InstanceDao(ctx)
	entity, err := instanceDao.GetByInstanceID(ctx, t.in.InstanceID)
	if err != nil {
		if errors.Is(err, errcode.ErrInstanceNotFound) {
			ctx.Logger().Info("idempotent check: instance not found, treat as already renewed",
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
	case modelinstance.InstanceStatusRunning, modelinstance.InstanceStatusDeleted, modelinstance.InstanceStatusFailed:
		ctx.Logger().Info("idempotent check: instance already in terminal running/end state",
			zap.String("instance_id", t.in.InstanceID),
			zap.String("status", entity.Status),
		)
		return t.markSuccess(ctx)
	}

	ctx.Logger().Warn("idempotent check: instance not yet running, exiting as lock contention",
		zap.String("instance_id", t.in.InstanceID),
		zap.String("status", entity.Status),
	)
	return "", fmt.Errorf("LockTask failed, instance status=%s (not yet running)", entity.Status)
}

func (t *renewInstanceTask) onExecuteFailed(_ string, err error) {
	t.lastExecuteErr = err
	t.recordFailureMessage(err)
}

func (t *renewInstanceTask) finalizeFailure(ctx pctx.Context) (string, error) {
	err := t.lastExecuteErr
	if err == nil {
		err = errors.New("renew instance task execute failed")
	}
	instancelogic.FinalizeRenewInstanceTaskFailure(ctx, t.in, err)
	return t.completeTaskFailure(ctx, taskmodel.TruncateMessage(err))
}

func (t *renewInstanceTask) exceedMaxExecuteCount(ctx pctx.Context) (string, error) {
	instancelogic.FinalizeRenewInstanceTaskFailure(ctx, t.in, fmt.Errorf("max execute count exceeded"))
	return t.failTask(ctx, "ExecuteCount greater than or equal to MaxExecuteCount")
}

func (t *renewInstanceTask) failTask(ctx pctx.Context, message string) (string, error) {
	if _, err := t.completeTaskFailure(ctx, message); err != nil {
		return "", err
	}
	return "", errors.New(message)
}

func (t *renewInstanceTask) markSuccess(ctx pctx.Context) (string, error) {
	if err := daoFactory.DefaultDaoFactory.TaskDao(ctx).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:   taskmodel.StateSuccess,
		taskmodel.ColumnTaskMessage: "",
	}, t.TaskId); err != nil {
		return "", fmt.Errorf("update renew instance task success state: %w", err)
	}
	t.TaskEntity.TaskState = taskmodel.StateSuccess
	t.TaskEntity.TaskMessage = ""
	return taskflow.StepCodeSuccess, nil
}

func (t *renewInstanceTask) completeTaskFailure(ctx pctx.Context, message string) (string, error) {
	if err := daoFactory.DefaultDaoFactory.TaskDao(ctx).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:       taskmodel.StateFailed,
		taskmodel.ColumnTaskMessage:     message,
		taskmodel.ColumnLastExecuteTime: time.Now().UTC(),
	}, t.TaskId); err != nil {
		return "", fmt.Errorf("update renew instance task failed state: %w", err)
	}
	t.TaskEntity.TaskState = taskmodel.StateFailed
	t.TaskEntity.TaskMessage = message
	return taskflow.StepCodeSuccess, nil
}

func (t *renewInstanceTask) recordFailureMessage(err error) {
	_ = daoFactory.DefaultDaoFactory.TaskDao(nil).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskMessage: taskmodel.TruncateMessage(err),
	}, t.TaskId)
}
