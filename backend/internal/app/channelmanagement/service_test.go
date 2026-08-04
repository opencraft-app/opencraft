package channelmanagement

import (
	"context"
	"testing"
	"time"

	"chatserver/internal/apperror"
	channelport "chatserver/internal/ports/channel"
)

const (
	channelAccountID   = "0198f4c2-7a30-7c91-a6d2-7d76f9188c37"
	channelServerID    = "0198f4c2-7a31-7c91-a6d2-7d76f9188c38"
	channelID          = "0198f4c2-7a36-7e45-913c-6baf30401a82"
	channelOperationID = "0198f4c2-7a37-7e45-913c-6baf30401a83"
	channelMemberID    = "0198f4c2-7a38-7e45-913c-6baf30401a84"
	channelMemberOpID  = "0198f4c2-7a39-7e45-913c-6baf30401a85"
	channelGroupID     = "@TGS#_C_5ODDSBF3PNVZH25YMT3OMJ4ZSF"
	channelTopicID     = channelGroupID + "@TOPIC#_T_46HDVNIIYDGRIRBGXZTJ7KMFLP"
)

type fakeChannelRepository struct {
	serverContext channelport.ServerContext
	command       channelport.CreateCommand
	updateCommand channelport.UpdateCommand
	channels      []channelport.Channel
}

func (repository *fakeChannelRepository) GetServerContext(
	context.Context,
	string,
	string,
) (channelport.ServerContext, error) {
	return repository.serverContext, nil
}

func (repository *fakeChannelRepository) Create(
	_ context.Context,
	command channelport.CreateCommand,
) (channelport.CreateResult, error) {
	repository.command = command
	topicID := command.Channel.IMTopicID
	return channelport.CreateResult{
		Channel: channelport.Channel{
			ID: command.Channel.ID, ServerID: command.ServerID,
			Name: command.Channel.Name, Description: command.Channel.Description,
			Visibility: command.Channel.Visibility,
			IMGroupID:  command.Channel.IMGroupID, IMTopicID: &topicID,
			IMState: "provisioning", Revision: 1,
		},
		Operations: []channelport.Operation{
			{ID: command.OperationID, ServerID: command.ServerID,
				Service: "im", Kind: "im.topic.ensure", State: "pending",
				CreatedAt: command.CreatedAt},
			{ID: command.InitialMembershipOperationID, ServerID: command.ServerID,
				Service: "im", Kind: "im.membership.ensure", State: "pending",
				CreatedAt: command.CreatedAt},
		},
	}, nil
}

func (repository *fakeChannelRepository) List(
	context.Context,
	string,
	string,
) ([]channelport.Channel, error) {
	return repository.channels, nil
}

func (repository *fakeChannelRepository) Get(
	context.Context,
	string,
	string,
	string,
) (channelport.Channel, error) {
	return repository.channels[0], nil
}

func (repository *fakeChannelRepository) Update(
	_ context.Context,
	command channelport.UpdateCommand,
) (channelport.Channel, error) {
	repository.updateCommand = command
	value := repository.channels[0]
	if command.NameSet {
		value.Name = command.Name
	}
	if command.DescriptionSet {
		value.Description = command.Description
	}
	value.Revision++
	return value, nil
}

type fakeTopicDeriver struct{}

func (fakeTopicDeriver) Topic(
	serverID string,
	gotChannelID string,
	groupID string,
) (string, string, error) {
	if serverID != channelServerID || gotChannelID != channelID ||
		groupID != channelGroupID {
		panic("unexpected topic input")
	}
	return channelTopicID, "C-46HDVNIIYDGRIRBGXZTJ", nil
}

type fixedChannelIDs struct {
	values []string
	index  int
}

func (ids *fixedChannelIDs) New() (string, error) {
	value := ids.values[ids.index]
	ids.index++
	return value, nil
}

type fixedChannelClock struct{ now time.Time }

func (clock fixedChannelClock) Now() time.Time { return clock.now }

func TestServiceCreatesProvisioningTopicChannel(t *testing.T) {
	now := time.Date(2026, 7, 30, 23, 0, 0, 0, time.UTC)
	repository := &fakeChannelRepository{
		serverContext: channelport.ServerContext{
			IMGroupID: channelGroupID,
			IMState:   "ready",
			Role:      "owner",
		},
	}
	service, err := NewService(
		repository,
		fakeTopicDeriver{},
		&fixedChannelIDs{
			values: []string{
				channelID, channelOperationID, channelMemberID, channelMemberOpID,
			},
		},
		fixedChannelClock{now: now},
	)
	if err != nil {
		t.Fatal(err)
	}
	description := "项目讨论"
	result, err := service.Create(context.Background(), CreateCommand{
		AccountID: channelAccountID, ServerID: channelServerID,
		IdempotencyKey: "channel-create-0001",
		Name:           "研发", Description: &description, Visibility: "private",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Channel.ID != channelID ||
		result.Channel.IMTopicID == nil ||
		*result.Channel.IMTopicID != channelTopicID ||
		len(result.Operations) != 2 ||
		result.Operations[0].ID != channelOperationID ||
		result.Operations[1].ID != channelMemberOpID ||
		repository.command.InitialChannelMemberID != channelMemberID ||
		repository.command.InitialMembershipOperationID != channelMemberOpID ||
		repository.command.Channel.IMTopicName !=
			"C-46HDVNIIYDGRIRBGXZTJ" {
		t.Fatalf("result/command = (%#v, %#v)", result, repository.command)
	}
}

func TestServiceListsAndGetsChannels(t *testing.T) {
	repository := &fakeChannelRepository{
		channels: []channelport.Channel{{
			ID: channelID, ServerID: channelServerID, Name: "全员",
			Visibility: "public", IMGroupID: channelGroupID,
			IMState: "ready", Revision: 2,
		}},
	}
	service, err := NewService(
		repository,
		fakeTopicDeriver{},
		&fixedChannelIDs{},
		fixedChannelClock{now: time.Now()},
	)
	if err != nil {
		t.Fatal(err)
	}
	values, err := service.List(
		context.Background(),
		channelAccountID,
		channelServerID,
	)
	if err != nil || len(values) != 1 {
		t.Fatalf("List() = (%#v, %v)", values, err)
	}
	value, err := service.Get(
		context.Background(),
		channelAccountID,
		channelServerID,
		channelID,
	)
	if err != nil || value.ID != channelID {
		t.Fatalf("Get() = (%#v, %v)", value, err)
	}
}

func TestServiceUpdatesChannelMetadataWithRevisionAndIdempotency(t *testing.T) {
	description := "旧描述"
	repository := &fakeChannelRepository{
		channels: []channelport.Channel{{
			ID: channelID, ServerID: channelServerID, Name: "研发",
			Description: &description, Visibility: "private",
			IMGroupID: channelGroupID, IMState: "ready", Revision: 2,
		}},
	}
	now := time.Date(2026, 7, 31, 14, 0, 0, 0, time.UTC)
	service, err := NewService(
		repository,
		fakeTopicDeriver{},
		&fixedChannelIDs{},
		fixedChannelClock{now: now},
	)
	if err != nil {
		t.Fatal(err)
	}
	name := "产品研发"
	nextDescription := "新的协作说明"
	value, err := service.Update(context.Background(), UpdateCommand{
		AccountID: channelAccountID, ServerID: channelServerID,
		ChannelID: channelID, Revision: 2,
		IdempotencyKey: "channel-update-0001",
		Name:           &name, DescriptionSet: true, Description: &nextDescription,
	})
	if err != nil {
		t.Fatal(err)
	}
	if value.Name != name || value.Revision != 3 ||
		repository.updateCommand.Name != name ||
		repository.updateCommand.Description == nil ||
		*repository.updateCommand.Description != nextDescription ||
		repository.updateCommand.UpdatedAt != now {
		t.Fatalf(
			"Update() = %#v command=%#v",
			value,
			repository.updateCommand,
		)
	}
}

func TestServiceRejectsCommunityRootMetadataUpdate(t *testing.T) {
	systemKey := "all"
	repository := &fakeChannelRepository{
		channels: []channelport.Channel{{
			ID: channelID, ServerID: channelServerID, Name: "全员",
			Visibility: "public", SystemKey: &systemKey,
			IMGroupID: channelGroupID, IMState: "ready", Revision: 2,
		}},
	}
	service, err := NewService(
		repository,
		fakeTopicDeriver{},
		&fixedChannelIDs{},
		fixedChannelClock{now: time.Now()},
	)
	if err != nil {
		t.Fatal(err)
	}
	name := "新的全员名称"
	_, err = service.Update(context.Background(), UpdateCommand{
		AccountID: channelAccountID, ServerID: channelServerID,
		ChannelID: channelID, Revision: 2,
		IdempotencyKey: "channel-root-update-0001", Name: &name,
	})
	if got := apperror.CodeOf(err); got != "system_channel_immutable" {
		t.Fatalf("Update(root) code = %q, want system_channel_immutable; err=%v", got, err)
	}
	if repository.updateCommand.ChannelID != "" {
		t.Fatalf("root update reached repository: %#v", repository.updateCommand)
	}
}
