// Package processor ...
package processor

import (
	"ctl/pkg/context"
	instancetask "ctl/pkg/instance/worker"
	passtask "ctl/pkg/pass/worker"
	"ctl/pkg/taskruntime"
	taskcommon "ctl/pkg/taskruntime/common"
)

type prepareTaskFunc func(ctx context.Context, data []byte) (task taskruntime.ServiceTask, in, out interface{}, err error)

var pfMap = map[string]prepareTaskFunc{
	taskcommon.TaskNameCreateInstance:  instancetask.PrepareCreateTask,
	taskcommon.TaskNameDestroyInstance: instancetask.PrepareDestroyTask,

	// trade-pass-isolate 父子 task（设计稿 §10 Q22-I-E）
	taskcommon.TaskNameIsolateInstance: instancetask.PrepareIsolateInstanceTask,
	taskcommon.TaskNameIsolatePass:     passtask.PrepareIsolatePassTask,

	// trade-pass-renew 父子 task（设计稿 §3.4 / §5 / R-D-3 + R-D-4）
	taskcommon.TaskNameRenewInstance: instancetask.PrepareRenewInstanceTask,
	taskcommon.TaskNameRenewPass:     passtask.PrepareRenewPassTask,

	// R-MR-5 续费失败回滚 task（2026-05-24 用户拍板）
	// 由 renewPassTask.finalizeFailure 派发；顶层 task（不是子 task）
	taskcommon.TaskNameRollbackRenewPass: passtask.PrepareRollbackRenewPassTask,

	// trade-pass-destroy 父子 task（设计稿 §3.5 / §4.5.2 / §4.5.3 / §4.6 / §4.7 / §11-A Q5）
	taskcommon.TaskNameDestroyPass:                 passtask.PrepareDestroyPassTask,
	taskcommon.TaskNameDestroyInstanceWithSnapshot: instancetask.PrepareDestroyInstanceForPassTask,
}
