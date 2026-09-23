package pass

import (
	"fmt"
	"testing"

	modelinstance "ctl/pkg/model/instance"
	taskmodel "ctl/pkg/model/task"
	taskcommon "ctl/pkg/taskruntime/common"

	"go.uber.org/zap"
)

func isolateChildTask(taskID, instanceID, state string) *taskmodel.Entity {
	return &taskmodel.Entity{
		TaskId:     taskID,
		TaskName:   taskcommon.TaskNameIsolateInstance,
		TaskState:  state,
		TaskParams: fmt.Sprintf(`{"instance_id":%q}`, instanceID),
	}
}

func isolateInstance(instanceID, status string) *modelinstance.Entity {
	return &modelinstance.Entity{InstanceId: instanceID, Status: status}
}

func TestCountIncompleteIsolateInstances_HistoricalFailureThenSuccess(t *testing.T) {
	children := []*taskmodel.Entity{
		isolateChildTask("failed-1", "instance-1", taskmodel.StateFailed),
		isolateChildTask("failed-2", "instance-1", taskmodel.StateFailed),
		isolateChildTask("success", "instance-1", taskmodel.StateSuccess),
	}
	states := indexIsolateInstanceChildTasks(children, zap.NewNop())

	pending, failed := countIncompleteIsolateInstances(
		[]*modelinstance.Entity{isolateInstance("instance-1", modelinstance.InstanceStatusRunning)},
		states,
	)
	if pending != 0 || failed != 0 {
		t.Fatalf("pending=%d failed=%d, want both zero after a later success", pending, failed)
	}
}

func TestCountIncompleteIsolateInstances_FailureWithRetryInFlight(t *testing.T) {
	children := []*taskmodel.Entity{
		isolateChildTask("failed", "instance-1", taskmodel.StateFailed),
		isolateChildTask("retry", "instance-1", taskmodel.StateRunning),
	}
	states := indexIsolateInstanceChildTasks(children, zap.NewNop())

	pending, failed := countIncompleteIsolateInstances(
		[]*modelinstance.Entity{isolateInstance("instance-1", modelinstance.InstanceStatusRunning)},
		states,
	)
	if pending != 1 || failed != 0 {
		t.Fatalf("pending=%d failed=%d, want pending=1 failed=0", pending, failed)
	}
}

func TestCountIncompleteIsolateInstances_FailureNeedsRedispatch(t *testing.T) {
	states := indexIsolateInstanceChildTasks([]*taskmodel.Entity{
		isolateChildTask("failed", "instance-1", taskmodel.StateFailed),
	}, zap.NewNop())

	pending, failed := countIncompleteIsolateInstances(
		[]*modelinstance.Entity{isolateInstance("instance-1", modelinstance.InstanceStatusRunning)},
		states,
	)
	if pending != 0 || failed != 1 {
		t.Fatalf("pending=%d failed=%d, want pending=0 failed=1", pending, failed)
	}
}

func TestCountIncompleteIsolateInstances_TerminalInstanceIgnoresHistoricalFailure(t *testing.T) {
	states := indexIsolateInstanceChildTasks([]*taskmodel.Entity{
		isolateChildTask("failed", "instance-1", taskmodel.StateFailed),
	}, zap.NewNop())

	for _, status := range []string{
		modelinstance.InstanceStatusPaused,
		modelinstance.InstanceStatusDeleted,
		modelinstance.InstanceStatusFailed,
	} {
		t.Run(status, func(t *testing.T) {
			pending, failed := countIncompleteIsolateInstances(
				[]*modelinstance.Entity{isolateInstance("instance-1", status)},
				states,
			)
			if pending != 0 || failed != 0 {
				t.Fatalf("pending=%d failed=%d, want terminal instance ignored", pending, failed)
			}
		})
	}
}

func TestCountIncompleteIsolateInstances_MultipleInstancesAreIndependent(t *testing.T) {
	children := []*taskmodel.Entity{
		isolateChildTask("success", "instance-success", taskmodel.StateSuccess),
		isolateChildTask("failed", "instance-pending", taskmodel.StateFailed),
		isolateChildTask("retry", "instance-pending", taskmodel.StateCreated),
		isolateChildTask("failed-only", "instance-failed", taskmodel.StatePartialFailed),
	}
	states := indexIsolateInstanceChildTasks(children, zap.NewNop())
	instances := []*modelinstance.Entity{
		isolateInstance("instance-success", modelinstance.InstanceStatusRunning),
		isolateInstance("instance-pending", modelinstance.InstanceStatusRunning),
		isolateInstance("instance-failed", modelinstance.InstanceStatusRunning),
	}

	pending, failed := countIncompleteIsolateInstances(instances, states)
	if pending != 1 || failed != 1 {
		t.Fatalf("pending=%d failed=%d, want pending=1 failed=1", pending, failed)
	}
}
