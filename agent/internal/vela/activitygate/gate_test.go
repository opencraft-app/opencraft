package activitygate

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestGateDrainsActiveLeasesAndRejectsNewWorkUntilReleased(t *testing.T) {
	t.Parallel()
	gate := New()
	lease, err := gate.Acquire(context.Background(), AgentTurn)
	if err != nil {
		t.Fatal(err)
	}
	drained := make(chan *DrainPermit, 1)
	go func() {
		permit, err := gate.Drain(context.Background())
		if err != nil {
			drained <- nil
			return
		}
		drained <- permit
	}()
	deadline := time.Now().Add(time.Second)
	for {
		probe, err := gate.Acquire(context.Background(), AgentTurn)
		if errors.Is(err, ErrDraining) {
			break
		}
		if err == nil {
			probe.Release()
		}
		if time.Now().After(deadline) {
			t.Fatal("gate never entered draining state")
		}
		time.Sleep(time.Millisecond)
	}
	select {
	case <-drained:
		t.Fatal("drain completed while work was active")
	default:
	}
	lease.Release()
	permit := <-drained
	if permit == nil {
		t.Fatal("drain failed")
	}
	if _, err := gate.Acquire(context.Background(), TerminalSession); !errors.Is(err, ErrDraining) {
		t.Fatalf("Acquire during drain error = %v", err)
	}
	permit.Release()
	next, err := gate.Acquire(context.Background(), TATTask)
	if err != nil {
		t.Fatal(err)
	}
	next.Release()
}
