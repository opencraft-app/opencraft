package httptransport

import (
	"context"
	"testing"
	"time"

	"chatserver/internal/api/openapi"
	appinvite "chatserver/internal/app/serverinvite"
	inviteport "chatserver/internal/ports/serverinvite"

	"github.com/google/uuid"
)

const handlerInviteID = "0198f4c2-7a38-7af3-a01e-0fcb31e9d84f"

type fakeInviteService struct {
	createCommand appinvite.CreateCommand
	acceptCommand appinvite.AcceptCommand
	revokeCommand appinvite.RevokeCommand
	values        []inviteport.Invite
}

func (service *fakeInviteService) Create(
	_ context.Context,
	command appinvite.CreateCommand,
) (appinvite.CreateResult, error) {
	service.createCommand = command
	return appinvite.CreateResult{
		Invite: service.values[0],
		Token:  appinvite.InviteToken("rfi_fixture_secret"),
	}, nil
}

func (service *fakeInviteService) List(
	context.Context,
	string,
	string,
) ([]inviteport.Invite, error) {
	return service.values, nil
}

func (service *fakeInviteService) Revoke(
	_ context.Context,
	command appinvite.RevokeCommand,
) error {
	service.revokeCommand = command
	return nil
}

func (service *fakeInviteService) Accept(
	_ context.Context,
	command appinvite.AcceptCommand,
) (appinvite.AcceptResult, error) {
	service.acceptCommand = command
	return appinvite.AcceptResult{
		MemberID:    handlerInviteID,
		ServerID:    handlerServerID,
		OperationID: handlerSessionID,
		CreatedAt:   service.values[0].ExpiresAt.Add(-time.Hour),
	}, nil
}

func (service *fakeInviteService) AcceptJoinLink(
	ctx context.Context,
	command appinvite.AcceptCommand,
) (appinvite.AcceptResult, error) {
	result, err := service.Accept(ctx, command)
	result.ServerSlug = "invite-test"
	result.LandingChannelID = handlerChannelID
	return result, err
}

func TestInviteHandlerMapsCreateListAndRevoke(t *testing.T) {
	expiresAt := time.Date(2026, 7, 31, 23, 0, 0, 0, time.UTC)
	service := &fakeInviteService{
		values: []inviteport.Invite{{
			ID: handlerInviteID, ServerID: handlerServerID,
			Role: "member", MaxUses: 3, UsedCount: 0,
			LandingChannelID: stringPointer(handlerChannelID),
			ExpiresAt:        expiresAt, Revision: 1,
		}},
	}
	handler, err := NewInviteHandler(service)
	if err != nil {
		t.Fatal(err)
	}

	createResponse, err := handler.CreateInvite(
		currentHumanContext(t),
		openapi.CreateInviteRequestObject{
			ServerId: uuid.MustParse(handlerServerID),
			Body: &openapi.CreateInviteRequest{
				Role:    openapi.CreateInviteRequestRoleMember,
				MaxUses: 3, ExpiresAt: expiresAt,
				LandingChannelId: uuidPointer(handlerChannelID),
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	created, ok := createResponse.(openapi.CreateInvite201JSONResponse)
	if !ok ||
		created.Body.Token == nil ||
		*created.Body.Token != "rfi_fixture_secret" ||
		created.Body.Invite.Id.String() != handlerInviteID ||
		created.Headers.CacheControl != "no-store" ||
		created.Headers.Pragma != "no-cache" ||
		service.createCommand.AccountID != handlerAccountID ||
		service.createCommand.ServerID != handlerServerID ||
		service.createCommand.LandingChannelID == nil ||
		*service.createCommand.LandingChannelID != handlerChannelID ||
		created.Body.Invite.LandingChannelId == nil ||
		created.Body.Invite.LandingChannelId.String() != handlerChannelID {
		t.Fatalf(
			"CreateInvite() = %#v command=%#v",
			createResponse,
			service.createCommand,
		)
	}

	listResponse, err := handler.ListInvites(
		currentHumanContext(t),
		openapi.ListInvitesRequestObject{
			ServerId: uuid.MustParse(handlerServerID),
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	list, ok := listResponse.(openapi.ListInvites200JSONResponse)
	if !ok || len(list) != 1 ||
		list[0].Id.String() != handlerInviteID {
		t.Fatalf("ListInvites() = %#v", listResponse)
	}

	revokeResponse, err := handler.RevokeInvite(
		currentHumanContext(t),
		openapi.RevokeInviteRequestObject{
			ServerId: uuid.MustParse(handlerServerID),
			InviteId: uuid.MustParse(handlerInviteID),
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := revokeResponse.(openapi.RevokeInvite204Response); !ok ||
		service.revokeCommand.InviteID != handlerInviteID {
		t.Fatalf(
			"RevokeInvite() = %#v command=%#v",
			revokeResponse,
			service.revokeCommand,
		)
	}

	acceptResponse, err := handler.AcceptInvite(
		currentHumanContext(t),
		openapi.AcceptInviteRequestObject{
			Params: openapi.AcceptInviteParams{
				IdempotencyKey: "invite-accept-0001",
			},
			Body: &openapi.AcceptInviteJSONRequestBody{
				Token: "rfi_fixture_secret_long_enough",
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	accepted, ok := acceptResponse.(openapi.AcceptInvite202JSONResponse)
	if !ok ||
		accepted.ResourceId.String() != handlerInviteID ||
		len(accepted.Operations) != 1 ||
		accepted.Operations[0].Id.String() != handlerSessionID ||
		service.acceptCommand.AccountID != handlerAccountID ||
		service.acceptCommand.IdempotencyKey != "invite-accept-0001" {
		t.Fatalf(
			"AcceptInvite() = %#v command=%#v",
			acceptResponse,
			service.acceptCommand,
		)
	}

	joinToken := "rfi_fixture_secret_long_enough"
	joinResponse, err := handler.AcceptJoinLink(
		currentHumanContext(t),
		openapi.AcceptJoinLinkRequestObject{
			Params: openapi.AcceptJoinLinkParams{
				IdempotencyKey: "join-link-accept-0001",
			},
			Body: &openapi.AcceptJoinLinkJSONRequestBody{
				Token: &joinToken,
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	joined, ok := joinResponse.(openapi.AcceptJoinLink200JSONResponse)
	if !ok ||
		joined.ServerId.String() != handlerServerID ||
		joined.ServerSlug != "invite-test" ||
		joined.MemberId.String() != handlerInviteID ||
		joined.LandingChannelId.String() != handlerChannelID ||
		len(joined.Operations) != 1 ||
		service.acceptCommand.IdempotencyKey != "join-link-accept-0001" {
		t.Fatalf(
			"AcceptJoinLink() = %#v command=%#v",
			joinResponse,
			service.acceptCommand,
		)
	}
}

func stringPointer(value string) *string { return &value }

func uuidPointer(value string) *uuid.UUID {
	parsed := uuid.MustParse(value)
	return &parsed
}
