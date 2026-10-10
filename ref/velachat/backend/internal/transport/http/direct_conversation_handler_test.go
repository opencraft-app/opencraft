package httptransport

import (
	"context"
	"testing"
	"time"

	"chatserver/internal/api/openapi"
	appdirect "chatserver/internal/app/directconversation"
	directport "chatserver/internal/ports/directconversation"

	"github.com/google/uuid"
)

const (
	handlerDirectID     = "0198f4c2-7c10-7c91-a6d2-7d76f9188c01"
	handlerDirectPeerID = "0198f4c2-7c11-7c91-a6d2-7d76f9188c02"
	handlerDirectOpID   = "0198f4c2-7c12-7c91-a6d2-7d76f9188c03"
)

type fakeDirectConversationService struct {
	createCommand appdirect.CreateCommand
	retryCommand  appdirect.RetryCommand
	result        directport.CreateResult
	page          directport.Page
}

func (service *fakeDirectConversationService) Create(_ context.Context, command appdirect.CreateCommand) (directport.CreateResult, error) {
	service.createCommand = command
	return service.result, nil
}

func (service *fakeDirectConversationService) Retry(_ context.Context, command appdirect.RetryCommand) (directport.CreateResult, error) {
	service.retryCommand = command
	return service.result, nil
}

func (service *fakeDirectConversationService) List(context.Context, directport.PageRequest) (directport.Page, error) {
	return service.page, nil
}

func (service *fakeDirectConversationService) Get(context.Context, string, string, string) (directport.Conversation, error) {
	return service.result.Conversation, nil
}

func TestDirectConversationHandlerCreatesListsGetsAndRetries(t *testing.T) {
	value := handlerDirectConversation()
	service := &fakeDirectConversationService{
		result: directport.CreateResult{Conversation: value, Accepted: true, Operations: []directport.Operation{{
			ID: handlerDirectOpID, ServerID: handlerServerID, Service: "im", Kind: "im.direct.ensure",
			State: "pending", CreatedAt: time.Date(2026, 8, 4, 18, 0, 0, 0, time.UTC),
		}}},
		page: directport.Page{Items: []directport.Conversation{value}},
	}
	handler, err := NewDirectConversationHandler(service)
	if err != nil {
		t.Fatal(err)
	}
	ctx := currentHumanContext(t)
	create, err := handler.CreateDirectConversation(ctx, openapi.CreateDirectConversationRequestObject{
		ServerId: uuid.MustParse(handlerServerID),
		Params:   openapi.CreateDirectConversationParams{IdempotencyKey: "direct-create-0001"},
		Body:     &openapi.CreateDirectConversationRequest{PeerMemberId: uuid.MustParse(handlerDirectPeerID)},
	})
	if err != nil {
		t.Fatal(err)
	}
	accepted, ok := create.(openapi.CreateDirectConversation202JSONResponse)
	if !ok || accepted.ResourceId.String() != handlerDirectID || len(accepted.Operations) != 1 ||
		service.createCommand.AccountID != handlerAccountID || service.createCommand.PeerMemberID != handlerDirectPeerID {
		t.Fatalf("create=%#v command=%#v", create, service.createCommand)
	}

	list, err := handler.ListDirectConversations(ctx, openapi.ListDirectConversationsRequestObject{
		ServerId: uuid.MustParse(handlerServerID), Params: openapi.ListDirectConversationsParams{},
	})
	if err != nil {
		t.Fatal(err)
	}
	page, ok := list.(openapi.ListDirectConversations200JSONResponse)
	if !ok || len(page.Items) != 1 || page.Items[0].ImGroupId != "an_dm_handler" ||
		page.Items[0].MemberB.Id.String() != handlerDirectPeerID {
		t.Fatalf("list=%#v", list)
	}

	get, err := handler.GetDirectConversation(ctx, openapi.GetDirectConversationRequestObject{
		ServerId: uuid.MustParse(handlerServerID), DirectConversationId: uuid.MustParse(handlerDirectID),
	})
	if err != nil {
		t.Fatal(err)
	}
	if body, ok := get.(openapi.GetDirectConversation200JSONResponse); !ok || body.Id.String() != handlerDirectID {
		t.Fatalf("get=%#v", get)
	}

	retry, err := handler.RetryDirectConversation(ctx, openapi.RetryDirectConversationRequestObject{
		ServerId: uuid.MustParse(handlerServerID), DirectConversationId: uuid.MustParse(handlerDirectID),
		Params: openapi.RetryDirectConversationParams{IdempotencyKey: "direct-retry-0001"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := retry.(openapi.RetryDirectConversation202JSONResponse); !ok ||
		service.retryCommand.DirectConversationID != handlerDirectID {
		t.Fatalf("retry=%#v command=%#v", retry, service.retryCommand)
	}
}

func handlerDirectConversation() directport.Conversation {
	accountID := handlerAccountID
	return directport.Conversation{
		ID: handlerDirectID, ServerID: handlerServerID, Status: "active", IMGroupID: "an_dm_handler",
		IMState: "provisioning", Revision: 1,
		MemberA: directport.Member{ID: handlerMemberID, ServerID: handlerServerID, AccountID: &accountID,
			Kind: "human", Role: "owner", DisplayName: "Alice", Handle: "alice", Status: "active",
			IMUserID: "u_ALICE", IMState: "ready", Revision: 1},
		MemberB: directport.Member{ID: handlerDirectPeerID, ServerID: handlerServerID,
			Kind: "agent", Role: "member", DisplayName: "Agent", Handle: "agent", Status: "active",
			IMUserID: "a_AGENT", IMState: "ready", Revision: 1},
	}
}
