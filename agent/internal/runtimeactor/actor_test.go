package runtimeactor

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/runtimeapi"
)

type testSession struct {
	id          string
	events      chan runtimeapi.Event
	stopped     sync.Once
	delivered   []runtimeapi.Delivery
	deliveryErr error
}

func (s *testSession) Deliver(_ context.Context, delivery runtimeapi.Delivery) error {
	s.delivered = append(s.delivered, delivery)
	return s.deliveryErr
}
func (s *testSession) Stop(context.Context) error {
	s.stopped.Do(func() {
		if s.events != nil {
			close(s.events)
		}
	})
	return nil
}
func (s *testSession) Events() <-chan runtimeapi.Event { return s.events }
func (s *testSession) SessionID() string               { return s.id }

type emptyResolver struct{}

func (emptyResolver) ResolveRuntime(string) (runtimeapi.ResolvedRuntime, bool) {
	return runtimeapi.ResolvedRuntime{}, false
}

func TestActorRejectsCrossAgentCommand(t *testing.T) {
	t.Parallel()

	actor, err := New(Options{
		AgentID:  "agent-a",
		Runtimes: emptyResolver{},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = actor.Close(context.Background()) })

	err = actor.Start(context.Background(), StartCommand{
		AgentID:  "agent-b",
		LaunchID: "launch-1",
		Runtime:  "codex",
	})
	if !errors.Is(err, ErrAgentBoundary) {
		t.Fatalf("Start error = %v, want %v", err, ErrAgentBoundary)
	}
}

func TestActorRetirementVersionIsOneWay(t *testing.T) {
	t.Parallel()

	actor, err := New(Options{
		AgentID:  "agent-a",
		Runtimes: emptyResolver{},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = actor.Close(context.Background()) })

	snapshot := actor.RetirementSnapshot()
	if !snapshot.Retirable {
		t.Fatalf("new Actor retirement snapshot = %#v, want retirable", snapshot)
	}
	if !actor.BeginRetire(snapshot.Version) {
		t.Fatal("BeginRetire rejected unchanged retirement version")
	}
	if actor.BeginRetire(snapshot.Version) {
		t.Fatal("BeginRetire succeeded twice")
	}
	if err := actor.Reserve(StartCommand{
		AgentID:  "agent-a",
		LaunchID: "launch-1",
		Runtime:  "codex",
	}); !errors.Is(err, ErrActorRetiring) {
		t.Fatalf("Reserve after retirement = %v, want %v", err, ErrActorRetiring)
	}
}

func TestActorCanceledQueuedRebindUsesImmutableJobToken(t *testing.T) {
	t.Parallel()

	coordinator := &blockingCoordinator{entered: make(chan struct{}, 1)}
	actor, err := New(Options{
		AgentID: "agent-a",
		Runtimes: staticResolver{runtime: runtimeapi.ResolvedRuntime{
			ID: "codex",
			NewDriver: func() (runtimeapi.RuntimeDriver, error) {
				return nil, nil
			},
		}},
		Coordinator: coordinator,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	first := make(chan error, 1)
	go func() {
		first <- actor.Start(ctx, StartCommand{
			AgentID:  "agent-a",
			LaunchID: "launch-1",
			Runtime:  "codex",
		})
	}()
	select {
	case <-coordinator.entered:
	case <-time.After(time.Second):
		t.Fatal("first Start did not enter coordinator")
	}
	if err := actor.Start(context.Background(), StartCommand{
		AgentID:  "agent-a",
		LaunchID: "launch-2",
		Runtime:  "codex",
	}); err != nil {
		t.Fatalf("queued rebind: %v", err)
	}
	cancel()
	if err := <-first; !errors.Is(err, context.Canceled) {
		t.Fatalf("first Start error = %v, want context canceled", err)
	}
	if snapshot := actor.RetirementSnapshot(); !snapshot.Retirable {
		t.Fatalf("canceled queued rebind left ghost state: %#v", snapshot)
	}
	_ = actor.Close(context.Background())
}

func TestActorEventMustBeAcknowledgedBeforeRetirement(t *testing.T) {
	t.Parallel()

	actor, err := New(Options{AgentID: "agent-a", Runtimes: emptyResolver{}})
	if err != nil {
		t.Fatal(err)
	}
	if !actor.emit(Event{AgentID: "agent-a", Runtime: "codex"}) {
		t.Fatal("emit rejected live Actor event")
	}
	event := <-actor.Events()
	if snapshot := actor.RetirementSnapshot(); snapshot.BufferedEvents != 1 || snapshot.Retirable {
		t.Fatalf("unacknowledged event retirement snapshot = %#v", snapshot)
	}
	actor.AckEvent(event.EventID)
	if snapshot := actor.RetirementSnapshot(); snapshot.BufferedEvents != 0 || !snapshot.Retirable {
		t.Fatalf("acknowledged event retirement snapshot = %#v", snapshot)
	}
	_ = actor.Close(context.Background())
}

func TestActorCancelReservationRestoresIdleAndRemovesFreshState(t *testing.T) {
	t.Parallel()

	actor, err := New(Options{AgentID: "agent-a", Runtimes: emptyResolver{}})
	if err != nil {
		t.Fatal(err)
	}
	actor.mu.Lock()
	actor.current = &record{
		launchID: "launch-idle",
		runtime:  "codex",
		idle:     true,
	}
	actor.mu.Unlock()

	command := StartCommand{AgentID: actor.agentID, LaunchID: "launch-idle", Runtime: "codex"}
	// Replace the empty resolver only for this white-box state transition.
	actor.runtimes = staticResolver{runtime: runtimeapi.ResolvedRuntime{
		ID: "codex",
		NewDriver: func() (runtimeapi.RuntimeDriver, error) {
			return nil, nil
		},
	}}
	if err := actor.Reserve(command); err != nil {
		t.Fatal(err)
	}
	if err := actor.CancelReservation(command.LaunchID); err != nil {
		t.Fatal(err)
	}
	actor.mu.Lock()
	idle := actor.current
	actor.mu.Unlock()
	if idle == nil || !idle.idle || idle.starting || idle.reserved || idle.reserveRestart {
		t.Fatalf("idle state after cancel = %#v", idle)
	}

	if err := actor.Stop(context.Background(), command.LaunchID); err != nil {
		t.Fatal(err)
	}
	fresh := StartCommand{AgentID: actor.agentID, LaunchID: "launch-fresh", Runtime: "codex"}
	if err := actor.Reserve(fresh); err != nil {
		t.Fatal(err)
	}
	if err := actor.CancelReservation(fresh.LaunchID); err != nil {
		t.Fatal(err)
	}
	actor.mu.Lock()
	exists := actor.current != nil
	actor.mu.Unlock()
	if exists {
		t.Fatal("fresh canceled reservation retained Actor state")
	}
	_ = actor.Close(context.Background())
}

func TestActorCompletedSessionKeepsOnlyDurablePending(t *testing.T) {
	t.Parallel()

	actor, err := New(Options{AgentID: "agent-a", Runtimes: emptyResolver{}})
	if err != nil {
		t.Fatal(err)
	}
	session := &testSession{id: "session-1", events: make(chan runtimeapi.Event)}
	actor.mu.Lock()
	actor.current = &record{
		launchID:       "launch-1",
		runtime:        "codex",
		session:        session,
		turnCompleted:  true,
		retryScheduled: true,
		pending: []runtimeapi.Delivery{
			{Text: "accepted transient", Transient: true},
			{Text: "durable follow-up"},
		},
	}
	actor.mu.Unlock()

	actor.finishSession(actor.agentID, session)

	actor.mu.Lock()
	current := actor.current
	pending := append([]runtimeapi.Delivery(nil), current.pending...)
	retryScheduled := current.retryScheduled
	actor.mu.Unlock()
	if len(pending) != 1 || pending[0].Text != "durable follow-up" || pending[0].Transient {
		t.Fatalf("pending after completed session = %#v", pending)
	}
	if retryScheduled {
		t.Fatal("closed Runtime retained retry owner")
	}
	_ = actor.Close(context.Background())
}

func TestActorTransientDeliveryPolicyAcrossDormantStates(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name        string
		state       *record
		wantErr     error
		wantPending int
	}{
		{name: "idle", state: &record{launchID: "launch-1", idle: true}, wantErr: ErrAgentIdle},
		{name: "reservation", state: &record{launchID: "launch-1", starting: true, reserved: true}},
		{name: "terminal", state: &record{launchID: "launch-1", terminal: true}},
		{
			name:        "cooldown",
			state:       &record{launchID: "launch-1", idle: true, cooldownUntil: now.Add(time.Minute)},
			wantPending: 1,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			actor, err := New(Options{
				AgentID:  "agent-a",
				Runtimes: emptyResolver{},
				Now:      func() time.Time { return now },
			})
			if err != nil {
				t.Fatal(err)
			}
			test.state.runtime = "codex"
			actor.mu.Lock()
			actor.current = test.state
			actor.mu.Unlock()
			err = actor.Deliver(
				context.Background(),
				"launch-1",
				runtimeapi.Delivery{Text: "ephemeral", Transient: true},
			)
			if !errors.Is(err, test.wantErr) {
				t.Fatalf("Deliver error = %v, want %v", err, test.wantErr)
			}
			actor.mu.Lock()
			pending := len(actor.current.pending)
			actor.mu.Unlock()
			if pending != test.wantPending {
				t.Fatalf("pending = %d, want %d", pending, test.wantPending)
			}
			_ = actor.Close(context.Background())
		})
	}
}

func TestActorDeliverDirectNeverAcceptsIntoPendingMemory(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		record  *record
		wantErr error
	}{
		{name: "starting", record: &record{launchID: "launch-1", starting: true}, wantErr: ErrDirectDeliveryUnavailable},
		{name: "flushing", record: &record{launchID: "launch-1", session: &testSession{}, flushing: true}, wantErr: ErrDirectDeliveryUnavailable},
		{name: "terminal", record: &record{launchID: "launch-1", session: &testSession{}, terminal: true}, wantErr: ErrDirectDeliveryUnavailable},
		{name: "idle", record: &record{launchID: "launch-1", idle: true}, wantErr: ErrDirectDeliveryUnavailable},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			actor, err := New(Options{AgentID: "agent-a", Runtimes: emptyResolver{}})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = actor.Close(context.Background()) })
			actor.mu.Lock()
			actor.current = test.record
			actor.mu.Unlock()
			err = actor.DeliverDirect(context.Background(), "launch-1", runtimeapi.Delivery{Text: "must reach runtime"})
			if !errors.Is(err, test.wantErr) {
				t.Fatalf("DeliverDirect() = %v, want %v", err, test.wantErr)
			}
			actor.mu.Lock()
			pending := len(actor.current.pending)
			actor.mu.Unlock()
			if pending != 0 {
				t.Fatalf("DeliverDirect queued %d pending deliveries", pending)
			}
		})
	}

	session := &testSession{id: "session-ready"}
	actor, err := New(Options{AgentID: "agent-a", Runtimes: emptyResolver{}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = actor.Close(context.Background()) })
	actor.mu.Lock()
	actor.current = &record{launchID: "launch-1", session: session, turnCompleted: true}
	actor.mu.Unlock()
	if err := actor.DeliverDirect(context.Background(), "launch-1", runtimeapi.Delivery{Text: "direct"}); err != nil {
		t.Fatal(err)
	}
	if len(session.delivered) != 1 || session.delivered[0].Text != "direct" {
		t.Fatalf("delivered = %#v", session.delivered)
	}
}

type staticResolver struct {
	runtime runtimeapi.ResolvedRuntime
}

type blockingCoordinator struct {
	entered chan struct{}
}

func (c *blockingCoordinator) Execute(
	ctx context.Context,
	_ StartJob,
	_ func(context.Context) error,
) error {
	c.entered <- struct{}{}
	<-ctx.Done()
	return ctx.Err()
}

func (*blockingCoordinator) Close(context.Context) error { return nil }

func (r staticResolver) ResolveRuntime(id string) (runtimeapi.ResolvedRuntime, bool) {
	return r.runtime, id == r.runtime.ID
}
