package token

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	clockport "chatserver/internal/ports/clock"
	tokenport "chatserver/internal/ports/token"
)

const (
	jwtAccountID  = "01989c24-7540-7f12-a27b-c83243215dd1"
	jwtSessionID  = "01989c24-7540-7f12-a27b-c83243215dd2"
	jwtServerID   = "01989c24-7540-7f12-a27b-c83243215dd3"
	jwtAgentID    = "01989c24-7540-7f12-a27b-c83243215dd4"
	jwtComputerID = "01989c24-7540-7f12-a27b-c83243215dd5"
)

type mutableClock struct{ now time.Time }

func (c *mutableClock) Now() time.Time { return c.now }

var _ clockport.Clock = (*mutableClock)(nil)

func TestHMACJWTRoundTripsHumanClaims(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	clock := &mutableClock{now: now}
	signer, err := NewHMACJWT([]byte(strings.Repeat("k", 32)), clock)
	if err != nil {
		t.Fatal(err)
	}
	claims, err := tokenport.NewHumanClaims(
		jwtAccountID,
		jwtSessionID,
		7,
		now,
		now.Add(15*time.Minute),
	)
	if err != nil {
		t.Fatal(err)
	}

	raw, err := signer.Sign(context.Background(), claims)
	if err != nil {
		t.Fatalf("Sign() error = %v", err)
	}
	if parts := strings.Split(raw, "."); len(parts) != 3 {
		t.Fatalf("JWT parts = %d", len(parts))
	}
	got, err := signer.Verify(context.Background(), raw)
	if err != nil {
		t.Fatalf("Verify() error = %v", err)
	}
	if got.Kind() != tokenport.ClaimsHumanAccess ||
		got.AccountID() != jwtAccountID ||
		got.SessionID() != jwtSessionID ||
		got.Version() != 7 ||
		!got.ExpiresAt().Equal(now.Add(15*time.Minute)) {
		t.Fatalf("Verify() claims = %#v", got)
	}
}

func TestHMACJWTRejectsTamperingExpiryAndWeakKey(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	clock := &mutableClock{now: now}
	if _, err := NewHMACJWT([]byte("too-short"), clock); err == nil {
		t.Fatal("NewHMACJWT(weak key) returned nil")
	}
	signer, err := NewHMACJWT([]byte(strings.Repeat("k", 32)), clock)
	if err != nil {
		t.Fatal(err)
	}
	claims, err := tokenport.NewHumanClaims(
		jwtAccountID,
		jwtSessionID,
		1,
		now,
		now.Add(time.Minute),
	)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := signer.Sign(context.Background(), claims)
	if err != nil {
		t.Fatal(err)
	}

	tampered := raw[:len(raw)-1] + "A"
	if _, err := signer.Verify(context.Background(), tampered); !errors.Is(
		err,
		tokenport.ErrInvalidToken,
	) {
		t.Fatalf("Verify(tampered) error = %v", err)
	}

	clock.now = now.Add(2 * time.Minute)
	if _, err := signer.Verify(context.Background(), raw); !errors.Is(
		err,
		tokenport.ErrExpiredToken,
	) {
		t.Fatalf("Verify(expired) error = %v", err)
	}
}

func TestHMACJWTRoundTripsRuntimeClaimsWithoutHumanIdentity(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	clock := &mutableClock{now: now}
	signer, err := NewHMACJWT([]byte(strings.Repeat("r", 32)), clock)
	if err != nil {
		t.Fatal(err)
	}
	claims, err := tokenport.NewRuntimeClaims(
		jwtServerID,
		jwtAgentID,
		11,
		now,
		now.Add(10*time.Minute),
	)
	if err != nil {
		t.Fatal(err)
	}

	raw, err := signer.Sign(context.Background(), claims)
	if err != nil {
		t.Fatal(err)
	}
	got, err := signer.Verify(context.Background(), raw)
	if err != nil {
		t.Fatal(err)
	}
	if got.Kind() != tokenport.ClaimsRuntimeAccess ||
		got.ServerID() != jwtServerID ||
		got.AgentID() != jwtAgentID ||
		got.Version() != 11 ||
		got.AccountID() != "" ||
		got.SessionID() != "" {
		t.Fatalf("Verify(runtime) claims = %#v", got)
	}
}

func TestHMACJWTRoundTripsCompleteRuntimeLaunchFence(t *testing.T) {
	now := time.Date(2026, 8, 1, 20, 0, 0, 0, time.UTC)
	clock := &mutableClock{now: now}
	signer, err := NewHMACJWT([]byte(strings.Repeat("f", 32)), clock)
	if err != nil {
		t.Fatal(err)
	}
	launchID := "01989c24-7540-7f12-a27b-c83243215dd6"
	epoch := "01989c24-7540-7f12-a27b-c83243215dd7"
	claims, err := tokenport.NewRuntimeLaunchClaims(
		jwtServerID, jwtComputerID, jwtAgentID, launchID, epoch,
		6, 2, 4, now, now.Add(10*time.Minute),
	)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := signer.Sign(context.Background(), claims)
	if err != nil {
		t.Fatal(err)
	}
	got, err := signer.Verify(context.Background(), raw)
	if err != nil {
		t.Fatal(err)
	}
	if !got.HasLaunchFence() || got.ComputerID() != jwtComputerID ||
		got.LaunchID() != launchID || got.AssignmentEpoch() != epoch ||
		got.ConfigGeneration() != 6 || got.Version() != 2 || got.Attempt() != 4 {
		t.Fatalf("Verify(Runtime Launch) claims = %#v", got)
	}
}

func TestHMACJWTRoundTripsComputerClaimsWithoutHumanOrAgentIdentity(t *testing.T) {
	now := time.Date(2026, 8, 1, 16, 0, 0, 0, time.UTC)
	clock := &mutableClock{now: now}
	signer, err := NewHMACJWT([]byte(strings.Repeat("c", 32)), clock)
	if err != nil {
		t.Fatal(err)
	}
	claims, err := tokenport.NewComputerClaims(
		jwtServerID,
		jwtComputerID,
		4,
		now,
		now.Add(15*time.Minute),
	)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := signer.Sign(context.Background(), claims)
	if err != nil {
		t.Fatal(err)
	}
	got, err := signer.Verify(context.Background(), raw)
	if err != nil {
		t.Fatal(err)
	}
	if got.Kind() != tokenport.ClaimsComputerAccess ||
		got.ServerID() != jwtServerID ||
		got.ComputerID() != jwtComputerID ||
		got.Version() != 4 || got.AgentID() != "" ||
		got.AccountID() != "" || got.SessionID() != "" {
		t.Fatalf("Verify(computer) claims = %#v", got)
	}
}
