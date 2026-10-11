//go:build darwin || linux

package daemon

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"velachat/agent/internal/common"
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

func TestRunnerDispatchesAcceptedProfileCapabilityRefresh(t *testing.T) {
	t.Parallel()

	agent := runningAgent(
		"018f0c9e-7b14-7abc-8def-0123456789ab",
		1,
	)
	agent.ProfileCapabilityRefresh = &ProfileCapabilityRefresh{
		SchemaVersion:         1,
		RefreshID:             "019fdb62-966b-7c88-a38f-d8a33d77eb70",
		ContextGeneration:     1,
		AuthorityContextKey:   "9-IO_89H4x2KmxY6eGj2NdgUqWLJv0eBqbxbQn3RCN0",
		RuntimeKind:           "codex",
		InvalidationWatermark: 0,
		ForceReload:           true,
		RequestedAt:           time.Now().UTC(),
	}
	snapshot := newSnapshot(t, 1, []AgentAssignment{agent})
	snapshot.SchemaVersion = AssignmentSchemaVersionV2
	_, snapshotDigest, err := CanonicalSnapshot(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	snapshot.SnapshotHash = base64.RawURLEncoding.EncodeToString(
		snapshotDigest[:],
	)
	if err := ValidateSnapshot(snapshot, testComputerID); err != nil {
		t.Fatalf("capability snapshot is invalid: %v", err)
	}
	source := &fakeAssignmentSource{
		results: []PollResult{{Snapshot: &snapshot}},
	}
	registry, err := NewRegistry(RegistryConfig{
		Factory: &fakeFactory{}, MaxConcurrent: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	sink := &fakeCapabilitySink{calls: make(chan AgentAssignment, 1)}
	runner, err := NewRunner(RunnerConfig{
		StateRoot: shortDaemonRoot(t), Version: "test-version",
		ComputerID: testComputerID, Source: source, Registry: registry,
		CapabilitySink: sink,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runner.Run(ctx) }()

	select {
	case got := <-sink.calls:
		if got.AgentID != agent.AgentID ||
			got.ProfileCapabilityRefresh == nil ||
			got.ProfileCapabilityRefresh.RefreshID !=
				agent.ProfileCapabilityRefresh.RefreshID {
			t.Fatalf("capability assignment = %#v", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf(
			"accepted capability refresh was not dispatched: %#v",
			runner.Status(),
		)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
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

	var cursor assignmentCursorState
	if err := common.Unmarshal([]byte(fmt.Sprintf(
		`{"schemaVersion":2,"assignmentSchemaVersion":3,"epoch":%q,"revision":3,"snapshotHash":"stable-hash","appliedAt":"2026-08-18T00:00:00Z"}`,
		testEpoch,
	)), &cursor); err != nil {
		t.Fatal(err)
	}
	if err := validateSnapshotAgainstCursor(cursor, Snapshot{
		Epoch: testEpoch, Revision: 2, SnapshotHash: "older-hash",
	}); !errors.Is(err, ErrRevisionRegressed) {
		t.Fatalf("regressed snapshot error = %v", err)
	}
	if err := validateSnapshotAgainstCursor(cursor, Snapshot{
		SchemaVersion: AssignmentSchemaVersionV3,
		Epoch:         testEpoch, Revision: 3, SnapshotHash: "other-hash",
	}); !errors.Is(err, ErrRevisionCollision) {
		t.Fatalf("colliding snapshot error = %v", err)
	}
	if err := validateSnapshotAgainstCursor(cursor, Snapshot{
		SchemaVersion: AssignmentSchemaVersionV3,
		Epoch:         testEpoch, Revision: 3, SnapshotHash: "stable-hash",
	}); err != nil {
		t.Fatalf("same snapshot error = %v", err)
	}
	var previousProtocolCursor assignmentCursorState
	if err := common.Unmarshal([]byte(fmt.Sprintf(
		`{"schemaVersion":2,"assignmentSchemaVersion":2,"epoch":%q,"revision":3,"snapshotHash":"v2-hash","appliedAt":"2026-08-18T00:00:00Z"}`,
		testEpoch,
	)), &previousProtocolCursor); err != nil {
		t.Fatal(err)
	}
	if err := validateSnapshotAgainstCursor(previousProtocolCursor, Snapshot{
		SchemaVersion: AssignmentSchemaVersionV3,
		Epoch:         testEpoch, Revision: 3, SnapshotHash: "v3-hash",
	}); err != nil {
		t.Fatalf("protocol transition error = %v", err)
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
		HeartbeatInterval: time.Hour,
		RetryDelay:        func(int) time.Duration { return 0 },
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runner.Run(ctx) }()
	deadline := time.Now().Add(500 * time.Millisecond)
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

func TestHeartbeatWakeSkipsAnAlreadySentAssignmentFence(t *testing.T) {
	registry, err := NewRegistry(RegistryConfig{
		Factory: &fakeFactory{}, MaxConcurrent: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	sink := &fakeHeartbeatSink{}
	runner, err := NewRunner(RunnerConfig{
		StateRoot: shortDaemonRoot(t), Version: "test-version",
		ComputerID: testComputerID, Source: &fakeAssignmentSource{},
		Registry: registry, HeartbeatSink: sink,
		HeartbeatInterval: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	runner.setStatus(Status{
		Online: true, Version: "test-version",
		Assignment:     AssignmentStatus{Epoch: testEpoch, Revision: 3},
		ReconcileState: "healthy",
	})
	runner.signalHeartbeat()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		runner.runHeartbeats(ctx)
		close(done)
	}()
	deadline := time.Now().Add(500 * time.Millisecond)
	for len(sink.copy()) == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if len(sink.copy()) != 1 {
		t.Fatalf("initial heartbeat count = %d", len(sink.copy()))
	}
	runner.signalHeartbeat()
	time.Sleep(25 * time.Millisecond)
	if len(sink.copy()) != 1 {
		t.Fatalf("duplicate heartbeat count = %d", len(sink.copy()))
	}
	cancel()
	<-done
}

func TestHeartbeatRetrySwitchesToTheLatestAssignmentFence(t *testing.T) {
	registry, err := NewRegistry(RegistryConfig{
		Factory: &fakeFactory{}, MaxConcurrent: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	sink := &scriptedHeartbeatSink{}
	runner, err := NewRunner(RunnerConfig{
		StateRoot: shortDaemonRoot(t), Version: "test-version",
		ComputerID: testComputerID, Source: &fakeAssignmentSource{},
		Registry: registry, HeartbeatSink: sink,
		HeartbeatInterval: time.Hour,
		RetryDelay:        func(int) time.Duration { return 0 },
	})
	if err != nil {
		t.Fatal(err)
	}
	runner.setStatus(Status{
		Online: true, Version: "test-version",
		Assignment:     AssignmentStatus{Epoch: testEpoch, Revision: 3},
		ReconcileState: "healthy",
	})
	sink.send = func(attempt int, _ Heartbeat) error {
		if attempt != 1 {
			return nil
		}
		status := runner.Status()
		status.Assignment.Revision = 4
		runner.setStatus(status)
		return errors.New("transient heartbeat failure")
	}
	sent, fence := runner.sendLatestHeartbeat(
		context.Background(), false, heartbeatFence{},
	)
	if !sent || fence != (heartbeatFence{epoch: testEpoch, revision: 4}) {
		t.Fatalf("send result = %v, %#v", sent, fence)
	}
	values := sink.copy()
	if len(values) != 2 ||
		values[0].AssignmentRevision != 3 ||
		values[1].AssignmentRevision != 4 ||
		values[0].HeartbeatID == values[1].HeartbeatID {
		t.Fatalf("heartbeat attempts = %#v", values)
	}
}

func TestHeartbeatIntervalJitterUsesUniformTenPercentBand(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		sample float64
		want   time.Duration
	}{
		{name: "lower bound", sample: 0, want: 54 * time.Second},
		{name: "midpoint", sample: 0.5, want: 60 * time.Second},
		{name: "upper bound", sample: 1, want: 66 * time.Second},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := jitterHeartbeatInterval(time.Minute, test.sample); got != test.want {
				t.Fatalf("jittered interval = %s, want %s", got, test.want)
			}
		})
	}
}

func TestRunnerUsesInjectedHeartbeatJitterForEachNormalInterval(t *testing.T) {
	registry, err := NewRegistry(RegistryConfig{
		Factory: &fakeFactory{}, MaxConcurrent: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	intervals := []time.Duration{54 * time.Second, 66 * time.Second}
	calls := 0
	runner, err := NewRunner(RunnerConfig{
		StateRoot: shortDaemonRoot(t), Version: "test-version",
		ComputerID: testComputerID, Source: &fakeAssignmentSource{},
		Registry: registry, HeartbeatSink: &fakeHeartbeatSink{},
		HeartbeatInterval: time.Minute,
		HeartbeatJitter: func(base time.Duration) time.Duration {
			if base != time.Minute {
				t.Fatalf("base interval = %s", base)
			}
			value := intervals[calls]
			calls++
			return value
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := runner.nextHeartbeatInterval(); got != intervals[0] {
		t.Fatalf("first interval = %s", got)
	}
	if got := runner.nextHeartbeatInterval(); got != intervals[1] {
		t.Fatalf("second interval = %s", got)
	}
	if calls != 2 {
		t.Fatalf("jitter calls = %d", calls)
	}
}

func TestHeartbeatRetryDoesNotUseIntervalJitter(t *testing.T) {
	registry, err := NewRegistry(RegistryConfig{
		Factory: &fakeFactory{}, MaxConcurrent: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	sink := &scriptedHeartbeatSink{}
	jitterCalls := 0
	runner, err := NewRunner(RunnerConfig{
		StateRoot: shortDaemonRoot(t), Version: "test-version",
		ComputerID: testComputerID, Source: &fakeAssignmentSource{},
		Registry: registry, HeartbeatSink: sink,
		HeartbeatInterval: time.Minute,
		HeartbeatJitter: func(base time.Duration) time.Duration {
			jitterCalls++
			return base
		},
		RetryDelay: func(int) time.Duration { return 0 },
	})
	if err != nil {
		t.Fatal(err)
	}
	runner.setStatus(Status{
		Online: true, Version: "test-version",
		Assignment:     AssignmentStatus{Epoch: testEpoch, Revision: 3},
		ReconcileState: "healthy",
	})
	sink.send = func(attempt int, _ Heartbeat) error {
		if attempt == 1 {
			return errors.New("transient heartbeat failure")
		}
		return nil
	}
	sent, _ := runner.sendLatestHeartbeat(
		context.Background(), false, heartbeatFence{},
	)
	if !sent {
		t.Fatal("heartbeat was not eventually sent")
	}
	if jitterCalls != 0 {
		t.Fatalf("retry used heartbeat jitter %d times", jitterCalls)
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

type fakeCapabilitySink struct {
	calls chan AgentAssignment
}

func (s *fakeCapabilitySink) Refresh(
	_ context.Context,
	assignment AgentAssignment,
) {
	s.calls <- assignment
}

type scriptedHeartbeatSink struct {
	mu      sync.Mutex
	values  []Heartbeat
	attempt int
	send    func(int, Heartbeat) error
}

func (s *scriptedHeartbeatSink) Send(
	_ context.Context,
	value Heartbeat,
) error {
	s.mu.Lock()
	s.attempt++
	attempt := s.attempt
	s.values = append(s.values, value)
	s.mu.Unlock()
	if s.send == nil {
		return nil
	}
	return s.send(attempt, value)
}

func (s *scriptedHeartbeatSink) copy() []Heartbeat {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Heartbeat(nil), s.values...)
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
