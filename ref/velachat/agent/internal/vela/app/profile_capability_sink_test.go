//go:build darwin || linux

package app

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"velachat/agent/internal/runtimeapi"
	"velachat/agent/internal/runtimecatalog"
	"velachat/agent/internal/vela/daemon"
	"velachat/agent/internal/vela/platform"
)

func TestProfileCapabilitySinkDiscoversAndSubmitsNormalizedResult(t *testing.T) {
	t.Parallel()

	future := newRuntimeSnapshotFuture()
	catalog, err := runtimecatalog.New([]runtimeapi.Registration{{
		ID: "codex", DisplayName: "Codex", NewDriver: func() (runtimeapi.RuntimeDriver, error) {
			return &fakeProfileCapabilityDriver{}, nil
		},
		Policy: runtimeapi.RuntimePolicy{
			SupportsStdin: true, BusyMode: runtimeapi.BusyDeliveryDirect,
			Completion: runtimeapi.CompletionEvent,
		},
		LaunchPlanner: runtimeapi.LaunchPlannerFunc(func(runtimeapi.LaunchInput) (runtimeapi.LaunchPlan, error) {
			return runtimeapi.LaunchPlan{}, nil
		}),
	}})
	if err != nil {
		t.Fatal(err)
	}
	future.Publish(catalog.Snapshot(context.Background()))
	submitter := &fakeProfileCapabilitySubmitter{
		errors: []error{errors.New("temporary submission failure")},
	}
	now := time.Date(2026, time.August, 18, 11, 0, 0, 0, time.UTC)
	sink := &computerProfileCapabilitySink{
		computerID:         "01989c24-7540-7f12-a27b-c83243215dd5",
		stateRoot:          t.TempDir(),
		runtimeFuture:      future,
		workspaceDirectory: func(string) (string, error) { return "/workspace/a", nil },
		submitter:          submitter,
		now:                func() time.Time { return now },
		retryDelay:         func(int) time.Duration { return 0 },
		active:             make(map[string]struct{}),
	}
	assignment := daemon.AgentAssignment{
		AgentID: "01989c24-7540-7f12-a27b-c83243215dd8",
		Runtime: daemon.RuntimeConfig{Kind: "codex"},
		ProfileCapabilityRefresh: &daemon.ProfileCapabilityRefresh{
			SchemaVersion:       1,
			RefreshID:           "01989c24-7540-7f12-a27b-c83243215dd9",
			ContextGeneration:   7,
			AuthorityContextKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
			RuntimeKind:         "codex", InvalidationWatermark: 3,
			ForceReload: true, RequestedAt: time.Now().UTC(),
		},
	}
	sink.Refresh(context.Background(), assignment)

	result, calls := submitter.last()
	if calls != 2 || result.Status != "succeeded" ||
		result.ContextGeneration != 7 || result.RuntimeKind != "codex" ||
		result.RuntimeContextGeneration != 1 ||
		result.ObservedThroughSequence != 0 || result.Subject == nil ||
		result.Subject.WorkspacePath != "/workspace/a" ||
		result.Source == nil || result.Source.Protocol != "codex_app_server" ||
		len(result.Models.Items) != 1 || result.Models.Items[0].ID != "gpt-5" ||
		len(result.Skills.Items) != 1 || result.Skills.Items[0].Name != "review" {
		t.Fatalf("submitted capability result = %#v calls=%d", result, calls)
	}
}

type fakeProfileCapabilityDriver struct{}

func (*fakeProfileCapabilityDriver) Probe(context.Context) (runtimeapi.ProbeResult, error) {
	return runtimeapi.ProbeResult{Available: true}, nil
}

func (*fakeProfileCapabilityDriver) DetectModels(context.Context) (runtimeapi.ModelResult, error) {
	return runtimeapi.ModelResult{}, nil
}

func (*fakeProfileCapabilityDriver) Start(context.Context, runtimeapi.StartRequest) (runtimeapi.RuntimeSession, error) {
	return nil, nil
}

func (*fakeProfileCapabilityDriver) DiscoverProfileCapabilities(
	context.Context,
	runtimeapi.ProfileCapabilityRequest,
) (runtimeapi.ProfileCapabilityResult, error) {
	return runtimeapi.ProfileCapabilityResult{
		Protocol: "codex_app_server", RuntimeVersion: "test-version",
		ProfileHome: "/profile/a", ProfileKind: "codex_home",
		Models: runtimeapi.ModelResult{
			Default: "gpt-5", Models: []runtimeapi.Model{{ID: "gpt-5", Label: "GPT-5"}},
		},
		Skills: []runtimeapi.Skill{{
			ID: "review", Name: "review", Description: "Review code",
			Enabled: true, Availability: "available", Scope: "user",
		}},
	}, nil
}

type fakeProfileCapabilitySubmitter struct {
	mu     sync.Mutex
	result platform.ComputerAgentProfileCapabilityResult
	calls  int
	errors []error
}

func (s *fakeProfileCapabilitySubmitter) Submit(
	_ context.Context,
	_ string,
	_ string,
	result platform.ComputerAgentProfileCapabilityResult,
) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.result = result
	s.calls++
	if len(s.errors) > 0 {
		err := s.errors[0]
		s.errors = s.errors[1:]
		return err
	}
	return nil
}

func (s *fakeProfileCapabilitySubmitter) last() (
	platform.ComputerAgentProfileCapabilityResult,
	int,
) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.result, s.calls
}
