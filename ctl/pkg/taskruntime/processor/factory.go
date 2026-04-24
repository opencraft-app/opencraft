// Package processor ...
package processor

import (
	"ctl/pkg/context"
	instancetask "ctl/pkg/instance/worker"
	instancebirthworker "ctl/pkg/instancebirth/worker"
	"ctl/pkg/taskruntime"
	taskcommon "ctl/pkg/taskruntime/common"
)

type prepareTaskFunc func(ctx context.Context, data []byte) (task taskruntime.ServiceTask, in, out interface{}, err error)

var pfMap = map[string]prepareTaskFunc{
	taskcommon.TaskNameCreateInstance:            instancetask.PrepareCreateTask,
	taskcommon.TaskNameDestroyInstance:           instancetask.PrepareDestroyTask,
	taskcommon.TaskNameBuildInstanceBirthProfile: instancebirthworker.PrepareBuildBirthProfileTask,
}
