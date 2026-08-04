//go:build darwin || linux

package daemon

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	rootstate "velachat/agent/internal/state"
	"velachat/agent/internal/vela/managementipc"
)

func TestRunnerAppliesAssignmentsAndServesManagementStatus(t *testing.T) {
	t.Parallel()

	root := shortDaemonRoot(t)
	agent := runningAgent(
		"018f0c9e-7b14-7abc-8def-0123456789ab",
		1,
	)
	snapshot := newSnapshot(t, 1, []AgentAssignment{agent})
	source := &fakeAssignmentSource{
		results: []PollResult{{Snapshot: &snapshot}},
	}
	factory := &fakeFactory{}
	registry, err := NewRegistry(RegistryConfig{
		Factory:       factory,
		MaxConcurrent: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	runner, err := NewRunner(RunnerConfig{
		StateRoot:  root,
		Version:    "test-version",
		ComputerID: testComputerID,
		Source:     source,
		Registry:   registry,
		Now:        time.Now,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runner.Run(ctx) }()

	client := managementipc.NewClient(
		filepath.Join(root, "daemon.sock"),
		"test-client",
	)
	var status Status
	deadline := time.Now().Add(5 * time.Second)
	for {
		requestID, err := uuid.NewV7()
		if err != nil {
			t.Fatal(err)
		}
		callCtx, callCancel := context.WithTimeout(
			context.Background(),
			100*time.Millisecond,
		)
		err = client.Call(
			callCtx,
			requestID.String(),
			"status.get",
			map[string]any{},
			&status,
		)
		callCancel()
		if err == nil && status.Assignment.Revision == 1 &&
			len(status.Agents) == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("daemon did not expose applied status: %v %#v", err, status)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !status.Online ||
		status.Version != "test-version" ||
		status.ComputerID != testComputerID ||
		status.Assignment.Epoch != testEpoch ||
		status.Agents[0].AgentID != agent.AgentID {
		t.Fatalf("status = %#v", status)
	}
	requests := source.requestsCopy()
	if len(requests) < 1 ||
		requests[0].SinceRevision != 0 ||
		!requests[0].ForceFull {
		t.Fatalf("initial poll = %#v", requests)
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("daemon did not stop after cancellation")
	}
	if _, err := os.Stat(filepath.Join(root, "daemon.sock")); !os.IsNotExist(err) {
		t.Fatalf("socket remains after stop: %v", err)
	}
}

func TestRunnerColdStartForcesFullSnapshotWithPersistedCursor(t *testing.T) {
	t.Parallel()

	root := shortDaemonRoot(t)
	agent := runningAgent(
		"018f0c9e-7b14-7abc-8def-0123456789ab",
		3,
	)
	snapshot := newSnapshot(t, 3, []AgentAssignment{agent})
	if err := rootstate.New(root).Write(assignmentCursor, assignmentCursorState{
		SchemaVersion: 1,
		Epoch:         snapshot.Epoch,
		Revision:      snapshot.Revision,
		SnapshotHash:  snapshot.SnapshotHash,
		AppliedAt:     time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	source := &fakeAssignmentSource{results: []PollResult{{Snapshot: &snapshot}}}
	registry, err := NewRegistry(RegistryConfig{
		Factory:       &fakeFactory{},
		MaxConcurrent: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	runner, err := NewRunner(RunnerConfig{
		StateRoot:  root,
		Version:    "test-version",
		ComputerID: testComputerID,
		Source:     source,
		Registry:   registry,
		Now:        time.Now,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runner.Run(ctx) }()
	deadline := time.Now().Add(5 * time.Second)
	for len(runner.Status().Agents) != 1 {
		if time.Now().After(deadline) {
			t.Fatal("persisted Assignment did not reconstruct the Agent registry")
		}
		time.Sleep(10 * time.Millisecond)
	}
	requests := source.requestsCopy()
	if len(requests) == 0 || !requests[0].ForceFull ||
		requests[0].SinceEpoch != snapshot.Epoch ||
		requests[0].SinceRevision != snapshot.Revision {
		t.Fatalf("cold-start poll = %#v", requests)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestColdStartSnapshotCannotRegressPersistedCursor(t *testing.T) {
	t.Parallel()

	cursor := assignmentCursorState{
		Epoch: testEpoch, Revision: 3, SnapshotHash: "stable-hash",
	}
	if err := validateSnapshotAgainstCursor(cursor, Snapshot{
		Epoch: testEpoch, Revision: 2, SnapshotHash: "older-hash",
	}); !errors.Is(err, ErrRevisionRegressed) {
		t.Fatalf("regressed snapshot error = %v", err)
	}
	if err := validateSnapshotAgainstCursor(cursor, Snapshot{
		Epoch: testEpoch, Revision: 3, SnapshotHash: "other-hash",
	}); !errors.Is(err, ErrRevisionCollision) {
		t.Fatalf("colliding snapshot error = %v", err)
	}
	if err := validateSnapshotAgainstCursor(cursor, Snapshot{
		Epoch: testEpoch, Revision: 3, SnapshotHash: "stable-hash",
	}); err != nil {
		t.Fatalf("same snapshot error = %v", err)
	}
	if err := validateSnapshotAgainstCursor(cursor, Snapshot{
		Epoch:    "01900000-0000-7000-8000-000000000099",
		Revision: 1, SnapshotHash: "new-epoch",
	}); err != nil {
		t.Fatalf("new epoch error = %v", err)
	}
}

func TestRunnerUsesSingleInstanceLock(t *testing.T) {
	t.Parallel()

	root := shortDaemonRoot(t)
	firstSource := &fakeAssignmentSource{}
	firstRegistry, err := NewRegistry(RegistryConfig{
		Factory:       &fakeFactory{},
		MaxConcurrent: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	first, err := NewRunner(RunnerConfig{
		StateRoot:  root,
		Version:    "test-version",
		ComputerID: testComputerID,
		Source:     firstSource,
		Registry:   firstRegistry,
		Now:        time.Now,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- first.Run(ctx) }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(filepath.Join(root, "daemon.sock")); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("first daemon did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}

	secondRegistry, err := NewRegistry(RegistryConfig{
		Factory:       &fakeFactory{},
		MaxConcurrent: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := NewRunner(RunnerConfig{
		StateRoot:  root,
		Version:    "test-version",
		ComputerID: testComputerID,
		Source:     &fakeAssignmentSource{},
		Registry:   secondRegistry,
		Now:        time.Now,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := second.Run(context.Background()); !errors.Is(
		err,
		ErrDaemonAlreadyRunning,
	) {
		t.Fatalf("second daemon error = %v", err)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestRunnerRetriesAssignmentPollWithoutStoppingDaemon(t *testing.T) {
	t.Parallel()

	root := shortDaemonRoot(t)
	snapshot := newSnapshot(t, 1, nil)
	source := &fakeAssignmentSource{
		errors:  []error{errors.New("temporary network failure")},
		results: []PollResult{{Snapshot: &snapshot}},
	}
	registry, err := NewRegistry(RegistryConfig{
		Factory:       &fakeFactory{},
		MaxConcurrent: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	runner, err := NewRunner(RunnerConfig{
		StateRoot:  root,
		Version:    "test-version",
		ComputerID: testComputerID,
		Source:     source,
		Registry:   registry,
		Now:        time.Now,
		RetryDelay: func(int) time.Duration { return 0 },
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runner.Run(ctx) }()
	deadline := time.Now().Add(5 * time.Second)
	for runner.Status().Assignment.Revision != 1 {
		if time.Now().After(deadline) {
			t.Fatal("assignment was not applied after transient failure")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if len(source.requestsCopy()) < 2 {
		t.Fatal("assignment source was not retried")
	}
}

func TestRunnerKeepsServingAfterRejectedAssignmentSnapshot(t *testing.T) {
	t.Parallel()

	root := shortDaemonRoot(t)
	tooMany := make([]AgentAssignment, 0, 6)
	for index := 0; index < 6; index++ {
		tooMany = append(tooMany, runningAgent(
			[]string{
				"018f0c9e-7b20-7abc-8def-0123456789ab",
				"018f0c9e-7b21-7abc-8def-0123456789ab",
				"018f0c9e-7b22-7abc-8def-0123456789ab",
				"018f0c9e-7b23-7abc-8def-0123456789ab",
				"018f0c9e-7b24-7abc-8def-0123456789ab",
				"018f0c9e-7b25-7abc-8def-0123456789ab",
			}[index],
			1,
		))
	}
	rejected := newSnapshot(t, 1, tooMany)
	accepted := newSnapshot(t, 1, nil)
	source := &fakeAssignmentSource{results: []PollResult{
		{Snapshot: &rejected},
		{Snapshot: &accepted},
	}}
	registry, err := NewRegistry(RegistryConfig{
		Factory:       &fakeFactory{},
		MaxConcurrent: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	runner, err := NewRunner(RunnerConfig{
		StateRoot:  root,
		Version:    "test-version",
		ComputerID: testComputerID,
		Source:     source,
		Registry:   registry,
		Now:        time.Now,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runner.Run(ctx) }()
	waitFor(t, func() bool {
		return runner.Status().Assignment.Revision == 1
	})
	select {
	case err := <-done:
		t.Fatalf("runner exited after rejected snapshot: %v", err)
	default:
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if len(source.requestsCopy()) < 2 {
		t.Fatal("runner did not continue polling after rejected snapshot")
	}
}

func TestRunnerArchivesCorruptCursorAndForcesFullPoll(t *testing.T) {
	t.Parallel()

	root := shortDaemonRoot(t)
	if err := os.WriteFile(
		filepath.Join(root, assignmentCursor),
		[]byte(`{"schemaVersion":1,"revision":-1}`),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	source := &fakeAssignmentSource{}
	registry, err := NewRegistry(RegistryConfig{
		Factory:       &fakeFactory{},
		MaxConcurrent: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	runner, err := NewRunner(RunnerConfig{
		StateRoot:  root,
		Version:    "test-version",
		ComputerID: testComputerID,
		Source:     source,
		Registry:   registry,
		Now:        time.Now,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runner.Run(ctx) }()
	deadline := time.Now().Add(5 * time.Second)
	for len(source.requestsCopy()) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("runner did not recover from corrupt cursor")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	request := source.requestsCopy()[0]
	if !request.ForceFull || request.SinceRevision != 0 {
		t.Fatalf("first request = %#v", request)
	}
	matches, err := filepath.Glob(
		filepath.Join(root, "assignment.cursor.corrupt-*.json"),
	)
	if err != nil || len(matches) != 1 {
		t.Fatalf("corrupt cursor archive = %#v, %v", matches, err)
	}
}

func TestRunnerSendsHeartbeatFromAppliedAssignment(t *testing.T) {
	t.Parallel()

	root := shortDaemonRoot(t)
	agent := runningAgent(
		"018f0c9e-7b14-7abc-8def-0123456789ab",
		7,
	)
	snapshot := newSnapshot(t, 3, []AgentAssignment{agent})
	source := &fakeAssignmentSource{
		results: []PollResult{{Snapshot: &snapshot}},
	}
	registry, err := NewRegistry(RegistryConfig{
		Factory:       &fakeFactory{},
		MaxConcurrent: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	heartbeats := &fakeHeartbeatSink{}
	runner, err := NewRunner(RunnerConfig{
		StateRoot:         root,
		Version:           "test-version",
		BuildID:           "sha256:test-build",
		ComputerID:        testComputerID,
		Source:            source,
		Registry:          registry,
		Now:               time.Now,
		HeartbeatSink:     heartbeats,
		HeartbeatInterval: 10 * time.Millisecond,
		RetryDelay:        func(int) time.Duration { return 0 },
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runner.Run(ctx) }()
	deadline := time.Now().Add(5 * time.Second)
	for len(heartbeats.copy()) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("heartbeat was not sent")
		}
		time.Sleep(10 * time.Millisecond)
	}
	heartbeat := heartbeats.copy()[0]
	if heartbeat.AssignmentRevision != 3 ||
		heartbeat.AssignmentEpoch != testEpoch ||
		heartbeat.DaemonBuildID != "sha256:test-build" ||
		heartbeat.TATState != "online" ||
		heartbeat.ReconcileState != "healthy" ||
		len(heartbeat.Agents) != 1 ||
		heartbeat.Agents[0].ConfigGeneration != 7 ||
		heartbeat.Agents[0].AssignmentEpoch != testEpoch ||
		heartbeat.Agents[0].CredentialVersion != 1 {
		t.Fatalf("heartbeat = %#v", heartbeat)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestHeartbeatDoesNotAdvertiseUnhealthyCellAsOnline(t *testing.T) {
	t.Parallel()

	runner := &Runner{}
	heartbeat, err := runner.newHeartbeat(Status{
		Version: "test-version",
		Assignment: AssignmentStatus{
			Epoch:    testEpoch,
			Revision: 4,
		},
		ReconcileState: "degraded",
		ErrorCode:      "agent_host_exited",
		Agents: []AgentStatus{{
			AgentID:          "018f0c9e-7b14-7abc-8def-0123456789ab",
			ConfigGeneration: 3,
			Attempt:          2,
			LaunchID:         "018f0c9e-7b19-7abc-8def-0123456789ab",
			State:            AgentStateRetryWait,
			ErrorCode:        "agent_host_exited",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if heartbeat.ReconcileState != "error" ||
		heartbeat.ErrorCode == nil ||
		*heartbeat.ErrorCode != "agent_host_exited" ||
		len(heartbeat.Agents) != 0 {
		t.Fatalf("heartbeat = %#v", heartbeat)
	}
}

type fakeAssignmentSource struct {
	mu       sync.Mutex
	results  []PollResult
	errors   []error
	requests []PollRequest
}

type fakeHeartbeatSink struct {
	mu     sync.Mutex
	values []Heartbeat
}

func (s *fakeHeartbeatSink) Send(
	_ context.Context,
	value Heartbeat,
) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.values = append(s.values, value)
	return nil
}

func (s *fakeHeartbeatSink) copy() []Heartbeat {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Heartbeat(nil), s.values...)
}

func (s *fakeAssignmentSource) Poll(
	ctx context.Context,
	request PollRequest,
) (PollResult, error) {
	s.mu.Lock()
	s.requests = append(s.requests, request)
	if len(s.errors) > 0 {
		err := s.errors[0]
		s.errors = s.errors[1:]
		s.mu.Unlock()
		return PollResult{}, err
	}
	if len(s.results) > 0 {
		result := s.results[0]
		s.results = s.results[1:]
		s.mu.Unlock()
		return result, nil
	}
	s.mu.Unlock()
	<-ctx.Done()
	return PollResult{}, ctx.Err()
}

func (s *fakeAssignmentSource) requestsCopy() []PollRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]PollRequest(nil), s.requests...)
}

func shortDaemonRoot(t *testing.T) string {
	t.Helper()
	root, err := os.MkdirTemp("", "vela-daemon-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	return root
}
