package authn

import (
	"context"
	"testing"

	"chatserver/internal/apperror"
	authnport "chatserver/internal/ports/authn"
)

type recordingAuthenticator struct {
	calls     int
	principal authnport.CurrentPrincipal
}

func (a *recordingAuthenticator) Authenticate(
	_ context.Context,
	_ authnport.CredentialCandidate,
) (authnport.CurrentPrincipal, error) {
	a.calls++
	return a.principal, nil
}

func TestCompositeAuthenticatorDispatchesByExactCandidateKind(t *testing.T) {
	humanPrincipal, err := authnport.NewCurrentHumanPrincipal(
		"01989c24-7540-7f12-a27b-c83243215dd1",
		"01989c24-7540-7f12-a27b-c83243215dd2",
		1,
	)
	if err != nil {
		t.Fatal(err)
	}
	runtimePrincipal, err := authnport.NewCurrentRuntimePrincipal(
		agentCredentialServerID,
		agentCredentialAgentID,
		7,
	)
	if err != nil {
		t.Fatal(err)
	}
	agentPrincipal, err := authnport.NewCurrentAgentCredentialPrincipal(
		agentCredentialServerID,
		agentCredentialAgentID,
		7,
	)
	if err != nil {
		t.Fatal(err)
	}
	computerPrincipal, err := authnport.NewCurrentComputerPrincipal(
		agentCredentialServerID,
		"01989c24-7540-7f12-a27b-c83243215dd5",
		2,
	)
	if err != nil {
		t.Fatal(err)
	}
	human := &recordingAuthenticator{principal: humanPrincipal}
	runtime := &recordingAuthenticator{principal: runtimePrincipal}
	agent := &recordingAuthenticator{principal: agentPrincipal}
	computerCredential := &recordingAuthenticator{principal: computerPrincipal}
	computerBearer := &recordingAuthenticator{principal: computerPrincipal}
	composite, err := NewCompositeAuthenticator(
		map[authnport.CandidateKind]authnport.Authenticator{
			authnport.CandidateHumanBearer:        human,
			authnport.CandidateRuntimeBearer:      runtime,
			authnport.CandidateAgentCredential:    agent,
			authnport.CandidateComputerCredential: computerCredential,
			authnport.CandidateComputerBearer:     computerBearer,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	humanCandidate, _ := authnport.NewHumanBearerCandidate("human")
	runtimeCandidate, _ := authnport.NewRuntimeBearerCandidate("runtime")
	agentCandidate, _ := authnport.NewAgentCredentialCandidate("agent", "route")
	computerCredentialCandidate, _ := authnport.NewComputerCredentialCandidate("computer", "route")
	computerBearerCandidate, _ := authnport.NewComputerBearerCandidate("computer-bearer")

	for _, candidate := range []authnport.CredentialCandidate{
		humanCandidate,
		runtimeCandidate,
		agentCandidate,
		computerCredentialCandidate,
		computerBearerCandidate,
	} {
		if _, err := composite.Authenticate(
			context.Background(),
			candidate,
		); err != nil {
			t.Fatalf("Authenticate(%q) error = %v", candidate.Kind(), err)
		}
	}
	if human.calls != 1 || runtime.calls != 1 || agent.calls != 1 ||
		computerCredential.calls != 1 || computerBearer.calls != 1 {
		t.Fatalf(
			"calls = human:%d runtime:%d agent:%d computer-credential:%d computer-bearer:%d",
			human.calls,
			runtime.calls,
			agent.calls,
			computerCredential.calls,
			computerBearer.calls,
		)
	}
}

func TestCompositeAuthenticatorRejectsMissingOrInvalidRegistration(
	t *testing.T,
) {
	if _, err := NewCompositeAuthenticator(nil); err == nil {
		t.Fatal("NewCompositeAuthenticator(nil) error = nil")
	}
	if _, err := NewCompositeAuthenticator(
		map[authnport.CandidateKind]authnport.Authenticator{
			authnport.CandidateHumanBearer: nil,
		},
	); err == nil {
		t.Fatal("NewCompositeAuthenticator(nil authenticator) error = nil")
	}
	human := &recordingAuthenticator{}
	composite, err := NewCompositeAuthenticator(
		map[authnport.CandidateKind]authnport.Authenticator{
			authnport.CandidateHumanBearer: human,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	runtimeCandidate, _ := authnport.NewRuntimeBearerCandidate("runtime")
	if _, err := composite.Authenticate(
		context.Background(),
		runtimeCandidate,
	); apperror.CodeOf(err) != "runtime_credential_invalid" {
		t.Fatalf("Authenticate(runtime) error = %v", err)
	}
	if human.calls != 0 {
		t.Fatal("runtime candidate was dispatched to human authenticator")
	}
}
