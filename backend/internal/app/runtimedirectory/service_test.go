package runtimedirectory

import (
	"context"
	"errors"
	"testing"
	"time"

	"chatserver/internal/apperror"
	clockport "chatserver/internal/ports/clock"
	directoryport "chatserver/internal/ports/runtimedirectory"
)

const (
	directoryServerID = "0198f9f2-fc49-7f81-9cb6-929866d41741"
	directoryAgentID  = "0198f9f2-fc4a-77f4-bd52-e20b699c21b1"
)

type fakeDirectoryRepository struct {
	snapshot       directoryport.Snapshot
	channelMembers directoryport.ChannelMembersSnapshot
	err            error
}

func (repository *fakeDirectoryRepository) Get(
	context.Context,
	string,
	string,
) (directoryport.Snapshot, error) {
	return repository.snapshot, repository.err
}

func (repository *fakeDirectoryRepository) GetChannelMembers(
	context.Context,
	string,
	string,
	string,
) (directoryport.ChannelMembersSnapshot, error) {
	return repository.channelMembers, repository.err
}

type directoryClock struct{ now time.Time }

func (clock directoryClock) Now() time.Time { return clock.now }

var _ clockport.Clock = directoryClock{}

func TestServiceReturnsShortLivedAuthorizedDirectory(t *testing.T) {
	now := time.Date(2026, 8, 2, 15, 0, 0, 0, time.UTC)
	repository := &fakeDirectoryRepository{snapshot: directoryport.Snapshot{
		Server: directoryport.Server{ID: directoryServerID, Slug: "team", Name: "研发"},
		Self: directoryport.Self{
			AgentID: directoryAgentID, MemberID: directoryAgentID,
			Handle: "builder", DisplayName: "Builder", IMUserID: "agent_builder",
		},
		Channels: []directoryport.Channel{{
			ID: "0198f9f2-fc4b-7473-99f0-046eed4cdd47", Name: "全员",
			Visibility: "public", Joined: true, IMGroupID: "community-1",
			IMState: "ready", Revision: 3,
		}},
		Members: []directoryport.Member{{
			MemberID: directoryAgentID, Kind: "agent", AgentID: stringPointer(directoryAgentID),
			Handle: "builder", DisplayName: "Builder", IMUserID: "agent_builder",
		}},
		Revision: "sha256:test-directory",
	}}
	service, err := NewService(repository, directoryClock{now: now}, 2*time.Minute)
	if err != nil {
		t.Fatal(err)
	}

	got, err := service.Get(context.Background(), directoryServerID, directoryAgentID)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if got.Server.ID != directoryServerID || got.Self.AgentID != directoryAgentID ||
		got.Revision != "sha256:test-directory" || len(got.Channels) != 1 ||
		len(got.Members) != 1 || !got.ExpiresAt.Equal(now.Add(2*time.Minute)) {
		t.Fatalf("Get() = %#v", got)
	}
}

func TestServiceRejectsInvalidIdentityAndMapsMissingDirectory(t *testing.T) {
	service, err := NewService(
		&fakeDirectoryRepository{err: directoryport.ErrNotFound},
		directoryClock{now: time.Now()},
		time.Minute,
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Get(context.Background(), "bad", directoryAgentID); err == nil {
		t.Fatal("Get() accepted invalid server ID")
	}
	_, err = service.Get(context.Background(), directoryServerID, directoryAgentID)
	var appErr *apperror.Error
	if !errors.As(err, &appErr) || appErr.Code() != "runtime_directory_not_found" {
		t.Fatalf("Get() error = %#v", err)
	}
}

func TestServiceReturnsShortLivedAuthorizedChannelMembers(t *testing.T) {
	now := time.Date(2026, 8, 2, 15, 30, 0, 0, time.UTC)
	channelID := "0198f9f2-fc4b-7473-99f0-046eed4cdd47"
	repository := &fakeDirectoryRepository{
		channelMembers: directoryport.ChannelMembersSnapshot{
			Channel: directoryport.Channel{
				ID: channelID, Name: "全员", Visibility: "public", Joined: true,
				IMGroupID: "community-1", IMState: "ready", Revision: 3,
			},
			Members: []directoryport.Member{{
				MemberID: directoryAgentID, Kind: "agent",
				AgentID: stringPointer(directoryAgentID), Handle: "builder",
				DisplayName: "Builder", IMUserID: "agent_builder",
			}},
			Revision: "sha256:test-channel-members",
		},
	}
	service, err := NewService(repository, directoryClock{now: now}, 2*time.Minute)
	if err != nil {
		t.Fatal(err)
	}

	got, err := service.GetChannelMembers(
		context.Background(), directoryServerID, directoryAgentID, channelID,
	)
	if err != nil {
		t.Fatalf("GetChannelMembers() error = %v", err)
	}
	if got.Channel.ID != channelID || len(got.Members) != 1 ||
		got.Revision != "sha256:test-channel-members" ||
		!got.ExpiresAt.Equal(now.Add(2*time.Minute)) {
		t.Fatalf("GetChannelMembers() = %#v", got)
	}
}

func stringPointer(value string) *string { return &value }
