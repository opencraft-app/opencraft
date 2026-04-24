package processor

import (
	"encoding/json"
	"fmt"
	"time"

	"ctl/pkg/taskflow"

	"ctl/pkg/context"
	"ctl/pkg/taskruntime"
)

const (
	taskNameDemo = "Demo"
)

type demoTaskIn struct {
	Name         string
	SleepSeconds int
}

type demoTask struct {
	*taskruntime.BaseTask

	in *demoTaskIn

	data struct {
	}
}

func newDemoTask() *demoTask {
	task := &demoTask{
		BaseTask: taskruntime.NewBaseTask(),
	}

	return task
}

func prepareDemoTask(ctx context.Context, data []byte) (task taskruntime.ServiceTask, in, out interface{}, err error) {
	task = newDemoTask()
	in = new(demoTaskIn)
	err = json.Unmarshal(data, in)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("json.Unmarshal error: %w", err)
	}

	return task, in, nil, nil
}

func (t *demoTask) Init(in, out interface{}) error {
	t.in = in.(*demoTaskIn)

	return nil
}

// Name ...
func (t *demoTask) Name() string {
	return "demo"
}

// StepConfigMap ...
func (t *demoTask) StepConfigMap() map[string]*taskflow.StepConfig[context.Context] {
	return map[string]*taskflow.StepConfig[context.Context]{
		"first": {
			RetryCnt:   1,
			RetryDelay: time.Second * 1,
			StepFunc:   t.firstStep,
			RouteMap: map[string]string{
				taskflow.StepCodeSuccess: "",
				taskflow.StepCodeFailure: "",
			},
		},
	}
}

// FirstStepKey ...
func (t *demoTask) FirstStepKey() string {
	return "first"
}

func (t *demoTask) firstStep(ctx context.Context) (string, error) {
	fmt.Println("firstStep name", t.in.Name)
	fmt.Println("task id", t.TaskId)
	fmt.Println("sleep", t.in.SleepSeconds)
	time.Sleep(time.Second * time.Duration(t.in.SleepSeconds))

	return taskflow.StepCodeSuccess, nil
}
