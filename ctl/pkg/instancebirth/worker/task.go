package worker

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"

	pctx "ctl/pkg/context"
	instancebirth "ctl/pkg/instancebirth"
	daoFactory "ctl/pkg/model/factory"
	taskmodel "ctl/pkg/model/task"
	"ctl/pkg/taskflow"
	"ctl/pkg/taskruntime"
	taskcommon "ctl/pkg/taskruntime/common"
)

const (
	birthTaskLockSeconds   = 300
	stepKeyFinalizeFailure = "FinalizeFailure"
)

type buildBirthProfileTask struct {
	*taskruntime.BaseTask
	in             *taskcommon.BuildInstanceBirthProfileTaskPayload
	lastExecuteErr error
}

func newBuildBirthProfileTask() *buildBirthProfileTask {
	task := &buildBirthProfileTask{
		BaseTask: taskruntime.NewBaseTask(),
	}
	task.TaskLockSeconds = birthTaskLockSeconds
	task.ExceedMaxExecuteCountFunc = task.exceedMaxExecuteCount
	return task
}

func PrepareBuildBirthProfileTask(_ pctx.Context, data []byte) (task taskruntime.ServiceTask, in, out interface{}, err error) {
	task = newBuildBirthProfileTask()
	in = new(taskcommon.BuildInstanceBirthProfileTaskPayload)
	err = parseMessageData(data, in)
	return
}

func (t *buildBirthProfileTask) Init(in, _ interface{}) error {
	payload, ok := in.(*taskcommon.BuildInstanceBirthProfileTaskPayload)
	if !ok {
		return fmt.Errorf("unexpected birth profile task payload: %T", in)
	}
	t.in = payload
	return nil
}

func (t *buildBirthProfileTask) Name() string         { return taskcommon.TaskNameBuildInstanceBirthProfile }
func (t *buildBirthProfileTask) FirstStepKey() string { return taskruntime.StepKeyLockTask }

func (t *buildBirthProfileTask) StepConfigMap() map[string]*taskflow.StepConfig[pctx.Context] {
	return map[string]*taskflow.StepConfig[pctx.Context]{
		taskruntime.StepKeyLockTask: {
			RetryCnt:   5,
			RetryDelay: 3 * time.Second,
			StepFunc:   t.LockTask,
			RouteMap: map[string]string{
				taskflow.StepCodeSuccess: taskruntime.StepKeyCheckTask,
				taskflow.StepCodeFailure: "",
			},
		},
		taskruntime.StepKeyCheckTask: {
			StepFunc: t.CheckTask,
			RouteMap: map[string]string{
				taskflow.StepCodeSuccess: taskruntime.StepKeyUpdateTaskExecute,
				taskflow.StepCodeFailure: taskruntime.StepKeyUnlockTask,
			},
		},
		taskruntime.StepKeyUpdateTaskExecute: {
			StepFunc: t.UpdateTaskExecute,
			RouteMap: map[string]string{
				taskflow.StepCodeSuccess: "Execute",
				taskflow.StepCodeFailure: taskruntime.StepKeyUnlockTask,
			},
		},
		"Execute": {
			StepFunc:       t.execute,
			StepFailedFunc: t.onExecuteFailed,
			RouteMap: map[string]string{
				taskflow.StepCodeSuccess: taskruntime.StepKeyUnlockTask,
				taskflow.StepCodeFailure: stepKeyFinalizeFailure,
			},
		},
		stepKeyFinalizeFailure: {
			StepFunc: t.finalizeFailure,
			RouteMap: map[string]string{
				taskflow.StepCodeSuccess: taskruntime.StepKeyUnlockTask,
				taskflow.StepCodeFailure: taskruntime.StepKeyUnlockTask,
			},
		},
		taskruntime.StepKeyUnlockTask: {
			StepFunc: t.UnlockTask,
			RouteMap: map[string]string{
				taskflow.StepCodeSuccess: "",
				taskflow.StepCodeFailure: "",
			},
		},
	}
}

func (t *buildBirthProfileTask) execute(ctx pctx.Context) (string, error) {
	if t.in == nil || t.in.InstanceID == "" {
		return "", errors.New("instance_id is required")
	}
	svc := instancebirth.NewService(
		daoFactory.DefaultDaoFactory.InstanceDao(ctx),
		daoFactory.DefaultDaoFactory.InstanceBirthProfileDao(ctx),
	)
	if err := svc.RebuildForInstance(ctx, t.in.InstanceID); err != nil {
		return "", err
	}
	return t.markSuccess(ctx)
}

func (t *buildBirthProfileTask) markSuccess(ctx pctx.Context) (string, error) {
	if err := daoFactory.DefaultDaoFactory.TaskDao(ctx).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:   taskmodel.StateSuccess,
		taskmodel.ColumnTaskMessage: "",
	}, t.TaskId); err != nil {
		return "", fmt.Errorf("update birth profile task success state: %w", err)
	}
	t.TaskEntity.TaskState = taskmodel.StateSuccess
	t.TaskEntity.TaskMessage = ""
	return taskflow.StepCodeSuccess, nil
}

func (t *buildBirthProfileTask) onExecuteFailed(_ string, err error) {
	t.lastExecuteErr = err
	_ = daoFactory.DefaultDaoFactory.TaskDao(nil).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskMessage: truncateTaskMessage(err),
	}, t.TaskId)
}

func (t *buildBirthProfileTask) finalizeFailure(ctx pctx.Context) (string, error) {
	err := t.lastExecuteErr
	if err == nil {
		err = errors.New("build birth profile task execute failed")
	}
	if err := daoFactory.DefaultDaoFactory.TaskDao(ctx).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:       taskmodel.StateFailed,
		taskmodel.ColumnTaskMessage:     truncateTaskMessage(err),
		taskmodel.ColumnLastExecuteTime: time.Now().UTC(),
	}, t.TaskId); err != nil {
		return "", fmt.Errorf("update birth profile task failed state: %w", err)
	}
	t.TaskEntity.TaskState = taskmodel.StateFailed
	t.TaskEntity.TaskMessage = truncateTaskMessage(err)
	return taskflow.StepCodeSuccess, nil
}

func (t *buildBirthProfileTask) exceedMaxExecuteCount(ctx pctx.Context) (string, error) {
	if err := daoFactory.DefaultDaoFactory.TaskDao(ctx).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:   taskmodel.StateFailed,
		taskmodel.ColumnTaskMessage: "ExecuteCount greater than or equal to MaxExecuteCount",
	}, t.TaskId); err != nil {
		return "", fmt.Errorf("update birth profile task max-exec failure: %w", err)
	}
	t.TaskEntity.TaskState = taskmodel.StateFailed
	t.TaskEntity.TaskMessage = "ExecuteCount greater than or equal to MaxExecuteCount"
	return "", errors.New("ExecuteCount greater than or equal to MaxExecuteCount")
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
