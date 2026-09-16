package authn

import (
	"context"
	"testing"

	"git.woa.com/wisp/mono2/collaboration/internal/ports/authn"
)

const gatewayHumanAccountID = "01989c24-7540-7f12-a27b-c83243215dd1"

type fakeGatewayHumanResolver struct {
	subject string
}

func (resolver *fakeGatewayHumanResolver) ResolveOrCreate(
	_ context.Context,
	subject string,
) (string, error) {
	resolver.subject = subject
	return gatewayHumanAccountID, nil
}

func TestGatewayHumanAuthenticatorUsesVerifiedLightVelaSubject(t *testing.T) {
	resolver := &fakeGatewayHumanResolver{}
	authenticator, err := NewGatewayHumanAuthenticator(
		[]byte("service-gateway-internal-token"),
		resolver,
	)
	if err != nil {
		t.Fatal(err)
	}
	candidate, err := authn.NewGatewayHumanCandidate(
		"service-gateway-internal-token",
		"usr_0123456789abcdef01234567",
	)
	if err != nil {
		t.Fatal(err)
	}

	principal, err := authenticator.Authenticate(context.Background(), candidate)
	if err != nil {
		t.Fatal(err)
	}
	human, ok := principal.(authn.CurrentHumanPrincipal)
	if !ok {
		t.Fatalf("principal = %#v", principal)
	}
	if human.AccountID() != gatewayHumanAccountID ||
		human.ExternalSubject() != "usr_0123456789abcdef01234567" ||
		human.AuthSessionID() != "" {
		t.Fatalf("human principal = %#v", human)
	}
	if resolver.subject != "usr_0123456789abcdef01234567" {
		t.Fatalf("resolver subject = %q", resolver.subject)
	}
}

func TestGatewayHumanAuthenticatorRejectsWrongInternalToken(t *testing.T) {
	authenticator, err := NewGatewayHumanAuthenticator(
		[]byte("service-gateway-internal-token"),
		&fakeGatewayHumanResolver{},
	)
	if err != nil {
		t.Fatal(err)
	}
	candidate, err := authn.NewGatewayHumanCandidate(
		"different-token",
		"usr_0123456789abcdef01234567",
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := authenticator.Authenticate(context.Background(), candidate); err == nil {
		t.Fatal("Authenticate() error = nil")
	}
}
