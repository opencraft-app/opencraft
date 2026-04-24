// Package tasks ...
package tasks

import (
	"fmt"

	"go.uber.org/zap"

	"ctl/pkg/context"
	"ctl/pkg/taskflow"
	"ctl/pkg/tracing"
)

// Task ...
type Task interface {
	taskflow.Task[context.Context]
}

// BaseTask ...
type BaseTask struct {
	err error
}

// NewBaseTask ...
func NewBaseTask() *BaseTask {
	return &BaseTask{}
}

// BeforeStep ...
func (t *BaseTask) BeforeStep(stepKey string) {
}

// AfterStep ...
func (t *BaseTask) AfterStep(stepKey string) {
}

// StepFailed ...
func (t *BaseTask) StepFailed(stepKey string, err error) {
	t.err = fmt.Errorf("step %s run error: %w", stepKey, err)
}

// Error ...
func (t *BaseTask) Error() error {
	return t.err
}

// SetError ...
func (t *BaseTask) SetError(err error) {
	t.err = err
}

// RunTask ...
func RunTask(ctx context.Context, task Task, in, out interface{}) (err error) {
	tctx, span := tracing.StartTrace(ctx, fmt.Sprintf("RunTask %s", task.Name()))
	defer func() { span.EndWithError(err) }()

	defer func() {
		if err != nil {
			tctx.Logger().Error(fmt.Sprintf("RunTask %s error", task.Name()), zap.Error(err))
		}
	}()

	err = taskflow.NewRunner[context.Context]().
		SetStartTraceFunc(tracing.StartTraceForFramework).
		RunTask(tctx, task, in, out)

	if err != nil {
		return err
	}

	return task.Error()
}
