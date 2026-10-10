package directconversation

import (
	"context"
	"testing"
	"time"

	"chatserver/internal/apperror"
	directport "chatserver/internal/ports/directconversation"
)

const (
	directAccountID   = "0198f4c2-7a30-7c91-a6d2-7d76f9188c37"
	directServerID    = "0198f4c2-7a31-7c91-a6d2-7d76f9188c38"
	directSelfID      = "0198f4c2-7a32-7c91-a6d2-7d76f9188c39"
	directPeerID      = "0198f4c2-7a33-7c91-a6d2-7d76f9188c40"
	directID          = "0198f4c2-7a34-7c91-a6d2-7d76f9188c41"
	directOperationID = "0198f4c2-7a35-7c91-a6d2-7d76f9188c42"
	directRetryOpID   = "0198f4c2-7a36-7c91-a6d2-7d76f9188c43"
	directGroupID     = "an_dm_5ODDSBF3PNVZH25YMT3OMJ4ZSF"
)

type fakeDirectRepository struct {
	participants directport.Participants
	create       directport.CreateCommand
	retry        directport.RetryCommand
}

func (repository *fakeDirectRepository) ResolveParticipants(context.Context, string, string, string) (directport.Participants, error) {
	return repository.participants, nil
}

func (repository *fakeDirectRepository) Create(_ context.Context, command directport.CreateCommand) (directport.CreateResult, error) {
	repository.create = command
	return directport.CreateResult{
		Conversation: directport.Conversation{
			ID: command.DirectConversationID, ServerID: command.ServerID,
			MemberA: repository.participants.Self, MemberB: repository.participants.Peer,
			Status: "active", IMGroupID: command.IMGroupID,
			IMState: "provisioning", Revision: 1,
		},
		Operations: []directport.Operation{{
			ID: command.OperationID, ServerID: command.ServerID,
			Service: "im", Kind: "im.direct.ensure", State: "pending",
			CreatedAt: command.CreatedAt,
		}},
		Accepted: true,
	}, nil
}

func (repository *fakeDirectRepository) Retry(_ context.Context, command directport.RetryCommand) (directport.CreateResult, error) {
	repository.retry = command
	return directport.CreateResult{Accepted: true, Operations: []directport.Operation{{ID: command.OperationID}}}, nil
}

func (*fakeDirectRepository) List(context.Context, directport.PageRequest) (directport.Page, error) {
	return directport.Page{}, nil
}

func (*fakeDirectRepository) Get(context.Context, string, string, string) (directport.Conversation, error) {
	return directport.Conversation{}, nil
}

type fakeDirectDeriver struct{}

func (fakeDirectDeriver) DirectGroupID(serverID, conversationID string) (string, error) {
	if serverID != directServerID || conversationID != directID {
		panic("unexpected direct group input")
	}
	return directGroupID, nil
}

type fixedDirectIDs struct {
	values []string
	index  int
}

func (ids *fixedDirectIDs) New() (string, error) {
	value := ids.values[ids.index]
	ids.index++
	return value, nil
}

type fixedDirectClock struct{ now time.Time }

func (clock fixedDirectClock) Now() time.Time { return clock.now }

func TestServiceCreatesCanonicalServerScopedConversation(t *testing.T) {
	now := time.Date(2026, 8, 4, 14, 30, 0, 0, time.UTC)
	repository := &fakeDirectRepository{participants: directport.Participants{
		Self: directport.Member{ID: directPeerID, ServerID: directServerID, Status: "active", IMState: "ready", IMUserID: "human-self"},
		Peer: directport.Member{ID: directSelfID, ServerID: directServerID, Status: "active", IMState: "ready", IMUserID: "agent-peer"},
	}}
	service, err := NewService(repository, fakeDirectDeriver{}, &fixedDirectIDs{values: []string{directID, directOperationID}}, fixedDirectClock{now: now})
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.Create(context.Background(), CreateCommand{
		AccountID: directAccountID, ServerID: directServerID,
		PeerMemberID: directSelfID, IdempotencyKey: "direct-create-0001",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Accepted || result.Conversation.IMGroupID != directGroupID ||
		repository.create.MemberAID != directSelfID || repository.create.MemberBID != directPeerID ||
		repository.create.DirectConversationID != directID || repository.create.OperationID != directOperationID ||
		repository.create.CreatedAt != now {
		t.Fatalf("result/command = (%#v, %#v)", result, repository.create)
	}
}

func TestServiceRetryUsesSeparateOperationAndIdempotencyScope(t *testing.T) {
	repository := &fakeDirectRepository{}
	service, err := NewService(repository, fakeDirectDeriver{}, &fixedDirectIDs{values: []string{directRetryOpID}}, fixedDirectClock{now: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.Retry(context.Background(), RetryCommand{
		AccountID: directAccountID, ServerID: directServerID,
		DirectConversationID: directID, IdempotencyKey: "direct-retry-0001",
	})
	if err != nil {
		t.Fatal(err)
	}
	if repository.retry.OperationID != directRetryOpID || repository.retry.IdempotencyKey != "direct-retry-0001" {
		t.Fatalf("retry command = %#v", repository.retry)
	}
}

func TestServiceRejectsInvalidOrSelfPeer(t *testing.T) {
	repository := &fakeDirectRepository{participants: directport.Participants{
		Self: directport.Member{ID: directSelfID}, Peer: directport.Member{ID: directSelfID},
	}}
	service, err := NewService(repository, fakeDirectDeriver{}, &fixedDirectIDs{}, fixedDirectClock{now: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.Create(context.Background(), CreateCommand{
		AccountID: directAccountID, ServerID: directServerID,
		PeerMemberID: directSelfID, IdempotencyKey: "direct-create-0001",
	})
	if apperror.CodeOf(err) != "invalid_request" {
		t.Fatalf("Create(self) error = %v", err)
	}
}
