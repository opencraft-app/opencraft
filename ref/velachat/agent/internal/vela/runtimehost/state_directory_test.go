package runtimehost

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"velachat/agent/internal/runtimeapi"
	velastate "velachat/agent/internal/vela/state"
)

func TestAdapterPersistsRuntimeStateOutsideWorkspace(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	agentID := "019fcafe-15a6-7494-9da6-0f69a8e60c24"
	stateDirectory := filepath.Join(root, "state", "agents", agentID)
	workspaceDirectory := filepath.Join(root, "workspaces", agentID)
	adapter, err := New(Config{
		AgentID:          agentID,
		StateDirectory:   stateDirectory,
		WorkingDirectory: workspaceDirectory,
		Actor:            &fakeManager{},
		Runtimes: fakeResolver{runtime: runtimeapi.ResolvedRuntime{
			ID: "codex", InternalID: "codex",
			LaunchPlanner: runtimeapi.LaunchPlannerFunc(noopPlan),
		}},
		NewRuntimeEpoch: func() (string, error) { return "runtime-epoch-1", nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = adapter.Close(context.Background()) })
	_, _, err = adapter.config.Occurrences.Observe(velastate.OccurrenceInput{
		AgentID:      agentID,
		OccurrenceID: "019fc179-4b0f-75a4-bc6d-b8348a7ab68e",
		ReminderID:   "019fc179-4b0f-75a4-bc6d-b8348a7ab68f",
		ScheduledAt:  time.Now().UTC(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(
		stateDirectory,
		velastate.OccurrenceStoreFilename,
	)); err != nil {
		t.Fatalf("runtime state was not written to Agent state directory: %v", err)
	}
	if _, err := os.Stat(filepath.Join(
		filepath.Dir(workspaceDirectory),
		velastate.OccurrenceStoreFilename,
	)); !os.IsNotExist(err) {
		t.Fatalf("runtime state leaked into workspace root: %v", err)
	}
}
