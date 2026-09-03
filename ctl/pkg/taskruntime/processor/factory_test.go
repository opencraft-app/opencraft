package processor

import (
	"testing"

	pctx "ctl/pkg/context"
	"ctl/pkg/taskruntime/common"
)

func TestFactoryKeepsDeprecatedBirthProfileTaskAsNoop(t *testing.T) {
	prepare, ok := pfMap[common.TaskNameBuildInstanceBirthProfile]
	if !ok {
		t.Fatalf("expected deprecated %s task to remain registered for rollout compatibility", common.TaskNameBuildInstanceBirthProfile)
	}

	task, in, out, err := prepare(pctx.NewContext(nil), []byte(`{"instance_id":"ins-legacy"}`))
	if err != nil {
		t.Fatalf("prepare deprecated birth profile task: %v", err)
	}
	if task == nil {
		t.Fatal("expected no-op task")
	}
	if err := task.Init(in, out); err != nil {
		t.Fatalf("init deprecated birth profile task: %v", err)
	}
	if got := task.Name(); got != common.TaskNameBuildInstanceBirthProfile {
		t.Fatalf("task name = %q, want %q", got, common.TaskNameBuildInstanceBirthProfile)
	}
}
