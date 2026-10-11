package authn

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"chatserver/internal/apperror"
	authnport "chatserver/internal/ports/authn"
)

const (
	serviceTestAccountID  = "01989c24-7540-7f12-a27b-c83243215dd1"
	serviceTestSessionID  = "01989c24-7540-7f12-a27b-c83243215dd2"
	serviceTestServerID   = "01989c24-7540-7f12-a27b-c83243215dd3"
	serviceTestAgentID    = "01989c24-7540-7f12-a27b-c83243215dd4"
	serviceTestComputerID = "01989c24-7540-7f12-a27b-c83243215dd5"
)

type fakeAuthenticator struct {
	principal authnport.CurrentPrincipal
	err       error
	candidate authnport.CredentialCandidate
}

func (a *fakeAuthenticator) Authenticate(
	_ context.Context,
	candidate authnport.CredentialCandidate,
) (authnport.CurrentPrincipal, error) {
	a.candidate = candidate
	return a.principal, a.err
}

func TestServiceRejectsPrincipalKindThatDoesNotMatchCandidate(t *testing.T) {
	runtimePrincipal, err := authnport.NewCurrentRuntimePrincipal(
		serviceTestServerID,
		serviceTestAgentID,
		1,
	)
	if err != nil {
		t.Fatalf("NewCurrentRuntimePrincipal() error = %v", err)
	}
	authenticator := &fakeAuthenticator{principal: runtimePrincipal}
	service, err := NewService(authenticator)
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	candidate, err := authnport.NewHumanBearerCandidate("human-token")
	if err != nil {
		t.Fatalf("NewHumanBearerCandidate() error = %v", err)
	}

	principal, err := service.Authenticate(context.Background(), candidate)

	if principal != nil {
		t.Fatalf("Authenticate() principal = %#v, want nil", principal)
	}
	if got := apperror.CodeOf(err); got != "unauthenticated" {
		t.Fatalf("Authenticate() code = %q, want unauthenticated", got)
	}
}

func TestServiceDoesNotLetCurrentnessErrorReachHandler(t *testing.T) {
	revoked := apperror.New("session_revoked", "登录会话已失效", nil)
	authenticator := &fakeAuthenticator{err: revoked}
	service, err := NewService(authenticator)
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	candidate, err := authnport.NewHumanBearerCandidate("revoked-token")
	if err != nil {
		t.Fatalf("NewHumanBearerCandidate() error = %v", err)
	}

	principal, err := service.Authenticate(context.Background(), candidate)

	if principal != nil {
		t.Fatalf("Authenticate() principal = %#v, want nil", principal)
	}
	if got := apperror.CodeOf(err); got != "session_revoked" {
		t.Fatalf("Authenticate() code = %q, want session_revoked", got)
	}
}

func TestAgentCredentialSecretIsAbsentFromPrincipal(t *testing.T) {
	principal, err := authnport.NewCurrentAgentCredentialPrincipal(
		serviceTestServerID,
		serviceTestAgentID,
		9,
	)
	if err != nil {
		t.Fatalf("NewCurrentAgentCredentialPrincipal() error = %v", err)
	}
	authenticator := &fakeAuthenticator{principal: principal}
	service, err := NewService(authenticator)
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	const secret = "sap_super-sensitive"
	candidate, err := authnport.NewAgentCredentialCandidate(secret, "sap_")
	if err != nil {
		t.Fatalf("NewAgentCredentialCandidate() error = %v", err)
	}

	got, err := service.Authenticate(context.Background(), candidate)
	if err != nil {
		t.Fatalf("Authenticate() error = %v", err)
	}
	if strings.Contains(fmt.Sprintf("%#v", got), secret) {
		t.Fatalf("principal contains credential secret: %#v", got)
	}
	if authenticator.candidate.Kind() != authnport.CandidateAgentCredential {
		t.Fatalf(
			"candidate kind = %q, want %q",
			authenticator.candidate.Kind(),
			authnport.CandidateAgentCredential,
		)
	}
}

func TestNewServiceRejectsMissingAuthenticator(t *testing.T) {
	if _, err := NewService(nil); err == nil {
		t.Fatal("NewService(nil) error = nil")
	}
}

func TestServiceAcceptsComputerPrincipalForLongAndShortCredentials(t *testing.T) {
	principal, err := authnport.NewCurrentComputerPrincipal(
		serviceTestServerID,
		serviceTestComputerID,
		2,
	)
	if err != nil {
		t.Fatal(err)
	}
	for _, candidate := range []authnport.CredentialCandidate{
		mustComputerCredentialCandidate(t),
		mustComputerBearerCandidate(t),
	} {
		service, err := NewService(&fakeAuthenticator{principal: principal})
		if err != nil {
			t.Fatal(err)
		}
		got, err := service.Authenticate(context.Background(), candidate)
		if err != nil {
			t.Fatalf("Authenticate(%q) error = %v", candidate.Kind(), err)
		}
		if got.Kind() != authnport.PrincipalComputer {
			t.Fatalf("Authenticate(%q) kind = %q", candidate.Kind(), got.Kind())
		}
	}
}

func TestServiceRejectsMismatchedComputerPrincipalWithComputerError(t *testing.T) {
	human, err := authnport.NewCurrentHumanPrincipal(
		serviceTestAccountID,
		serviceTestSessionID,
		1,
	)
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(&fakeAuthenticator{principal: human})
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.Authenticate(
		context.Background(),
		mustComputerBearerCandidate(t),
	)
	if got := apperror.CodeOf(err); got != "computer_credential_invalid" {
		t.Fatalf("Authenticate() code = %q", got)
	}
}

func mustComputerCredentialCandidate(t *testing.T) authnport.ComputerCredentialCandidate {
	t.Helper()
	value, err := authnport.NewComputerCredentialCandidate("computer-secret", serviceTestServerID)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func mustComputerBearerCandidate(t *testing.T) authnport.ComputerBearerCandidate {
	t.Helper()
	value, err := authnport.NewComputerBearerCandidate("computer-token")
	if err != nil {
		t.Fatal(err)
	}
	return value
}
