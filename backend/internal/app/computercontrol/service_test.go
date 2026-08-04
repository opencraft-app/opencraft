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
		!repository.usedAt.Equal(controlNow) {
		t.Fatalf("repository use = %#v at %s", repository.route, repository.usedAt)
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
