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

// 同 SP 变配子 task ModifyInstance。需求：TAPD 1010132091137784162 §5.4 / §8.1
//
// 一个子 task 对应一台实例：创建 sandbox modify operation → 轮询到终态 → 收口。
// 本子 task 自身的 task ID 就是传给 sandbox 的 idempotency_key，所以同一子 task 的
// 任意次重投都命中同一份云操作账本，不可逆的磁盘扩容不会执行两次。
//
// 重试节奏 60s × 60 = 1h：腾讯云侧停机改配再开机可达十几分钟，1h 留足余量。
const modifyInstanceTaskLockSeconds = instanceTaskLockSeconds

type modifyInstanceTask struct {
	*taskruntime.BaseTask
	in             *taskcommon.ModifyInstanceTaskPayload
	lastExecuteErr error
}

func newModifyInstanceTask() *modifyInstanceTask {
	task := &modifyInstanceTask{
		BaseTask: taskruntime.NewBaseTask(),
	}
	task.TaskLockSeconds = modifyInstanceTaskLockSeconds
	task.ExceedMaxExecuteCountFunc = task.exceedMaxExecuteCount
	return task
}

// PrepareModifyInstanceTask 由 processor.factory 注册到 pfMap
func PrepareModifyInstanceTask(_ pctx.Context, data []byte) (task taskruntime.ServiceTask, in, out interface{}, err error) {
	task = newModifyInstanceTask()
	in = new(taskcommon.ModifyInstanceTaskPayload)
	err = parseMessageData(data, in)
	return
}

func (t *modifyInstanceTask) Init(in, _ interface{}) error {
	payload, ok := in.(*taskcommon.ModifyInstanceTaskPayload)
	if !ok {
		return fmt.Errorf("unexpected modify instance task payload: %T", in)
	}
	t.in = payload
	return nil
}

func (t *modifyInstanceTask) Name() string         { return taskcommon.TaskNameModifyInstance }
func (t *modifyInstanceTask) FirstStepKey() string { return taskruntime.StepKeyLockTask }

func (t *modifyInstanceTask) StepConfigMap() map[string]*taskflow.StepConfig[pctx.Context] {
	stepMap := instanceTaskStepConfigMap(t.BaseTask, t.execute, t.onExecuteFailed, t.idempotentCheck)
	stepMap[stepKeyFinalizeFailure].StepFunc = t.finalizeFailure
	return stepMap
}

// execute 把 t.TaskId 透传给 logic 层：它既是持久化 operation_id 的落点，
// 也是传给 sandbox 的幂等键。
func (t *modifyInstanceTask) execute(ctx pctx.Context) (string, error) {
	if err := instancelogic.ExecuteModifyInstanceTask(ctx, t.TaskId, t.in); err != nil {
		return "", err
	}
	return t.markSuccess(ctx)
}

// idempotentCheck 锁竞争场景。
//
// 与 isolate / renew 子 task 不同，这里不能靠 instance.status 判断是否已完成：
// 升配前后 instance.status 都是 Running，翻不出牌。唯一可信的完成信号是 sandbox
// 账本终态，所以未拿到锁时统一按锁竞争退出，让下一轮重投走正常路径去轮询。
func (t *modifyInstanceTask) idempotentCheck(ctx pctx.Context) (string, error) {
	if t.in == nil || t.in.InstanceID == "" {
		return "", fmt.Errorf("idempotent check: missing instance id")
	}
	entity, err := daoFactory.DefaultDaoFactory.InstanceDao(ctx).GetByInstanceID(ctx, t.in.InstanceID)
	if err != nil {
		if errors.Is(err, errcode.ErrInstanceNotFound) {
			ctx.Logger().Info("modify idempotent check: instance not found, nothing left to upgrade",
				zap.String("instance_id", t.in.InstanceID),
			)
			return t.markSuccess(ctx)
		}
		ctx.Logger().Warn("modify idempotent check: query instance failed, treat as lock contention",
			zap.Error(err),
			zap.String("instance_id", t.in.InstanceID),
		)
		return "", fmt.Errorf("LockTask failed and idempotent check unavailable: %w", err)
	}
	if entity.Status == modelinstance.InstanceStatusDeleted || entity.Status == modelinstance.InstanceStatusFailed {
		ctx.Logger().Info("modify idempotent check: instance in terminal state",
			zap.String("instance_id", t.in.InstanceID),
			zap.String("status", entity.Status),
		)
		return t.markSuccess(ctx)
	}
	return "", fmt.Errorf("LockTask failed, modify progress is tracked in sandbox operation %q",
		t.in.SandboxOperationID)
}

func (t *modifyInstanceTask) onExecuteFailed(_ string, err error) {
	t.lastExecuteErr = err
	t.recordFailureMessage(err)
}

// finalizeFailure 默认把失败当暂态：云 API 抖动、operation 还在跑、实例状态暂时不合适
// 都应该在 1h 窗口内继续重试，而不是让父 task 看到一个假的终态失败。
//
// 只有 ErrModifyPermanentFailed 哨兵（payload 关键字段缺失、sandbox 报账本目标冲突）
// 才 fail-fast 进终态 Failed，让父 task 立刻重派新子 task 换一个幂等键重来。
func (t *modifyInstanceTask) finalizeFailure(ctx pctx.Context) (string, error) {
	err := t.lastExecuteErr
	if err == nil {
		err = errors.New("modify instance task execute failed")
	}
	logger := ctx.Logger().With(
		zap.String("instance_id", t.in.InstanceID),
		zap.String("pass_id", t.in.PassID),
		zap.String("sandbox_operation_id", t.in.SandboxOperationID),
	)

	if errors.Is(err, instancelogic.ErrModifyPermanentFailed) {
		logger.Error("modify instance task permanent failure, fail-fast to terminal Failed", zap.Error(err))
		return t.failTask(ctx, taskmodel.TruncateMessage(err))
	}

	logger.Warn("modify instance task transient failure, will be retried by checkTasks bypass",
		zap.Error(err),
		zap.Int("execute_count", t.TaskEntity.ExecuteCount),
		zap.Int("max_execute_count", t.TaskEntity.MaxExecuteCount),
	)
	return t.markRetryable(ctx, taskmodel.TruncateMessage(err))
}

func (t *modifyInstanceTask) markRetryable(ctx pctx.Context, message string) (string, error) {
	if err := daoFactory.DefaultDaoFactory.TaskDao(ctx).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:   taskmodel.StateCreated,
		taskmodel.ColumnTaskMessage: message,
	}, t.TaskId); err != nil {
		return "", fmt.Errorf("update modify instance task retryable state: %w", err)
	}
	t.TaskEntity.TaskState = taskmodel.StateCreated
	t.TaskEntity.TaskMessage = message
	return taskflow.StepCodeSuccess, nil
}

func (t *modifyInstanceTask) exceedMaxExecuteCount(ctx pctx.Context) (string, error) {
	return t.failTask(ctx, "ExecuteCount greater than or equal to MaxExecuteCount")
}

func (t *modifyInstanceTask) failTask(ctx pctx.Context, message string) (string, error) {
	if _, err := t.completeTaskFailure(ctx, message); err != nil {
		return "", err
	}
	return "", errors.New(message)
}

func (t *modifyInstanceTask) markSuccess(ctx pctx.Context) (string, error) {
	if err := daoFactory.DefaultDaoFactory.TaskDao(ctx).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:   taskmodel.StateSuccess,
		taskmodel.ColumnTaskMessage: "",
	}, t.TaskId); err != nil {
		return "", fmt.Errorf("update modify instance task success state: %w", err)
	}
	t.TaskEntity.TaskState = taskmodel.StateSuccess
	t.TaskEntity.TaskMessage = ""
	return taskflow.StepCodeSuccess, nil
}

func (t *modifyInstanceTask) completeTaskFailure(ctx pctx.Context, message string) (string, error) {
	if err := daoFactory.DefaultDaoFactory.TaskDao(ctx).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:       taskmodel.StateFailed,
		taskmodel.ColumnTaskMessage:     message,
		taskmodel.ColumnLastExecuteTime: time.Now().UTC(),
	}, t.TaskId); err != nil {
		return "", fmt.Errorf("update modify instance task failed state: %w", err)
	}
	t.TaskEntity.TaskState = taskmodel.StateFailed
	t.TaskEntity.TaskMessage = message
	return taskflow.StepCodeSuccess, nil
}

func (t *modifyInstanceTask) recordFailureMessage(err error) {
	_ = daoFactory.DefaultDaoFactory.TaskDao(nil).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskMessage: taskmodel.TruncateMessage(err),
	}, t.TaskId)
}
