package httptransport

import (
	"context"
	"testing"
	"time"

	"chatserver/internal/api/openapi"
	appservermember "chatserver/internal/app/servermember"
	servermemberport "chatserver/internal/ports/servermember"

	"github.com/google/uuid"
)

const (
	handlerServerID    = "0198f4c2-7a31-7c91-a6d2-7d76f9188c38"
	handlerMemberID    = "0198f4c2-7a32-7d02-b8c1-3f6e15aa91b4"
	handlerOperationID = "0198f4c2-7a34-7af3-a01e-0fcb31e9d84b"
)

type fakeServerCreator struct {
	command appservermember.CreateCommand
	result  appservermember.CreateResult
}

func (creator *fakeServerCreator) Create(
	_ context.Context,
	command appservermember.CreateCommand,
) (appservermember.CreateResult, error) {
	creator.command = command
	return creator.result, nil
}

type fakeServerQueries struct {
	page           servermemberport.ServerPage
	server         servermemberport.Server
	members        []servermemberport.Member
	channelMembers []servermemberport.Member
	member         servermemberport.Member
}

func (queries *fakeServerQueries) ListServers(
	context.Context,
	string,
	servermemberport.ListOptions,
) (servermemberport.ServerPage, error) {
	return queries.page, nil
}
func (queries *fakeServerQueries) GetServer(
	context.Context,
	string,
	string,
) (servermemberport.Server, error) {
	return queries.server, nil
}
func (queries *fakeServerQueries) ListMembers(
	context.Context,
	string,
	string,
	servermemberport.ListOptions,
) (servermemberport.MemberPage, error) {
	return servermemberport.MemberPage{Items: queries.members}, nil
}

func (queries *fakeServerQueries) ListChannelMembers(
	context.Context,
	string,
	string,
	string,
	servermemberport.ListOptions,
) ([]servermemberport.Member, error) {
	return queries.channelMembers, nil
}
func (queries *fakeServerQueries) GetMember(
	context.Context,
	string,
	string,
	string,
) (servermemberport.Member, error) {
	return queries.member, nil
}

func TestServerMemberHandlerMapsCreateListGetAndMemberFacts(t *testing.T) {
	now := time.Date(2026, 7, 30, 21, 0, 0, 0, time.UTC)
	serverValue := servermemberport.Server{
		ID:            handlerServerID,
		Slug:          "agent-lab",
		Name:          "Agent 实验室",
		OwnerMemberID: handlerMemberID,
		IMState:       "ready",
		Revision:      2,
	}
	operation := appservermember.Operation{
		ID:        handlerOperationID,
		Service:   "im",
		Kind:      "im.community.ensure",
		State:     "succeeded",
		CreatedAt: now,
	}
	creator := &fakeServerCreator{
		result: appservermember.CreateResult{
			Ready:     true,
			Server:    serverValue,
			Operation: operation,
		},
	}
	memberValue := servermemberport.Member{
		ID:          handlerMemberID,
		ServerID:    handlerServerID,
		Kind:        "human",
		Role:        "owner",
		DisplayName: "爱丽丝",
		Handle:      "u_ALICE",
		Status:      "active",
		IMUserID:    "u_ALICE_IM",
		IMState:     "ready",
		Revision:    2,
	}
	queries := &fakeServerQueries{
		page:    servermemberport.ServerPage{Items: []servermemberport.Server{serverValue}},
		server:  serverValue,
		members: []servermemberport.Member{memberValue},
		member:  memberValue,
	}
	handler, err := NewServerMemberHandler(creator, queries)
	if err != nil {
		t.Fatal(err)
	}
	ctx := currentHumanContext(t)
	body := openapi.CreateServerJSONRequestBody{
		Slug: "agent-lab",
		Name: "Agent 实验室",
	}
	createResponse, err := handler.CreateServer(
		ctx,
		openapi.CreateServerRequestObject{
			Params: openapi.CreateServerParams{
				IdempotencyKey: "server-create-0001",
			},
			Body: &body,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	created, ok := createResponse.(openapi.CreateServer201JSONResponse)
	if !ok || created.Id.String() != handlerServerID ||
		creator.command.AccountID != handlerAccountID ||
		creator.command.IdempotencyKey != "server-create-0001" {
		t.Fatalf("CreateServer() = %#v, command = %#v", createResponse, creator.command)
	}
	listResponse, err := handler.ListServers(
		ctx,
		openapi.ListServersRequestObject{},
	)
	if err != nil {
		t.Fatal(err)
	}
	list, ok := listResponse.(openapi.ListServers200JSONResponse)
	if !ok || len(list.Items) != 1 || list.Items[0].Id.String() != handlerServerID {
		t.Fatalf("ListServers() = %#v", listResponse)
	}
	getResponse, err := handler.GetServer(
		ctx,
		openapi.GetServerRequestObject{ServerId: uuid.MustParse(handlerServerID)},
	)
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := getResponse.(openapi.GetServer200JSONResponse); !ok || got.OwnerMemberId.String() != handlerMemberID {
		t.Fatalf("GetServer() = %#v", getResponse)
	}
	membersResponse, err := handler.ListMembers(
		ctx,
		openapi.ListMembersRequestObject{
			ServerId: uuid.MustParse(handlerServerID),
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	members, ok := membersResponse.(openapi.ListMembers200JSONResponse)
	if !ok || len(members.Items) != 1 || members.Items[0].ImUserId == nil {
		t.Fatalf("ListMembers() = %#v", membersResponse)
	}
}

func TestServerMemberHandlerReturnsAcceptedPendingOperation(t *testing.T) {
	creator := &fakeServerCreator{
		result: appservermember.CreateResult{
			Server: servermemberport.Server{ID: handlerServerID},
			Operation: appservermember.Operation{
				ID:        handlerOperationID,
				Service:   "im",
				Kind:      "im.community.ensure",
				State:     "pending",
				CreatedAt: time.Now(),
			},
		},
	}
	handler, err := NewServerMemberHandler(creator, &fakeServerQueries{})
	if err != nil {
		t.Fatal(err)
	}
	body := openapi.CreateServerJSONRequestBody{
		Slug: "agent-lab",
		Name: "Agent 实验室",
	}
	response, err := handler.CreateServer(
		currentHumanContext(t),
		openapi.CreateServerRequestObject{
			Params: openapi.CreateServerParams{IdempotencyKey: "server-create-0001"},
			Body:   &body,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	accepted, ok := response.(openapi.CreateServer202JSONResponse)
	if !ok || accepted.ResourceId.String() != handlerServerID ||
		len(accepted.Operations) != 1 ||
		accepted.Operations[0].Id.String() != handlerOperationID {
		t.Fatalf("CreateServer() = %#v", response)
	}
}
