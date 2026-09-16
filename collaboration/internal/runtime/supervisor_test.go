package runtime

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeDatabase struct {
	running  *atomic.Int64
	closed   atomic.Bool
	badClose atomic.Bool
}

func (database *fakeDatabase) Close() error {
	if database.running.Load() != 0 {
		database.badClose.Store(true)
	}
	database.closed.Store(true)
	return nil
}

type fakeComponent struct {
	role          Role
	running       *atomic.Int64
	started       chan Database
	exited        chan struct{}
	intakeStopped atomic.Bool
	drainStarted  chan struct{}
	drainGate     <-chan struct{}
	blockDrain    bool
	exitOnce      sync.Once
	drainOnce     sync.Once
}

func newFakeComponent(role Role, running *atomic.Int64) *fakeComponent {
	return &fakeComponent{
		role:         role,
		running:      running,
		started:      make(chan Database, 1),
		exited:       make(chan struct{}),
		drainStarted: make(chan struct{}),
	}
}

func (component *fakeComponent) Role() Role {
	return component.role
}

func (component *fakeComponent) Run(ctx context.Context, database Database) error {
	component.running.Add(1)
	component.started <- database
	<-ctx.Done()
	component.running.Add(-1)
	component.exitOnce.Do(func() { close(component.exited) })
	return nil
}

func (component *fakeComponent) StopIntake() {
	component.intakeStopped.Store(true)
}

func (component *fakeComponent) Drain(ctx context.Context) error {
	component.drainOnce.Do(func() { close(component.drainStarted) })
	if component.blockDrain {
		<-ctx.Done()
		return ctx.Err()
	}
	if component.drainGate != nil {
		select {
		case <-component.drainGate:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

func TestSupervisorSharesOneDatabaseAcrossThreeRoles(t *testing.T) {
	supervisor, database, components := newTestSupervisor(t, 200*time.Millisecond)
	if err := supervisor.Start(context.Background()); err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	for _, component := range components {
		select {
		case got := <-component.started:
			if got != database {
				t.Fatalf("%s received a different Database", component.role)
			}
		case <-time.After(time.Second):
			t.Fatalf("%s did not start", component.role)
		}
	}
	if !supervisor.Ready() {
		t.Fatal("Ready() = false after all roles started")
	}

	if err := supervisor.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown() error = %v", err)
	}
	if !database.closed.Load() {
		t.Fatal("Database was not closed")
	}
	if database.badClose.Load() {
		t.Fatal("Database closed before role goroutines exited")
	}
}

func TestShutdownStopsAllIntakeBeforeDrainCompletes(t *testing.T) {
	gate := make(chan struct{})
	supervisor, _, components := newTestSupervisor(t, time.Second)
	for _, component := range components {
		component.drainGate = gate
	}
	if err := supervisor.Start(context.Background()); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	for _, component := range components {
		<-component.started
	}

	done := make(chan error, 1)
	go func() {
		done <- supervisor.Shutdown(context.Background())
	}()
	for _, component := range components {
		select {
		case <-component.drainStarted:
		case <-time.After(time.Second):
			t.Fatalf("%s did not start draining", component.role)
		}
	}
	if supervisor.Ready() {
		t.Fatal("Ready() remained true during drain")
	}
	for _, component := range components {
		if !component.intakeStopped.Load() {
			t.Fatalf("%s intake was not stopped", component.role)
		}
	}
	close(gate)
	if err := <-done; err != nil {
		t.Fatalf("Shutdown() error = %v", err)
	}
}

func TestDrainTimeoutCancelsJoinsThenClosesDatabase(t *testing.T) {
	supervisor, database, components := newTestSupervisor(t, 20*time.Millisecond)
	for _, component := range components {
		component.blockDrain = true
	}
	if err := supervisor.Start(context.Background()); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	for _, component := range components {
		<-component.started
	}

	err := supervisor.Shutdown(context.Background())

	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Shutdown() error = %v, want deadline exceeded", err)
	}
	for _, component := range components {
		select {
		case <-component.exited:
		case <-time.After(time.Second):
			t.Fatalf("%s was not joined after cancel", component.role)
		}
	}
	if !database.closed.Load() {
		t.Fatal("Database was not closed after join")
	}
	if database.badClose.Load() {
		t.Fatal("Database closed while a role was still running")
	}
}

func newTestSupervisor(
	t *testing.T,
	drainTimeout time.Duration,
) (*Supervisor, *fakeDatabase, []*fakeComponent) {
	t.Helper()
	roles, err := NewRoleSet(RoleAPI, RoleWorker, RoleScheduler)
	if err != nil {
		t.Fatalf("NewRoleSet() error = %v", err)
	}
	running := &atomic.Int64{}
	database := &fakeDatabase{running: running}
	components := []*fakeComponent{
		newFakeComponent(RoleAPI, running),
		newFakeComponent(RoleWorker, running),
		newFakeComponent(RoleScheduler, running),
	}
	componentInterfaces := make([]Component, 0, len(components))
	for _, component := range components {
		componentInterfaces = append(componentInterfaces, component)
	}
	supervisor, err := NewSupervisor(SupervisorConfig{
		Mode:         DatabaseModeSQLite,
		Roles:        roles,
		DrainTimeout: drainTimeout,
	}, database, componentInterfaces)
	if err != nil {
		t.Fatalf("NewSupervisor() error = %v", err)
	}
	return supervisor, database, components
}
