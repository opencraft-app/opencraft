package computercontrol

import (
	"context"
	"errors"
	"testing"
	"time"

	"chatserver/internal/apperror"
	computerauthport "chatserver/internal/ports/computerauth"
	computercontrolport "chatserver/internal/ports/computercontrol"
	tokenport "chatserver/internal/ports/token"
)

const (
	controlServerID   = "01989c24-7540-7f12-a27b-c83243215dd3"
	controlComputerID = "01989c24-7540-7f12-a27b-c83243215dd5"
	controlEpoch      = "01989c24-7540-7f12-a27b-c83243215dd6"
)

var controlNow = time.Date(2026, 8, 1, 16, 30, 0, 0, time.UTC)

type fakeControlRepository struct {
	identity computercontrolport.SessionIdentity
	err      error
	route    computerauthport.Route
	usedAt   time.Time
	leaseAt  time.Time
	leaseErr error
}

func (repository *fakeControlRepository) UseCurrentCredential(
	_ context.Context,
	route computerauthport.Route,
	usedAt time.Time,
) (computercontrolport.SessionIdentity, error) {
	repository.route = route
	repository.usedAt = usedAt
	return repository.identity, repository.err
}

func (repository *fakeControlRepository) RefreshSessionLease(
	_ context.Context,
	route computerauthport.Route,
	seenAt time.Time,
) error {
	if route != (computerauthport.Route{
		ServerID: controlServerID, ComputerID: controlComputerID, Version: 2,
	}) {
		return errors.New("unexpected Computer identity")
	}
	repository.leaseAt = seenAt
	return repository.leaseErr
}

type fakeTokenSigner struct {
	claims tokenport.Claims
	token  string
	err    error
}

func (signer *fakeTokenSigner) Sign(_ context.Context, claims tokenport.Claims) (string, error) {
	signer.claims = claims
	return signer.token, signer.err
}

func (*fakeTokenSigner) Verify(context.Context, string) (tokenport.Claims, error) {
	return tokenport.Claims{}, errors.New("not used")
}

type fixedClock struct{ now time.Time }

func (clock fixedClock) Now() time.Time { return clock.now }

func TestServiceCreatesFifteenMinuteComputerSessionWithAssignmentFence(t *testing.T) {
	repository := &fakeControlRepository{identity: computercontrolport.SessionIdentity{
		ServerID:           controlServerID,
		ComputerID:         controlComputerID,
		CredentialVersion:  2,
		AssignmentEpoch:    controlEpoch,
		AssignmentRevision: 7,
	}}
	tokens := &fakeTokenSigner{token: "signed-computer-token"}
	service, err := NewService(repository, tokens, fixedClock{now: controlNow}, Config{
		AccessTTL: 15 * time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	session, err := service.CreateSession(
		context.Background(),
		controlServerID,
		controlComputerID,
		2,
	)
	if err != nil {
		t.Fatal(err)
	}
	if session.AccessToken != "signed-computer-token" ||
		!session.ExpiresAt.Equal(controlNow.Add(15*time.Minute)) ||
		session.Computer != repository.identity {
		t.Fatalf("Session = %#v", session)
	}
	if len(session.AssignmentVersions) != 1 || session.AssignmentVersions[0] != 1 {
		t.Fatalf("AssignmentVersions = %#v", session.AssignmentVersions)
	}
	if tokens.claims.Kind() != tokenport.ClaimsComputerAccess ||
		tokens.claims.ComputerID() != controlComputerID ||
		tokens.claims.Version() != 2 {
		t.Fatalf("signed claims = %#v", tokens.claims)
	}
	if repository.route != (computerauthport.Route{ServerID: controlServerID, ComputerID: controlComputerID, Version: 2}) ||
		!repository.usedAt.Equal(controlNow) ||
		!repository.leaseAt.Equal(controlNow) {
		t.Fatalf(
			"repository use = %#v at %s, lease at %s",
			repository.route,
			repository.usedAt,
			repository.leaseAt,
		)
	}
}

func TestServiceDoesNotRefreshSessionLeaseWhenTokenSigningFails(t *testing.T) {
	repository := &fakeControlRepository{identity: computercontrolport.SessionIdentity{
		ServerID: controlServerID, ComputerID: controlComputerID,
		CredentialVersion: 2, AssignmentEpoch: controlEpoch,
		AssignmentRevision: 7,
	}}
	service, err := NewService(
		repository,
		&fakeTokenSigner{err: errors.New("signing unavailable")},
		fixedClock{now: controlNow},
		Config{AccessTTL: 15 * time.Minute},
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.CreateSession(
		context.Background(), controlServerID, controlComputerID, 2,
	); apperror.CodeOf(err) != "internal_error" {
		t.Fatalf("CreateSession() error = %v", err)
	}
	if !repository.leaseAt.IsZero() {
		t.Fatalf("session lease refreshed at %s", repository.leaseAt)
	}
}

func TestNegotiateAssignmentVersionChoosesHighestCommonVersion(t *testing.T) {
	t.Parallel()

	version, err := NegotiateAssignmentVersion([]int{1, 3, 2}, []int{3})
	if err != nil {
		t.Fatal(err)
	}
	if version != 3 {
		t.Fatalf("version = %d, want 3", version)
	}
	if _, err := NegotiateAssignmentVersion([]int{1, 2}, []int{3}); err == nil {
		t.Fatal("negotiation without a common version succeeded")
	}
}

func TestServiceRejectsRotatedComputerCredential(t *testing.T) {
	repository := &fakeControlRepository{err: computercontrolport.ErrCredentialNotCurrent}
	service, err := NewService(
		repository,
		&fakeTokenSigner{token: "must-not-be-used"},
		fixedClock{now: controlNow},
		Config{AccessTTL: 15 * time.Minute},
	)
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.CreateSession(context.Background(), controlServerID, controlComputerID, 2)
	if apperror.CodeOf(err) != "computer_credential_revoked" {
		t.Fatalf("CreateSession() error = %v", err)
	}
}
