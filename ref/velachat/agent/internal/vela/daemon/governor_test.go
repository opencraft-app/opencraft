package daemon

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func TestLaunchGovernorSerializesAndSpacesAllLaunchKinds(t *testing.T) {
	t.Parallel()

	clock := &governorTestClock{now: time.Unix(100, 0)}
	governor, err := NewLaunchGovernor(LaunchGovernorConfig{
		MinimumInterval: 500 * time.Millisecond,
		Now:             clock.Now,
		Sleep:           clock.Sleep,
		Jitter:          func() time.Duration { return 0 },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer governor.Close()

	first, err := governor.Acquire(
		context.Background(),
		LaunchAgentHost,
		LaunchIdentity{AgentID: "agent-a", LaunchID: "launch-a"},
	)
	if err != nil {
		t.Fatal(err)
	}
	acquired := make(chan Permit, 1)
	go func() {
		permit, acquireErr := governor.Acquire(
			context.Background(),
			LaunchRuntime,
			LaunchIdentity{AgentID: "agent-b", LaunchID: "launch-b"},
		)
		if acquireErr == nil {
			acquired <- permit
		}
	}()
	select {
	case <-acquired:
		t.Fatal("second launch acquired while first permit was held")
	case <-time.After(20 * time.Millisecond):
	}
	first.Release()

	select {
	case second := <-acquired:
		second.Release()
	case <-time.After(time.Second):
		t.Fatal("second launch did not acquire after release")
	}
	if got := clock.Slept(); len(got) != 1 || got[0] != 500*time.Millisecond {
		t.Fatalf("spacing sleeps = %#v", got)
	}
}

func TestLaunchGovernorReleaseIsIdempotentAndCloseRejectsAcquire(t *testing.T) {
	t.Parallel()

	governor, err := NewLaunchGovernor(LaunchGovernorConfig{
		Jitter: func() time.Duration { return 0 },
	})
	if err != nil {
		t.Fatal(err)
	}
	permit, err := governor.Acquire(
		context.Background(),
		LaunchRuntime,
		LaunchIdentity{AgentID: "agent-a", LaunchID: "launch-a"},
	)
	if err != nil {
		t.Fatal(err)
	}
	permit.Release()
	permit.Release()
	governor.Close()
	governor.Close()

	_, err = governor.Acquire(
		context.Background(),
		LaunchAgentHost,
		LaunchIdentity{AgentID: "agent-b", LaunchID: "launch-b"},
	)
	if !errors.Is(err, ErrLaunchGovernorClosed) {
		t.Fatalf("Acquire() error = %v, want ErrLaunchGovernorClosed", err)
	}
}

type governorTestClock struct {
	mu     sync.Mutex
	now    time.Time
	sleeps []time.Duration
}

func (c *governorTestClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *governorTestClock) Sleep(
	ctx context.Context,
	delay time.Duration,
) error {
	c.mu.Lock()
	c.sleeps = append(c.sleeps, delay)
	c.now = c.now.Add(delay)
	c.mu.Unlock()
	return ctx.Err()
}

func (c *governorTestClock) Slept() []time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]time.Duration(nil), c.sleeps...)
}
