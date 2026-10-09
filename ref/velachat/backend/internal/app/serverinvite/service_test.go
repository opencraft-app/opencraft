package serverinvite

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"strings"
	"testing"
	"time"

	inviteport "chatserver/internal/ports/serverinvite"

	"github.com/google/uuid"
)

const (
	inviteAccountID = "0198f4c2-7a30-7c91-a6d2-7d76f9188c37"
	inviteServerID  = "0198f4c2-7a31-7c91-a6d2-7d76f9188c38"
	inviteID        = "0198f4c2-7a36-7e45-913c-6baf30401a82"
	inviteMemberID  = "0198f4c2-7a37-7e45-913c-6baf30401a83"
	inviteOperation = "0198f4c2-7a38-7e45-913c-6baf30401a84"
)

type fakeInviteRepository struct {
	command       inviteport.CreateCommand
	acceptCommand inviteport.AcceptCommand
	values        []inviteport.Invite
}

func (repository *fakeInviteRepository) Create(
	_ context.Context,
	command inviteport.CreateCommand,
) (inviteport.Invite, error) {
	repository.command = command
	return inviteport.Invite{
		ID: command.InviteID, ServerID: command.ServerID,
		Role: command.Role, MaxUses: command.MaxUses,
		ExpiresAt: command.ExpiresAt, Revision: 1,
	}, nil
}

func (repository *fakeInviteRepository) List(
	context.Context,
	string,
	string,
) ([]inviteport.Invite, error) {
	return repository.values, nil
}

func (repository *fakeInviteRepository) Revoke(
	context.Context,
	inviteport.RevokeCommand,
) error {
	return nil
}

func (repository *fakeInviteRepository) Accept(
	_ context.Context,
	command inviteport.AcceptCommand,
) (inviteport.AcceptResult, error) {
	repository.acceptCommand = command
	return inviteport.AcceptResult{
		MemberID:    command.MemberID,
		ServerID:    command.ServerID,
		OperationID: command.OperationID,
		CreatedAt:   command.AcceptedAt,
	}, nil
}

type fixedInviteIDs struct{ value string }

func (ids fixedInviteIDs) New() (string, error) { return ids.value, nil }

type sequenceInviteIDs struct {
	values []string
	index  int
}

func (ids *sequenceInviteIDs) New() (string, error) {
	value := ids.values[ids.index]
	ids.index++
	return value, nil
}

type fixedInviteClock struct{ now time.Time }

func (clock fixedInviteClock) Now() time.Time { return clock.now }

func TestServiceCreatesOneTimeInviteWithoutPersistingRawToken(t *testing.T) {
	now := time.Date(2026, 7, 30, 23, 0, 0, 0, time.UTC)
	repository := &fakeInviteRepository{}
	service, err := NewService(
		repository,
		fixedInviteIDs{value: inviteID},
		fixedInviteClock{now: now},
		strings.NewReader(strings.Repeat("r", 32)),
	)
	if err != nil {
		t.Fatal(err)
	}

	result, err := service.Create(context.Background(), CreateCommand{
		AccountID: inviteAccountID,
		ServerID:  inviteServerID,
		Role:      "member",
		MaxUses:   3,
		ExpiresAt: now.Add(24 * time.Hour),
	})

	if err != nil {
		t.Fatal(err)
	}
	token := result.Token.Reveal()
	if !strings.HasPrefix(token, "rfi_") || len(token) < 40 {
		t.Fatalf("token format = %q", token)
	}
	serverID, err := serverIDFromToken(token)
	if err != nil || serverID != inviteServerID {
		t.Fatalf("serverIDFromToken() = (%q, %v)", serverID, err)
	}
	expectedHash := sha256.Sum256([]byte(token))
	if repository.command.TokenHash != expectedHash {
		t.Fatal("repository did not receive the token hash")
	}
	if result.Invite.ID != inviteID ||
		repository.command.InviteID != inviteID ||
		repository.command.CreatedAt != now {
		t.Fatalf("result/command = (%#v, %#v)", result, repository.command)
	}
	if strings.Contains(
		strings.ToLower(repository.command.Role),
		token,
	) {
		t.Fatal("raw token leaked into repository command")
	}
}

func TestServiceAcceptsRoutableInviteWithStableIdempotency(t *testing.T) {
	now := time.Date(2026, 7, 30, 23, 0, 0, 0, time.UTC)
	repository := &fakeInviteRepository{}
	ids := &sequenceInviteIDs{
		values: []string{inviteID, inviteMemberID, inviteOperation},
	}
	service, err := NewService(
		repository,
		ids,
		fixedInviteClock{now: now},
		strings.NewReader(strings.Repeat("r", 32)),
	)
	if err != nil {
		t.Fatal(err)
	}
	created, err := service.Create(context.Background(), CreateCommand{
		AccountID: inviteAccountID,
		ServerID:  inviteServerID,
		Role:      "member",
		MaxUses:   3,
		ExpiresAt: now.Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	token := created.Token.Reveal()
	result, err := service.Accept(context.Background(), AcceptCommand{
		AccountID:      inviteAccountID,
		IdempotencyKey: "invite-accept-0001",
		Token:          token,
	})
	if err != nil {
		t.Fatal(err)
	}
	command := repository.acceptCommand
	if result.MemberID != inviteMemberID ||
		result.OperationID != inviteOperation ||
		command.ServerID != inviteServerID ||
		command.MemberID != inviteMemberID ||
		command.OperationID != inviteOperation ||
		command.IdempotencyKey != "invite-accept-0001" ||
		command.TokenHash != sha256.Sum256([]byte(token)) ||
		command.RequestHash != sha256.Sum256([]byte(token)) ||
		command.Handle == "" ||
		!command.AcceptedAt.Equal(now) {
		t.Fatalf("Accept() = (%#v, %#v)", result, command)
	}
}

func TestServiceAcceptsJoinLinkWithExistingMembershipSemantics(t *testing.T) {
	now := time.Date(2026, 7, 30, 23, 0, 0, 0, time.UTC)
	repository := &fakeInviteRepository{}
	ids := &sequenceInviteIDs{
		values: []string{inviteMemberID, inviteOperation},
	}
	service, err := NewService(
		repository,
		ids,
		fixedInviteClock{now: now},
		strings.NewReader(strings.Repeat("r", 32)),
	)
	if err != nil {
		t.Fatal(err)
	}
	tokenPayload := make([]byte, 48)
	serverUUID, err := uuid.Parse(inviteServerID)
	if err != nil {
		t.Fatal(err)
	}
	copy(tokenPayload, serverUUID[:])
	token := "rfi_" + base64.RawURLEncoding.EncodeToString(tokenPayload)

	_, err = service.AcceptJoinLink(context.Background(), AcceptCommand{
		AccountID:      inviteAccountID,
		IdempotencyKey: "join-link-accept-0001",
		Token:          token,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !repository.acceptCommand.AllowExistingMember {
		t.Fatal("AcceptJoinLink() did not enable existing-member semantics")
	}
}

func TestServiceRejectsUnsafeInviteLimits(t *testing.T) {
	now := time.Date(2026, 7, 30, 23, 0, 0, 0, time.UTC)
	service, err := NewService(
		&fakeInviteRepository{},
		fixedInviteIDs{value: inviteID},
		fixedInviteClock{now: now},
		strings.NewReader(strings.Repeat("r", 32)),
	)
	if err != nil {
		t.Fatal(err)
	}
	tests := []CreateCommand{
		{
			AccountID: inviteAccountID, ServerID: inviteServerID,
			Role: "owner", MaxUses: 1, ExpiresAt: now.Add(time.Hour),
		},
		{
			AccountID: inviteAccountID, ServerID: inviteServerID,
			Role: "member", MaxUses: 0, ExpiresAt: now.Add(time.Hour),
		},
		{
			AccountID: inviteAccountID, ServerID: inviteServerID,
			Role: "member", MaxUses: 1, ExpiresAt: now.Add(time.Minute),
		},
		{
			AccountID: inviteAccountID, ServerID: inviteServerID,
			Role: "member", MaxUses: 1, ExpiresAt: now.Add(31 * 24 * time.Hour),
		},
	}
	for _, command := range tests {
		if _, err := service.Create(
			context.Background(),
			command,
		); err == nil {
			t.Fatalf("Create(%#v) error = nil", command)
		}
	}
}

func TestInviteTokenCannotBeFormattedOrJSONEncoded(t *testing.T) {
	token := InviteToken("rfi_secret")
	if got := strings.TrimSpace(token.String()); got != "[REDACTED]" {
		t.Fatalf("String() = %q", got)
	}
	if _, err := token.MarshalJSON(); err == nil {
		t.Fatal("MarshalJSON() error = nil")
	}
}
