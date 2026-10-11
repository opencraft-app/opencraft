package hermes

import (
	"testing"
	"time"

	"velachat/agent/internal/runtimeapi"
)

func TestActionDispatcherPreservesOrder(t *testing.T) {
	t.Parallel()

	session := &session{events: make(chan runtimeapi.Event, 4)}
	session.initActionDispatcher()
	session.emit(runtimeapi.Event{
		Kind:   runtimeapi.EventTurnCompletion,
		Detail: "generation-one",
	})
	session.emit(runtimeapi.Event{
		Kind: runtimeapi.EventActivity,
		Text: "generation-two",
	})
	session.closeEvents()

	first := <-session.events
	second := <-session.events
	if first.Kind != runtimeapi.EventTurnCompletion ||
		second.Kind != runtimeapi.EventActivity {
		t.Fatalf("ordered events = %#v then %#v", first, second)
	}
	if _, ok := <-session.events; ok {
		t.Fatal("Hermes events remained open after dispatcher drain")
	}
}

func TestActionDispatcherCloseIsBoundedWithoutConsumer(t *testing.T) {
	t.Parallel()

	session := &session{events: make(chan runtimeapi.Event)}
	session.initActionDispatcher()
	session.emit(runtimeapi.Event{
		Kind: runtimeapi.EventAssistantText,
		Text: "blocked event",
	})

	closed := make(chan struct{})
	go func() {
		session.closeEvents()
		close(closed)
	}()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("event backpressure prevented bounded dispatcher closure")
	}
	if _, ok := <-session.events; ok {
		t.Fatal("Hermes events remained open after forced dispatcher closure")
	}
}
