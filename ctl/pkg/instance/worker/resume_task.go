package instance

import (
	"errors"
	"fmt"
	"time"

	pctx "ctl/pkg/context"
	instancelogic "ctl/pkg/instance"
	daoFactory "ctl/pkg/model/factory"
	modelinstance "ctl/pkg/model/instance"
	taskmodel "ctl/pkg/model/task"
	"ctl/pkg/taskflow"
	"ctl/pkg/taskruntime"
	taskcommon "ctl/pkg/taskruntime/common"
)

type resumeInstanceTask struct {
	*taskruntime.BaseTask
	in             *taskcommon.ResumeInstanceTaskPayload
	lastExecuteErr error
}

func newResumeInstanceTask() *resumeInstanceTask {
	t := &resumeInstanceTask{BaseTask: taskruntime.NewBaseTask()}
	t.TaskLockSeconds = instanceTaskLockSeconds
	t.ExceedMaxExecuteCountFunc = t.exceedMaxExecuteCount
	return t
}

func PrepareResumeInstanceTask(_ pctx.Context, data []byte) (task taskruntime.ServiceTask, in, out interface{}, err error) {
	task = newResumeInstanceTask()
	in = new(taskcommon.ResumeInstanceTaskPayload)
	err = parseMessageData(data, in)
	return
}

func (t *resumeInstanceTask) Init(in, _ interface{}) error {
	payload, ok := in.(*taskcommon.ResumeInstanceTaskPayload)
	if !ok {
		return fmt.Errorf("unexpected resume instance task payload: %T", in)
	}
	t.in = payload
	return nil
}

func (t *resumeInstanceTask) Name() string         { return taskcommon.TaskNameResumeInstance }
func (t *resumeInstanceTask) FirstStepKey() string { return taskruntime.StepKeyLockTask }

func (t *resumeInstanceTask) StepConfigMap() map[string]*taskflow.StepConfig[pctx.Context] {
	steps := instanceTaskStepConfigMap(t.BaseTask, t.execute, t.onExecuteFailed, t.idempotentCheck)
	steps[stepKeyFinalizeFailure].StepFunc = t.finalizeFailure
	return steps
}

func (t *resumeInstanceTask) execute(ctx pctx.Context) (string, error) {
	if err := instancelogic.ExecuteResumeInstanceTask(ctx, t.in); err != nil {
		return "", err
	}
	return t.markSuccess(ctx)
}

func (t *resumeInstanceTask) idempotentCheck(ctx pctx.Context) (string, error) {
	if t.in == nil || t.in.InstanceID == "" {
		return "", errors.New("missing instance id")
	}
	entity, err := daoFactory.DefaultDaoFactory.InstanceDao(ctx).GetByInstanceID(ctx, t.in.InstanceID)
	if err != nil {
		return "", err
	}
	if entity.Status == modelinstance.InstanceStatusRunning {
		return t.markSuccess(ctx)
	}
	return "", fmt.Errorf("instance status %s is not running", entity.Status)
}

func (t *resumeInstanceTask) onExecuteFailed(_ string, err error) {
	t.lastExecuteErr = err
	_ = daoFactory.DefaultDaoFactory.TaskDao(nil).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskMessage: taskmodel.TruncateMessage(err),
	}, t.TaskId)
}

func (t *resumeInstanceTask) finalizeFailure(ctx pctx.Context) (string, error) {
	err := t.lastExecuteErr
	if err == nil {
		err = errors.New("resume instance task failed")
	}
	if errors.Is(err, instancelogic.ErrResumeTaskPermanent) {
		return t.markFailure(ctx, err)
	}
	// A timeout or ambiguous cloud response must remain retryable: CVM may
	// already be starting, and no HTTP caller remains to repair Resuming.
	if err := daoFactory.DefaultDaoFactory.TaskDao(ctx).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:   taskmodel.StateCreated,
		taskmodel.ColumnTaskMessage: taskmodel.TruncateMessage(err),
	}, t.TaskId); err != nil {
		return "", err
	}
	t.TaskEntity.TaskState = taskmodel.StateCreated
	return taskflow.StepCodeSuccess, nil
}

func (t *resumeInstanceTask) exceedMaxExecuteCount(ctx pctx.Context) (string, error) {
	return t.markFailure(ctx, errors.New("resume retry limit exceeded"))
}

func (t *resumeInstanceTask) markSuccess(ctx pctx.Context) (string, error) {
	if err := daoFactory.DefaultDaoFactory.TaskDao(ctx).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:   taskmodel.StateSuccess,
		taskmodel.ColumnTaskMessage: "",
	}, t.TaskId); err != nil {
		return "", err
	}
	t.TaskEntity.TaskState = taskmodel.StateSuccess
	instancelogic.CompleteResumeInstanceOperation(ctx, t.in.OperationID, nil)
	return taskflow.StepCodeSuccess, nil
}

func (t *resumeInstanceTask) markFailure(ctx pctx.Context, taskErr error) (string, error) {
	if err := daoFactory.DefaultDaoFactory.TaskDao(ctx).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:       taskmodel.StateFailed,
		taskmodel.ColumnTaskMessage:     taskmodel.TruncateMessage(taskErr),
		taskmodel.ColumnLastExecuteTime: time.Now().UTC(),
	}, t.TaskId); err != nil {
		return "", err
	}
	t.TaskEntity.TaskState = taskmodel.StateFailed
	instancelogic.CompleteResumeInstanceOperation(ctx, t.in.OperationID, taskErr)
	return taskflow.StepCodeSuccess, nil
}
