package channelmembership

import (
	"context"
	"testing"
	"time"

	channelmembershipport "chatserver/internal/ports/channelmembership"
)

const (
	channelMembershipAccount = "0198f4c2-7a30-7c91-a6d2-7d76f9188c37"
	channelMembershipServer  = "0198f4c2-7a31-7c91-a6d2-7d76f9188c38"
	channelMembershipChannel = "0198f4c2-7a35-7c91-a6d2-7d76f9188c40"
	channelMembershipMember  = "0198f4c2-7a37-7e45-913c-6baf30401a83"
	channelMembershipOp      = "0198f4c2-7a38-7e45-913c-6baf30401a84"
)

type channelMembershipRepository struct {
	command channelmembershipport.Command
}

func (repository *channelMembershipRepository) Change(
	_ context.Context,
	command channelmembershipport.Command,
) (channelmembershipport.Result, error) {
	repository.command = command
	return channelmembershipport.Result{
		ChannelMemberID: command.MemberID,
		OperationID:     command.OperationID, CreatedAt: command.ChangedAt,
	}, nil
}

type channelMembershipIDs struct{ value string }

func (ids channelMembershipIDs) New() (string, error) { return ids.value, nil }

type channelMembershipClock struct{ now time.Time }

func (clock channelMembershipClock) Now() time.Time { return clock.now }

func TestServiceBuildsAddAndRemoveCommands(t *testing.T) {
	now := time.Date(2026, 7, 31, 4, 0, 0, 0, time.UTC)
	repository := &channelMembershipRepository{}
	service, err := NewService(
		repository,
		channelMembershipIDs{value: channelMembershipOp},
		channelMembershipClock{now: now},
	)
	if err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"ensure", "remove"} {
		_, err := service.Change(context.Background(), Command{
			AccountID:      channelMembershipAccount,
			ServerID:       channelMembershipServer,
			ChannelID:      channelMembershipChannel,
			MemberID:       channelMembershipMember,
			IdempotencyKey: "channel-member-0001",
			Action:         action,
		})
		if err != nil ||
			repository.command.Action != action ||
			repository.command.RequestHash == [32]byte{} {
			t.Fatalf("Change(%s) = (%#v, %v)", action, repository.command, err)
		}
	}
}
