package membermutation

import (
	"context"
	"testing"
	"time"

	membermutationport "chatserver/internal/ports/membermutation"
)

const (
	mutationAccountID = "0198f4c2-7a30-7c91-a6d2-7d76f9188c37"
	mutationServerID  = "0198f4c2-7a31-7c91-a6d2-7d76f9188c38"
	mutationMemberID  = "0198f4c2-7a37-7e45-913c-6baf30401a83"
	mutationOperation = "0198f4c2-7a38-7e45-913c-6baf30401a84"
)

type mutationRepository struct {
	update membermutationport.UpdateCommand
	remove membermutationport.RemoveCommand
}

func (repository *mutationRepository) Update(
	_ context.Context,
	command membermutationport.UpdateCommand,
) (membermutationport.UpdateResult, error) {
	repository.update = command
	return membermutationport.UpdateResult{MemberID: command.MemberID}, nil
}

func (repository *mutationRepository) Remove(
	_ context.Context,
	command membermutationport.RemoveCommand,
) (membermutationport.RemoveResult, error) {
	repository.remove = command
	return membermutationport.RemoveResult{
		MemberID: command.MemberID, OperationID: command.OperationID,
		CreatedAt: command.RemovedAt,
	}, nil
}

type mutationIDs struct{ value string }

func (ids mutationIDs) New() (string, error) { return ids.value, nil }

type mutationClock struct{ now time.Time }

func (clock mutationClock) Now() time.Time { return clock.now }

func TestServiceBuildsUpdateAndRemoveCommands(t *testing.T) {
	now := time.Date(2026, 7, 31, 2, 0, 0, 0, time.UTC)
	repository := &mutationRepository{}
	service, err := NewService(
		repository,
		mutationIDs{value: mutationOperation},
		mutationClock{now: now},
	)
	if err != nil {
		t.Fatal(err)
	}
	displayName := "新名字"
	role := "admin"
	updated, err := service.Update(context.Background(), UpdateCommand{
		AccountID: mutationAccountID, ServerID: mutationServerID,
		MemberID: mutationMemberID, ExpectedRevision: 1,
		IdempotencyKey: "member-update-0001",
		DisplayName:    &displayName, Role: &role,
	})
	if err != nil || updated.MemberID != mutationMemberID ||
		repository.update.RequestHash == [32]byte{} ||
		!repository.update.UpdatedAt.Equal(now) {
		t.Fatalf("Update() = (%#v, %#v, %v)", updated, repository.update, err)
	}
	removed, err := service.Remove(context.Background(), RemoveCommand{
		AccountID: mutationAccountID, ServerID: mutationServerID,
		MemberID: mutationMemberID, IdempotencyKey: "member-remove-0001",
	})
	if err != nil || removed.OperationID != mutationOperation ||
		repository.remove.RequestHash == [32]byte{} ||
		!repository.remove.RemovedAt.Equal(now) {
		t.Fatalf("Remove() = (%#v, %#v, %v)", removed, repository.remove, err)
	}
}
