package processor

import (
	"encoding/json"
	"fmt"
	"time"

	pctx "ctl/pkg/context"
	"ctl/pkg/model/factory"
	taskmodel "ctl/pkg/model/task"
	"ctl/pkg/taskflow"
	"ctl/pkg/taskruntime"
	taskcommon "ctl/pkg/taskruntime/common"
)

const stepKeySkipDeprecatedBirthProfile = "SkipDeprecatedBirthProfile"

type deprecatedBirthProfileTask struct {
	*taskruntime.BaseTask
	in *taskcommon.BuildInstanceBirthProfileTaskPayload
}

func newDeprecatedBirthProfileTask() *deprecatedBirthProfileTask {
	return &deprecatedBirthProfileTask{
		BaseTask: taskruntime.NewBaseTask(),
	}
}

func prepareDeprecatedBirthProfileTask(_ pctx.Context, data []byte) (task taskruntime.ServiceTask, in, out interface{}, err error) {
	task = newDeprecatedBirthProfileTask()
	in = new(taskcommon.BuildInstanceBirthProfileTaskPayload)
	if err := json.Unmarshal(data, in); err != nil {
		return nil, nil, nil, fmt.Errorf("json.Unmarshal error: %w", err)
	}
	return task, in, nil, nil
}

func (t *deprecatedBirthProfileTask) Init(in, _ interface{}) error {
	payload, ok := in.(*taskcommon.BuildInstanceBirthProfileTaskPayload)
	if !ok {
		return fmt.Errorf("unexpected deprecated birth profile task payload: %T", in)
	}
	t.in = payload
	return nil
}

func (t *deprecatedBirthProfileTask) Name() string {
	return taskcommon.TaskNameBuildInstanceBirthProfile
}

func (t *deprecatedBirthProfileTask) FirstStepKey() string {
	return stepKeySkipDeprecatedBirthProfile
}

func (t *deprecatedBirthProfileTask) StepConfigMap() map[string]*taskflow.StepConfig[pctx.Context] {
	return map[string]*taskflow.StepConfig[pctx.Context]{
		stepKeySkipDeprecatedBirthProfile: {
			StepFunc: t.skip,
			RouteMap: map[string]string{
				taskflow.StepCodeSuccess: "",
				taskflow.StepCodeFailure: "",
			},
		},
	}
}

func (t *deprecatedBirthProfileTask) skip(ctx pctx.Context) (string, error) {
	if err := factory.DefaultDaoFactory.TaskDao(ctx).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:       taskmodel.StateSuccess,
		taskmodel.ColumnTaskMessage:     "deprecated BuildInstanceBirthProfile task skipped",
		taskmodel.ColumnLastExecuteTime: time.Now().UTC(),
	}, t.TaskId); err != nil {
		return "", fmt.Errorf("mark deprecated birth profile task skipped: %w", err)
	}
	t.TaskEntity.TaskState = taskmodel.StateSuccess
	t.TaskEntity.TaskMessage = "deprecated BuildInstanceBirthProfile task skipped"
	return taskflow.StepCodeSuccess, nil
}
