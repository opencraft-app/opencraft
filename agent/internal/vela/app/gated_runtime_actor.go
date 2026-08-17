package app

import (
	"context"
	"sync"

	"velachat/agent/internal/runtimeactor"
	"velachat/agent/internal/runtimeapi"
	"velachat/agent/internal/vela/activitygate"
	"velachat/agent/internal/vela/runtimehost"
)

type gatedRuntimeActor struct {
	next   runtimehost.RuntimeActor
	gate   *activitygate.Gate
	events chan runtimeactor.Event

	mu     sync.Mutex
	active *activitygate.Lease
}

func newGatedRuntimeActor(
	next runtimehost.RuntimeActor,
	gate *activitygate.Gate,
) (*gatedRuntimeActor, error) {
	if next == nil || gate == nil {
		return nil, ErrInvalidConfig
	}
	actor := &gatedRuntimeActor{
		next: next, gate: gate, events: make(chan runtimeactor.Event, 128),
	}
	go actor.forwardEvents()
	return actor, nil
}

func (actor *gatedRuntimeActor) Start(
	ctx context.Context,
	command runtimeactor.StartCommand,
) error {
	return actor.withAdmission(ctx, func() error { return actor.next.Start(ctx, command) })
}

func (actor *gatedRuntimeActor) Deliver(
	ctx context.Context,
	launchID string,
	delivery runtimeapi.Delivery,
) error {
	return actor.withAdmission(ctx, func() error {
		return actor.next.Deliver(ctx, launchID, delivery)
	})
}

func (actor *gatedRuntimeActor) DeliverDirect(
	ctx context.Context,
	launchID string,
	delivery runtimeapi.Delivery,
) error {
	return actor.withAdmission(ctx, func() error {
		return actor.next.DeliverDirect(ctx, launchID, delivery)
	})
}

func (actor *gatedRuntimeActor) Stop(ctx context.Context, launchID string) error {
	if actor == nil {
		return ErrInvalidConfig
	}
	err := actor.next.Stop(ctx, launchID)
	actor.releaseActive()
	return err
}

func (actor *gatedRuntimeActor) Events() <-chan runtimeactor.Event {
	if actor == nil {
		return nil
	}
	return actor.events
}

func (actor *gatedRuntimeActor) AckEvent(eventID uint64) {
	if actor != nil {
		actor.next.AckEvent(eventID)
	}
}

func (actor *gatedRuntimeActor) withAdmission(ctx context.Context, operation func() error) error {
	if actor == nil || ctx == nil || operation == nil {
		return ErrInvalidConfig
	}
	admission, err := actor.gate.Acquire(ctx, activitygate.AgentTurn)
	if err != nil {
		return err
	}
	if err := operation(); err != nil {
		admission.Release()
		return err
	}
	actor.mu.Lock()
	if actor.active == nil {
		actor.active = admission
		admission = nil
	}
	actor.mu.Unlock()
	if admission != nil {
		admission.Release()
	}
	return nil
}

func (actor *gatedRuntimeActor) forwardEvents() {
	defer close(actor.events)
	defer actor.releaseActive()
	for event := range actor.next.Events() {
		if event.Kind == runtimeapi.EventTurnCompletion ||
			event.Kind == runtimeapi.EventTerminalFailure ||
			(event.Kind == runtimeapi.EventStatus && event.Status == "inactive") {
			actor.releaseActive()
		}
		actor.events <- event
	}
}

func (actor *gatedRuntimeActor) releaseActive() {
	if actor == nil {
		return
	}
	actor.mu.Lock()
	lease := actor.active
	actor.active = nil
	actor.mu.Unlock()
	if lease != nil {
		lease.Release()
	}
}

var _ runtimehost.RuntimeActor = (*gatedRuntimeActor)(nil)
