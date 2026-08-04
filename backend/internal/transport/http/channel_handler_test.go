package httptransport

import (
	"context"
	"testing"
	"time"

	"chatserver/internal/api/openapi"
	appchannel "chatserver/internal/app/channelmanagement"
	channelport "chatserver/internal/ports/channel"
	servermemberport "chatserver/internal/ports/servermember"

	"github.com/google/uuid"
)

const (
	handlerChannelID                = "0198f4c2-7a36-7af3-a01e-0fcb31e9d84d"
	handlerChannelMemberOperationID = "0198f4c2-7a39-7af3-a01e-0fcb31e9d84e"
)

type fakeChannelService struct {
	createCommand appchannel.CreateCommand
	updateCommand appchannel.UpdateCommand
	result        channelport.CreateResult
	channels      []channelport.Channel
}

func (service *fakeChannelService) Create(
	_ context.Context,
	command appchannel.CreateCommand,
) (channelport.CreateResult, error) {
	service.createCommand = command
	return service.result, nil
}

func (service *fakeChannelService) List(
	context.Context,
	string,
	string,
) ([]channelport.Channel, error) {
	return service.channels, nil
}

func (service *fakeChannelService) Get(
	context.Context,
	string,
	string,
	string,
) (channelport.Channel, error) {
	return service.channels[0], nil
}

func (service *fakeChannelService) Update(
	_ context.Context,
	command appchannel.UpdateCommand,
) (channelport.Channel, error) {
	service.updateCommand = command
	value := service.channels[0]
	if command.Name != nil {
		value.Name = *command.Name
	}
	if command.DescriptionSet {
		value.Description = command.Description
	}
	value.Revision++
	return value, nil
}

func TestChannelHandlerMapsCreateListAndGet(t *testing.T) {
	now := time.Date(2026, 7, 30, 23, 30, 0, 0, time.UTC)
	description := "协作讨论"
	topicID := "@TGS#_test@TOPIC#_T_TEST"
	value := channelport.Channel{
		ID: handlerChannelID, ServerID: handlerServerID,
		Name: "协作", Description: &description, Visibility: "private",
		IMGroupID: "@TGS#_test", IMTopicID: &topicID,
		IMState: "provisioning", Revision: 1,
	}
	service := &fakeChannelService{
		channels: []channelport.Channel{value},
		result: channelport.CreateResult{
			Channel: value,
			Operations: []channelport.Operation{
				{ID: handlerOperationID, ServerID: handlerServerID,
					Service: "im", Kind: "im.topic.ensure",
					State: "pending", CreatedAt: now},
				{ID: handlerChannelMemberOperationID, ServerID: handlerServerID,
					Service: "im", Kind: "im.membership.ensure",
					State: "pending", CreatedAt: now},
			},
		},
	}
	handler, err := NewChannelHandler(service, &fakeServerQueries{})
	if err != nil {
		t.Fatal(err)
	}

	createResponse, err := handler.CreateChannel(
		currentHumanContext(t),
		openapi.CreateChannelRequestObject{
			ServerId: uuid.MustParse(handlerServerID),
			Params: openapi.CreateChannelParams{
				IdempotencyKey: "channel-create-0001",
			},
			Body: &openapi.CreateChannelRequest{
				Name:        "协作",
				Description: &description,
				Visibility:  openapi.CreateChannelRequestVisibilityPrivate,
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	accepted, ok := createResponse.(openapi.CreateChannel202JSONResponse)
	if !ok || accepted.ResourceId.String() != handlerChannelID ||
		len(accepted.Operations) != 2 ||
		accepted.Operations[0].Id.String() != handlerOperationID ||
		accepted.Operations[1].Id.String() != handlerChannelMemberOperationID ||
		service.createCommand.AccountID != handlerAccountID ||
		service.createCommand.ServerID != handlerServerID ||
		service.createCommand.Visibility != "private" {
		t.Fatalf(
			"CreateChannel() = %#v command=%#v",
			createResponse,
			service.createCommand,
		)
	}

	listResponse, err := handler.ListChannels(
		currentHumanContext(t),
		openapi.ListChannelsRequestObject{
			ServerId: uuid.MustParse(handlerServerID),
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	list, ok := listResponse.(openapi.ListChannels200JSONResponse)
	if !ok || len(list) != 1 ||
		list[0].Id.String() != handlerChannelID ||
		list[0].ImTopicId == nil ||
		*list[0].ImTopicId != topicID {
		t.Fatalf("ListChannels() = %#v", listResponse)
	}

	getResponse, err := handler.GetChannel(
		currentHumanContext(t),
		openapi.GetChannelRequestObject{
			ServerId:  uuid.MustParse(handlerServerID),
			ChannelId: uuid.MustParse(handlerChannelID),
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := getResponse.(openapi.GetChannel200JSONResponse)
	if !ok || got.Visibility != openapi.ChannelVisibilityPrivate ||
		got.ImState != openapi.ChannelImStateProvisioning {
		t.Fatalf("GetChannel() = %#v", getResponse)
	}
}

func TestChannelHandlerListsExplicitPublicChannelMembers(t *testing.T) {
	topicID := "@TGS#_test@TOPIC#_PRIVATE"
	service := &fakeChannelService{
		channels: []channelport.Channel{{
			ID: handlerChannelID, ServerID: handlerServerID,
			Name: "公开协作", Visibility: "public",
			IMGroupID: "@TGS#_test", IMTopicID: &topicID,
			IMState: "ready", Revision: 1,
		}},
	}
	queries := &fakeServerQueries{
		channelMembers: []servermemberport.Member{{
			ID: handlerMemberID, ServerID: handlerServerID,
			Kind: "human", Role: "owner", DisplayName: "爱丽丝",
			Handle: "u_ALICE", Status: "active",
			IMUserID: "u_ALICE_IM", IMState: "ready", Revision: 1,
		}},
	}
	handler, err := NewChannelHandler(service, queries)
	if err != nil {
		t.Fatal(err)
	}

	response, err := handler.ListChannelMembers(
		currentHumanContext(t),
		openapi.ListChannelMembersRequestObject{
			ServerId:  uuid.MustParse(handlerServerID),
			ChannelId: uuid.MustParse(handlerChannelID),
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	members, ok := response.(openapi.ListChannelMembers200JSONResponse)
	if !ok || len(members) != 1 ||
		members[0].Id.String() != handlerMemberID {
		t.Fatalf("ListChannelMembers(explicit) = %#v", response)
	}
}

func TestChannelHandlerMapsUpdateChannel(t *testing.T) {
	topicID := "@TGS#_test@TOPIC#_PRIVATE"
	service := &fakeChannelService{
		channels: []channelport.Channel{{
			ID: handlerChannelID, ServerID: handlerServerID,
			Name: "研发", Visibility: "private",
			IMGroupID: "@TGS#_test", IMTopicID: &topicID,
			IMState: "ready", Revision: 2,
		}},
	}
	handler, err := NewChannelHandler(service, &fakeServerQueries{})
	if err != nil {
		t.Fatal(err)
	}
	name := "产品研发"
	description := "新的协作说明"
	response, err := handler.UpdateChannel(
		currentHumanContext(t),
		openapi.UpdateChannelRequestObject{
			ServerId:  uuid.MustParse(handlerServerID),
			ChannelId: uuid.MustParse(handlerChannelID),
			Params: openapi.UpdateChannelParams{
				XResourceRevision: 2, IdempotencyKey: "channel-update-0001",
			},
			Body: &openapi.UpdateChannelRequest{
				Name: &name, Description: &description,
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	updated, ok := response.(openapi.UpdateChannel200JSONResponse)
	if !ok || updated.Body.Name != name || updated.Body.Revision != 3 ||
		updated.Headers.XResourceRevision != 3 ||
		service.updateCommand.Revision != 2 ||
		service.updateCommand.IdempotencyKey != "channel-update-0001" ||
		!service.updateCommand.DescriptionSet {
		t.Fatalf(
			"UpdateChannel() = %#v command=%#v",
			response,
			service.updateCommand,
		)
	}
}
