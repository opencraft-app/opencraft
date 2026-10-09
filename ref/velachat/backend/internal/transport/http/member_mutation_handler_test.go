package httptransport

import (
	"context"
	"testing"
	"time"

	"chatserver/internal/api/openapi"
	appmembermutation "chatserver/internal/app/membermutation"
	membermutationport "chatserver/internal/ports/membermutation"
	servermemberport "chatserver/internal/ports/servermember"

	"github.com/google/uuid"
)

type fakeMemberMutationService struct {
	update appmembermutation.UpdateCommand
	remove appmembermutation.RemoveCommand
}

func (service *fakeMemberMutationService) Update(
	_ context.Context,
	command appmembermutation.UpdateCommand,
) (membermutationport.UpdateResult, error) {
	service.update = command
	return membermutationport.UpdateResult{MemberID: command.MemberID}, nil
}

func (service *fakeMemberMutationService) Remove(
	_ context.Context,
	command appmembermutation.RemoveCommand,
) (membermutationport.RemoveResult, error) {
	service.remove = command
	return membermutationport.RemoveResult{
		MemberID: command.MemberID, OperationID: handlerSessionID,
		CreatedAt: time.Date(2026, 7, 31, 3, 0, 0, 0, time.UTC),
	}, nil
}

type fakeMemberMutationQueries struct{}

func (fakeMemberMutationQueries) ListChannelMembers(
	context.Context,
	string,
	string,
	string,
	servermemberport.ListOptions,
) ([]servermemberport.Member, error) {
	return nil, nil
}

func (fakeMemberMutationQueries) ListServers(
	context.Context,
	string,
	servermemberport.ListOptions,
) (servermemberport.ServerPage, error) {
	return servermemberport.ServerPage{}, nil
}

func (fakeMemberMutationQueries) GetServer(
	context.Context,
	string,
	string,
) (servermemberport.Server, error) {
	return servermemberport.Server{}, nil
}

func (fakeMemberMutationQueries) ListMembers(
	context.Context,
	string,
	string,
	servermemberport.ListOptions,
) (servermemberport.MemberPage, error) {
	return servermemberport.MemberPage{}, nil
}

func (fakeMemberMutationQueries) GetMember(
	_ context.Context,
	_ string,
	serverID string,
	memberID string,
) (servermemberport.Member, error) {
	accountID := handlerAccountID
	return servermemberport.Member{
		ID: memberID, ServerID: serverID, AccountID: &accountID,
		Kind: "human", Role: "admin", DisplayName: "新名字",
		Handle: "member", Status: "active", IMUserID: "u_MEMBER",
		IMState: "ready", Revision: 2,
	}, nil
}

func TestMemberMutationHandlerMapsUpdateAndRemove(t *testing.T) {
	service := &fakeMemberMutationService{}
	handler, err := NewMemberMutationHandler(
		service,
		fakeMemberMutationQueries{},
	)
	if err != nil {
		t.Fatal(err)
	}
	displayName := "新名字"
	role := openapi.UpdateMemberRequestRoleAdmin
	updatedResponse, err := handler.UpdateMember(
		currentHumanContext(t),
		openapi.UpdateMemberRequestObject{
			ServerId: uuid.MustParse(handlerServerID),
			MemberId: uuid.MustParse(handlerInviteID),
			Params: openapi.UpdateMemberParams{
				XResourceRevision: 1, IdempotencyKey: "member-update-0001",
			},
			Body: &openapi.UpdateMemberRequest{
				DisplayName: &displayName, Role: &role,
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	updated, ok := updatedResponse.(openapi.UpdateMember200JSONResponse)
	if !ok || updated.Body.Revision != 2 || updated.Headers.XResourceRevision != 2 ||
		service.update.ExpectedRevision != 1 ||
		service.update.AccountID != handlerAccountID {
		t.Fatalf("UpdateMember() = %#v command=%#v", updatedResponse, service.update)
	}
	removedResponse, err := handler.RemoveMember(
		currentHumanContext(t),
		openapi.RemoveMemberRequestObject{
			ServerId: uuid.MustParse(handlerServerID),
			MemberId: uuid.MustParse(handlerInviteID),
			Params: openapi.RemoveMemberParams{
				IdempotencyKey: "member-remove-0001",
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	removed, ok := removedResponse.(openapi.RemoveMember202JSONResponse)
	if !ok || removed.ResourceId.String() != handlerInviteID ||
		len(removed.Operations) != 1 ||
		removed.Operations[0].Kind != "im.membership.remove" {
		t.Fatalf("RemoveMember() = %#v", removedResponse)
	}
}
