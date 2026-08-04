package runtimehost

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"velachat/agent/internal/runtimeactor"
	"velachat/agent/internal/runtimeapi"
	"velachat/agent/internal/vela/im"
	"velachat/agent/internal/vela/ingress"
	"velachat/agent/internal/vela/platform"
	velastate "velachat/agent/internal/vela/state"
)

const taskReconcilerTaskID = "01900000-0000-7000-8000-000000000021"

type fakeTaskClient struct {
	mu     sync.Mutex
	values []platform.Task
	lists  int
}

func (client *fakeTaskClient) ListRuntimeTasks(
	context.Context,
	platform.AccessToken,
) ([]platform.Task, error) {
	client.mu.Lock()
	defer client.mu.Unlock()
	client.lists++
	return append([]platform.Task(nil), client.values...), nil
}

func TestAdapterReconcilesTaskWakeOnceAndMarksItNotified(t *testing.T) {
	t.Parallel()
	manager := &fakeManager{events: make(chan runtimeactor.Event, 1)}
	taskStore, err := velastate.OpenTaskDeliveryStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	planned := make(chan runtimeapi.LaunchInput, 1)
	client := &fakeTaskClient{values: []platform.Task{{
		ID: taskReconcilerTaskID, ServerID: reminderServerID, Number: 9,
		Title: "修复构建", Status: platform.TaskTodo,
		OwnerMemberID: reminderAgentID, AssignmentRevision: 3,
		CreatedByMemberID: reminderAgentID, UpdatedByMemberID: reminderAgentID,
		Revision: 4,
	}}}
	adapter, err := New(Config{
		AgentID: reminderAgentID, StateDirectory: t.TempDir(),
		WorkingDirectory: t.TempDir(), Actor: manager,
		Runtimes: fakeResolver{runtime: runtimeapi.ResolvedRuntime{
			ID: "codex", InternalID: "codex",
			LaunchPlanner: runtimeapi.LaunchPlannerFunc(func(input runtimeapi.LaunchInput) (runtimeapi.LaunchPlan, error) {
				planned <- input
				return runtimeapi.LaunchPlan{Prompt: string(input.WakeMessage)}, nil
			}),
		}},
		TaskDeliveries: taskStore, TaskClient: client, ReminderInterval: time.Hour,
		NewRuntimeEpoch: func() (string, error) { return "runtime-epoch-task", nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = adapter.Close(context.Background()) })
	if err := adapter.UpdateSession(platform.RuntimeSession{Agent: platform.AgentIdentity{
		ID: reminderAgentID, ServerID: reminderServerID, UserID: "im_agent_task",
		ReplyPolicy: "dm_only", RuntimeKind: "codex",
	}}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for {
		if revision, ok := taskStore.DeliveredRevision(taskReconcilerTaskID); ok && revision == 3 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("Task delivery watermark was not persisted")
		}
		time.Sleep(time.Millisecond)
	}
	select {
	case input := <-planned:
		if !input.WakeMessageTransient {
			t.Fatal("Task wake was modeled as durable chat inbox content")
		}
	case <-time.After(time.Second):
		t.Fatal("Task launch planning was not observed")
	}
	manager.mu.Lock()
	if len(manager.starts) != 1 ||
		!strings.Contains(manager.starts[0].Prompt, "vela task claim") ||
		!strings.Contains(manager.starts[0].Prompt, "--number 9") {
		t.Fatalf("starts = %#v", manager.starts)
	}
	manager.mu.Unlock()
	for index := range 2 {
		message := incomingMessage(t, fmt.Sprintf("task-hint-%d", index), "")
		message.Elements = []im.Element{{Type: im.ElementCustom, CustomType: TaskWakeCustomType}}
		result, err := adapter.HandleIngressMessage(context.Background(), message)
		if err != nil || result.Disposition != ingress.Consumed {
			t.Fatalf("task hint result = %#v, %v", result, err)
		}
	}
	if err := adapter.ReconcileTasks(context.Background()); err != nil {
		t.Fatal(err)
	}
	manager.mu.Lock()
	starts := len(manager.starts)
	manager.mu.Unlock()
	if starts != 1 {
		t.Fatalf("duplicate Task wake starts = %d", starts)
	}
}
