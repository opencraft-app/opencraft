package authn

import (
	"context"
	"crypto/sha256"
	"testing"
	"time"

	"chatserver/internal/apperror"
	authnport "chatserver/internal/ports/authn"
	computerauthport "chatserver/internal/ports/computerauth"
	tokenport "chatserver/internal/ports/token"
)

const (
	computerCredentialComputerID = "01989c24-7540-7f12-a27b-c83243215dd5"
	computerCredentialSecret     = "crc_" + agentCredentialServerID + "." +
		computerCredentialComputerID + ".2." +
		"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
)

type fakeComputerCredentialRepository struct {
	credential    computerauthport.Credential
	confirmed     bool
	findRoutes    []computerauthport.Route
	confirmRoutes []computerauthport.Route
}

func (repository *fakeComputerCredentialRepository) FindCurrent(
	_ context.Context,
	route computerauthport.Route,
) (computerauthport.Credential, error) {
	repository.findRoutes = append(repository.findRoutes, route)
	return repository.credential, nil
}

func (repository *fakeComputerCredentialRepository) ConfirmCurrent(
	_ context.Context,
	route computerauthport.Route,
) (bool, error) {
	repository.confirmRoutes = append(repository.confirmRoutes, route)
	return repository.confirmed, nil
}

func TestComputerCredentialAuthenticatorUsesExactRouteAndDigest(t *testing.T) {
	digest := sha256.Sum256([]byte("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"))
	route := computerauthport.Route{
		ServerID:   agentCredentialServerID,
		ComputerID: computerCredentialComputerID,
		Version:    2,
	}
	repository := &fakeComputerCredentialRepository{
		credential: computerauthport.Credential{Route: route, SecretDigest: digest},
		confirmed:  true,
	}
	authenticator, err := NewComputerCredentialAuthenticator(repository)
	if err != nil {
		t.Fatal(err)
	}
	candidate, err := authnport.NewComputerCredentialCandidate(
		computerCredentialSecret,
		agentCredentialServerID,
	)
	if err != nil {
		t.Fatal(err)
	}
	principal, err := authenticator.Authenticate(context.Background(), candidate)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := principal.(authnport.CurrentComputerPrincipal)
	if !ok || got.ServerID() != route.ServerID ||
		got.ComputerID() != route.ComputerID || got.CredentialVersion() != 2 {
		t.Fatalf("principal = %#v", principal)
	}
	if len(repository.findRoutes) != 1 || repository.findRoutes[0] != route ||
		len(repository.confirmRoutes) != 1 || repository.confirmRoutes[0] != route {
		t.Fatalf("routes = find:%#v confirm:%#v", repository.findRoutes, repository.confirmRoutes)
	}
}

func TestComputerBearerAuthenticatorRequiresComputerClaimsAndCurrentVersion(t *testing.T) {
	now := time.Date(2026, 8, 1, 16, 0, 0, 0, time.UTC)
	claims, err := tokenport.NewComputerClaims(
		agentCredentialServerID,
		computerCredentialComputerID,
		2,
		now,
		now.Add(15*time.Minute),
	)
	if err != nil {
		t.Fatal(err)
	}
	route := computerauthport.Route{
		ServerID:   agentCredentialServerID,
		ComputerID: computerCredentialComputerID,
		Version:    2,
	}
	repository := &fakeComputerCredentialRepository{confirmed: true}
	authenticator, err := NewComputerBearerAuthenticator(
		&fakeRuntimeTokenSigner{claims: claims},
		repository,
	)
	if err != nil {
		t.Fatal(err)
	}
	candidate, _ := authnport.NewComputerBearerCandidate("computer-token")
	principal, err := authenticator.Authenticate(context.Background(), candidate)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := principal.(authnport.CurrentComputerPrincipal)
	if !ok || got.ComputerID() != computerCredentialComputerID {
		t.Fatalf("principal = %#v", principal)
	}
	if len(repository.confirmRoutes) != 1 || repository.confirmRoutes[0] != route {
		t.Fatalf("ConfirmCurrent routes = %#v", repository.confirmRoutes)
	}
}

func TestComputerAuthenticatorsRejectWrongCredentialKinds(t *testing.T) {
	repository := &fakeComputerCredentialRepository{confirmed: true}
	long, err := NewComputerCredentialAuthenticator(repository)
	if err != nil {
		t.Fatal(err)
	}
	runtimeCandidate, _ := authnport.NewRuntimeBearerCandidate("runtime")
	if _, err := long.Authenticate(context.Background(), runtimeCandidate); apperror.CodeOf(err) != "computer_credential_invalid" {
		t.Fatalf("long credential error = %v", err)
	}

	now := time.Date(2026, 8, 1, 16, 0, 0, 0, time.UTC)
	humanClaims, _ := tokenport.NewHumanClaims(
		"01989c24-7540-7f12-a27b-c83243215dd1",
		"01989c24-7540-7f12-a27b-c83243215dd2",
		1,
		now,
		now.Add(time.Hour),
	)
	short, err := NewComputerBearerAuthenticator(
		&fakeRuntimeTokenSigner{claims: humanClaims},
		repository,
	)
	if err != nil {
		t.Fatal(err)
	}
	bearerCandidate, _ := authnport.NewComputerBearerCandidate("human-token")
	if _, err := short.Authenticate(context.Background(), bearerCandidate); apperror.CodeOf(err) != "computer_credential_invalid" {
		t.Fatalf("short credential error = %v", err)
	}
}
