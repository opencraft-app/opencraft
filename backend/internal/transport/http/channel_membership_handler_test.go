package httptransport

import (
	"context"
	"testing"
	"time"

	"chatserver/internal/api/openapi"
	appchannelmembership "chatserver/internal/app/channelmembership"
	channelmembershipport "chatserver/internal/ports/channelmembership"

	"github.com/google/uuid"
)

type fakeChannelMembershipService struct {
	command appchannelmembership.Command
}

func (service *fakeChannelMembershipService) Change(
	_ context.Context,
	command appchannelmembership.Command,
) (channelmembershipport.Result, error) {
	service.command = command
	return channelmembershipport.Result{
		ChannelMemberID: handlerInviteID,
		OperationID:     handlerSessionID,
		CreatedAt:       time.Date(2026, 7, 31, 5, 0, 0, 0, time.UTC),
	}, nil
}

func TestChannelMembershipHandlerMapsAddAndRemove(t *testing.T) {
	service := &fakeChannelMembershipService{}
	handler, err := NewChannelMembershipHandler(service)
	if err != nil {
		t.Fatal(err)
	}
	addedResponse, err := handler.AddChannelMember(
		currentHumanContext(t),
		openapi.AddChannelMemberRequestObject{
			ServerId:  uuid.MustParse(handlerServerID),
			ChannelId: uuid.MustParse(handlerInviteID),
			MemberId:  uuid.MustParse(handlerAccountID),
			Params: openapi.AddChannelMemberParams{
				IdempotencyKey: "channel-member-add-0001",
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	added, ok := addedResponse.(openapi.AddChannelMember202JSONResponse)
	if !ok || service.command.Action != "ensure" ||
		added.Operations[0].Kind != "im.membership.ensure" {
		t.Fatalf("AddChannelMember() = %#v command=%#v", addedResponse, service.command)
	}
	removedResponse, err := handler.RemoveChannelMember(
		currentHumanContext(t),
		openapi.RemoveChannelMemberRequestObject{
			ServerId:  uuid.MustParse(handlerServerID),
			ChannelId: uuid.MustParse(handlerInviteID),
			MemberId:  uuid.MustParse(handlerAccountID),
			Params: openapi.RemoveChannelMemberParams{
				IdempotencyKey: "channel-member-remove-0001",
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	removed, ok := removedResponse.(openapi.RemoveChannelMember202JSONResponse)
	if !ok || service.command.Action != "remove" ||
		removed.Operations[0].Kind != "im.membership.remove" {
		t.Fatalf(
			"RemoveChannelMember() = %#v command=%#v",
			removedResponse,
			service.command,
		)
	}
}
