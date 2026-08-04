package daemon

import (
	"context"
	"encoding/base64"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestRegistryAcceptsSnapshotWhileOneAgentRetriesIndependently(t *testing.T) {
	t.Parallel()

	factory := newSupervisorFactory()
	agentA := "018f0c9e-7b14-7abc-8def-0123456789ab"
	agentB := "018f0c9e-7b15-7abc-8def-0123456789ab"
	factory.failNext(agentA, errors.New("temporary Agent A failure"))
	registry, err := NewRegistry(RegistryConfig{
		Factory:       factory,
		MaxConcurrent: 5,
		RetryDelay:    func(int) time.Duration { return time.Millisecond },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer registry.Close(context.Background())

	result, err := registry.Apply(context.Background(), newSnapshot(
		t,
		1,
		[]AgentAssignment{runningAgent(agentA, 1), runningAgent(agentB, 1)},
	))
	if err != nil || !result.Accepted {
		t.Fatalf("Apply() = %#v, %v", result, err)
	}
	waitRegistryState(t, registry, map[string]AgentState{
		agentA: AgentStateRunning,
		agentB: AgentStateRunning,
	})
	if attempts := factory.attempts(agentA); attempts != 2 {
		t.Fatalf("Agent A attempts = %d, want 2", attempts)
	}
	if attempts := factory.attempts(agentB); attempts != 1 {
		t.Fatalf("Agent B attempts = %d, want 1", attempts)
	}
}

func TestRegistryRestartsUnexpectedHostExitWithoutClosingOtherAgent(t *testing.T) {
	t.Parallel()

	factory := newSupervisorFactory()
	agentA := "018f0c9e-7b14-7abc-8def-0123456789ab"
	agentB := "018f0c9e-7b15-7abc-8def-0123456789ab"
	registry, err := NewRegistry(RegistryConfig{
		Factory:       factory,
		MaxConcurrent: 5,
		RetryDelay:    func(int) time.Duration { return time.Millisecond },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer registry.Close(context.Background())
	result, err := registry.Apply(context.Background(), newSnapshot(
		t,
		1,
		[]AgentAssignment{runningAgent(agentA, 1), runningAgent(agentB, 1)},
	))
	if err != nil || !result.Accepted {
		t.Fatalf("Apply() = %#v, %v", result, err)
	}
	waitRegistryState(t, registry, map[string]AgentState{
		agentA: AgentStateRunning,
		agentB: AgentStateRunning,
	})
	instanceA := factory.latest(agentA)
	instanceB := factory.latest(agentB)
	instanceA.exit(errors.New("IM host exited"))

	waitFor(t, func() bool { return factory.attempts(agentA) >= 2 })
	if instanceA.closeCount() == 0 {
		t.Fatal("exited Agent A instance was not closed before restart")
	}
	waitRegistryState(t, registry, map[string]AgentState{
		agentA: AgentStateRunning,
		agentB: AgentStateRunning,
	})
	if instanceB.closeCount() != 0 {
		t.Fatalf("Agent B was closed after Agent A failure")
	}
}

func TestRegistryApplyNeverWaitsForAgentStartIO(t *testing.T) {
	t.Parallel()

	factory := newSupervisorFactory()
	factory.block = make(chan struct{})
	registry, err := NewRegistry(RegistryConfig{
		Factory:       factory,
		MaxConcurrent: 5,
		RetryDelay:    func(int) time.Duration { return time.Millisecond },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer registry.Close(context.Background())

	startedAt := time.Now()
	result, err := registry.Apply(context.Background(), newSnapshot(
		t,
		1,
		[]AgentAssignment{runningAgent(
			"018f0c9e-7b14-7abc-8def-0123456789ab",
			1,
		)},
	))
	if err != nil || !result.Accepted {
		t.Fatalf("Apply() = %#v, %v", result, err)
	}
	if elapsed := time.Since(startedAt); elapsed > 100*time.Millisecond {
		t.Fatalf("Apply() waited for Agent I/O: %s", elapsed)
	}
	close(factory.block)
}

func TestCellOwnsAttemptLifetimeSeparatelyFromStartDeadline(t *testing.T) {
	t.Parallel()

	agentID := "018f0c9e-7b14-7abc-8def-0123456789ab"
	factory := &lifetimeFactory{}
	registry, err := NewRegistry(RegistryConfig{
		Factory:       factory,
		MaxConcurrent: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result, applyErr := registry.Apply(
		context.Background(),
		newSnapshot(t, 1, []AgentAssignment{runningAgent(agentID, 1)}),
	); applyErr != nil || !result.Accepted {
		t.Fatalf("Apply() = %#v, %v", result, applyErr)
	}
	waitRegistryState(t, registry, map[string]AgentState{
		agentID: AgentStateRunning,
	})

	startContext, lifetime := factory.contexts()
	select {
	case <-startContext.Done():
	case <-time.After(time.Second):
		t.Fatal("Factory start deadline remained live after handoff")
	}
	select {
	case <-lifetime.Done():
		t.Fatal("attempt lifetime was canceled with Factory start deadline")
	default:
	}
	closeContext, cancel := context.WithTimeout(
		context.Background(),
		time.Second,
	)
	defer cancel()
	if err := registry.Close(closeContext); err != nil {
		t.Fatal(err)
	}
	if err := factory.stopError(); err != nil {
		t.Fatal(err)
	}
}

func TestRevisionOnlySnapshotAdvancesLiveLeaseWithoutRestart(t *testing.T) {
	t.Parallel()

	agentID := "018f0c9e-7b14-7abc-8def-0123456789ab"
	factory := newSupervisorFactory()
	registry, err := NewRegistry(RegistryConfig{
		Factory:       factory,
		MaxConcurrent: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer registry.Close(context.Background())
	if result, applyErr := registry.Apply(
		context.Background(),
		newSnapshot(t, 1, []AgentAssignment{runningAgent(agentID, 1)}),
	); applyErr != nil || !result.Accepted {
		t.Fatalf("first Apply() = %#v, %v", result, applyErr)
	}
	waitRegistryState(t, registry, map[string]AgentState{
		agentID: AgentStateRunning,
	})
	lease := factory.latestLease(agentID)

	if result, applyErr := registry.Apply(
		context.Background(),
		newSnapshot(t, 2, []AgentAssignment{runningAgent(agentID, 1)}),
	); applyErr != nil || !result.Accepted {
		t.Fatalf("revision Apply() = %#v, %v", result, applyErr)
	}
	waitFor(t, func() bool {
		current, ok := lease.Current()
		status := registry.Status()
		return ok && current.Revision == 2 &&
			len(status) == 1 && status[0].AssignmentRevision == 2
	})
	if attempts := factory.attempts(agentID); attempts != 1 {
		t.Fatalf("revision-only Agent starts = %d, want 1", attempts)
	}
}

func TestBlockedAgentOnlyRetriesAfterDesiredFenceChanges(t *testing.T) {
	t.Parallel()

	factory := newSupervisorFactory()
	agentID := "018f0c9e-7b14-7abc-8def-0123456789ab"
	factory.failNext(agentID, NewAgentLifecycleError(
		"agent_credential_rejected",
		false,
		errors.New("credential rejected"),
	))
	registry, err := NewRegistry(RegistryConfig{
		Factory:       factory,
		MaxConcurrent: 5,
		RetryDelay:    func(int) time.Duration { return time.Millisecond },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer registry.Close(context.Background())
	first := newSnapshot(t, 1, []AgentAssignment{runningAgent(agentID, 1)})
	result, err := registry.Apply(context.Background(), first)
	if err != nil || !result.Accepted {
		t.Fatalf("Apply() = %#v, %v", result, err)
	}
	waitRegistryState(t, registry, map[string]AgentState{
		agentID: AgentStateBlocked,
	})
	time.Sleep(10 * time.Millisecond)
	if attempts := factory.attempts(agentID); attempts != 1 {
		t.Fatalf("blocked Agent attempts = %d, want 1", attempts)
	}
	updated := runningAgent(agentID, 2)
	second := newSnapshot(t, 2, []AgentAssignment{updated})
	result, err = registry.Apply(context.Background(), second)
	if err != nil || !result.Accepted {
		t.Fatalf("updated Apply() = %#v, %v", result, err)
	}
	waitRegistryState(t, registry, map[string]AgentState{
		agentID: AgentStateRunning,
	})
	if attempts := factory.attempts(agentID); attempts != 2 {
		t.Fatalf("updated Agent attempts = %d, want 2", attempts)
	}
}

func TestRegistryQuiescesPreviousEpochWithoutWaitingForFinalization(
	t *testing.T,
) {
	t.Parallel()

	agentID := "018f0c9e-7b14-7abc-8def-0123456789ab"
	factory := newHandoffFactory()
	registry, err := NewRegistry(RegistryConfig{
		Factory:       factory,
		MaxConcurrent: 1,
		RetryDelay:    func(int) time.Duration { return time.Millisecond },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer registry.Close(context.Background())
	var allowCloseOnce sync.Once
	defer allowCloseOnce.Do(func() { close(factory.allowClose) })
	first := newSnapshot(t, 1, []AgentAssignment{runningAgent(agentID, 1)})
	if result, err := registry.Apply(context.Background(), first); err != nil ||
		!result.Accepted {
		t.Fatalf("first Apply() = %#v, %v", result, err)
	}
	waitRegistryState(t, registry, map[string]AgentState{
		agentID: AgentStateRunning,
	})

	second := newSnapshot(t, 1, []AgentAssignment{runningAgent(agentID, 1)})
	second.Epoch = "018f0c9e-7b16-7abc-8def-0123456789ab"
	_, digest, err := CanonicalSnapshot(second)
	if err != nil {
		t.Fatal(err)
	}
	second.SnapshotHash = base64.RawURLEncoding.EncodeToString(digest[:])
	if result, err := registry.Apply(context.Background(), second); err != nil ||
		!result.Accepted {
		t.Fatalf("replacement Apply() = %#v, %v", result, err)
	}
	select {
	case <-factory.revoked:
	case <-time.After(time.Second):
		t.Fatal("previous epoch was not quiesced")
	}
	select {
	case <-factory.closeStarted:
	case <-time.After(time.Second):
		t.Fatal("previous epoch did not begin background finalization")
	}
	select {
	case <-factory.secondStarted:
	case <-time.After(time.Second):
		t.Fatal("replacement waited for previous epoch finalization")
	}
	allowCloseOnce.Do(func() { close(factory.allowClose) })
}

func TestRegistryReusesQuiescedCellWhilePreviousInstanceFinalizes(
	t *testing.T,
) {
	t.Parallel()

	agentID := "018f0c9e-7b14-7abc-8def-0123456789ab"
	factory := newHandoffFactory()
	registry, err := NewRegistry(RegistryConfig{
		Factory:       factory,
		MaxConcurrent: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer registry.Close(context.Background())
	var allowCloseOnce sync.Once
	defer allowCloseOnce.Do(func() { close(factory.allowClose) })
	if result, err := registry.Apply(
		context.Background(),
		newSnapshot(t, 1, []AgentAssignment{runningAgent(agentID, 1)}),
	); err != nil || !result.Accepted {
		t.Fatalf("first Apply() = %#v, %v", result, err)
	}
	waitRegistryState(t, registry, map[string]AgentState{
		agentID: AgentStateRunning,
	})
	if result, err := registry.Apply(
		context.Background(),
		newSnapshot(t, 2, nil),
	); err != nil || !result.Accepted {
		t.Fatalf("remove Apply() = %#v, %v", result, err)
	}
	select {
	case <-factory.closeStarted:
	case <-time.After(time.Second):
		t.Fatal("removed Agent did not begin stopping")
	}
	if result, err := registry.Apply(
		context.Background(),
		newSnapshot(t, 3, []AgentAssignment{runningAgent(agentID, 1)}),
	); err != nil || !result.Accepted {
		t.Fatalf("re-add Apply() = %#v, %v", result, err)
	}
	select {
	case <-factory.secondStarted:
	case <-time.After(time.Second):
		t.Fatal("re-added Agent waited for previous instance finalization")
	}
	allowCloseOnce.Do(func() { close(factory.allowClose) })
}

func TestCellFinalizationFailureDoesNotBlockReplacementAndSurfacesOnShutdown(
	t *testing.T,
) {
	t.Parallel()

	agentID := "018f0c9e-7b14-7abc-8def-0123456789ab"
	factory := &closeFailFactory{}
	registry, err := NewRegistry(RegistryConfig{
		Factory:       factory,
		MaxConcurrent: 1,
		RetryDelay:    func(int) time.Duration { return 10 * time.Millisecond },
	})
	if err != nil {
		t.Fatal(err)
	}
	first := newSnapshot(t, 1, []AgentAssignment{runningAgent(agentID, 1)})
	if result, err := registry.Apply(context.Background(), first); err != nil ||
		!result.Accepted {
		t.Fatalf("first Apply() = %#v, %v", result, err)
	}
	waitRegistryState(t, registry, map[string]AgentState{
		agentID: AgentStateRunning,
	})

	second := newSnapshot(t, 2, []AgentAssignment{runningAgent(agentID, 2)})
	if result, err := registry.Apply(context.Background(), second); err != nil ||
		!result.Accepted {
		t.Fatalf("replacement Apply() = %#v, %v", result, err)
	}
	waitFor(t, func() bool { return factory.starts.Load() == 2 })
	waitRegistryState(t, registry, map[string]AgentState{
		agentID: AgentStateRunning,
	})
	if starts := factory.starts.Load(); starts != 2 {
		t.Fatalf("replacement starts = %d, want 2", starts)
	}

	closeContext, cancel := context.WithTimeout(
		context.Background(),
		time.Second,
	)
	defer cancel()
	if err := registry.Close(closeContext); !errors.Is(err, errCloseFailed) {
		t.Fatalf("Registry.Close() error = %v, want %v", err, errCloseFailed)
	}
}

func TestRetryingStartReportsStartingDegradedWithRetryDeadline(t *testing.T) {
	t.Parallel()

	agentID := "018f0c9e-7b14-7abc-8def-0123456789ab"
	factory := newSupervisorFactory()
	factory.failNext(agentID, errors.New("temporary start failure"))
	registry, err := NewRegistry(RegistryConfig{
		Factory:       factory,
		MaxConcurrent: 1,
		RetryDelay:    func(int) time.Duration { return time.Second },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer registry.Close(context.Background())
	if result, applyErr := registry.Apply(
		context.Background(),
		newSnapshot(t, 1, []AgentAssignment{runningAgent(agentID, 1)}),
	); applyErr != nil || !result.Accepted {
		t.Fatalf("Apply() = %#v, %v", result, applyErr)
	}
	waitFor(t, func() bool {
		status := registry.Status()
		return len(status) == 1 &&
			status[0].Phase == AgentPhaseStarting &&
			status[0].Health == AgentHealthDegraded &&
			status[0].State == AgentStateRetryWait &&
			status[0].NextRetryAt != nil &&
			status[0].LastTransitionAt.Before(*status[0].NextRetryAt) &&
			status[0].ServerID == testServerID &&
			status[0].CredentialVersion == 1 &&
			status[0].AssignmentRevision == 1
	})
}

func TestCellProjectsManagedInstanceHealthWithoutRestarting(t *testing.T) {
	t.Parallel()

	agentID := "018f0c9e-7b14-7abc-8def-0123456789ab"
	instance := newHealthInstance()
	factory := &healthFactory{instance: instance}
	registry, err := NewRegistry(RegistryConfig{
		Factory:       factory,
		MaxConcurrent: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer registry.Close(context.Background())
	if result, err := registry.Apply(
		context.Background(),
		newSnapshot(t, 1, []AgentAssignment{runningAgent(agentID, 1)}),
	); err != nil || !result.Accepted {
		t.Fatalf("Apply() = %#v, %v", result, err)
	}
	waitRegistryState(t, registry, map[string]AgentState{
		agentID: AgentStateRunning,
	})

	instance.health <- AgentHealth{
		Ready:     false,
		ErrorCode: "agent_im_reconnecting",
	}
	waitFor(t, func() bool {
		status := registry.Status()
		return len(status) == 1 &&
			status[0].Phase == AgentPhaseRunning &&
			status[0].Health == AgentHealthReconnecting &&
			status[0].State == AgentStateRetryWait &&
			status[0].ErrorCode == "agent_im_reconnecting"
	})
	instance.health <- AgentHealth{Ready: true}
	waitFor(t, func() bool {
		status := registry.Status()
		return len(status) == 1 &&
			status[0].Phase == AgentPhaseRunning &&
			status[0].Health == AgentHealthReady &&
			status[0].State == AgentStateRunning
	})
	if starts := factory.starts.Load(); starts != 1 {
		t.Fatalf("Agent starts = %d, want 1", starts)
	}
}

func TestCellProjectsAuthoritativeServerLaunchFence(t *testing.T) {
	t.Parallel()

	agentID := "018f0c9e-7b14-7abc-8def-0123456789ab"
	factory := &authoritativeFenceFactory{}
	registry, err := NewRegistry(RegistryConfig{
		Factory: factory, MaxConcurrent: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer registry.Close(context.Background())
	if result, applyErr := registry.Apply(
		context.Background(),
		newSnapshot(t, 1, []AgentAssignment{runningAgent(agentID, 1)}),
	); applyErr != nil || !result.Accepted {
		t.Fatalf("Apply() = %#v, %v", result, applyErr)
	}
	waitFor(t, func() bool {
		status := registry.Status()
		return len(status) == 1 && status[0].State == AgentStateRunning &&
			status[0].Attempt == 7 && status[0].LaunchID != ""
	})
}

func waitRegistryState(
	t *testing.T,
	registry *Registry,
	want map[string]AgentState,
) {
	t.Helper()
	waitFor(t, func() bool {
		status := registry.Status()
		if len(status) != len(want) {
			return false
		}
		for _, agent := range status {
			if want[agent.AgentID] != agent.State {
				return false
			}
		}
		return true
	})
}

func waitFor(t *testing.T, ready func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !ready() {
		if time.Now().After(deadline) {
			t.Fatal("condition was not satisfied")
		}
		time.Sleep(time.Millisecond)
	}
}

type supervisorFactory struct {
	mu        sync.Mutex
	failures  map[string][]error
	instances map[string][]*supervisorInstance
	leases    map[string][]AssignmentLeaseReader
	starts    map[string]int
	block     chan struct{}
}

type lifetimeFactory struct {
	mu           sync.Mutex
	startContext context.Context
	lifetime     context.Context
	instance     *lifetimeInstance
}

func (f *lifetimeFactory) Start(
	ctx context.Context,
	request AgentStartRequest,
) (AgentInstance, error) {
	instance := newLifetimeInstance(request.Lifetime)
	f.mu.Lock()
	f.startContext = ctx
	f.lifetime = request.Lifetime
	f.instance = instance
	f.mu.Unlock()
	return instance, nil
}

func (f *lifetimeFactory) contexts() (context.Context, context.Context) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.startContext, f.lifetime
}

func (f *lifetimeFactory) stopError() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.instance.stopError
}

type lifetimeInstance struct {
	lifetime  context.Context
	ready     chan struct{}
	done      chan struct{}
	mu        sync.Mutex
	revoked   bool
	stopError error
	once      sync.Once
}

func newLifetimeInstance(lifetime context.Context) *lifetimeInstance {
	ready := make(chan struct{})
	close(ready)
	return &lifetimeInstance{
		lifetime: lifetime,
		ready:    ready,
		done:     make(chan struct{}),
	}
}

func (i *lifetimeInstance) Ready() <-chan struct{} { return i.ready }

func (i *lifetimeInstance) Done() <-chan struct{} { return i.done }

func (*lifetimeInstance) Err() error { return nil }

func (i *lifetimeInstance) Revoke(context.Context) error {
	i.mu.Lock()
	i.revoked = true
	i.mu.Unlock()
	return nil
}

func (i *lifetimeInstance) Close(context.Context) error {
	i.mu.Lock()
	defer i.mu.Unlock()
	if !i.revoked {
		i.stopError = errors.New("Agent capability was not revoked first")
	} else if i.lifetime.Err() == nil {
		i.stopError = errors.New("Agent lifetime was not canceled before wait")
	}
	i.once.Do(func() { close(i.done) })
	return i.stopError
}

func newSupervisorFactory() *supervisorFactory {
	return &supervisorFactory{
		failures:  make(map[string][]error),
		instances: make(map[string][]*supervisorInstance),
		leases:    make(map[string][]AssignmentLeaseReader),
		starts:    make(map[string]int),
	}
}

func (f *supervisorFactory) Start(
	ctx context.Context,
	request AgentStartRequest,
) (AgentInstance, error) {
	assignment := request.Launch.Assignment
	if f.block != nil {
		select {
		case <-f.block:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.starts[assignment.AgentID]++
	f.leases[assignment.AgentID] = append(
		f.leases[assignment.AgentID],
		request.Lease,
	)
	if values := f.failures[assignment.AgentID]; len(values) > 0 {
		err := values[0]
		f.failures[assignment.AgentID] = values[1:]
		return nil, err
	}
	instance := newSupervisorInstance()
	f.instances[assignment.AgentID] = append(
		f.instances[assignment.AgentID],
		instance,
	)
	return instance, nil
}

func (f *supervisorFactory) failNext(agentID string, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failures[agentID] = append(f.failures[agentID], err)
}

func (f *supervisorFactory) attempts(agentID string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.starts[agentID]
}

func (f *supervisorFactory) latest(agentID string) *supervisorInstance {
	f.mu.Lock()
	defer f.mu.Unlock()
	values := f.instances[agentID]
	return values[len(values)-1]
}

func (f *supervisorFactory) latestLease(
	agentID string,
) AssignmentLeaseReader {
	f.mu.Lock()
	defer f.mu.Unlock()
	values := f.leases[agentID]
	return values[len(values)-1]
}

type supervisorInstance struct {
	ready  chan struct{}
	done   chan struct{}
	once   sync.Once
	mu     sync.Mutex
	err    error
	closed int
}

type handoffFactory struct {
	mu            sync.Mutex
	starts        int
	revoked       chan struct{}
	closeStarted  chan struct{}
	allowClose    chan struct{}
	secondStarted chan struct{}
}

func newHandoffFactory() *handoffFactory {
	return &handoffFactory{
		revoked:       make(chan struct{}),
		closeStarted:  make(chan struct{}),
		allowClose:    make(chan struct{}),
		secondStarted: make(chan struct{}),
	}
}

func (f *handoffFactory) Start(
	context.Context,
	AgentStartRequest,
) (AgentInstance, error) {
	f.mu.Lock()
	f.starts++
	start := f.starts
	f.mu.Unlock()
	if start == 1 {
		return newHandoffInstance(
			f.revoked,
			f.closeStarted,
			f.allowClose,
		), nil
	}
	if start == 2 {
		close(f.secondStarted)
	}
	return newSupervisorInstance(), nil
}

type handoffInstance struct {
	ready        chan struct{}
	done         chan struct{}
	revoked      chan struct{}
	closeStarted chan struct{}
	allowClose   chan struct{}
	revokeOnce   sync.Once
	closeOnce    sync.Once
}

var errCloseFailed = errors.New("Agent instance close failed")

type closeFailFactory struct {
	starts atomic.Int64
}

func (f *closeFailFactory) Start(
	context.Context,
	AgentStartRequest,
) (AgentInstance, error) {
	f.starts.Add(1)
	return newCloseFailInstance(), nil
}

type closeFailInstance struct {
	ready chan struct{}
	done  chan struct{}
}

func newCloseFailInstance() *closeFailInstance {
	ready := make(chan struct{})
	close(ready)
	return &closeFailInstance{ready: ready, done: make(chan struct{})}
}

func (i *closeFailInstance) Ready() <-chan struct{} { return i.ready }

func (i *closeFailInstance) Done() <-chan struct{} { return i.done }

func (*closeFailInstance) Err() error { return nil }

func (*closeFailInstance) Revoke(context.Context) error { return nil }

func (*closeFailInstance) Close(context.Context) error { return errCloseFailed }

type healthFactory struct {
	instance *healthInstance
	starts   atomic.Int64
}

func (f *healthFactory) Start(
	context.Context,
	AgentStartRequest,
) (AgentInstance, error) {
	f.starts.Add(1)
	return f.instance, nil
}

type healthInstance struct {
	ready  chan struct{}
	done   chan struct{}
	health chan AgentHealth
	once   sync.Once
}

type authoritativeFenceFactory struct{}

func (f *authoritativeFenceFactory) Start(
	_ context.Context,
	request AgentStartRequest,
) (AgentInstance, error) {
	instance := newSupervisorInstance()
	return &authoritativeFenceInstance{
		supervisorInstance: instance,
		fence: Fence{
			Epoch:            request.Launch.Fence.Epoch,
			ConfigGeneration: request.Launch.Fence.ConfigGeneration,
			Attempt:          7,
			LaunchID:         "018f0c9e-7b17-7abc-8def-0123456789ab",
		},
	}, nil
}

type authoritativeFenceInstance struct {
	*supervisorInstance
	fence Fence
}

func (i *authoritativeFenceInstance) Fence() Fence { return i.fence }

func newHealthInstance() *healthInstance {
	ready := make(chan struct{})
	close(ready)
	return &healthInstance{
		ready:  ready,
		done:   make(chan struct{}),
		health: make(chan AgentHealth, 2),
	}
}

func (i *healthInstance) Ready() <-chan struct{} { return i.ready }

func (i *healthInstance) Done() <-chan struct{} { return i.done }

func (*healthInstance) Err() error { return nil }

func (*healthInstance) Revoke(context.Context) error { return nil }

func (i *healthInstance) Health() <-chan AgentHealth { return i.health }

func (i *healthInstance) Close(context.Context) error {
	i.once.Do(func() { close(i.done) })
	return nil
}

func newHandoffInstance(
	revoked chan struct{},
	closeStarted chan struct{},
	allowClose chan struct{},
) *handoffInstance {
	ready := make(chan struct{})
	close(ready)
	return &handoffInstance{
		ready:        ready,
		done:         make(chan struct{}),
		revoked:      revoked,
		closeStarted: closeStarted,
		allowClose:   allowClose,
	}
}

func (i *handoffInstance) Ready() <-chan struct{} { return i.ready }

func (i *handoffInstance) Done() <-chan struct{} { return i.done }

func (*handoffInstance) Err() error { return nil }

func (i *handoffInstance) Revoke(context.Context) error {
	i.revokeOnce.Do(func() { close(i.revoked) })
	return nil
}

func (i *handoffInstance) Close(ctx context.Context) error {
	i.closeOnce.Do(func() { close(i.closeStarted) })
	select {
	case <-i.allowClose:
		select {
		case <-i.done:
		default:
			close(i.done)
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func newSupervisorInstance() *supervisorInstance {
	ready := make(chan struct{})
	close(ready)
	return &supervisorInstance{ready: ready, done: make(chan struct{})}
}

func (i *supervisorInstance) Ready() <-chan struct{} { return i.ready }

func (i *supervisorInstance) Done() <-chan struct{} { return i.done }

func (i *supervisorInstance) Err() error {
	i.mu.Lock()
	defer i.mu.Unlock()
	return i.err
}

func (*supervisorInstance) Revoke(context.Context) error { return nil }

func (i *supervisorInstance) Close(context.Context) error {
	i.mu.Lock()
	i.closed++
	i.mu.Unlock()
	i.exit(nil)
	return nil
}

func (i *supervisorInstance) exit(err error) {
	i.mu.Lock()
	i.err = err
	i.mu.Unlock()
	i.once.Do(func() { close(i.done) })
}

func (i *supervisorInstance) closeCount() int {
	i.mu.Lock()
	defer i.mu.Unlock()
	return i.closed
}
