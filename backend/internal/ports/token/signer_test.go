package token

import (
	"context"
	"testing"
	"time"
)

const (
	tokenTestAccountID  = "01989c24-7540-7f12-a27b-c83243215dd1"
	tokenTestSessionID  = "01989c24-7540-7f12-a27b-c83243215dd2"
	tokenTestServerID   = "01989c24-7540-7f12-a27b-c83243215dd3"
	tokenTestAgentID    = "01989c24-7540-7f12-a27b-c83243215dd4"
	tokenTestComputerID = "01989c24-7540-7f12-a27b-c83243215dd5"
)

type fixedSigner struct {
	token  string
	claims Claims
}

func (s fixedSigner) Sign(_ context.Context, _ Claims) (string, error) {
	return s.token, nil
}

func (s fixedSigner) Verify(_ context.Context, _ string) (Claims, error) {
	return s.claims, nil
}

func TestClaimsRequireValidLifetimeAndIdentity(t *testing.T) {
	now := time.Date(2026, time.July, 30, 12, 0, 0, 0, time.UTC)

	if _, err := NewHumanClaims(
		"not-a-uuid",
		tokenTestSessionID,
		1,
		now,
		now.Add(time.Hour),
	); err == nil {
		t.Fatal("NewHumanClaims() error = nil for malformed account ID")
	}
	if _, err := NewRuntimeClaims(
		tokenTestServerID,
		tokenTestAgentID,
		1,
		now,
		now,
	); err == nil {
		t.Fatal("NewRuntimeClaims() error = nil for non-positive lifetime")
	}
	if _, err := NewRuntimeClaims(
		tokenTestServerID,
		tokenTestAgentID,
		0,
		now,
		now.Add(time.Hour),
	); err == nil {
		t.Fatal("NewRuntimeClaims() error = nil for zero credential version")
	}
}

func TestSignerCanBeReplacedByDeterministicFake(t *testing.T) {
	now := time.Date(2026, time.July, 30, 12, 0, 0, 0, time.UTC)
	claims, err := NewHumanClaims(
		tokenTestAccountID,
		tokenTestSessionID,
		4,
		now,
		now.Add(time.Hour),
	)
	if err != nil {
		t.Fatalf("NewHumanClaims() error = %v", err)
	}
	var subject Signer = fixedSigner{token: "signed-token", claims: claims}

	signed, err := subject.Sign(context.Background(), claims)
	if err != nil {
		t.Fatalf("Sign() error = %v", err)
	}
	if signed != "signed-token" {
		t.Fatalf("Sign() = %q, want signed-token", signed)
	}

	verified, err := subject.Verify(context.Background(), signed)
	if err != nil {
		t.Fatalf("Verify() error = %v", err)
	}
	if verified.Kind() != ClaimsHumanAccess {
		t.Fatalf("Kind() = %q, want %q", verified.Kind(), ClaimsHumanAccess)
	}
	if verified.AccountID() != tokenTestAccountID {
		t.Fatalf("AccountID() = %q, want %q", verified.AccountID(), tokenTestAccountID)
	}
}

func TestComputerClaimsCarryOnlyComputerRouteAndCredentialVersion(t *testing.T) {
	now := time.Date(2026, time.August, 1, 16, 0, 0, 0, time.UTC)
	claims, err := NewComputerClaims(
		tokenTestServerID,
		tokenTestComputerID,
		3,
		now,
		now.Add(15*time.Minute),
	)
	if err != nil {
		t.Fatalf("NewComputerClaims() error = %v", err)
	}
	if claims.Kind() != ClaimsComputerAccess ||
		claims.ServerID() != tokenTestServerID ||
		claims.ComputerID() != tokenTestComputerID ||
		claims.Version() != 3 {
		t.Fatalf("Computer claims = %#v", claims)
	}
	if claims.AgentID() != "" || claims.AccountID() != "" {
		t.Fatal("Computer claims leaked unrelated identity")
	}
}

func TestRuntimeLaunchClaimsCarryCompleteFence(t *testing.T) {
	now := time.Date(2026, time.August, 1, 20, 0, 0, 0, time.UTC)
	claims, err := NewRuntimeLaunchClaims(
		tokenTestServerID,
		tokenTestComputerID,
		tokenTestAgentID,
		"01989c24-7540-7f12-a27b-c83243215dd6",
		"01989c24-7540-7f12-a27b-c83243215dd7",
		6,
		2,
		4,
		now,
		now.Add(15*time.Minute),
	)
	if err != nil {
		t.Fatal(err)
	}
	if !claims.HasLaunchFence() || claims.ComputerID() != tokenTestComputerID ||
		claims.LaunchID() != "01989c24-7540-7f12-a27b-c83243215dd6" ||
		claims.AssignmentEpoch() != "01989c24-7540-7f12-a27b-c83243215dd7" ||
		claims.ConfigGeneration() != 6 || claims.Version() != 2 || claims.Attempt() != 4 {
		t.Fatalf("Runtime Launch claims = %#v", claims)
	}
}
