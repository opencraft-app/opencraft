package runtimecatalog

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"velachat/agent/internal/runtimeapi"
	"velachat/agent/internal/runtimeprompt"
)

func TestNewRejectsInvalidRegistrations(t *testing.T) {
	t.Parallel()

	valid := fixtureRegistration("codex", func() (runtimeapi.RuntimeDriver, error) {
		return &fixtureDriver{available: true}, nil
	})
	testCases := []struct {
		name          string
		registrations []runtimeapi.Registration
	}{
		{name: "empty id", registrations: []runtimeapi.Registration{{}}},
		{
			name: "malformed id",
			registrations: []runtimeapi.Registration{
				fixtureRegistration("Codex Runtime", valid.NewDriver),
			},
		},
		{
			name:          "duplicate id",
			registrations: []runtimeapi.Registration{valid, valid},
		},
		{
			name: "missing display name",
			registrations: []runtimeapi.Registration{{
				ID:            "codex",
				NewDriver:     valid.NewDriver,
				Policy:        valid.Policy,
				LaunchPlanner: valid.LaunchPlanner,
			}},
		},
		{
			name: "missing factory",
			registrations: []runtimeapi.Registration{{
				ID:            "codex",
				DisplayName:   "Codex",
				Policy:        valid.Policy,
				LaunchPlanner: valid.LaunchPlanner,
			}},
		},
		{
			name: "missing planner",
			registrations: []runtimeapi.Registration{{
				ID:          "codex",
				DisplayName: "Codex",
				NewDriver:   valid.NewDriver,
				Policy:      valid.Policy,
			}},
		},
		{
			name: "unknown busy mode",
			registrations: []runtimeapi.Registration{{
				ID:          "codex",
				DisplayName: "Codex",
				NewDriver:   valid.NewDriver,
				Policy: runtimeapi.RuntimePolicy{
					BusyMode:   "fixture",
					Completion: runtimeapi.CompletionEvent,
				},
				LaunchPlanner: valid.LaunchPlanner,
			}},
		},
		{
			name: "direct without stdin",
			registrations: []runtimeapi.Registration{{
				ID:          "codex",
				DisplayName: "Codex",
				NewDriver:   valid.NewDriver,
				Policy: runtimeapi.RuntimePolicy{
					BusyMode:   runtimeapi.BusyDeliveryDirect,
					Completion: runtimeapi.CompletionEvent,
				},
				LaunchPlanner: valid.LaunchPlanner,
			}},
		},
	}
	for _, testCase := range testCases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			if _, err := New(testCase.registrations); err == nil {
				t.Fatal("New() error = nil, want invalid registration")
			}
		})
	}
}

func TestNewRequiresSupportedCompletionPolicy(t *testing.T) {
	t.Parallel()

	missing := fixtureRegistration(
		"missing-completion",
		func() (runtimeapi.RuntimeDriver, error) {
			return &fixtureDriver{available: true}, nil
		},
	)
	missing.Policy.Completion = ""
	if _, err := New([]runtimeapi.Registration{missing}); err == nil {
		t.Fatal("New() accepted a Runtime without completion policy")
	}

	unsupported := fixtureRegistration(
		"unsupported-completion",
		func() (runtimeapi.RuntimeDriver, error) {
			return &fixtureDriver{available: true}, nil
		},
	)
	unsupported.Policy.Completion = runtimeapi.CompletionMode("process_exit")
	if _, err := New([]runtimeapi.Registration{unsupported}); err == nil {
		t.Fatal("New() accepted an unsupported completion policy")
	}
}

func TestSnapshotContainsOnlyAvailableRuntimesInStableOrder(t *testing.T) {
	t.Parallel()

	catalog, err := New([]runtimeapi.Registration{
		fixtureRegistration("zeta", func() (runtimeapi.RuntimeDriver, error) {
			return &fixtureDriver{available: true}, nil
		}),
		fixtureRegistration("missing", func() (runtimeapi.RuntimeDriver, error) {
			return &fixtureDriver{available: false}, nil
		}),
		fixtureRegistration("alpha", func() (runtimeapi.RuntimeDriver, error) {
			return &fixtureDriver{available: true}, nil
		}),
		fixtureRegistration("factory-error", func() (runtimeapi.RuntimeDriver, error) {
			return nil, errors.New("factory failed")
		}),
		fixtureRegistration("nil-driver", func() (runtimeapi.RuntimeDriver, error) {
			return nil, nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	snapshot := catalog.Snapshot(context.Background())
	ids := snapshot.RuntimeIDs()
	if len(ids) != 2 || ids[0] != "alpha" || ids[1] != "zeta" {
		t.Fatalf("RuntimeIDs() = %#v", ids)
	}
	for _, id := range ids {
		resolved, ok := snapshot.ResolveRuntime(id)
		if !ok {
			t.Fatalf("ResolveRuntime(%q) = missing", id)
		}
		if resolved.ID != id || resolved.InternalID != id {
			t.Fatalf("ResolveRuntime(%q) identities = %#v", id, resolved)
		}
		internal, ok := snapshot.ResolveInternalRuntime(id)
		if !ok || internal.ID != id || internal.InternalID != id {
			t.Fatalf("ResolveInternalRuntime(%q) = %#v, %v", id, internal, ok)
		}
	}
	for _, unavailable := range []string{"missing", "factory-error", "nil-driver"} {
		if _, ok := snapshot.ResolveRuntime(unavailable); ok {
			t.Fatalf("unavailable Runtime %q resolved", unavailable)
		}
	}
}

func TestSnapshotMapsWireRuntimeToInternalPlannerIdentity(t *testing.T) {
	t.Parallel()

	var plannedRuntime string
	registration := fixtureRegistration(
		"hermes-acp",
		func() (runtimeapi.RuntimeDriver, error) {
			return &fixtureDriver{available: true}, nil
		},
	)
	registration.WireID = "opencode"
	registration.LaunchPlanner = runtimeapi.LaunchPlannerFunc(
		func(input runtimeapi.LaunchInput) (runtimeapi.LaunchPlan, error) {
			plannedRuntime = input.Runtime
			return runtimeapi.LaunchPlan{
				Prompt:         "mapped",
				StandingPrompt: "custom planner instructions",
			}, nil
		},
	)
	catalog, err := New([]runtimeapi.Registration{registration})
	if err != nil {
		t.Fatal(err)
	}
	snapshot := catalog.Snapshot(context.Background())
	if ids := snapshot.RuntimeIDs(); len(ids) != 1 || ids[0] != "opencode" {
		t.Fatalf("RuntimeIDs() = %#v", ids)
	}
	if _, ok := snapshot.ResolveRuntime("hermes-acp"); ok {
		t.Fatal("internal Runtime ID resolved as a cloud wire identity")
	}
	resolved, ok := snapshot.ResolveRuntime("opencode")
	if !ok || resolved.ID != "opencode" ||
		resolved.InternalID != "hermes-acp" {
		t.Fatalf("ResolveRuntime(opencode) = %#v, %v", resolved, ok)
	}
	internal, ok := snapshot.ResolveInternalRuntime("hermes-acp")
	if !ok || internal.ID != "opencode" ||
		internal.InternalID != "hermes-acp" {
		t.Fatalf("ResolveInternalRuntime(hermes-acp) = %#v, %v", internal, ok)
	}
	if _, ok := snapshot.ResolveInternalRuntime("opencode"); ok {
		t.Fatal("wire alias resolved as an internal Runtime identity")
	}
	plan, err := resolved.LaunchPlanner.PlanLaunch(runtimeapi.LaunchInput{
		AgentID: "agent-test",
		Runtime: "opencode",
	})
	if err != nil {
		t.Fatal(err)
	}
	if plannedRuntime != "hermes-acp" || plan.Prompt != "mapped" {
		t.Fatalf("planner input Runtime = %q, plan = %#v", plannedRuntime, plan)
	}
	if !strings.HasPrefix(plan.StandingPrompt, "custom planner instructions\n\n") ||
		strings.Count(
			plan.StandingPrompt,
			runtimeprompt.SharedConversationPolicyMarker,
		) != 1 ||
		!strings.Contains(plan.StandingPrompt, "You are Vela Agent agent-test.") {
		t.Fatalf("catalog-composed standing prompt = %q", plan.StandingPrompt)
	}
	if _, err := resolved.LaunchPlanner.PlanLaunch(runtimeapi.LaunchInput{
		Runtime: "opencode",
	}); err == nil {
		t.Fatal("catalog launch planner accepted an empty Agent identity")
	}
}

func TestSnapshotDoesNotDuplicatePrecomposedSharedPolicy(t *testing.T) {
	t.Parallel()

	precomposed, err := runtimeprompt.ComposeStandingPrompt(
		"agent-precomposed",
		"precomposed Driver instructions",
	)
	if err != nil {
		t.Fatal(err)
	}
	registration := fixtureRegistration(
		"precomposed",
		func() (runtimeapi.RuntimeDriver, error) {
			return &fixtureDriver{available: true}, nil
		},
	)
	registration.LaunchPlanner = runtimeapi.LaunchPlannerFunc(
		func(runtimeapi.LaunchInput) (runtimeapi.LaunchPlan, error) {
			return runtimeapi.LaunchPlan{
				StandingPrompt: precomposed,
			}, nil
		},
	)
	catalog, err := New([]runtimeapi.Registration{registration})
	if err != nil {
		t.Fatal(err)
	}
	resolved, ok := catalog.Snapshot(context.Background()).
		ResolveRuntime("precomposed")
	if !ok {
		t.Fatal("precomposed Runtime did not resolve")
	}
	plan, err := resolved.LaunchPlanner.PlanLaunch(runtimeapi.LaunchInput{
		AgentID: "agent-precomposed",
		Runtime: "precomposed",
	})
	if err != nil {
		t.Fatal(err)
	}
	if plan.StandingPrompt != precomposed ||
		strings.Count(
			plan.StandingPrompt,
			runtimeprompt.SharedConversationPolicyMarker,
		) != 1 {
		t.Fatalf("catalog duplicated precomposed policy: %q", plan.StandingPrompt)
	}
}

func TestSnapshotSortsByEffectiveWireRuntimeID(t *testing.T) {
	t.Parallel()

	zetaDriver := fixtureRegistration(
		"alpha-driver",
		func() (runtimeapi.RuntimeDriver, error) {
			return &fixtureDriver{available: true}, nil
		},
	)
	zetaDriver.WireID = "zeta"
	alphaDriver := fixtureRegistration(
		"zeta-driver",
		func() (runtimeapi.RuntimeDriver, error) {
			return &fixtureDriver{available: true}, nil
		},
	)
	alphaDriver.WireID = "alpha"
	catalog, err := New([]runtimeapi.Registration{zetaDriver, alphaDriver})
	if err != nil {
		t.Fatal(err)
	}
	if ids := catalog.Snapshot(context.Background()).RuntimeIDs(); len(ids) != 2 ||
		ids[0] != "alpha" || ids[1] != "zeta" {
		t.Fatalf("RuntimeIDs() = %#v", ids)
	}
}

func TestNewRejectsInvalidOrDuplicateWireRuntimeIDs(t *testing.T) {
	t.Parallel()

	malformed := fixtureRegistration(
		"hermes-acp",
		func() (runtimeapi.RuntimeDriver, error) {
			return &fixtureDriver{available: true}, nil
		},
	)
	malformed.WireID = "OpenCode Runtime"
	if _, err := New([]runtimeapi.Registration{malformed}); err == nil {
		t.Fatal("New() accepted a malformed wire Runtime ID")
	}

	whitespace := fixtureRegistration(
		"hermes-acp",
		func() (runtimeapi.RuntimeDriver, error) {
			return &fixtureDriver{available: true}, nil
		},
	)
	whitespace.WireID = " opencode "
	if _, err := New([]runtimeapi.Registration{whitespace}); err == nil {
		t.Fatal("New() accepted a padded wire Runtime ID")
	}

	first := fixtureRegistration(
		"hermes-acp",
		func() (runtimeapi.RuntimeDriver, error) {
			return &fixtureDriver{available: true}, nil
		},
	)
	first.WireID = "opencode"
	second := fixtureRegistration(
		"other-acp",
		func() (runtimeapi.RuntimeDriver, error) {
			return &fixtureDriver{available: true}, nil
		},
	)
	second.WireID = "opencode"
	if _, err := New([]runtimeapi.Registration{first, second}); err == nil {
		t.Fatal("New() accepted duplicate wire Runtime IDs")
	}
}

func TestSnapshotReturnsImmutableValuesAndFreshFactories(t *testing.T) {
	t.Parallel()

	var mu sync.Mutex
	var created []*fixtureDriver
	registration := fixtureRegistration("codex", func() (runtimeapi.RuntimeDriver, error) {
		mu.Lock()
		defer mu.Unlock()
		driver := &fixtureDriver{available: true}
		created = append(created, driver)
		return driver, nil
	})
	catalog, err := New([]runtimeapi.Registration{registration})
	if err != nil {
		t.Fatal(err)
	}
	snapshot := catalog.Snapshot(context.Background())

	first, ok := snapshot.ResolveRuntime("codex")
	if !ok {
		t.Fatal("Codex is unavailable")
	}
	first.Policy.BusyMode = runtimeapi.BusyDeliveryNone
	second, ok := snapshot.ResolveRuntime("codex")
	if !ok || second.Policy.BusyMode != runtimeapi.BusyDeliveryDirect {
		t.Fatalf("second resolution = %#v, %v", second, ok)
	}
	modelDriver, err := second.NewDriver()
	if err != nil {
		t.Fatal(err)
	}
	launchDriver, err := second.NewDriver()
	if err != nil {
		t.Fatal(err)
	}
	if modelDriver == launchDriver {
		t.Fatal("factory reused one Driver instance")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(created) != 3 {
		t.Fatalf("factory calls = %d, want probe + model + launch", len(created))
	}
}

func TestSnapshotConcurrentResolutionIsRaceFree(t *testing.T) {
	t.Parallel()

	catalog, err := New([]runtimeapi.Registration{
		fixtureRegistration("codex", func() (runtimeapi.RuntimeDriver, error) {
			return &fixtureDriver{available: true}, nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	snapshot := catalog.Snapshot(context.Background())
	var wait sync.WaitGroup
	for index := 0; index < 32; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			resolved, ok := snapshot.ResolveRuntime("codex")
			if !ok || resolved.ID != "codex" {
				t.Errorf("ResolveRuntime() = %#v, %v", resolved, ok)
			}
			if ids := snapshot.RuntimeIDs(); len(ids) != 1 || ids[0] != "codex" {
				t.Errorf("RuntimeIDs() = %#v", ids)
			}
		}()
	}
	wait.Wait()
}

func fixtureRegistration(
	id string,
	factory runtimeapi.DriverFactory,
) runtimeapi.Registration {
	return runtimeapi.Registration{
		ID:          id,
		DisplayName: id,
		NewDriver:   factory,
		Policy: runtimeapi.RuntimePolicy{
			SupportsStdin: true,
			BusyMode:      runtimeapi.BusyDeliveryDirect,
			Completion:    runtimeapi.CompletionEvent,
		},
		LaunchPlanner: runtimeapi.LaunchPlannerFunc(
			func(runtimeapi.LaunchInput) (runtimeapi.LaunchPlan, error) {
				return runtimeapi.LaunchPlan{}, nil
			},
		),
	}
}

type fixtureDriver struct {
	available bool
}

func (d *fixtureDriver) Probe(context.Context) (runtimeapi.ProbeResult, error) {
	return runtimeapi.ProbeResult{Available: d.available}, nil
}

func (d *fixtureDriver) DetectModels(context.Context) (runtimeapi.ModelResult, error) {
	return runtimeapi.ModelResult{}, nil
}

func (d *fixtureDriver) Start(
	context.Context,
	runtimeapi.StartRequest,
) (runtimeapi.RuntimeSession, error) {
	return nil, errors.New("not used")
}
