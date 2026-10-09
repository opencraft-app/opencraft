package computercontrol

import (
	"context"
	"errors"
	"testing"
	"time"

	appruntimesession "chatserver/internal/app/runtimesession"
	"chatserver/internal/apperror"
	computercontrolport "chatserver/internal/ports/computercontrol"
)

type recordingAgentLaunchRepository struct {
	events   *[]string
	requests []computercontrolport.AgentLaunchRequest
	fence    computercontrolport.AgentLaunchFence
	err      error
}

func (repository *recordingAgentLaunchRepository) AllocateAgentLaunch(
	_ context.Context,
	request computercontrolport.AgentLaunchRequest,
) (computercontrolport.AgentLaunchAllocation, error) {
	*repository.events = append(*repository.events, "allocate")
	repository.requests = append(repository.requests, request)
	if repository.err != nil {
		return computercontrolport.AgentLaunchAllocation{}, repository.err
	}
	return computercontrolport.AgentLaunchAllocation{
		Fence:   repository.fence,
		Created: len(repository.requests) == 1,
	}, nil
}

func TestAgentLaunchServiceMapsInactiveComputerCredential(t *testing.T) {
	events := make([]string, 0, 1)
	repository := &recordingAgentLaunchRepository{
		events: &events,
		err:    computercontrolport.ErrComputerCredentialNotActive,
	}
	service, err := NewAgentLaunchService(
		repository,
		&recordingRuntimeSessionIssuer{events: &events},
		launchClock{now: time.Date(2026, 8, 1, 18, 0, 0, 0, time.UTC)},
	)
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.Create(
		context.Background(),
		"01989c24-7540-7f12-a27b-c83243215dd3",
		"01989c24-7540-7f12-a27b-c83243215dd5",
		"01989c24-7540-7f12-a27b-c83243215dd8",
		AgentLaunchRequest{
			ComputerCredentialVersion: 4,
			LaunchID:                  "01989c24-7540-7f12-a27b-c83243215dda",
			AssignmentEpoch:           "01989c24-7540-7f12-a27b-c83243215dd7",
			AssignmentRevision:        4, ConfigGeneration: 6, CredentialVersion: 2,
		},
	)
	if got := apperror.CodeOf(err); got != "computer_credential_not_active" {
		t.Fatalf("Create() error code = %q, error = %v", got, err)
	}
}

func TestAgentLaunchServiceKeepsLaunchAndMapsSessionMintFailure(t *testing.T) {
	events := make([]string, 0, 2)
	fence := computercontrolport.AgentLaunchFence{
		LaunchID:         "01989c24-7540-7f12-a27b-c83243215dda",
		AssignmentEpoch:  "01989c24-7540-7f12-a27b-c83243215dd7",
		ConfigGeneration: 6, CredentialVersion: 2, Attempt: 1,
		IssuedAt: time.Date(2026, 8, 1, 18, 0, 0, 0, time.UTC),
	}
	service, err := NewAgentLaunchService(
		&recordingAgentLaunchRepository{events: &events, fence: fence},
		&recordingRuntimeSessionIssuer{events: &events, err: errors.New("issuer unavailable")},
		launchClock{now: fence.IssuedAt},
	)
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.Create(
		context.Background(),
		"01989c24-7540-7f12-a27b-c83243215dd3",
		"01989c24-7540-7f12-a27b-c83243215dd5",
		"01989c24-7540-7f12-a27b-c83243215dd8",
		AgentLaunchRequest{
			ComputerCredentialVersion: 4, LaunchID: fence.LaunchID,
			AssignmentEpoch: fence.AssignmentEpoch, AssignmentRevision: 4,
			ConfigGeneration: 6, CredentialVersion: 2,
		},
	)
	if got := apperror.CodeOf(err); got != "session_temporarily_unavailable" {
		t.Fatalf("Create() error code = %q, error = %v", got, err)
	}
	if got, want := events, []string{"allocate", "mint"}; len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("events = %#v", got)
	}
}

func (repository *recordingAgentLaunchRepository) ValidateAgentLaunch(
	_ context.Context,
	request computercontrolport.AgentLaunchSessionRequest,
) (computercontrolport.AgentLaunchFence, error) {
	*repository.events = append(*repository.events, "validate")
	if request.LaunchID != repository.fence.LaunchID ||
		request.AssignmentEpoch != repository.fence.AssignmentEpoch ||
		request.ConfigGeneration != repository.fence.ConfigGeneration ||
		request.CredentialVersion != repository.fence.CredentialVersion ||
		request.Attempt != repository.fence.Attempt {
		return computercontrolport.AgentLaunchFence{}, computercontrolport.ErrLaunchConflict
	}
	return repository.fence, nil
}

type recordingRuntimeSessionIssuer struct {
	events   *[]string
	session  appruntimesession.Session
	err      error
	launches []appruntimesession.LaunchFence
}

func (issuer *recordingRuntimeSessionIssuer) CreateForLaunch(
	_ context.Context,
	_ string,
	_ string,
	_ string,
	fence appruntimesession.LaunchFence,
) (appruntimesession.Session, error) {
	*issuer.events = append(*issuer.events, "mint")
	issuer.launches = append(issuer.launches, fence)
	return issuer.session, issuer.err
}

func (issuer *recordingRuntimeSessionIssuer) Create(
	_ context.Context,
	_ string,
	_ string,
	_ uint64,
) (appruntimesession.Session, error) {
	*issuer.events = append(*issuer.events, "mint")
	return issuer.session, issuer.err
}

type launchClock struct{ now time.Time }

func (clock launchClock) Now() time.Time { return clock.now }

func TestAgentLaunchServiceAllocatesMintsAndRevalidates(t *testing.T) {
	now := time.Date(2026, 8, 1, 18, 0, 0, 0, time.UTC)
	events := make([]string, 0, 3)
	fence := computercontrolport.AgentLaunchFence{
		LaunchID:          "01989c24-7540-7f12-a27b-c83243215dda",
		AssignmentEpoch:   "01989c24-7540-7f12-a27b-c83243215dd7",
		ConfigGeneration:  6,
		CredentialVersion: 2,
		Attempt:           1,
		IssuedAt:          now,
	}
	repository := &recordingAgentLaunchRepository{events: &events, fence: fence}
	runtime := appruntimesession.Session{AccessToken: "agent-token"}
	issuer := &recordingRuntimeSessionIssuer{events: &events, session: runtime}
	service, err := NewAgentLaunchService(repository, issuer, launchClock{now: now})
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.Create(
		context.Background(),
		"01989c24-7540-7f12-a27b-c83243215dd3",
		"01989c24-7540-7f12-a27b-c83243215dd5",
		"01989c24-7540-7f12-a27b-c83243215dd8",
		AgentLaunchRequest{
			ComputerCredentialVersion: 4,
			LaunchID:                  fence.LaunchID,
			AssignmentEpoch:           fence.AssignmentEpoch,
			AssignmentRevision:        4,
			ConfigGeneration:          fence.ConfigGeneration,
			CredentialVersion:         fence.CredentialVersion,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := events, []string{"allocate", "mint", "allocate"}; len(got) != len(want) || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] {
		t.Fatalf("events = %#v, want %#v", got, want)
	}
	if len(repository.requests) != 2 || repository.requests[0] != repository.requests[1] ||
		!repository.requests[0].RequestedAt.Equal(now) {
		t.Fatalf("launch requests = %#v", repository.requests)
	}
	if !result.Created || result.Fence != fence || result.Runtime.AccessToken != "agent-token" {
		t.Fatalf("Agent launch = %#v", result)
	}
	if len(issuer.launches) != 1 || issuer.launches[0].LaunchID != fence.LaunchID ||
		issuer.launches[0].Attempt != fence.Attempt {
		t.Fatalf("Runtime Launch fences = %#v", issuer.launches)
	}
}

func TestAgentLaunchServiceRefreshesOnlyCurrentLaunch(t *testing.T) {
	now := time.Date(2026, 8, 1, 18, 0, 0, 0, time.UTC)
	events := make([]string, 0, 3)
	fence := computercontrolport.AgentLaunchFence{
		LaunchID:          "01989c24-7540-7f12-a27b-c83243215dda",
		AssignmentEpoch:   "01989c24-7540-7f12-a27b-c83243215dd7",
		ConfigGeneration:  6,
		CredentialVersion: 2,
		Attempt:           4,
		IssuedAt:          now.Add(-time.Hour),
	}
	repository := &recordingAgentLaunchRepository{events: &events, fence: fence}
	issuer := &recordingRuntimeSessionIssuer{
		events: &events,
		session: appruntimesession.Session{
			AccessToken: "refreshed-agent-token",
		},
	}
	service, err := NewAgentLaunchService(repository, issuer, launchClock{now: now})
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.Refresh(
		context.Background(),
		"01989c24-7540-7f12-a27b-c83243215dd3",
		"01989c24-7540-7f12-a27b-c83243215dd5",
		"01989c24-7540-7f12-a27b-c83243215dd8",
		fence.LaunchID,
		AgentSessionRefreshRequest{
			AssignmentEpoch:   fence.AssignmentEpoch,
			ConfigGeneration:  fence.ConfigGeneration,
			CredentialVersion: fence.CredentialVersion,
			Attempt:           fence.Attempt,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := events, []string{"validate", "mint", "validate"}; len(got) != len(want) || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] {
		t.Fatalf("events = %#v, want %#v", got, want)
	}
	if result.AccessToken != "refreshed-agent-token" {
		t.Fatalf("Refresh() = %#v", result)
	}
}
