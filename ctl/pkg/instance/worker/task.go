package instance

import (
	"encoding/json"
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

const (
	instanceTaskLockSeconds = 600
)

type createInstanceTask struct {
	*taskruntime.BaseTask
	in             *taskcommon.CreateInstanceTaskPayload
	lastExecuteErr error
}

type destroyInstanceTask struct {
	*taskruntime.BaseTask
	in             *taskcommon.DestroyInstanceTaskPayload
	lastExecuteErr error
}

func newCreateInstanceTask() *createInstanceTask {
	task := &createInstanceTask{
		BaseTask: taskruntime.NewBaseTask(),
	}
	task.TaskLockSeconds = instanceTaskLockSeconds
	task.ExceedMaxExecuteCountFunc = task.exceedMaxExecuteCount
	return task
}

func newDestroyInstanceTask() *destroyInstanceTask {
	task := &destroyInstanceTask{
		BaseTask: taskruntime.NewBaseTask(),
	}
	task.TaskLockSeconds = instanceTaskLockSeconds
	task.ExceedMaxExecuteCountFunc = task.exceedMaxExecuteCount
	return task
}

func PrepareCreateTask(_ pctx.Context, data []byte) (task taskruntime.ServiceTask, in, out interface{}, err error) {
	task = newCreateInstanceTask()
	in = new(taskcommon.CreateInstanceTaskPayload)
	err = parseMessageData(data, in)
	return
}

func PrepareDestroyTask(_ pctx.Context, data []byte) (task taskruntime.ServiceTask, in, out interface{}, err error) {
	task = newDestroyInstanceTask()
	in = new(taskcommon.DestroyInstanceTaskPayload)
	err = parseMessageData(data, in)
	return
}

func (t *createInstanceTask) Init(in, _ interface{}) error {
	payload, ok := in.(*taskcommon.CreateInstanceTaskPayload)
	if !ok {
		return fmt.Errorf("unexpected create task payload: %T", in)
	}
	t.in = payload
	return nil
}

func (t *destroyInstanceTask) Init(in, _ interface{}) error {
	payload, ok := in.(*taskcommon.DestroyInstanceTaskPayload)
	if !ok {
		return fmt.Errorf("unexpected destroy task payload: %T", in)
	}
	t.in = payload
	return nil
}

func (t *createInstanceTask) Name() string  { return taskcommon.TaskNameCreateInstance }
func (t *destroyInstanceTask) Name() string { return taskcommon.TaskNameDestroyInstance }

func (t *createInstanceTask) FirstStepKey() string  { return taskruntime.StepKeyLockTask }
func (t *destroyInstanceTask) FirstStepKey() string { return taskruntime.StepKeyLockTask }

func (t *createInstanceTask) StepConfigMap() map[string]*taskflow.StepConfig[pctx.Context] {
	stepMap := instanceTaskStepConfigMap(t.BaseTask, t.execute, t.onExecuteFailed, t.idempotentCheck)
	stepMap[stepKeyFinalizeFailure].StepFunc = t.finalizeFailure
	return stepMap
}

func (t *destroyInstanceTask) StepConfigMap() map[string]*taskflow.StepConfig[pctx.Context] {
	stepMap := instanceTaskStepConfigMap(t.BaseTask, t.execute, t.onExecuteFailed, t.idempotentCheck)
	stepMap[stepKeyFinalizeFailure].StepFunc = t.finalizeFailure
	return stepMap
}

const stepKeyIdempotentCheck = "IdempotentCheck"
const stepKeyFinalizeFailure = "FinalizeFailure"

func instanceTaskStepConfigMap(base *taskruntime.BaseTask, execute taskflow.StepFunc[pctx.Context], onFailed taskflow.StepFailedFunc, idempotentCheck taskflow.StepFunc[pctx.Context]) map[string]*taskflow.StepConfig[pctx.Context] {
	return map[string]*taskflow.StepConfig[pctx.Context]{
		taskruntime.StepKeyLockTask: {
			RetryCnt:   5,
			RetryDelay: 3 * time.Second,
			StepFunc:   base.LockTask,
			RouteMap: map[string]string{
				taskflow.StepCodeSuccess: taskruntime.StepKeyCheckTask,
				taskflow.StepCodeFailure: stepKeyIdempotentCheck,
			},
		},
		stepKeyIdempotentCheck: {
			StepFunc: idempotentCheck,
			RouteMap: map[string]string{
				taskflow.StepCodeSuccess: "",
				taskflow.StepCodeFailure: "",
			},
		},
		taskruntime.StepKeyCheckTask: {
			StepFunc: base.CheckTask,
			RouteMap: map[string]string{
				taskflow.StepCodeSuccess: taskruntime.StepKeyUpdateTaskExecute,
				taskflow.StepCodeFailure: taskruntime.StepKeyUnlockTask,
			},
		},
		taskruntime.StepKeyUpdateTaskExecute: {
			StepFunc: base.UpdateTaskExecute,
			RouteMap: map[string]string{
				taskflow.StepCodeSuccess: "Execute",
				taskflow.StepCodeFailure: taskruntime.StepKeyUnlockTask,
			},
		},
		"Execute": {
			StepFunc:       execute,
			StepFailedFunc: onFailed,
			RouteMap: map[string]string{
				taskflow.StepCodeSuccess: taskruntime.StepKeyUnlockTask,
				taskflow.StepCodeFailure: stepKeyFinalizeFailure,
			},
		},
		stepKeyFinalizeFailure: {
			RouteMap: map[string]string{
				taskflow.StepCodeSuccess: taskruntime.StepKeyUnlockTask,
				taskflow.StepCodeFailure: taskruntime.StepKeyUnlockTask,
			},
		},
		taskruntime.StepKeyUnlockTask: {
			StepFunc: base.UnlockTask,
			RouteMap: map[string]string{
				taskflow.StepCodeSuccess: "",
				taskflow.StepCodeFailure: "",
			},
		},
	}
}

func (t *createInstanceTask) execute(ctx pctx.Context) (string, error) {
	if err := instancelogic.ExecuteCreateInstanceTask(ctx, t.in); err != nil {
		return "", err
	}
	return t.markSuccess(ctx)
}

// idempotentCheck 在 LockTask 失败（重入场景）时检查实例是否已到终态。
// 若实例已 Running 且 sandbox_id 有效，说明前一次执行已成功，直接收口 task 为 SUCCESS。
func (t *createInstanceTask) idempotentCheck(ctx pctx.Context) (string, error) {
	if t.in == nil || t.in.InstanceID == "" {
		return "", fmt.Errorf("idempotent check: missing instance id")
	}
	instanceDao := daoFactory.DefaultDaoFactory.InstanceDao(ctx)
	entity, err := instanceDao.GetByInstanceID(ctx, t.in.InstanceID)
	if err != nil {
		ctx.Logger().Warn("idempotent check: query instance failed, treat as lock contention",
			zap.Error(err),
			zap.String("instance_id", t.in.InstanceID),
		)
		return "", fmt.Errorf("LockTask failed and idempotent check unavailable: %w", err)
	}

	if entity.Status == modelinstance.InstanceStatusRunning && entity.SandboxId != "" && !instancelogic.IsPendingSandboxID(entity.SandboxId) {
		ctx.Logger().Info("idempotent check: instance already running, short-circuit task to success",
			zap.String("instance_id", t.in.InstanceID),
			zap.String("sandbox_id", entity.SandboxId),
		)
		return t.markSuccess(ctx)
	}

	ctx.Logger().Warn("idempotent check: instance not yet in terminal state, exiting as lock contention",
		zap.String("instance_id", t.in.InstanceID),
		zap.String("status", entity.Status),
	)
	return "", fmt.Errorf("LockTask failed, instance status=%s (not yet terminal)", entity.Status)
}

func (t *destroyInstanceTask) execute(ctx pctx.Context) (string, error) {
	if err := instancelogic.ExecuteDestroyInstanceTask(ctx, t.in); err != nil {
		return "", err
	}
	return t.markSuccess(ctx)
}

// idempotentCheck 在 LockTask 失败（重入场景）时检查实例是否已到终态。
// 若实例已 Deleted，说明前一次执行已成功，直接收口 task 为 SUCCESS。
func (t *destroyInstanceTask) idempotentCheck(ctx pctx.Context) (string, error) {
	if t.in == nil || t.in.InstanceID == "" {
		return "", fmt.Errorf("idempotent check: missing instance id")
	}
	instanceDao := daoFactory.DefaultDaoFactory.InstanceDao(ctx)
	entity, err := instanceDao.GetByInstanceID(ctx, t.in.InstanceID)
	if err != nil {
		if errors.Is(err, errcode.ErrInstanceNotFound) {
			// 实例不存在视为删除成功
			ctx.Logger().Info("idempotent check: instance not found, treat as already deleted",
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

	if entity.Status == modelinstance.InstanceStatusDeleted {
		ctx.Logger().Info("idempotent check: instance already deleted, short-circuit task to success",
			zap.String("instance_id", t.in.InstanceID),
		)
		return t.markSuccess(ctx)
	}

	ctx.Logger().Warn("idempotent check: instance not yet in terminal state, exiting as lock contention",
		zap.String("instance_id", t.in.InstanceID),
		zap.String("status", entity.Status),
	)
	return "", fmt.Errorf("LockTask failed, instance status=%s (not yet terminal)", entity.Status)
}

func (t *createInstanceTask) markSuccess(ctx pctx.Context) (string, error) {
	if err := daoFactory.DefaultDaoFactory.TaskDao(ctx).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:   taskmodel.StateSuccess,
		taskmodel.ColumnTaskMessage: "",
	}, t.TaskId); err != nil {
		return "", fmt.Errorf("update create task success state: %w", err)
	}
	t.TaskEntity.TaskState = taskmodel.StateSuccess
	t.TaskEntity.TaskMessage = ""
	instancelogic.CompleteAsyncOperation(ctx, t.in.OperationID, nil)
	return taskflow.StepCodeSuccess, nil
}

func (t *destroyInstanceTask) markSuccess(ctx pctx.Context) (string, error) {
	if err := daoFactory.DefaultDaoFactory.TaskDao(ctx).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:   taskmodel.StateSuccess,
		taskmodel.ColumnTaskMessage: "",
	}, t.TaskId); err != nil {
		return "", fmt.Errorf("update destroy task success state: %w", err)
	}
	t.TaskEntity.TaskState = taskmodel.StateSuccess
	t.TaskEntity.TaskMessage = ""
	instancelogic.CompleteAsyncOperation(ctx, t.in.OperationID, nil)
	return taskflow.StepCodeSuccess, nil
}

func (t *createInstanceTask) onExecuteFailed(_ string, err error) {
	t.lastExecuteErr = err
	t.recordFailureMessage(err)
}

func (t *destroyInstanceTask) onExecuteFailed(_ string, err error) {
	t.lastExecuteErr = err
	t.recordFailureMessage(err)
}

func (t *createInstanceTask) finalizeFailure(ctx pctx.Context) (string, error) {
	err := t.lastExecuteErr
	if err == nil {
		err = errors.New("create task execute failed")
	}
	instancelogic.FinalizeCreateInstanceTaskFailure(ctx, t.in, err)
	return t.completeTaskFailure(ctx, truncateTaskMessage(err))
}

func (t *destroyInstanceTask) finalizeFailure(ctx pctx.Context) (string, error) {
	err := t.lastExecuteErr
	if err == nil {
		err = errors.New("destroy task execute failed")
	}
	instancelogic.FinalizeDestroyInstanceTaskFailure(ctx, t.in, err)
	return t.completeTaskFailure(ctx, truncateTaskMessage(err))
}

func (t *createInstanceTask) exceedMaxExecuteCount(ctx pctx.Context) (string, error) {
	instancelogic.FinalizeCreateInstanceTaskFailure(ctx, t.in, fmt.Errorf("max execute count exceeded"))
	return t.failTask(ctx, "ExecuteCount greater than or equal to MaxExecuteCount")
}

func (t *destroyInstanceTask) exceedMaxExecuteCount(ctx pctx.Context) (string, error) {
	instancelogic.FinalizeDestroyInstanceTaskFailure(ctx, t.in, fmt.Errorf("max execute count exceeded"))
	return t.failTask(ctx, "ExecuteCount greater than or equal to MaxExecuteCount")
}

func (t *createInstanceTask) failTask(ctx pctx.Context, message string) (string, error) {
	if _, err := t.completeTaskFailure(ctx, message); err != nil {
		return "", err
	}
	return "", errors.New(message)
}

func (t *destroyInstanceTask) failTask(ctx pctx.Context, message string) (string, error) {
	if _, err := t.completeTaskFailure(ctx, message); err != nil {
		return "", err
	}
	return "", errors.New(message)
}

func (t *createInstanceTask) completeTaskFailure(ctx pctx.Context, message string) (string, error) {
	if err := daoFactory.DefaultDaoFactory.TaskDao(ctx).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:       taskmodel.StateFailed,
		taskmodel.ColumnTaskMessage:     message,
		taskmodel.ColumnLastExecuteTime: time.Now().UTC(),
	}, t.TaskId); err != nil {
		return "", fmt.Errorf("update create task failed state: %w", err)
	}
	t.TaskEntity.TaskState = taskmodel.StateFailed
	t.TaskEntity.TaskMessage = message
	return taskflow.StepCodeSuccess, nil
}

func (t *destroyInstanceTask) completeTaskFailure(ctx pctx.Context, message string) (string, error) {
	if err := daoFactory.DefaultDaoFactory.TaskDao(ctx).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:       taskmodel.StateFailed,
		taskmodel.ColumnTaskMessage:     message,
		taskmodel.ColumnLastExecuteTime: time.Now().UTC(),
	}, t.TaskId); err != nil {
		return "", fmt.Errorf("update destroy task failed state: %w", err)
	}
	t.TaskEntity.TaskState = taskmodel.StateFailed
	t.TaskEntity.TaskMessage = message
	return taskflow.StepCodeSuccess, nil
}

func (t *createInstanceTask) recordFailureMessage(err error) {
	_ = daoFactory.DefaultDaoFactory.TaskDao(nil).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskMessage: truncateTaskMessage(err),
	}, t.TaskId)
}

func (t *destroyInstanceTask) recordFailureMessage(err error) {
	_ = daoFactory.DefaultDaoFactory.TaskDao(nil).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskMessage: truncateTaskMessage(err),
	}, t.TaskId)
}

func truncateTaskMessage(err error) string {
	return taskmodel.TruncateMessage(err)
}

func parseMessageData(data []byte, in interface{}) error {
	if in == nil {
		return fmt.Errorf("task input is nil")
	}
	if err := json.Unmarshal(data, in); err != nil {
		return fmt.Errorf("json.Unmarshal error: %w", err)
	}
	return nil
}
