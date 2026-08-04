package computermanagement

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"strings"
	"testing"
	"time"

	computerport "chatserver/internal/ports/computer"
)

type fakeCredentialRepository struct {
	command         computerport.CredentialCommand
	rotationCommand computerport.CredentialRotationCommand
	result          computerport.Credential
	err             error
}

func (repository *fakeCredentialRepository) RotateCredential(
	_ context.Context,
	command computerport.CredentialRotationCommand,
) (computerport.Credential, error) {
	repository.rotationCommand = command
	result := repository.result
	if result.ID == "" {
		result = computerport.Credential{
			ID: command.CredentialID, ServerID: command.ServerID,
			ComputerID: command.ComputerID, Version: command.CurrentVersion + 1,
			ExpiresAt: command.ExpiresAt, GraceExpiresAt: &command.GraceExpiresAt,
			Created: true,
		}
	}
	return result, repository.err
}

func (repository *fakeCredentialRepository) IssueCredential(
	_ context.Context,
	command computerport.CredentialCommand,
) (computerport.Credential, error) {
	repository.command = command
	result := repository.result
	if result.ID == "" {
		result = computerport.Credential{
			ID: command.CredentialID, ServerID: command.ServerID,
			ComputerID: command.ComputerID, Version: 2,
			ExpiresAt: command.ExpiresAt, Created: true,
		}
	}
	return result, repository.err
}

func TestCredentialServiceIssuesDerivedNonPersistedSecret(t *testing.T) {
	repository := &fakeCredentialRepository{}
	service, err := NewCredentialService(
		repository,
		&fixedIDs{values: []string{"0198f4c2-7a36-7af3-a01e-0fcb31e9d84d"}},
		fixedClock{now: time.Date(2026, 8, 1, 20, 0, 0, 0, time.UTC)},
		CredentialConfig{
			DerivationKey: bytesOf(0x5a, 32),
			CredentialTTL: 365 * 24 * time.Hour,
			HandoffTTL:    time.Hour,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.Issue(
		context.Background(),
		testAccountID,
		testServerID,
		testComputerID,
		"bootstrap",
		"computer-credential-0001",
	)
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(result.Secret, ".")
	if len(parts) != 4 || parts[0] != "crc_"+testServerID ||
		parts[1] != testComputerID || parts[2] != "2" {
		t.Fatalf("credential secret = %q", result.Secret)
	}
	secretBytes, err := base64.RawURLEncoding.Strict().DecodeString(parts[3])
	if err != nil || len(secretBytes) != 32 {
		t.Fatalf("secret part = %q, %v", parts[3], err)
	}
	digest := sha256.Sum256([]byte(parts[3]))
	if repository.command.SecretHash != digest ||
		repository.command.Mode != "bootstrap" ||
		repository.command.HandoffExpiresAt.Sub(repository.command.CreatedAt) != time.Hour ||
		result.Version != 2 || !result.ExpiresAt.Equal(repository.command.ExpiresAt) {
		t.Fatalf("command=%#v result=%#v", repository.command, result)
	}
}

func TestCredentialServiceRotatesCurrentVersionWithFixedGrace(t *testing.T) {
	repository := &fakeCredentialRepository{}
	now := time.Date(2026, 8, 1, 20, 0, 0, 0, time.UTC)
	service, err := NewCredentialService(
		repository,
		&fixedIDs{values: []string{"0198f4c2-7a36-7af3-a01e-0fcb31e9d84e"}},
		fixedClock{now: now},
		CredentialConfig{
			DerivationKey: bytesOf(0x5a, 32),
			CredentialTTL: 365 * 24 * time.Hour,
			HandoffTTL:    time.Hour,
			RotationGrace: time.Hour,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.Rotate(
		context.Background(),
		testServerID,
		testComputerID,
		4,
		"computer-credential-rotate-0001",
	)
	if err != nil {
		t.Fatal(err)
	}
	if repository.rotationCommand.CurrentVersion != 4 ||
		repository.rotationCommand.GraceExpiresAt.Sub(now) != time.Hour ||
		repository.rotationCommand.HandoffExpiresAt.Sub(now) != time.Hour ||
		result.Version != 5 || result.GraceExpiresAt == nil ||
		!result.GraceExpiresAt.Equal(now.Add(time.Hour)) ||
		!strings.Contains(result.Secret, ".5.") {
		t.Fatalf(
			"rotation command=%#v result=%#v",
			repository.rotationCommand,
			result,
		)
	}
}

func bytesOf(value byte, count int) []byte {
	result := make([]byte, count)
	for index := range result {
		result[index] = value
	}
	return result
}
