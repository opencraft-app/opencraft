package authn

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"
	"testing"

	"chatserver/internal/apperror"
	authnport "chatserver/internal/ports/authn"
	runtimeauthport "chatserver/internal/ports/runtimeauth"
)

const (
	agentCredentialServerID = "01989c24-7540-7f12-a27b-c83243215dd3"
	agentCredentialAgentID  = "01989c24-7540-7f12-a27b-c83243215dd4"
	agentCredentialSecret   = "arc_" + agentCredentialServerID + "." +
		agentCredentialAgentID + ".7." +
		"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
)

type fakeRuntimeCredentialRepository struct {
	credential       runtimeauthport.Credential
	findErr          error
	confirmed        bool
	confirmErr       error
	findRoutes       []runtimeauthport.Route
	confirms         []runtimeauthport.Route
	launchConfirmed  bool
	launchConfirmErr error
	launchConfirms   []runtimeauthport.LaunchRoute
}

func (r *fakeRuntimeCredentialRepository) ConfirmCurrentLaunch(
	_ context.Context,
	route runtimeauthport.LaunchRoute,
) (bool, error) {
	r.launchConfirms = append(r.launchConfirms, route)
	return r.launchConfirmed, r.launchConfirmErr
}

func (r *fakeRuntimeCredentialRepository) FindCurrent(
	_ context.Context,
	route runtimeauthport.Route,
) (runtimeauthport.Credential, error) {
	r.findRoutes = append(r.findRoutes, route)
	return r.credential, r.findErr
}

func (r *fakeRuntimeCredentialRepository) ConfirmCurrent(
	_ context.Context,
	route runtimeauthport.Route,
) (bool, error) {
	r.confirms = append(r.confirms, route)
	return r.confirmed, r.confirmErr
}

func TestAgentCredentialAuthenticatorUsesExactRouteAndVerifiesDigest(
	t *testing.T,
) {
	digest := sha256.Sum256([]byte(agentCredentialSecret))
	repository := &fakeRuntimeCredentialRepository{
		credential: runtimeauthport.Credential{
			Route: runtimeauthport.Route{
				ServerID: agentCredentialServerID,
				AgentID:  agentCredentialAgentID,
				Version:  7,
			},
			SecretDigest: digest,
		},
		confirmed: true,
	}
	authenticator, err := NewAgentCredentialAuthenticator(repository)
	if err != nil {
		t.Fatal(err)
	}
	candidate, err := authnport.NewAgentCredentialCandidate(
		agentCredentialSecret,
		agentCredentialServerID,
	)
	if err != nil {
		t.Fatal(err)
	}

	principal, err := authenticator.Authenticate(context.Background(), candidate)
	if err != nil {
		t.Fatalf("Authenticate() error = %v", err)
	}
	got, ok := principal.(authnport.CurrentAgentCredentialPrincipal)
	if !ok {
		t.Fatalf("principal type = %T", principal)
	}
	if got.ServerID() != agentCredentialServerID ||
		got.AgentID() != agentCredentialAgentID ||
		got.CredentialVersion() != 7 {
		t.Fatalf("principal = %#v", got)
	}
	wantRoute := runtimeauthport.Route{
		ServerID: agentCredentialServerID,
		AgentID:  agentCredentialAgentID,
		Version:  7,
	}
	if len(repository.findRoutes) != 1 ||
		repository.findRoutes[0] != wantRoute {
		t.Fatalf("FindCurrent routes = %#v", repository.findRoutes)
	}
	if len(repository.confirms) != 1 ||
		repository.confirms[0] != wantRoute {
		t.Fatalf("ConfirmCurrent routes = %#v", repository.confirms)
	}
	if strings.Contains(fmt.Sprintf("%#v", got), agentCredentialSecret) {
		t.Fatal("current principal retained plaintext credential")
	}
}

func TestAgentCredentialAuthenticatorRejectsRouteHintAsAuthorization(
	t *testing.T,
) {
	repository := &fakeRuntimeCredentialRepository{confirmed: true}
	authenticator, err := NewAgentCredentialAuthenticator(repository)
	if err != nil {
		t.Fatal(err)
	}
	candidate, err := authnport.NewAgentCredentialCandidate(
		agentCredentialSecret,
		"01989c24-7540-7f12-a27b-c83243215dde",
	)
	if err != nil {
		t.Fatal(err)
	}

	_, err = authenticator.Authenticate(context.Background(), candidate)
	if got := apperror.CodeOf(err); got != "runtime_credential_invalid" {
		t.Fatalf("Authenticate() code = %q", got)
	}
	if len(repository.findRoutes) != 0 {
		t.Fatalf("repository was queried with mismatched route hint: %#v", repository.findRoutes)
	}
}

func TestAgentCredentialAuthenticatorRejectsWrongSecretBeforeConfirmation(
	t *testing.T,
) {
	digest := sha256.Sum256([]byte(agentCredentialSecret))
	repository := &fakeRuntimeCredentialRepository{
		credential: runtimeauthport.Credential{
			Route: runtimeauthport.Route{
				ServerID: agentCredentialServerID,
				AgentID:  agentCredentialAgentID,
				Version:  7,
			},
			SecretDigest: digest,
		},
		confirmed: true,
	}
	authenticator, err := NewAgentCredentialAuthenticator(repository)
	if err != nil {
		t.Fatal(err)
	}
	wrongSecret := strings.TrimSuffix(agentCredentialSecret, "A") + "B"
	candidate, err := authnport.NewAgentCredentialCandidate(
		wrongSecret,
		agentCredentialServerID,
	)
	if err != nil {
		t.Fatal(err)
	}

	_, err = authenticator.Authenticate(context.Background(), candidate)
	if got := apperror.CodeOf(err); got != "runtime_credential_invalid" {
		t.Fatalf("Authenticate() code = %q", got)
	}
	if len(repository.confirms) != 0 {
		t.Fatal("wrong digest reached currentness confirmation")
	}
}

func TestAgentCredentialAuthenticatorRejectsRevokedOrRotatedCredential(
	t *testing.T,
) {
	digest := sha256.Sum256([]byte(agentCredentialSecret))
	tests := []struct {
		name       string
		findErr    error
		confirmed  bool
		confirmErr error
	}{
		{
			name:    "revoked or stopped before lookup",
			findErr: runtimeauthport.ErrCredentialNotCurrent,
		},
		{
			name:      "rotated after digest verification",
			confirmed: false,
		},
		{
			name:       "repository failure",
			confirmed:  true,
			confirmErr: errors.New("database unavailable"),
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			repository := &fakeRuntimeCredentialRepository{
				credential: runtimeauthport.Credential{
					Route: runtimeauthport.Route{
						ServerID: agentCredentialServerID,
						AgentID:  agentCredentialAgentID,
						Version:  7,
					},
					SecretDigest: digest,
				},
				findErr:    test.findErr,
				confirmed:  test.confirmed,
				confirmErr: test.confirmErr,
			}
			authenticator, err := NewAgentCredentialAuthenticator(repository)
			if err != nil {
				t.Fatal(err)
			}
			candidate, err := authnport.NewAgentCredentialCandidate(
				agentCredentialSecret,
				agentCredentialServerID,
			)
			if err != nil {
				t.Fatal(err)
			}

			_, err = authenticator.Authenticate(context.Background(), candidate)
			if test.confirmErr != nil {
				if got := apperror.CodeOf(err); got != "internal_error" {
					t.Fatalf("Authenticate() code = %q", got)
				}
				return
			}
			if got := apperror.CodeOf(err); got != "runtime_credential_invalid" {
				t.Fatalf("Authenticate() code = %q", got)
			}
		})
	}
}

func TestAgentCredentialAuthenticatorRejectsMalformedCredential(t *testing.T) {
	repository := &fakeRuntimeCredentialRepository{confirmed: true}
	authenticator, err := NewAgentCredentialAuthenticator(repository)
	if err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{
		"arc_invalid",
		"arc_" + agentCredentialServerID + "." +
			agentCredentialAgentID + ".0." +
			"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"arc_" + agentCredentialServerID + "." +
			agentCredentialAgentID + ".7.too-short",
	} {
		candidate, err := authnport.NewAgentCredentialCandidate(
			raw,
			agentCredentialServerID,
		)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := authenticator.Authenticate(
			context.Background(),
			candidate,
		); apperror.CodeOf(err) != "runtime_credential_invalid" {
			t.Fatalf("Authenticate(%q) error = %v", raw, err)
		}
	}
	if len(repository.findRoutes) != 0 {
		t.Fatalf("malformed credentials queried repository: %#v", repository.findRoutes)
	}
}
