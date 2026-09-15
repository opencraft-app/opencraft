package daemon

import (
	"context"
	"encoding/base64"
	"sync"
	"testing"
)

const (
	testComputerID = "018f0c9e-7b12-7abc-8def-0123456789ab"
	testServerID   = "018f0c9e-7b10-7abc-8def-0123456789ab"
	testEpoch      = "018f0c9e-7b13-7abc-8def-0123456789ab"
)

func TestEmptySnapshotMatchesFrozenJCSFixture(t *testing.T) {
	t.Parallel()

	snapshot := Snapshot{
		SchemaVersion: 1,
		ComputerID:    testComputerID,
		Epoch:         testEpoch,
		Revision:      1,
		Agents:        []AgentAssignment{},
	}
	canonical, hash, err := CanonicalSnapshot(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	const wantCanonical = `{"agents":[],"computerId":"018f0c9e-7b12-7abc-8def-0123456789ab","epoch":"018f0c9e-7b13-7abc-8def-0123456789ab","revision":1,"schemaVersion":1}`
	if string(canonical) != wantCanonical {
		t.Fatalf("canonical = %s", canonical)
	}
	if got := base64.RawURLEncoding.EncodeToString(hash[:]); got !=
		"KBcQSbQLv1TrsFOG_rj_6Fav01wz2__kQ217Y9fvP6Y" {
		t.Fatalf("snapshot hash = %s", got)
	}
}

func TestValidateSnapshotRejectsWholeInvalidSnapshot(t *testing.T) {
	t.Parallel()

	valid := newSnapshot(t, 1, []AgentAssignment{
		runningAgent("018f0c9e-7b14-7abc-8def-0123456789ab", 1),
	})
	tests := []struct {
		name   string
		mutate func(*Snapshot)
	}{
		{"wrong schema", func(s *Snapshot) { s.SchemaVersion = 99 }},
		{"wrong computer", func(s *Snapshot) { s.ComputerID = testServerID }},
		{"hash mismatch", func(s *Snapshot) { s.SnapshotHash = "bad" }},
		{"duplicate agent", func(s *Snapshot) { s.Agents = append(s.Agents, s.Agents[0]) }},
		{"unknown desired state", func(s *Snapshot) { s.Agents[0].DesiredState = "paused" }},
		{"unknown runtime", func(s *Snapshot) { s.Agents[0].Runtime.Kind = "unknown" }},
		{"unknown reply policy", func(s *Snapshot) { s.Agents[0].ReplyPolicy = "everyone" }},
		{"generation zero", func(s *Snapshot) { s.Agents[0].ConfigGeneration = 0 }},
		{"credential zero", func(s *Snapshot) { s.Agents[0].CredentialVersion = 0 }},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			snapshot := valid
			snapshot.Agents = append([]AgentAssignment(nil), valid.Agents...)
			test.mutate(&snapshot)
			if err := ValidateSnapshot(snapshot, testComputerID); err == nil {
				t.Fatal("invalid snapshot accepted")
			}
		})
	}
}

func TestValidateSnapshotAcceptsPlatformRuntimeKindsAndReplyPolicies(t *testing.T) {
	for _, test := range []struct {
		kind   string
		policy string
	}{
		{kind: "codex", policy: "mention_and_dm"},
		{kind: "hermes-acp", policy: "dm_only"},
		{kind: "hermes-gateway", policy: "all_channel_messages"},
		{kind: "openclaw", policy: "mention_and_dm"},
	} {
		schemaVersion := 1
		if test.kind == "openclaw" {
			schemaVersion = 3
		}
		snapshot := newSnapshot(t, 1, []AgentAssignment{
			runningAgent("018f0c9e-7b14-7abc-8def-0123456789ab", 1),
		})
		snapshot.SchemaVersion = schemaVersion
		snapshot.Agents[0].Runtime.Kind = test.kind
		snapshot.Agents[0].ReplyPolicy = test.policy
		_, digest, err := CanonicalSnapshot(snapshot)
		if err != nil {
			t.Fatal(err)
		}
		snapshot.SnapshotHash = base64.RawURLEncoding.EncodeToString(digest[:])
		if err := ValidateSnapshot(snapshot, testComputerID); err != nil {
			t.Fatalf("ValidateSnapshot(%s, %s) error = %v", test.kind, test.policy, err)
		}
	}
}

func TestValidateSnapshotBindsAndValidatesCurrentLaunch(t *testing.T) {
	agent := runningAgent("018f0c9e-7b14-7abc-8def-0123456789ab", 2)
	withoutLaunch := newSnapshot(t, 1, []AgentAssignment{agent})

	agent.CurrentLaunch = &AssignmentLaunchFence{
		LaunchID:          "018f0c9e-7b16-7abc-8def-0123456789ab",
		AssignmentEpoch:   testEpoch,
		ConfigGeneration:  1,
		CredentialVersion: 1,
		Attempt:           7,
	}
	withLaunch := newSnapshot(t, 1, []AgentAssignment{agent})
	if withLaunch.SnapshotHash == withoutLaunch.SnapshotHash {
		t.Fatal("currentLaunch was omitted from canonical snapshot hash")
	}
	if err := ValidateSnapshot(withLaunch, testComputerID); err != nil {
		t.Fatalf("ValidateSnapshot(currentLaunch) error = %v", err)
	}

	invalid := withLaunch
	invalid.Agents = append([]AgentAssignment(nil), withLaunch.Agents...)
	invalidFence := *invalid.Agents[0].CurrentLaunch
	invalidFence.Attempt = 0
	invalid.Agents[0].CurrentLaunch = &invalidFence
	_, digest, err := CanonicalSnapshot(invalid)
	if err != nil {
		t.Fatal(err)
	}
	invalid.SnapshotHash = base64.RawURLEncoding.EncodeToString(digest[:])
	if err := ValidateSnapshot(invalid, testComputerID); err == nil {
		t.Fatal("invalid currentLaunch was accepted")
	}
}

func TestRegistryReconcilesMultipleAgentsWithGenerationFencing(t *testing.T) {
	t.Parallel()

	factory := &fakeFactory{}
	registry, err := NewRegistry(RegistryConfig{
		Factory:       factory,
		MaxConcurrent: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	agentA := runningAgent("018f0c9e-7b14-7abc-8def-0123456789ab", 1)
	agentB := runningAgent("018f0c9e-7b15-7abc-8def-0123456789ab", 2)
	first := newSnapshot(t, 1, []AgentAssignment{agentB, agentA})
	if result, err := registry.Apply(context.Background(), first); err != nil || !result.Accepted {
		t.Fatalf("Apply() = %#v, %v", result, err)
	}
	waitFor(t, func() bool { return len(factory.starts()) == 2 })
	if got := factory.starts(); len(got) != 2 ||
		!containsStartedAgent(got, agentA.AgentID, 1, 1) ||
		!containsStartedAgent(got, agentB.AgentID, 2, 1) {
		t.Fatalf("initial starts = %#v", got)
	}

	agentA.ConfigGeneration = 3
	second := newSnapshot(t, 2, []AgentAssignment{agentA})
	if result, err := registry.Apply(context.Background(), second); err != nil || !result.Accepted {
		t.Fatalf("Apply() = %#v, %v", result, err)
	}
	waitFor(t, func() bool {
		return len(factory.starts()) == 3 && len(factory.closes()) == 2
	})
	starts := factory.starts()
	if len(starts) != 3 ||
		!containsStartedAgent(starts, agentA.AgentID, 3, 2) {
		t.Fatalf("updated starts = %#v", starts)
	}
	if closes := factory.closes(); len(closes) != 2 ||
		!containsString(closes, agentA.AgentID) ||
		!containsString(closes, agentB.AgentID) {
		t.Fatalf("closes = %#v", closes)
	}
	status := registry.Status()
	if len(status) != 1 ||
		status[0].AgentID != agentA.AgentID ||
		status[0].ConfigGeneration != 3 ||
		status[0].Attempt != 2 {
		t.Fatalf("status = %#v", status)
	}
}

func containsStartedAgent(
	values []AgentStatus,
	agentID string,
	generation int64,
	attempt int64,
) bool {
	for _, value := range values {
		if value.AgentID == agentID &&
			value.ConfigGeneration == generation &&
			value.Attempt == attempt {
			return true
		}
	}
	return false
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func TestRegistryRejectsInvalidSnapshotWithoutPartialMutation(t *testing.T) {
	t.Parallel()

	factory := &fakeFactory{}
	registry, err := NewRegistry(RegistryConfig{
		Factory:       factory,
		MaxConcurrent: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	initialAgent := runningAgent(
		"018f0c9e-7b14-7abc-8def-0123456789ab",
		1,
	)
	if result, err := registry.Apply(
		context.Background(),
		newSnapshot(t, 1, []AgentAssignment{initialAgent}),
	); err != nil || !result.Accepted {
		t.Fatalf("Apply() = %#v, %v", result, err)
	}
	waitFor(t, func() bool { return len(factory.starts()) == 1 })
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
	invalid := newSnapshot(t, 2, tooMany)
	if result, err := registry.Apply(context.Background(), invalid); err != nil ||
		result.Accepted || result.ErrorCode != "assignment_capacity_exceeded" {
		t.Fatalf("Apply() = %#v, %v", result, err)
	}
	if len(factory.starts()) != 1 || len(factory.closes()) != 0 {
		t.Fatalf(
			"invalid snapshot mutated registry: starts=%#v closes=%#v",
			factory.starts(),
			factory.closes(),
		)
	}
	if status := registry.Status(); len(status) != 1 ||
		status[0].AgentID != initialAgent.AgentID {
		t.Fatalf("status after rejection = %#v", status)
	}
}

func TestRegistryRejectsRevisionRegressionAndCollision(t *testing.T) {
	t.Parallel()

	factory := &fakeFactory{}
	registry, err := NewRegistry(RegistryConfig{
		Factory:       factory,
		MaxConcurrent: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	agent := runningAgent("018f0c9e-7b14-7abc-8def-0123456789ab", 1)
	first := newSnapshot(t, 2, []AgentAssignment{agent})
	if result, err := registry.Apply(context.Background(), first); err != nil || !result.Accepted {
		t.Fatalf("Apply() = %#v, %v", result, err)
	}
	regressed := newSnapshot(t, 1, []AgentAssignment{agent})
	if result, err := registry.Apply(context.Background(), regressed); err != nil ||
		result.Accepted || result.ErrorCode != "assignment_revision_regressed" {
		t.Fatalf("regression Apply() = %#v, %v", result, err)
	}
	agent.ConfigGeneration = 2
	collision := newSnapshot(t, 2, []AgentAssignment{agent})
	if result, err := registry.Apply(context.Background(), collision); err != nil ||
		result.Accepted || result.ErrorCode != "assignment_revision_collision" {
		t.Fatalf("collision Apply() = %#v, %v", result, err)
	}
}

func newSnapshot(
	t *testing.T,
	revision int64,
	agents []AgentAssignment,
) Snapshot {
	t.Helper()
	snapshot := Snapshot{
		SchemaVersion: 1,
		ComputerID:    testComputerID,
		Epoch:         testEpoch,
		Revision:      revision,
		Agents:        agents,
	}
	_, hash, err := CanonicalSnapshot(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	snapshot.SnapshotHash = base64.RawURLEncoding.EncodeToString(hash[:])
	return snapshot
}

func runningAgent(agentID string, generation int64) AgentAssignment {
	return AgentAssignment{
		AgentID:           agentID,
		ServerID:          testServerID,
		DesiredState:      DesiredRunning,
		ConfigGeneration:  generation,
		CredentialVersion: 1,
		Runtime: RuntimeConfig{
			Kind: "codex",
		},
		ReplyPolicy: "mention_and_dm",
	}
}

type fakeFactory struct {
	mu         sync.Mutex
	started    []AgentStatus
	closed     []string
	startError error
}

func (f *fakeFactory) Start(
	_ context.Context,
	request AgentStartRequest,
) (AgentInstance, error) {
	assignment := request.Launch.Assignment
	fence := request.Launch.Fence
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.startError != nil {
		return nil, f.startError
	}
	status := AgentStatus{
		AgentID:          assignment.AgentID,
		ConfigGeneration: assignment.ConfigGeneration,
		Attempt:          fence.Attempt,
		LaunchID:         fence.LaunchID,
	}
	f.started = append(f.started, status)
	return &fakeInstance{factory: f, agentID: assignment.AgentID}, nil
}

func (f *fakeFactory) starts() []AgentStatus {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]AgentStatus(nil), f.started...)
}

func (f *fakeFactory) closes() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.closed...)
}

type fakeInstance struct {
	factory *fakeFactory
	agentID string
	ready   chan struct{}
	done    chan struct{}
	once    sync.Once
}

func (i *fakeInstance) Ready() <-chan struct{} {
	if i.ready == nil {
		i.ready = make(chan struct{})
		close(i.ready)
	}
	return i.ready
}

func (i *fakeInstance) Done() <-chan struct{} {
	if i.done == nil {
		i.done = make(chan struct{})
	}
	return i.done
}

func (*fakeInstance) Err() error { return nil }

func (*fakeInstance) Revoke(context.Context) error { return nil }

func (i *fakeInstance) Close(context.Context) error {
	i.factory.mu.Lock()
	defer i.factory.mu.Unlock()
	i.factory.closed = append(i.factory.closed, i.agentID)
	i.once.Do(func() {
		if i.done == nil {
			i.done = make(chan struct{})
		}
		close(i.done)
	})
	return nil
}
