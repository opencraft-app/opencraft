package app

import (
	"context"
	"errors"
	"testing"
	"time"

	"velachat/agent/internal/runtimeactor"
	"velachat/agent/internal/runtimeapi"
	"velachat/agent/internal/vela/activitygate"
)

type fakeGatedActor struct {
	events       chan runtimeactor.Event
	startCalls   int
	deliverCalls int
}

func (actor *fakeGatedActor) Start(context.Context, runtimeactor.StartCommand) error {
	actor.startCalls++
	return nil
}

func (actor *fakeGatedActor) Deliver(context.Context, string, runtimeapi.Delivery) error {
	actor.deliverCalls++
	return nil
}

func (actor *fakeGatedActor) DeliverDirect(context.Context, string, runtimeapi.Delivery) error {
	actor.deliverCalls++
	return nil
}

func (*fakeGatedActor) Stop(context.Context, string) error      { return nil }
func (actor *fakeGatedActor) Events() <-chan runtimeactor.Event { return actor.events }
func (*fakeGatedActor) AckEvent(uint64)                         {}

func TestGatedRuntimeActorHoldsLeaseUntilRealTurnBoundary(t *testing.T) {
	t.Parallel()
	gate := activitygate.New()
	next := &fakeGatedActor{events: make(chan runtimeactor.Event, 4)}
	actor, err := newGatedRuntimeActor(next, gate)
	if err != nil {
		t.Fatal(err)
	}
	if err := actor.Start(context.Background(), runtimeactor.StartCommand{AgentID: "agent"}); err != nil {
		t.Fatal(err)
	}
	if gate.Snapshot().Total != 1 {
		t.Fatalf("active after Start = %#v", gate.Snapshot())
	}
	drained := make(chan *activitygate.DrainPermit, 1)
	go func() {
		permit, _ := gate.Drain(context.Background())
		drained <- permit
	}()
	deadline := time.Now().Add(time.Second)
	for !gate.Snapshot().Draining {
		if time.Now().After(deadline) {
			t.Fatal("gate did not enter drain")
		}
		time.Sleep(time.Millisecond)
	}
	if err := actor.Deliver(context.Background(), "launch", runtimeapi.Delivery{Text: "late"}); !errors.Is(err, activitygate.ErrDraining) {
		t.Fatalf("Deliver during drain error = %v", err)
	}
	if next.deliverCalls != 0 {
		t.Fatal("draining delivery reached RuntimeActor")
	}
	next.events <- runtimeactor.Event{Event: runtimeapi.Event{Kind: runtimeapi.EventTurnCompletion}}
	select {
	case <-actor.Events():
	case <-time.After(time.Second):
		t.Fatal("turn completion was not forwarded")
	}
	permit := <-drained
	if permit == nil {
		t.Fatal("drain failed")
	}
	permit.Release()
	if err := actor.Deliver(context.Background(), "launch", runtimeapi.Delivery{Text: "next"}); err != nil {
		t.Fatal(err)
	}
	if gate.Snapshot().Total != 1 || next.deliverCalls != 1 {
		t.Fatalf("second turn state=%#v calls=%d", gate.Snapshot(), next.deliverCalls)
	}
	next.events <- runtimeactor.Event{Event: runtimeapi.Event{Kind: runtimeapi.EventTerminalFailure}}
	select {
	case <-actor.Events():
	case <-time.After(time.Second):
		t.Fatal("terminal failure was not forwarded")
	}
	if gate.Snapshot().Total != 0 {
		t.Fatalf("terminal event retained lease: %#v", gate.Snapshot())
	}
}
