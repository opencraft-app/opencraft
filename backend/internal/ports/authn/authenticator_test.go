package authn

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

const (
	testAccountID  = "01989c24-7540-7f12-a27b-c83243215dd1"
	testSessionID  = "01989c24-7540-7f12-a27b-c83243215dd2"
	testServerID   = "01989c24-7540-7f12-a27b-c83243215dd3"
	testAgentID    = "01989c24-7540-7f12-a27b-c83243215dd4"
	testComputerID = "01989c24-7540-7f12-a27b-c83243215dd5"
)

type fixedAuthenticator struct {
	principal CurrentPrincipal
}

func (a fixedAuthenticator) Authenticate(
	_ context.Context,
	_ CredentialCandidate,
) (CurrentPrincipal, error) {
	return a.principal, nil
}

func TestCredentialCandidateCannotBeUsedAsCurrentPrincipal(t *testing.T) {
	candidate, err := NewHumanBearerCandidate("access-token")
	if err != nil {
		t.Fatalf("NewHumanBearerCandidate() error = %v", err)
	}

	if _, ok := any(candidate).(CurrentPrincipal); ok {
		t.Fatal("CredentialCandidate unexpectedly implements CurrentPrincipal")
	}
	if candidate.Kind() != CandidateHumanBearer {
		t.Fatalf("Kind() = %q, want %q", candidate.Kind(), CandidateHumanBearer)
	}
	if candidate.Credential().Reveal() != "access-token" {
		t.Fatal("Credential() did not preserve the request-local token")
	}
}

func TestCurrentPrincipalCannotBeUsedAsCredentialCandidate(t *testing.T) {
	principal, err := NewCurrentHumanPrincipal(testAccountID, testSessionID, 3)
	if err != nil {
		t.Fatalf("NewCurrentHumanPrincipal() error = %v", err)
	}

	if _, ok := any(principal).(CredentialCandidate); ok {
		t.Fatal("CurrentPrincipal unexpectedly implements CredentialCandidate")
	}
	if principal.Kind() != PrincipalHuman {
		t.Fatalf("Kind() = %q, want %q", principal.Kind(), PrincipalHuman)
	}
	if principal.AccountID() != testAccountID {
		t.Fatalf("AccountID() = %q, want %q", principal.AccountID(), testAccountID)
	}
}

func TestCandidateConstructorsRejectMissingSecrets(t *testing.T) {
	tests := []struct {
		name string
		run  func() error
	}{
		{
			name: "human bearer",
			run: func() error {
				_, err := NewHumanBearerCandidate(" ")
				return err
			},
		},
		{
			name: "runtime bearer",
			run: func() error {
				_, err := NewRuntimeBearerCandidate("")
				return err
			},
		},
		{
			name: "agent credential",
			run: func() error {
				_, err := NewAgentCredentialCandidate("", "agent_")
				return err
			},
		},
		{
			name: "computer credential",
			run: func() error {
				_, err := NewComputerCredentialCandidate("", testServerID)
				return err
			},
		},
		{
			name: "computer bearer",
			run: func() error {
				_, err := NewComputerBearerCandidate("")
				return err
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := test.run(); err == nil {
				t.Fatal("constructor error = nil, want validation error")
			}
		})
	}
}

func TestComputerCandidatesAndPrincipalsStayTypeSeparated(t *testing.T) {
	credential, err := NewComputerCredentialCandidate(
		"crc_secret",
		testServerID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if credential.Kind() != CandidateComputerCredential ||
		credential.RoutePrefix() != testServerID {
		t.Fatalf("Computer credential candidate = %#v", credential)
	}
	bearer, err := NewComputerBearerCandidate("computer-token")
	if err != nil {
		t.Fatal(err)
	}
	if bearer.Kind() != CandidateComputerBearer {
		t.Fatalf("Computer bearer kind = %q", bearer.Kind())
	}
	principal, err := NewCurrentComputerPrincipal(
		testServerID,
		testComputerID,
		2,
	)
	if err != nil {
		t.Fatal(err)
	}
	if principal.Kind() != PrincipalComputer ||
		principal.ServerID() != testServerID ||
		principal.ComputerID() != testComputerID ||
		principal.CredentialVersion() != 2 {
		t.Fatalf("Computer principal = %#v", principal)
	}
	if _, ok := any(credential).(CurrentPrincipal); ok {
		t.Fatal("Computer credential candidate implements CurrentPrincipal")
	}
}

func TestSensitiveCredentialRedactsEveryFormattingVerbAndRejectsJSON(
	t *testing.T,
) {
	const secret = "arc_never-log-this-secret"
	candidate, err := NewAgentCredentialCandidate(secret, testServerID)
	if err != nil {
		t.Fatalf("NewAgentCredentialCandidate() error = %v", err)
	}
	credential := candidate.Credential()
	for _, formatted := range []string{
		fmt.Sprintf("%s", credential),
		fmt.Sprintf("%q", credential),
		fmt.Sprintf("%v", credential),
		fmt.Sprintf("%+v", credential),
		fmt.Sprintf("%#v", credential),
		fmt.Sprintf("%x", credential),
	} {
		if strings.Contains(formatted, secret) {
			t.Fatalf("formatted credential leaked secret: %q", formatted)
		}
		if !strings.Contains(formatted, "REDACTED") {
			t.Fatalf("formatted credential = %q, want redaction marker", formatted)
		}
	}
	if formatted := fmt.Sprintf("%p", &credential); strings.Contains(formatted, secret) {
		t.Fatalf("pointer formatting leaked secret: %q", formatted)
	}
	if payload, err := json.Marshal(credential); err == nil {
		t.Fatalf("Marshal() = %q, nil; want rejection", payload)
	}
}

func TestAuthenticatorReturnsOnlyValidatedPrincipal(t *testing.T) {
	principal, err := NewCurrentRuntimePrincipal(testServerID, testAgentID, 7)
	if err != nil {
		t.Fatalf("NewCurrentRuntimePrincipal() error = %v", err)
	}
	candidate, err := NewRuntimeBearerCandidate("runtime-token")
	if err != nil {
		t.Fatalf("NewRuntimeBearerCandidate() error = %v", err)
	}
	var subject Authenticator = fixedAuthenticator{principal: principal}

	got, err := subject.Authenticate(context.Background(), candidate)
	if err != nil {
		t.Fatalf("Authenticate() error = %v", err)
	}
	if got.Kind() != PrincipalRuntime {
		t.Fatalf("Kind() = %q, want %q", got.Kind(), PrincipalRuntime)
	}
}
