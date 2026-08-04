package authn

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"chatserver/internal/apperror"
	authnport "chatserver/internal/ports/authn"
	runtimeauthport "chatserver/internal/ports/runtimeauth"
	tokenport "chatserver/internal/ports/token"
)

type fakeRuntimeTokenSigner struct {
	claims tokenport.Claims
	err    error
	raw    string
}

func (*fakeRuntimeTokenSigner) Sign(
	context.Context,
	tokenport.Claims,
) (string, error) {
	return "", errors.New("not used")
}

func (s *fakeRuntimeTokenSigner) Verify(
	_ context.Context,
	raw string,
) (tokenport.Claims, error) {
	s.raw = raw
	return s.claims, s.err
}

func TestRuntimeBearerAuthenticatorRequiresRuntimeClaimsAndCurrentVersion(
	t *testing.T,
) {
	now := time.Date(2026, 7, 30, 19, 0, 0, 0, time.UTC)
	claims, err := tokenport.NewRuntimeLaunchClaims(
		agentCredentialServerID,
		"01989c24-7540-7f12-a27b-c83243215dd5",
		agentCredentialAgentID,
		"01989c24-7540-7f12-a27b-c83243215dd6",
		"01989c24-7540-7f12-a27b-c83243215dd7",
		3,
		7,
		2,
		now,
		now.Add(10*time.Minute),
	)
	if err != nil {
		t.Fatal(err)
	}
	tokens := &fakeRuntimeTokenSigner{claims: claims}
	repository := &fakeRuntimeCredentialRepository{launchConfirmed: true}
	authenticator, err := NewRuntimeBearerAuthenticator(tokens, repository)
	if err != nil {
		t.Fatal(err)
	}
	const raw = "test-only-runtime-access-token"
	candidate, err := authnport.NewRuntimeBearerCandidate(raw)
	if err != nil {
		t.Fatal(err)
	}

	principal, err := authenticator.Authenticate(context.Background(), candidate)
	if err != nil {
		t.Fatalf("Authenticate() error = %v", err)
	}
	got, ok := principal.(authnport.CurrentRuntimePrincipal)
	if !ok {
		t.Fatalf("principal type = %T", principal)
	}
	if got.ServerID() != agentCredentialServerID ||
		got.AgentID() != agentCredentialAgentID ||
		got.CredentialVersion() != 7 {
		t.Fatalf("principal = %#v", got)
	}
	if tokens.raw != raw {
		t.Fatal("runtime token was not passed to verifier")
	}
	wantRoute := runtimeauthport.LaunchRoute{
		ServerID:          agentCredentialServerID,
		ComputerID:        "01989c24-7540-7f12-a27b-c83243215dd5",
		AgentID:           agentCredentialAgentID,
		LaunchID:          "01989c24-7540-7f12-a27b-c83243215dd6",
		AssignmentEpoch:   "01989c24-7540-7f12-a27b-c83243215dd7",
		ConfigGeneration:  3,
		CredentialVersion: 7,
		Attempt:           2,
	}
	if len(repository.launchConfirms) != 1 ||
		repository.launchConfirms[0] != wantRoute {
		t.Fatalf("ConfirmCurrentLaunch routes = %#v", repository.launchConfirms)
	}
	if got.ComputerID() != wantRoute.ComputerID ||
		got.LaunchID() != wantRoute.LaunchID ||
		got.AssignmentEpoch() != wantRoute.AssignmentEpoch ||
		got.ConfigGeneration() != wantRoute.ConfigGeneration ||
		got.Attempt() != wantRoute.Attempt {
		t.Fatalf("principal fence = %#v", got)
	}
	if strings.Contains(fmt.Sprintf("%#v", got), raw) {
		t.Fatal("runtime principal retained raw bearer token")
	}
}

func TestRuntimeBearerAuthenticatorRejectsRuntimeTokenWithoutLaunchFence(
	t *testing.T,
) {
	now := time.Date(2026, 7, 30, 19, 0, 0, 0, time.UTC)
	claims, err := tokenport.NewRuntimeClaims(
		agentCredentialServerID,
		agentCredentialAgentID,
		7,
		now,
		now.Add(10*time.Minute),
	)
	if err != nil {
		t.Fatal(err)
	}
	repository := &fakeRuntimeCredentialRepository{confirmed: true}
	authenticator, err := NewRuntimeBearerAuthenticator(
		&fakeRuntimeTokenSigner{claims: claims},
		repository,
	)
	if err != nil {
		t.Fatal(err)
	}
	candidate, err := authnport.NewRuntimeBearerCandidate("unbound-runtime-token")
	if err != nil {
		t.Fatal(err)
	}

	_, err = authenticator.Authenticate(context.Background(), candidate)
	if got := apperror.CodeOf(err); got != "runtime_credential_invalid" {
		t.Fatalf("Authenticate() code = %q, want runtime_credential_invalid", got)
	}
	if len(repository.confirms) != 0 {
		t.Fatal("unbound Runtime token reached currentness Repository")
	}
}

func TestRuntimeBearerAuthenticatorRejectsHumanTokenBeforeRepository(
	t *testing.T,
) {
	now := time.Date(2026, 7, 30, 19, 0, 0, 0, time.UTC)
	humanClaims, err := tokenport.NewHumanClaims(
		"01989c24-7540-7f12-a27b-c83243215dd1",
		"01989c24-7540-7f12-a27b-c83243215dd2",
		1,
		now,
		now.Add(time.Hour),
	)
	if err != nil {
		t.Fatal(err)
	}
	repository := &fakeRuntimeCredentialRepository{confirmed: true}
	authenticator, err := NewRuntimeBearerAuthenticator(
		&fakeRuntimeTokenSigner{claims: humanClaims},
		repository,
	)
	if err != nil {
		t.Fatal(err)
	}
	candidate, _ := authnport.NewRuntimeBearerCandidate("human-token")

	_, err = authenticator.Authenticate(context.Background(), candidate)
	if got := apperror.CodeOf(err); got != "runtime_credential_invalid" {
		t.Fatalf("Authenticate() code = %q", got)
	}
	if len(repository.confirms) != 0 {
		t.Fatal("Human token reached Runtime currentness Repository")
	}
}

func TestRuntimeBearerAuthenticatorMapsTokenAndCurrentnessFailures(
	t *testing.T,
) {
	now := time.Date(2026, 7, 30, 19, 0, 0, 0, time.UTC)
	claims, err := tokenport.NewRuntimeLaunchClaims(
		agentCredentialServerID,
		"01989c24-7540-7f12-a27b-c83243215dd5",
		agentCredentialAgentID,
		"01989c24-7540-7f12-a27b-c83243215dd6",
		"01989c24-7540-7f12-a27b-c83243215dd7",
		3,
		7,
		2,
		now,
		now.Add(time.Hour),
	)
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name       string
		tokenErr   error
		confirmed  bool
		confirmErr error
		wantCode   string
	}{
		{
			name:     "invalid signature",
			tokenErr: tokenport.ErrInvalidToken,
			wantCode: "runtime_credential_invalid",
		},
		{
			name:     "expired",
			tokenErr: tokenport.ErrExpiredToken,
			wantCode: "runtime_credential_invalid",
		},
		{
			name:      "credential rotated",
			confirmed: false,
			wantCode:  "runtime_credential_revoked",
		},
		{
			name:       "database unavailable",
			confirmed:  true,
			confirmErr: errors.New("database unavailable"),
			wantCode:   "internal_error",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			repository := &fakeRuntimeCredentialRepository{
				launchConfirmed:  test.confirmed,
				launchConfirmErr: test.confirmErr,
			}
			authenticator, err := NewRuntimeBearerAuthenticator(
				&fakeRuntimeTokenSigner{claims: claims, err: test.tokenErr},
				repository,
			)
			if err != nil {
				t.Fatal(err)
			}
			candidate, _ := authnport.NewRuntimeBearerCandidate("runtime-token")
			_, err = authenticator.Authenticate(
				context.Background(),
				candidate,
			)
			if got := apperror.CodeOf(err); got != test.wantCode {
				t.Fatalf("Authenticate() code = %q, want %q", got, test.wantCode)
			}
		})
	}
}
