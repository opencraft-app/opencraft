package runtimeapi

import (
	"context"
	"errors"
	"testing"
)

func TestRuntimePolicyDeclaresSchedulingAndCompletionContract(t *testing.T) {
	t.Parallel()

	policy := RuntimePolicy{
		SupportsStdin: true,
		BusyMode:      BusyDeliveryDirect,
		Completion:    CompletionEvent,
	}
	if !policy.SupportsStdin ||
		policy.BusyMode != BusyDeliveryDirect ||
		policy.Completion != CompletionEvent {
		t.Fatalf("RuntimePolicy = %#v", policy)
	}
}

func TestRetryableDeliveryErrorExposesOnlySupportedDisposition(t *testing.T) {
	t.Parallel()

	cause := errors.New("native request rejected")
	err := NewRetryableDeliveryError(RetryDelayedIdle, cause)
	disposition, ok := DeliveryRetryDisposition(err)
	if !ok || disposition != RetryDelayedIdle {
		t.Fatalf("DeliveryRetryDisposition() = %q, %v", disposition, ok)
	}
	if !errors.Is(err, cause) {
		t.Fatal("retryable delivery error does not unwrap its native cause")
	}

	unsupported := NewRetryableDeliveryError(RetryDisposition("fatal"), cause)
	if disposition, ok := DeliveryRetryDisposition(unsupported); ok {
		t.Fatalf("unsupported disposition = %q, want non-retryable", disposition)
	}
}

func TestLaunchPlannerFuncImplementsLaunchPlanner(t *testing.T) {
	t.Parallel()

	planner := LaunchPlannerFunc(func(input LaunchInput) (LaunchPlan, error) {
		return LaunchPlan{
			Prompt:                   input.ResumePrompt,
			ConsumedBufferedMessages: len(input.BufferedMessages),
		}, nil
	})
	plan, err := planner.PlanLaunch(LaunchInput{
		ResumePrompt: "resume fixture",
		BufferedMessages: []BufferedLaunchMessage{
			{Transient: true},
			{Transient: false},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Prompt != "resume fixture" || plan.ConsumedBufferedMessages != 2 {
		t.Fatalf("launch plan = %#v", plan)
	}
}

func TestDriverFactoryAndResolverContractsAreDependencyNeutral(t *testing.T) {
	t.Parallel()

	driver := contractDriver{}
	registration := ResolvedRuntime{
		ID:          "fixture-wire",
		InternalID:  "fixture",
		DisplayName: "Fixture",
		NewDriver: func() (RuntimeDriver, error) {
			return driver, nil
		},
		Policy: RuntimePolicy{
			SupportsStdin: true,
			BusyMode:      BusyDeliveryDirect,
			Completion:    CompletionEvent,
		},
		LaunchPlanner: LaunchPlannerFunc(func(LaunchInput) (LaunchPlan, error) {
			return LaunchPlan{Prompt: "fixture"}, nil
		}),
	}
	resolver := contractResolver{runtime: registration}
	resolved, ok := resolver.ResolveRuntime("fixture-wire")
	if !ok || resolved.ID != "fixture-wire" ||
		resolved.InternalID != "fixture" {
		t.Fatalf("ResolveRuntime() = %#v, %v", resolved, ok)
	}
	created, err := resolved.NewDriver()
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := created.(contractDriver); !ok {
		t.Fatalf("factory Driver = %T", created)
	}
}

func TestRuntimeSessionTurnCapabilitiesAreIndependent(t *testing.T) {
	t.Parallel()

	base := RuntimeSession(&contractSession{})
	if _, ok := base.(NativeSteerer); ok {
		t.Fatal("base RuntimeSession unexpectedly claims native steering")
	}
	if _, ok := base.(NativeTurnInterrupter); ok {
		t.Fatal("base RuntimeSession unexpectedly claims native turn interruption")
	}

	steering := RuntimeSession(&contractSteeringSession{})
	if _, ok := steering.(NativeSteerer); !ok {
		t.Fatal("steering session does not expose NativeSteerer")
	}
	if _, ok := steering.(NativeTurnInterrupter); ok {
		t.Fatal("steering session unexpectedly claims native turn interruption")
	}

	interrupting := RuntimeSession(&contractInterruptingSession{})
	if _, ok := interrupting.(NativeTurnInterrupter); !ok {
		t.Fatal("interrupting session does not expose NativeTurnInterrupter")
	}
	if _, ok := interrupting.(NativeSteerer); ok {
		t.Fatal("interrupting session unexpectedly claims native steering")
	}
}

type contractResolver struct {
	runtime ResolvedRuntime
}

func (r contractResolver) ResolveRuntime(id string) (ResolvedRuntime, bool) {
	if id != r.runtime.ID {
		return ResolvedRuntime{}, false
	}
	return r.runtime, true
}

type contractDriver struct{}

func (contractDriver) Probe(context.Context) (ProbeResult, error) {
	return ProbeResult{Available: true}, nil
}

func (contractDriver) DetectModels(context.Context) (ModelResult, error) {
	return ModelResult{}, nil
}

func (contractDriver) Start(context.Context, StartRequest) (RuntimeSession, error) {
	return nil, errors.New("not used")
}

type contractSession struct{}

func (*contractSession) Deliver(context.Context, Delivery) error {
	return nil
}

func (*contractSession) Stop(context.Context) error {
	return nil
}

func (*contractSession) Events() <-chan Event {
	return nil
}

func (*contractSession) SessionID() string {
	return "contract-session"
}

type contractSteeringSession struct {
	contractSession
}

func (*contractSteeringSession) Steer(context.Context, Delivery) error {
	return nil
}

type contractInterruptingSession struct {
	contractSession
}

func (*contractInterruptingSession) InterruptTurn(context.Context) error {
	return nil
}
